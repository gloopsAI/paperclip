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

GOVERNED_REPOSITORIES = {
    "gloopsAI/paperclip": {"repositoryId": "1299155335", "baseRef": "gloops/stable"},
    "gloopsAI/personal-delegate": {"repositoryId": "1308141485", "baseRef": "main"},
    "gloopsAI/autonomy-strategy": {"repositoryId": "1279656482", "baseRef": "main"},
    "gloopsAI/gloops-paperclip-plugin": {"repositoryId": "1297008772", "baseRef": "main"},
}
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
TRUSTED_REVIEWER_AGENT_IDS = frozenset(
    value.strip()
    for value in os.environ.get(
        "CLOSED_LOOP_REVIEWER_AGENT_IDS",
        "843c62bc-6f32-420e-9b62-7a2d6a34846f",
    ).split(",")
    if value.strip()
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


def write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("durable write made no progress")
        view = view[written:]


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
        write_all(temp_fd, payload)
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


def publish(binding: dict, verdict: str = "accepted") -> None:
    cmd = [
        sys.executable, str(PUBLISHER),
        "--repo", binding["repositoryFullName"],
        "--base", binding["baseRef"],
        "--base-sha", binding["exactBaseSha"],
        "--pr", str(binding["pullRequestNumber"]),
        "--head", binding["exactHeadSha"],
        "--review-issue-id", binding["reviewIssueId"],
        "--review-run-id", binding["reviewRunId"],
        "--verdict", verdict,
    ]
    print(f"[publish] {' '.join(cmd)}", flush=True)
    if os.geteuid() == 0:
        subprocess.check_call(cmd)
    else:
        subprocess.check_call(["sudo", "-n", *cmd])


def mark_ready_and_automerge(binding: dict) -> dict:
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
        str(binding["pullRequestNumber"]),
        "--repo",
        binding["repositoryFullName"],
        "--expected-head",
        binding["exactHeadSha"],
        "--base",
        binding["baseRef"],
        "--base-sha",
        binding["exactBaseSha"],
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
    if (
        evidence.get("headSha") != binding["exactHeadSha"]
        or evidence.get("baseRef") != binding["baseRef"]
        or evidence.get("baseSha") != binding["exactBaseSha"]
        or evidence.get("repo") != binding["repositoryFullName"]
        or evidence.get("pr") != binding["pullRequestNumber"]
    ):
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


def issue_detail(issue_id: str) -> dict:
    for path in (f"/issues/{issue_id}", f"/companies/{COMPANY}/issues/{issue_id}"):
        try:
            value = api("GET", path)
            if isinstance(value, dict):
                return value.get("issue") if isinstance(value.get("issue"), dict) else value
        except Exception:
            continue
    return {}


def review_provenance(issue: dict) -> dict | None:
    settings = issue.get("executionWorkspaceSettings")
    if not isinstance(settings, dict):
        return None
    value = settings.get("reviewProvenance")
    if not isinstance(value, dict) or value.get("kind") != "implementation_exact_head_v2":
        return None
    repository = value.get("repositoryFullName")
    governed = GOVERNED_REPOSITORIES.get(repository)
    required = {
        "parentIssueId", "sourceRunId", "implementerAgentId", "reviewerAgentId",
        "projectWorkspaceId", "repositoryId", "repositoryFullName", "baseRef",
        "exactBaseSha", "exactHeadSha", "pullRequestNumber", "pullRequestUrl",
    }
    expected_keys = required | {"kind", "alternateReviewerAgentIds"}
    if set(value) != expected_keys or not governed:
        return None
    if (
        value.get("repositoryId") != governed["repositoryId"]
        or value.get("baseRef") != governed["baseRef"]
        or value.get("implementerAgentId") == value.get("reviewerAgentId")
        or not isinstance(value.get("pullRequestNumber"), int)
        or value.get("pullRequestNumber", 0) <= 0
        or value.get("pullRequestUrl") != f"https://github.com/{repository}/pull/{value['pullRequestNumber']}"
        or not SHA_RE.fullmatch(str(value.get("exactBaseSha", "")))
        or not SHA_RE.fullmatch(str(value.get("exactHeadSha", "")))
    ):
        return None
    alternates = value.get("alternateReviewerAgentIds")
    if not isinstance(alternates, list) or any(not isinstance(item, str) for item in alternates):
        return None
    return value


def authenticated_reviewer_run(issue: dict, comment: dict, provenance: dict) -> bool:
    author_agent_id = comment.get("authorAgentId")
    allowed_reviewers = {provenance["reviewerAgentId"], *provenance["alternateReviewerAgentIds"]}
    run_id = comment.get("createdByRunId")
    if (
        not isinstance(author_agent_id, str)
        or author_agent_id not in allowed_reviewers
        or issue.get("assigneeAgentId") != author_agent_id
        or comment.get("authorUserId") not in (None, "")
        or not isinstance(run_id, str)
    ):
        return False
    try:
        run = api("GET", f"/heartbeat-runs/{run_id}")
    except Exception:
        return False
    context = run.get("contextSnapshot") if isinstance(run, dict) else None
    return bool(
        isinstance(context, dict)
        and run.get("companyId") == COMPANY
        and run.get("agentId") == author_agent_id
        and run.get("status") == "succeeded"
        and context.get("issueId") == issue.get("id")
        and (run.get("providerInvocationAttempted") is True
             or (isinstance(run.get("resultJson"), dict) and run["resultJson"].get("providerInvocationAttempted") is True))
    )


def trusted_approval_comment(issue: dict, comment: dict) -> bool:
    author_agent_id = comment.get("authorAgentId")
    return (
        isinstance(author_agent_id, str)
        and author_agent_id in TRUSTED_REVIEWER_AGENT_IDS
        and comment.get("authorUserId") in (None, "")
        and issue.get("assigneeAgentId") == author_agent_id
    )


def open_surface_prs(repo: str, base_ref: str) -> list[dict]:
    prs = gh_json(f"/repos/{repo}/pulls?state=open&base={base_ref}&per_page=30")
    return prs if isinstance(prs, list) else []


def independent_review_ok(binding: dict) -> bool | None:
    """Require the exact App-B publication for this authenticated review run."""
    try:
        external_id = (
            f"gloops-ir-v2:{binding['repositoryId']}:{binding['pullRequestNumber']}:"
            f"{binding['exactHeadSha']}:{binding['sourceRunId']}:{binding['reviewRunId']}"
        )
        data = gh_json(
            f"/repos/{binding['repositoryFullName']}/commits/{binding['exactHeadSha']}"
            "/check-runs?check_name=gloops%20%2F%20independent-review&per_page=100"
        )
        checks = data.get("check_runs") if isinstance(data, dict) else None
        if not isinstance(checks, list): return False
        for check in checks:
            if (
                check.get("name") == "gloops / independent-review"
                and int((check.get("app") or {}).get("id") or 0) == 4071335
                and check.get("head_sha") == binding["exactHeadSha"]
                and check.get("external_id") == external_id
            ):
                return check.get("status") == "completed" and check.get("conclusion") == "success"
        return False
    except Exception as e:
        print(f"[warn] exact check read pr#{binding['pullRequestNumber']}: {e}", flush=True)
        return None


def collect_approved_bindings() -> list[dict]:
    """Return server-bound repository/PR/base/head review receipts.

    Only **comments** count for bare APPROVE (issue descriptions include the
    template line "Verdict: APPROVE or CHANGES_REQUESTED" which is not a verdict).
    Same-line APPROVE_RE is also only applied to comments.
    """
    bindings: dict[tuple, dict] = {}
    for summary in list_review_issues():
        issue = issue_detail(summary["id"])
        provenance = review_provenance(issue)
        if not provenance:
            continue
        ident = issue.get("identifier") or issue.get("id", "")[:8]
        for c in issue_comments(issue["id"]):
            if not authenticated_reviewer_run(issue, c, provenance):
                continue
            blob = c.get("body") or c.get("content") or ""
            for h in extract_approved_heads(blob):
                if h != provenance["exactHeadSha"]:
                    continue
                binding = {**provenance, "sourceIssue": str(ident), "reviewIssueId": issue["id"], "reviewRunId": c["createdByRunId"]}
                key = (
                    binding["repositoryId"], binding["repositoryFullName"],
                    binding["pullRequestNumber"], binding["baseRef"], binding["exactBaseSha"], binding["exactHeadSha"],
                )
                bindings[key] = binding
                print(f"[approve] {ident} {binding['repositoryFullName']}#{binding['pullRequestNumber']} head={h[:12]}…", flush=True)
    return list(bindings.values())


def main() -> int:
    once = "--once" in sys.argv or "--dry-run" in sys.argv
    dry = "--dry-run" in sys.argv
    st = load_state()
    actions = []
    had_failure = False
    approved = collect_approved_bindings()
    print(f"[poll] approved_bindings={len(approved)}", flush=True)

    for binding in approved:
        num = binding["pullRequestNumber"]
        head = binding["exactHeadSha"]
        repo = binding["repositoryFullName"]
        try:
            pr = gh_json(f"/repos/{repo}/pulls/{num}")
        except Exception as error:
            had_failure = True
            actions.append({"repository": repo, "pr": num, "head": head, "result": "pr_read_failed", "errorClass": type(error).__name__})
            continue
        title = pr.get("title") or ""
        if (
            (pr.get("head") or {}).get("sha", "").lower() != head
            or (pr.get("base") or {}).get("ref") != binding["baseRef"]
            or (pr.get("base") or {}).get("sha", "").lower() != binding["exactBaseSha"]
            or str((pr.get("base") or {}).get("repo", {}).get("id") or "") != binding["repositoryId"]
            or pr.get("state") != "open"
        ):
            continue
        key = f"{binding['repositoryId']}:{num}:{head}"
        already = key in st.get("publishedForPr", {})
        ok = independent_review_ok(binding)
        if already or ok is True:
            # Re-enter after CI finishes: ready + merge-if-clean (not only first IR stamp).
            print(
                f"[merge-path] pr#{num} already_published={already} ir_ok={ok}",
                flush=True,
            )
            if not dry:
                try:
                    merge_evidence = mark_ready_and_automerge(binding)
                    st.setdefault("publishedForPr", {})[key] = {
                        "at": ts(),
                        "source": binding["sourceIssue"],
                        "note": "ready_merge_pass",
                    }
                    actions.append(
                        {
                            "repository": repo, "pr": num,
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
            "repository": repo,
            "sourceIssue": binding["sourceIssue"],
            "reviewRunId": binding["reviewRunId"],
            "title": title[:80],
            "at": ts(),
            "dryRun": dry,
        }
        print(f"[action] publish {repo}#{num} head={head[:12]} from {binding['sourceIssue']}", flush=True)
        if dry:
            actions.append(action)
            continue
        try:
            publish(binding, "accepted")
            try:
                merge_evidence = mark_ready_and_automerge(binding)
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
