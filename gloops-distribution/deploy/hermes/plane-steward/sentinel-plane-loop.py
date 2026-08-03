#!/usr/bin/env python3
"""Sentinel plane loop — host-closed residual for Induct SDLC plane law.

Timer-driven oneshot (see paperclip-sentinel-plane-loop.timer):

  1. Run verify-induct-sdlc-preflight.sh (S0)
  2. Collect criticalCodes / warningCodes from PREFLIGHT_JSON
  3. Optional lease auto-apply (SENTINEL_AUTO_APPLY_LEASE default 1) when
     lease.dirty_or_missing or head-related codes — ONLY induct-lease-refresh
  4. If critical remain OR campaign hours < 12: upsert single residual GLO
     title prefix [Sentinel/Plane], dedupe by fingerprint + state file
  5. If all green and residual open: comment plane-green and cancel residual
  6. Write receipt + JSONL log

Authority bounds (hard):
  - Never enable HEARTBEAT_SCHEDULER
  - Never multi-UUID READMIT
  - Never open campaigns (Harbor owns reopen)
  - Lease auto-apply is the only mutating host recipe from this loop
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from plane_loop_helpers import (  # noqa: E402
    HARBOR_CODES,
    LEASE_AUTO_APPLY_CODES,
    OPEN_STATUSES,
    TITLE_PREFIX,
    assignee_for_codes,
    build_residual_description,
    build_residual_title,
    comment_rate_limited,
    fingerprint_codes,
    needs_residual,
    parse_hours,
    recommended_recipes_for,
    should_auto_apply_lease,
    ts,
    utc_now,
)

# ---------------------------------------------------------------------------
# Host / API integration
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
PREFLIGHT_BIN = Path(
    os.environ.get(
        "SDLC_PREFLIGHT_BIN",
        "/usr/local/lib/paperclip-gloops/bin/verify-induct-sdlc-preflight.sh",
    )
)
REFRESH_BIN = Path(
    os.environ.get(
        "REFRESH_INDUCT_LEASE_BIN",
        "/usr/local/lib/paperclip-gloops/bin/refresh-induct-lease.py",
    )
)
STATE_DIR = Path(
    os.environ.get(
        "SENTINEL_PLANE_STATE_DIR",
        "/var/lib/paperclip-gloops/plane-steward",
    )
)
STATE_PATH = Path(
    os.environ.get(
        "SENTINEL_LOOP_STATE",
        str(STATE_DIR / "sentinel-loop-state.json"),
    )
)
RECEIPT_PATH = Path(
    os.environ.get(
        "SENTINEL_LOOP_RECEIPT",
        str(STATE_DIR / "sentinel-loop-last.json"),
    )
)
LOG_PATH = Path(
    os.environ.get(
        "SENTINEL_LOOP_LOG",
        "/var/log/paperclip-gloops/plane-steward/sentinel-loop.jsonl",
    )
)
API_BASE = os.environ.get("PAPERCLIP_API", "http://127.0.0.1:3100").rstrip("/")
if API_BASE.endswith("/api"):
    API_ORIGIN = API_BASE[: -len("/api")]
    API = API_BASE
else:
    API_ORIGIN = API_BASE
    API = API_BASE + "/api"

COMPANY_ID = os.environ.get(
    "PAPERCLIP_COMPANY_ID", "89ed0964-d918-4fcc-b830-5be49d2d4089"
)
PROJECT_ID = os.environ.get(
    "PAPERCLIP_PLANE_PROJECT_ID",
    os.environ.get("INDUCT_LEASE_PROJECT_ID", "cfca4683-e256-40e0-91b3-f2e513170ec0"),
)
SENTINEL_AGENT_ID = os.environ.get(
    "PAPERCLIP_SENTINEL_AGENT_ID", "32de720b-4231-45f3-9322-aa5da3d9f44d"
)
HARBOR_AGENT_ID = os.environ.get(
    "PAPERCLIP_HARBOR_AGENT_ID", "a3a1cb4c-390a-4d40-9a88-8609183ed012"
)
TOKEN_FILE = Path(
    os.environ.get(
        "PAPERCLIP_BOARD_TOKEN_FILE",
        "/etc/paperclip-gloops/operator-board-token",
    )
)
# SENTINEL_AUTO_APPLY_LEASE default **1** (document in SENTINEL_HARBOR_PLANE_LOOPS.md)
AUTO_APPLY_LEASE = os.environ.get("SENTINEL_AUTO_APPLY_LEASE", "1").strip().lower() in (
    "1",
    "true",
    "yes",
)
RESIDUAL_HOURS = float(os.environ.get("SENTINEL_RESIDUAL_HOURS", "12"))
COMMENT_MIN_INTERVAL = int(os.environ.get("SENTINEL_COMMENT_MIN_INTERVAL_SEC", "1800"))


def board_token() -> str:
    env = (
        os.environ.get("PAPERCLIP_TOKEN")
        or os.environ.get("PAPERCLIP_BOARD_TOKEN")
        or os.environ.get("PAPERCLIP_API_TOKEN")
        or ""
    ).strip()
    if env:
        return env
    if TOKEN_FILE.is_file():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    try:
        return subprocess.check_output(
            ["sudo", "-n", "cat", str(TOKEN_FILE)], text=True
        ).strip()
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"no board token: {e}") from e


def api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    url = path if path.startswith("http") else API + (path if path.startswith("/") else "/" + path)
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + board_token(),
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read()
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"API {method} {path} -> {e.code}: {err}") from e


def run_preflight() -> dict[str, Any]:
    if not PREFLIGHT_BIN.is_file():
        return {
            "schemaVersion": "gloops.sdlc-preflight.v1",
            "ok": False,
            "criticalCodes": ["sdlc.preflight_bin_missing"],
            "warningCodes": [],
            "codes": ["sdlc.preflight_bin_missing"],
            "error": f"missing {PREFLIGHT_BIN}",
        }
    proc = subprocess.run(
        ["bash", str(PREFLIGHT_BIN)],
        text=True,
        capture_output=True,
        check=False,
    )
    for line in (proc.stdout or "").splitlines():
        if line.startswith("PREFLIGHT_JSON="):
            try:
                data = json.loads(line[len("PREFLIGHT_JSON=") :])
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError:
                break
    return {
        "schemaVersion": "gloops.sdlc-preflight.v1",
        "ok": False,
        "criticalCodes": ["sdlc.preflight_parse_failed"],
        "warningCodes": [],
        "codes": ["sdlc.preflight_parse_failed"],
        "returncode": proc.returncode,
        "stdoutTail": (proc.stdout or "")[-1500:],
        "stderrTail": (proc.stderr or "")[-800:],
    }


def try_auto_apply_lease(critical: list[str], warning: list[str]) -> dict[str, Any]:
    detail: dict[str, Any] = {
        "enabled": AUTO_APPLY_LEASE,
        "eligible": should_auto_apply_lease(critical, warning),
        "applied": False,
    }
    if not AUTO_APPLY_LEASE:
        detail["reason"] = "SENTINEL_AUTO_APPLY_LEASE off"
        return detail
    if not should_auto_apply_lease(critical, warning):
        detail["reason"] = "no lease/head codes"
        return detail
    if not REFRESH_BIN.is_file():
        detail["reason"] = f"missing {REFRESH_BIN}"
        return detail
    # Only this recipe — never chain other mutators from Sentinel.
    proc = subprocess.run(
        ["python3", str(REFRESH_BIN), "--apply", "--only-if-stale"],
        text=True,
        capture_output=True,
        check=False,
    )
    detail["applied"] = proc.returncode == 0
    detail["command"] = "refresh-induct-lease.py --apply --only-if-stale"
    detail["returncode"] = proc.returncode
    detail["stdoutTail"] = (proc.stdout or "")[-2000:]
    detail["stderrTail"] = (proc.stderr or "")[-1000:]
    return detail


def load_state() -> dict[str, Any]:
    if not STATE_PATH.is_file():
        return {
            "schemaVersion": "gloops.sentinel-plane-loop-state.v1",
            "issueId": None,
            "fingerprint": None,
            "lastCommentAt": None,
        }
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("schemaVersion", "gloops.sentinel-plane-loop-state.v1")
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {
        "schemaVersion": "gloops.sentinel-plane-loop-state.v1",
        "issueId": None,
        "fingerprint": None,
        "lastCommentAt": None,
    }


def save_state(state: dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(
            json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    except OSError as e:
        print(f"WARN could not write state: {e}", file=sys.stderr)


def write_receipt(receipt: dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        RECEIPT_PATH.write_text(
            json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    except OSError as e:
        print(f"WARN could not write receipt: {e}", file=sys.stderr)


def append_log(record: dict[str, Any]) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError as e:
        print(f"WARN could not append log: {e}", file=sys.stderr)


def get_issue(issue_id: str) -> dict[str, Any] | None:
    try:
        data = api("GET", f"/issues/{issue_id}")
        return data if isinstance(data, dict) else None
    except Exception as e:  # noqa: BLE001
        print(f"WARN get issue {issue_id}: {e}", file=sys.stderr)
        return None


def issue_is_open(issue: dict[str, Any] | None) -> bool:
    if not issue:
        return False
    status = str(issue.get("status") or "").lower()
    return status in OPEN_STATUSES


def find_open_sentinel_residual() -> dict[str, Any] | None:
    """Find an open residual with title prefix [Sentinel/Plane]."""
    try:
        data = api(
            "GET",
            f"/companies/{COMPANY_ID}/issues?status=todo,in_progress,blocked&q=Sentinel%2FPlane",
        )
    except Exception as e:  # noqa: BLE001
        print(f"WARN list issues: {e}", file=sys.stderr)
        return None
    items = data if isinstance(data, list) else (data.get("issues") or data.get("items") or [])
    if not isinstance(items, list):
        return None
    for issue in items:
        if not isinstance(issue, dict):
            continue
        title = str(issue.get("title") or "")
        if TITLE_PREFIX in title and issue_is_open(issue):
            return issue
    return None


def create_residual(
    *,
    title: str,
    description: str,
    assignee_agent_id: str,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "title": title,
        "description": description,
        "status": "todo",
        "priority": "high",
        "assigneeAgentId": assignee_agent_id,
    }
    if PROJECT_ID:
        body["projectId"] = PROJECT_ID
    created = api("POST", f"/companies/{COMPANY_ID}/issues", body)
    if not isinstance(created, dict) or not created.get("id"):
        raise RuntimeError(f"create issue returned unexpected payload: {created!r}")
    return created


def comment_issue(issue_id: str, body: str) -> None:
    api("POST", f"/issues/{issue_id}/comments", {"body": body})


def cancel_issue(issue_id: str, comment: str) -> None:
    # Prefer cancelled; fall back to done if API rejects cancelled.
    try:
        api(
            "PATCH",
            f"/issues/{issue_id}",
            {"status": "cancelled", "comment": comment},
        )
        return
    except Exception:
        pass
    api("PATCH", f"/issues/{issue_id}", {"status": "done", "comment": comment})


def reassign_issue(issue_id: str, agent_id: str) -> None:
    try:
        api("PATCH", f"/issues/{issue_id}", {"assigneeAgentId": agent_id})
    except Exception as e:  # noqa: BLE001
        print(f"WARN reassign {issue_id}: {e}", file=sys.stderr)


def agent_id_for_role(role: str) -> str:
    return HARBOR_AGENT_ID if role == "harbor" else SENTINEL_AGENT_ID


def upsert_residual(
    *,
    state: dict[str, Any],
    critical: list[str],
    warning: list[str],
    hours_remaining: float | None,
    preflight: dict[str, Any],
    fingerprint: str,
    dry_run: bool,
) -> dict[str, Any]:
    role = assignee_for_codes(critical, warning)
    assignee = agent_id_for_role(role)
    recipes = recommended_recipes_for(critical, warning)
    title = build_residual_title(critical, hours_remaining)
    description = build_residual_description(
        critical=critical,
        warning=warning,
        hours_remaining=hours_remaining,
        preflight=preflight,
        recipes=recipes,
        fingerprint=fingerprint,
    )
    out: dict[str, Any] = {
        "action": None,
        "role": role,
        "assigneeAgentId": assignee,
        "fingerprint": fingerprint,
        "issueId": state.get("issueId"),
        "recipes": recipes,
        "title": title,
    }

    if dry_run:
        same_fp = state.get("fingerprint") == fingerprint and bool(state.get("issueId"))
        out["action"] = "dry-run-update" if same_fp else "dry-run-create"
        return out

    issue_id = state.get("issueId")
    issue = get_issue(issue_id) if issue_id else None
    if not issue_is_open(issue):
        # try recover by title search
        found = find_open_sentinel_residual()
        if found:
            issue = found
            issue_id = found.get("id")
            state["issueId"] = issue_id
        else:
            issue = None
            issue_id = None

    same_fp = state.get("fingerprint") == fingerprint and issue_is_open(issue)

    if same_fp and issue_id:
        out["action"] = "comment-update"
        if comment_rate_limited(state.get("lastCommentAt"), min_interval_sec=COMMENT_MIN_INTERVAL):
            out["commentSkipped"] = "rate-limited"
            return out
        comment_issue(
            str(issue_id),
            (
                f"{TITLE_PREFIX} residual still open — same fingerprint `{fingerprint}`.\n\n"
                f"criticalCodes={json.dumps(critical)}\n"
                f"warningCodes={json.dumps(warning)}\n"
                f"hoursRemaining={hours_remaining}\n"
                f"recommendedRecipes={json.dumps(recipes)}\n"
                "Do not page Zach."
            ),
        )
        state["lastCommentAt"] = ts()
        # keep assignee aligned with codes
        reassign_issue(str(issue_id), assignee)
        return out

    if issue_is_open(issue) and issue_id:
        # fingerprint changed — update description via comment + reassign
        out["action"] = "fingerprint-changed-update"
        comment_issue(
            str(issue_id),
            (
                f"{TITLE_PREFIX} fingerprint changed → `{fingerprint}`\n\n"
                f"{description}"
            ),
        )
        reassign_issue(str(issue_id), assignee)
        try:
            api(
                "PATCH",
                f"/issues/{issue_id}",
                {"title": title, "description": description},
            )
        except Exception as e:  # noqa: BLE001
            print(f"WARN patch residual: {e}", file=sys.stderr)
        state["fingerprint"] = fingerprint
        state["lastCommentAt"] = ts()
        state["issueId"] = issue_id
        return out

    # create new
    created = create_residual(
        title=title, description=description, assignee_agent_id=assignee
    )
    out["action"] = "created"
    out["issueId"] = created.get("id")
    state["issueId"] = created.get("id")
    state["fingerprint"] = fingerprint
    state["lastCommentAt"] = ts()
    state["createdAt"] = ts()
    return out


def clear_residual_if_green(
    *,
    state: dict[str, Any],
    dry_run: bool,
) -> dict[str, Any]:
    out: dict[str, Any] = {"action": None, "issueId": state.get("issueId")}
    if dry_run:
        out["action"] = (
            "dry-run-cancel" if state.get("issueId") else "dry-run-no-open-residual"
        )
        return out
    issue_id = state.get("issueId")
    issue = get_issue(issue_id) if issue_id else None
    if not issue_is_open(issue):
        found = find_open_sentinel_residual()
        if found:
            issue = found
            issue_id = found.get("id")
            state["issueId"] = issue_id
        else:
            out["action"] = "no-open-residual"
            state["fingerprint"] = None
            return out
    assert issue_id
    comment = (
        f"{TITLE_PREFIX} plane green — preflight criticalCodes empty and "
        f"campaign hours healthy. Cancelling residual. Do not page Zach."
    )
    try:
        comment_issue(str(issue_id), comment)
    except Exception as e:  # noqa: BLE001
        print(f"WARN green comment: {e}", file=sys.stderr)
    try:
        cancel_issue(str(issue_id), comment)
        out["action"] = "cancelled-green"
    except Exception as e:  # noqa: BLE001
        out["action"] = "cancel-failed"
        out["error"] = str(e)
    state["fingerprint"] = None
    state["lastCommentAt"] = ts()
    state["clearedAt"] = ts()
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Run preflight + decide residual actions without board writes or lease apply",
    )
    ap.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Use last preflight JSON only (tests / recovery)",
    )
    ap.add_argument(
        "--preflight-json",
        type=Path,
        help="Load preflight from file instead of running S0",
    )
    ap.add_argument("--json", action="store_true", help="Print receipt JSON only")
    args = ap.parse_args(argv)

    state = load_state()
    preflight: dict[str, Any]
    if args.preflight_json and args.preflight_json.is_file():
        preflight = json.loads(args.preflight_json.read_text(encoding="utf-8"))
    elif args.skip_preflight:
        last = Path(
            os.environ.get(
                "SDLC_PREFLIGHT_LAST_JSON",
                "/var/lib/paperclip-gloops/sdlc-preflight/last.json",
            )
        )
        if last.is_file():
            preflight = json.loads(last.read_text(encoding="utf-8"))
        else:
            preflight = run_preflight()
    else:
        preflight = run_preflight()

    critical = [c for c in (preflight.get("criticalCodes") or []) if c]
    warning = [c for c in (preflight.get("warningCodes") or []) if c]
    campaign = preflight.get("campaign") if isinstance(preflight.get("campaign"), dict) else {}
    hours = parse_hours(campaign.get("hoursRemaining") if campaign else None)
    if hours is None:
        hours = parse_hours(os.environ.get("PAPERCLIP_CAMPAIGN_HOURS_REMAINING"))

    lease_detail: dict[str, Any] = {"skipped": True, "reason": "dry-run"}
    if not args.dry_run:
        lease_detail = try_auto_apply_lease(critical, warning)
        # Re-run preflight after lease apply so residual reflects post-apply state
        if lease_detail.get("applied"):
            preflight = run_preflight()
            critical = [c for c in (preflight.get("criticalCodes") or []) if c]
            warning = [c for c in (preflight.get("warningCodes") or []) if c]
            campaign = (
                preflight.get("campaign")
                if isinstance(preflight.get("campaign"), dict)
                else {}
            )
            hours = parse_hours(campaign.get("hoursRemaining") if campaign else None)

    fp = fingerprint_codes(
        critical,
        warning,
        hours_remaining=hours,
        residual_hours_threshold=RESIDUAL_HOURS,
    )
    residual_needed = needs_residual(
        critical, hours, residual_hours_threshold=RESIDUAL_HOURS
    )

    residual_action: dict[str, Any]
    if residual_needed:
        residual_action = upsert_residual(
            state=state,
            critical=critical,
            warning=warning,
            hours_remaining=hours,
            preflight=preflight,
            fingerprint=fp,
            dry_run=args.dry_run,
        )
    else:
        residual_action = clear_residual_if_green(state=state, dry_run=args.dry_run)

    if not args.dry_run:
        save_state(state)

    receipt = {
        "schemaVersion": "gloops.sentinel-plane-loop.v1",
        "ts": ts(),
        "ok": bool(preflight.get("ok")) and not residual_needed,
        "preflightOk": bool(preflight.get("ok")),
        "criticalCodes": critical,
        "warningCodes": warning,
        "hoursRemaining": hours,
        "fingerprint": fp,
        "residualNeeded": residual_needed,
        "autoApplyLease": AUTO_APPLY_LEASE,
        "lease": lease_detail,
        "residual": residual_action,
        "stateIssueId": state.get("issueId"),
        "bounds": {
            "neverEnableHeartbeatScheduler": True,
            "neverMultiUuidReadmit": True,
            "neverOpenCampaignFromSentinel": True,
            "leaseAutoApplyOnlyRecipe": "induct-lease-refresh",
        },
        "agents": {
            "sentinel": SENTINEL_AGENT_ID,
            "harbor": HARBOR_AGENT_ID,
        },
        "dryRun": args.dry_run,
    }
    if not args.dry_run:
        write_receipt(receipt)
        append_log(receipt)

    print(json.dumps(receipt, indent=None if args.json else 2, sort_keys=True))
    # Exit 0 even when residual needed — loop itself succeeded; residual is the signal.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
