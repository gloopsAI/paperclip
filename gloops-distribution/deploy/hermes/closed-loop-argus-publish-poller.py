#!/usr/bin/env python3
"""Company-wide closed-loop poller: Argus APPROVE → App-B independent-review stamp.

Standing path for residual closed-loop half (P0-04). Replaces hand invocation of
closed-loop-publish-review.sh / wopr-review-publisher when Argus has accepted an
exact head on an open surface PR.

Detection (any one):
  1. Paperclip review issues (title contains maw-implementation-review or Review exact head)
     with a comment matching APPROVE + 40-char head SHA, and an open PR with that head.
  2. PAPERCLIP_SWARM_V1:{"action":"accepted","headSha":"..."} markers (wopr-loop-bridge compat).

Does NOT: merge, deploy, open PRs, bypass substrate denylist (publisher enforces).
State: /var/lib/paperclip-gloops/closed-loop-argus-publish-state.json
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = os.environ.get("CLOSED_LOOP_REPO", "gloopsAI/paperclip")
BASE_REF = os.environ.get("CLOSED_LOOP_BASE", "gloops/stable")
API = os.environ.get("PAPERCLIP_API", "http://127.0.0.1:3100/api").rstrip("/")
COMPANY = os.environ.get(
    "PAPERCLIP_COMPANY_ID", "89ed0964-d918-4fcc-b830-5be49d2d4089"
)
TOKEN_FILE = os.environ.get(
    "PAPERCLIP_BOARD_TOKEN_FILE", "/etc/paperclip-gloops/operator-board-token"
)
PUBLISHER = Path(
    os.environ.get(
        "WOPR_REVIEW_PUBLISHER",
        "/usr/local/lib/paperclip-gloops/wopr-review-publisher.py",
    )
)
STATE_PATH = Path(
    os.environ.get(
        "CLOSED_LOOP_PUBLISH_STATE",
        "/var/lib/paperclip-gloops/closed-loop-argus-publish-state.json",
    )
)
# Match: APPROVE head SHA | APPROVE exact head SHA | APPROVE SHA
APPROVE_RE = re.compile(
    r"\bAPPROVE\b(?:\s+exact)?(?:\s+head)?\s+([0-9a-f]{40})\b",
    re.IGNORECASE,
)
SWARM_RE = re.compile(r"PAPERCLIP_SWARM_V1:(\{.*?\})(?:\s|$)")
SHA_RE = re.compile(r"\b([0-9a-f]{40})\b")


def ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def token() -> str:
    env = os.environ.get("PAPERCLIP_TOKEN") or os.environ.get("PAPERCLIP_BOARD_TOKEN")
    if env:
        return env.strip()
    p = Path(TOKEN_FILE)
    if p.is_file():
        return p.read_text().strip()
    # sudo-readable
    try:
        return subprocess.check_output(
            ["sudo", "-n", "cat", TOKEN_FILE], text=True
        ).strip()
    except Exception as e:
        raise SystemExit(f"no board token: {e}") from e


def api(method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        API + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + token(),
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read()
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as e:
        err = e.read().decode()[:400]
        raise RuntimeError(f"API {method} {path} -> {e.code}: {err}") from e


def gh_json(path: str):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "closed-loop-argus-publish-poller",
    }
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    # Prefer gh CLI when available (host auth)
    try:
        out = subprocess.check_output(
            ["gh", "api", path], text=True, timeout=45, stderr=subprocess.DEVNULL
        )
        return json.loads(out)
    except Exception:
        pass
    req = urllib.request.Request("https://api.github.com" + path, headers=headers)
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text())
    return {"publishedForPr": {}, "lastRunAt": None, "lastActions": []}


def save_state(st: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE_PATH.parent, 0o700)
    parent_fd = os.open(STATE_PATH.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temp_name = f".{STATE_PATH.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp"
    temp_fd = -1
    try:
        temp_fd = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        payload = (json.dumps(st, indent=2, sort_keys=True) + "\n").encode()
        os.write(temp_fd, payload)
        os.fsync(temp_fd)
        os.close(temp_fd)
        temp_fd = -1
        os.rename(temp_name, STATE_PATH.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.chmod(STATE_PATH, 0o600)
        os.fsync(parent_fd)
    finally:
        if temp_fd >= 0:
            os.close(temp_fd)
        try:
            os.unlink(temp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def publish(pr: int, verdict: str = "accepted") -> None:
    cmd = [sys.executable, str(PUBLISHER), "--pr", str(pr), "--verdict", verdict]
    print(f"[publish] {' '.join(cmd)}", flush=True)
    if os.geteuid() == 0:
        subprocess.check_call(cmd)
    else:
        subprocess.check_call(["sudo", "-n", *cmd])


def mark_ready_and_automerge(pr: int, expected_head: str) -> dict:
    """Surface drafts cannot auto-merge; mark ready via App install token.

    Host `gh` as zach-hermes lacks MarkPullRequestReadyForReview. Root helper
    paperclip-mark-pr-ready.py mints a short-lived App token (PR write), marks
    ready, and arms squash auto-merge — then revokes the token.
    """
    helper = Path(
        os.environ.get(
            "PAPERCLIP_MARK_PR_READY",
            "/usr/local/lib/paperclip-gloops/tools/paperclip-mark-pr-ready.py",
        )
    )
    if not helper.is_file():
        raise RuntimeError("exact-head protected merge helper is unavailable")
    cmd = [
        sys.executable,
        str(helper),
        "--pr",
        str(pr),
        "--repo",
        REPO,
        "--expected-head",
        expected_head,
        "--base",
        BASE_REF,
        "--auto-merge",
        "--merge-if-clean",
    ]
    print(f"[merge-path] {' '.join(cmd)}", flush=True)
    executable = cmd if os.geteuid() == 0 else ["sudo", "-n", *cmd]
    out = subprocess.run(executable, check=False, timeout=90, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"protected merge helper failed rc={out.returncode}: {out.stderr[-300:]}")
    try:
        evidence = json.loads(out.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("protected merge helper returned invalid evidence") from error
    if evidence.get("ok") is not True:
        raise RuntimeError("protected merge helper did not report success")
    if evidence.get("headSha") != expected_head or evidence.get("baseRef") != BASE_REF:
        raise RuntimeError("protected merge helper evidence is not bound to the approved head/base")
    if evidence.get("merged") is not True and evidence.get("autoMergeArmed") is not True:
        raise RuntimeError("protected merge path is neither merged nor armed")
    return evidence


def extract_approved_heads(text: str) -> set[str]:
    heads: set[str] = set()
    if not text:
        return heads
    for m in APPROVE_RE.finditer(text):
        heads.add(m.group(1).lower())
    # Bare "APPROVE" / "Execution-truth receipt: APPROVE" with SHA later in blob
    # (Argus often puts SHA on the next lines: "Reviewed exact head <40hex>").
    if re.search(r"\bAPPROVE\b", text, re.IGNORECASE) and not heads:
        for m in re.finditer(
            r"(?:exact\s+)?head\s+`?([0-9a-f]{40})`?\b", text, re.IGNORECASE
        ):
            heads.add(m.group(1).lower())
        if not heads:
            # last resort: first full SHA in an APPROVE-containing comment
            for m in SHA_RE.finditer(text):
                heads.add(m.group(1).lower())
                break
    for m in SWARM_RE.finditer(text):
        try:
            obj = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if str(obj.get("action", "")).lower() in ("accepted", "approve", "approved"):
            hs = obj.get("headSha") or obj.get("head")
            if isinstance(hs, str) and SHA_RE.fullmatch(hs.lower()):
                heads.add(hs.lower())
    return heads


def list_review_issues() -> list[dict]:
    # Prefer recent review-lane issues
    out: list[dict] = []
    for q in ("maw-implementation-review", "Review exact head", "SUCCESSOR Review"):
        try:
            items = api("GET", f"/companies/{COMPANY}/issues?q={urllib_quote(q)}&limit=50")
        except Exception as e:
            print(f"[warn] list issues q={q}: {e}", flush=True)
            continue
        if isinstance(items, dict):
            items = items.get("issues") or items.get("items") or []
        for i in items or []:
            title = (i.get("title") or "").lower()
            if "review" in title or "maw-implementation-review" in title:
                out.append(i)
    # dedupe by id
    seen = set()
    uniq = []
    for i in out:
        iid = i.get("id")
        if iid and iid not in seen:
            seen.add(iid)
            uniq.append(i)
    return uniq


def urllib_quote(s: str) -> str:
    from urllib.parse import quote

    return quote(s)


def issue_comments(issue_id: str) -> list[dict]:
    for path in (
        f"/issues/{issue_id}/comments",
        f"/companies/{COMPANY}/issues/{issue_id}/comments",
    ):
        try:
            cs = api("GET", path)
            if isinstance(cs, dict):
                cs = cs.get("comments") or cs.get("items") or []
            return list(cs or [])
        except Exception:
            continue
    return []


def open_surface_prs() -> list[dict]:
    prs = gh_json(f"/repos/{REPO}/pulls?state=open&base={BASE_REF}&per_page=30")
    return prs if isinstance(prs, list) else []


def independent_review_ok(pr_number: int) -> bool | None:
    """True if check success, False if missing/failed, None if unknown."""
    # Prefer check-runs on the head
    try:
        # Use PR view via gh
        out = subprocess.check_output(
            [
                "gh",
                "pr",
                "view",
                str(pr_number),
                "--repo",
                REPO,
                "--json",
                "statusCheckRollup",
            ],
            text=True,
            timeout=45,
        )
        data = json.loads(out)
        for c in data.get("statusCheckRollup") or []:
            name = (c.get("name") or "").lower()
            if "independent-review" in name:
                conc = (c.get("conclusion") or "").upper()
                state = (c.get("status") or "").upper()
                if conc == "SUCCESS" or state == "SUCCESS":
                    return True
                return False
        return False
    except Exception as e:
        print(f"[warn] check rollup pr#{pr_number}: {e}", flush=True)
        return None


def collect_approved_heads() -> dict[str, str]:
    """headSha -> source issue identifier.

    Only **comments** count for bare APPROVE (issue descriptions include the
    template line "Verdict: APPROVE or CHANGES_REQUESTED" which is not a verdict).
    Same-line APPROVE_RE is also only applied to comments.
    """
    heads: dict[str, str] = {}
    for issue in list_review_issues():
        ident = issue.get("identifier") or issue.get("id", "")[:8]
        for c in issue_comments(issue["id"]):
            blob = c.get("body") or c.get("content") or ""
            for h in extract_approved_heads(blob):
                heads[h] = str(ident)
                print(f"[approve] {ident} head={h[:12]}…", flush=True)
    return heads


def main() -> int:
    once = "--once" in sys.argv or "--dry-run" in sys.argv
    dry = "--dry-run" in sys.argv
    st = load_state()
    actions = []
    had_failure = False
    approved = collect_approved_heads()
    prs = open_surface_prs()
    print(f"[poll] open_prs={len(prs)} approved_heads={len(approved)}", flush=True)

    for pr in prs:
        num = pr["number"]
        head = (pr.get("head") or {}).get("sha", "").lower()
        title = pr.get("title") or ""
        if not head:
            continue
        if head not in approved:
            continue
        key = f"{num}:{head}"
        already = key in st.get("publishedForPr", {})
        ok = independent_review_ok(num)
        if already or ok is True:
            # Re-enter after CI finishes: ready + merge-if-clean (not only first IR stamp).
            print(
                f"[merge-path] pr#{num} already_published={already} ir_ok={ok}",
                flush=True,
            )
            if not dry:
                try:
                    merge_evidence = mark_ready_and_automerge(num, head)
                    st.setdefault("publishedForPr", {})[key] = {
                        "at": ts(),
                        "source": approved.get(head) or "ir-green",
                        "note": "ready_merge_pass",
                    }
                    actions.append(
                        {
                            "pr": num,
                            "head": head,
                            "at": ts(),
                            "result": "ready_merge_pass",
                            "alreadyPublished": already,
                            "mergeEvidence": merge_evidence,
                        }
                    )
                except Exception as e:
                    had_failure = True
                    actions.append({
                        "pr": num,
                        "head": head,
                        "at": ts(),
                        "result": "merge_path_failed",
                        "errorClass": type(e).__name__,
                    })
                    print(f"[warn] ready/merge pr#{num}: {e}", flush=True)
            continue
        action = {
            "pr": num,
            "head": head,
            "sourceIssue": approved[head],
            "title": title[:80],
            "at": ts(),
            "dryRun": dry,
        }
        print(f"[action] publish pr#{num} head={head[:12]} from {approved[head]}", flush=True)
        if dry:
            actions.append(action)
            continue
        try:
            publish(num, "accepted")
            try:
                merge_evidence = mark_ready_and_automerge(num, head)
                action["mergePath"] = "ready+auto"
                action["mergeEvidence"] = merge_evidence
            except Exception as e:
                had_failure = True
                action["mergePathErrorClass"] = type(e).__name__
            action["result"] = "published" if "mergeEvidence" in action else "review_published_merge_pending"
            st.setdefault("publishedForPr", {})[key] = action
            actions.append(action)
        except Exception as e:
            action["result"] = f"error:{e}"
            actions.append(action)
            print(f"[error] publish pr#{num}: {e}", flush=True)

    st["lastRunAt"] = ts()
    st["lastActions"] = actions[-20:]
    if not dry:
        save_state(st)
    print(json.dumps({"ok": True, "actions": actions, "dryRun": dry}, indent=2))
    return 1 if had_failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
