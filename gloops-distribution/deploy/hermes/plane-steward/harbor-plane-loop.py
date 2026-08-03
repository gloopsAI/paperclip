#!/usr/bin/env python3
"""Harbor plane loop — owns campaign reopen (standing auth, not Zach phrases).

Timer-driven oneshot (paperclip-harbor-plane-loop.timer, 5m):

  1. Probe campaign hours remaining from epoch / PAPERCLIP_CAMPAIGN_DEADLINE_AT
  2. If hours < 6 AND standing Harbor reopen auth present → invoke
     harbor-campaign-reopen.sh --execute --confirm-execute
  3. Else if an open residual assigned to Harbor / title markers with campaign
     codes → reopen for that issue
  4. Write receipt + JSONL

Authority bounds:
  - Harbor only (never from Sentinel)
  - Requires standing auth file (zach-standing-delegation)
  - maxAutoReopensPerDay enforced by harbor-campaign-reopen.sh
  - Never enable HEARTBEAT_SCHEDULER / multi-UUID READMIT
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

HERE = Path(__file__).resolve().parent

STATE_DIR = Path(
    os.environ.get(
        "HARBOR_PLANE_STATE_DIR",
        "/var/lib/paperclip-gloops/plane-steward",
    )
)
RECEIPT_PATH = Path(
    os.environ.get(
        "HARBOR_LOOP_RECEIPT",
        str(STATE_DIR / "harbor-loop-last.json"),
    )
)
LOG_PATH = Path(
    os.environ.get(
        "HARBOR_LOOP_LOG",
        "/var/log/paperclip-gloops/plane-steward/harbor-loop.jsonl",
    )
)
STANDING_AUTH = Path(
    os.environ.get(
        "HARBOR_REOPEN_STANDING_AUTH",
        "/var/lib/paperclip-gloops/campaign-deadman/standing/harbor-reopen-authorized.json",
    )
)
REOPEN_BIN = Path(
    os.environ.get(
        "HARBOR_CAMPAIGN_REOPEN_BIN",
        "/usr/local/lib/paperclip-gloops/bin/harbor-campaign-reopen.sh",
    )
)
# Prefer installed path; fall back to repo-relative for dry tests.
if not REOPEN_BIN.is_file():
    cand = HERE.parent / "bin" / "harbor-campaign-reopen.sh"
    if cand.is_file():
        REOPEN_BIN = cand

PREFLIGHT_BIN = Path(
    os.environ.get(
        "SDLC_PREFLIGHT_BIN",
        "/usr/local/lib/paperclip-gloops/bin/verify-induct-sdlc-preflight.sh",
    )
)
CAMPAIGN_DIR = Path(
    os.environ.get(
        "PAPERCLIP_CAMPAIGN_DEADMAN_DIR",
        "/var/lib/paperclip-gloops/campaign-deadman",
    )
)
RUNTIME_ENV = Path(
    os.environ.get("PAPERCLIP_RUNTIME_ENV", "/etc/paperclip-gloops/runtime.env")
)
API_BASE = os.environ.get("PAPERCLIP_API", "http://127.0.0.1:3100").rstrip("/")
API = API_BASE if API_BASE.endswith("/api") else API_BASE + "/api"
COMPANY_ID = os.environ.get(
    "PAPERCLIP_COMPANY_ID", "89ed0964-d918-4fcc-b830-5be49d2d4089"
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
REOPEN_HOURS = float(os.environ.get("HARBOR_REOPEN_HOURS", "6"))
TITLE_MARKERS = ("[Harbor/Campaign]", "[Sentinel/Plane]")


def ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def load_runtime_env(path: Path = RUNTIME_ENV) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip("\"'")
    except OSError:
        pass
    return out


def find_epoch(campaign_id: str | None) -> Path | None:
    if campaign_id:
        p = CAMPAIGN_DIR / campaign_id / "epoch.json"
        if p.is_file():
            return p
    if not CAMPAIGN_DIR.is_dir():
        return None
    for p in sorted(CAMPAIGN_DIR.glob("controlled-swarm-repair-cell-*/epoch.json")):
        return p
    for p in sorted(CAMPAIGN_DIR.glob("*/epoch.json")):
        return p
    return None


def hours_remaining() -> tuple[float | None, str | None, str | None]:
    """Return (hours, deadline_at, source)."""
    runtime = load_runtime_env()
    campaign_id = (
        os.environ.get("PAPERCLIP_CAMPAIGN_ID")
        or runtime.get("PAPERCLIP_CAMPAIGN_ID")
        or ""
    ).strip() or None
    deadline_at = None
    source = None
    epoch_path = find_epoch(campaign_id)
    if epoch_path and epoch_path.is_file():
        try:
            epoch = json.loads(epoch_path.read_text(encoding="utf-8"))
            deadline_at = epoch.get("deadlineAt")
            source = str(epoch_path)
        except (OSError, json.JSONDecodeError):
            pass
    if not deadline_at:
        deadline_at = os.environ.get("PAPERCLIP_CAMPAIGN_DEADLINE_AT") or runtime.get(
            "PAPERCLIP_CAMPAIGN_DEADLINE_AT"
        )
        if deadline_at:
            source = "PAPERCLIP_CAMPAIGN_DEADLINE_AT"
    if not deadline_at:
        return None, None, None
    try:
        deadline = parse_utc(str(deadline_at))
    except ValueError:
        return None, str(deadline_at), source
    hrs = (deadline - datetime.now(timezone.utc)).total_seconds() / 3600.0
    return hrs, str(deadline_at), source


def standing_auth_ok() -> tuple[bool, dict[str, Any] | None, str]:
    if not STANDING_AUTH.is_file():
        return False, None, f"missing standing auth: {STANDING_AUTH}"
    try:
        data = json.loads(STANDING_AUTH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return False, None, f"unreadable standing auth: {e}"
    if not isinstance(data, dict):
        return False, None, "standing auth not an object"
    if data.get("authorized") is not True:
        return False, data, "authorized != true"
    phrase = str(data.get("phrase") or "")
    if "OPEN CAMPAIGN" not in phrase.upper():
        return False, data, "phrase missing OPEN CAMPAIGN"
    return True, data, "ok"


def board_token(required: bool = True) -> str:
    env = (
        os.environ.get("PAPERCLIP_TOKEN")
        or os.environ.get("PAPERCLIP_BOARD_TOKEN")
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
        if required:
            raise SystemExit(f"no board token: {e}") from e
        return ""


def api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    url = API + (path if path.startswith("/") else "/" + path)
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
        err = e.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"API {method} {path} -> {e.code}: {err}") from e


def run_preflight_codes() -> tuple[list[str], list[str], dict[str, Any] | None]:
    if not PREFLIGHT_BIN.is_file():
        return [], [], None
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
                    crit = [c for c in (data.get("criticalCodes") or []) if c]
                    warn = [c for c in (data.get("warningCodes") or []) if c]
                    return crit, warn, data
            except json.JSONDecodeError:
                break
    return [], [], None


def find_harbor_residual() -> dict[str, Any] | None:
    if not board_token(required=False):
        return None
    try:
        data = api(
            "GET",
            f"/companies/{COMPANY_ID}/issues?status=todo,in_progress,blocked&q=Sentinel%2FPlane",
        )
    except Exception as e:  # noqa: BLE001
        print(f"WARN list issues: {e}", file=sys.stderr)
        data = None
    items: list[Any] = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("issues") or data.get("items") or []
    # also search Harbor/Campaign
    try:
        data2 = api(
            "GET",
            f"/companies/{COMPANY_ID}/issues?status=todo,in_progress,blocked&q=Harbor%2FCampaign",
        )
        items2 = data2 if isinstance(data2, list) else (
            (data2 or {}).get("issues") or (data2 or {}).get("items") or []
        )
        if isinstance(items2, list):
            items = list(items) + list(items2)
    except Exception as e:  # noqa: BLE001
        print(f"WARN list harbor issues: {e}", file=sys.stderr)

    open_statuses = {"todo", "in_progress", "blocked", "backlog", "open", "ready"}
    for issue in items:
        if not isinstance(issue, dict):
            continue
        title = str(issue.get("title") or "")
        if not any(m in title for m in TITLE_MARKERS):
            continue
        status = str(issue.get("status") or "").lower()
        if status not in open_statuses:
            continue
        desc = str(issue.get("description") or "")
        assignee = str(issue.get("assigneeAgentId") or "")
        campaignish = (
            "campaign." in desc
            or "deadline" in title.lower()
            or "Harbor/Campaign" in title
            or assignee == HARBOR_AGENT_ID
        )
        if campaignish:
            return issue
    return None


def invoke_reopen(
    *,
    dry_run: bool,
    issue_id: str | None,
    execute: bool,
) -> dict[str, Any]:
    if not REOPEN_BIN.is_file():
        return {
            "ok": False,
            "error": f"missing reopen bin: {REOPEN_BIN}",
        }
    cmd = ["bash", str(REOPEN_BIN)]
    if dry_run or not execute:
        cmd.append("--dry-run")
    else:
        cmd.extend(["--execute", "--confirm-execute"])
    if issue_id:
        cmd.extend(["--issue-id", issue_id])
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "command": cmd,
        "stdoutTail": (proc.stdout or "")[-3000:],
        "stderrTail": (proc.stderr or "")[-1500:],
    }


def write_receipt(receipt: dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        RECEIPT_PATH.write_text(
            json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    except OSError as e:
        print(f"WARN receipt: {e}", file=sys.stderr)


def append_log(record: dict[str, Any]) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError as e:
        print(f"WARN log: {e}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="Never execute reopen")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Attempt reopen even if hours > threshold (still needs residual or force)",
    )
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    hrs, deadline_at, source = hours_remaining()
    auth_ok, auth_data, auth_reason = standing_auth_ok()
    critical, warning, preflight = run_preflight_codes()
    campaign_critical = any(
        c.startswith("campaign.") or c == "campaign.deadline_lt_6h" for c in critical
    )
    residual = None
    try:
        residual = find_harbor_residual()
    except Exception as e:  # noqa: BLE001
        print(f"WARN residual lookup: {e}", file=sys.stderr)

    should_reopen = False
    reason = "not-needed"
    issue_id = residual.get("id") if residual else None

    if not auth_ok:
        reason = f"standing-auth-refuse: {auth_reason}"
    elif hrs is not None and hrs < REOPEN_HOURS:
        should_reopen = True
        reason = f"hours_remaining={hrs:.4f} < {REOPEN_HOURS}"
    elif campaign_critical and residual:
        should_reopen = True
        reason = f"residual+campaign critical issue={issue_id}"
    elif residual and any(
        x in str(residual.get("description") or "")
        for x in ("campaign.deadline", "campaign.missing_epoch", "deadline_lt")
    ):
        should_reopen = True
        reason = f"residual campaign codes issue={issue_id}"
    elif args.force and residual:
        should_reopen = True
        reason = "force+residual"
    else:
        reason = "not-needed"

    reopen_detail: dict[str, Any] | None = None
    if should_reopen and auth_ok:
        reopen_detail = invoke_reopen(
            dry_run=args.dry_run,
            issue_id=str(issue_id) if issue_id else None,
            execute=not args.dry_run,
        )
    elif should_reopen and not auth_ok:
        reopen_detail = {"ok": False, "skipped": True, "reason": reason}

    receipt = {
        "schemaVersion": "gloops.harbor-plane-loop.v1",
        "ts": ts(),
        "hoursRemaining": hrs,
        "deadlineAt": deadline_at,
        "deadlineSource": source,
        "standingAuthOk": auth_ok,
        "standingAuthReason": auth_reason,
        "standingAuthBy": (auth_data or {}).get("authorizedBy") if auth_data else None,
        "criticalCodes": critical,
        "warningCodes": warning,
        "shouldReopen": should_reopen,
        "reason": reason,
        "residualIssueId": issue_id,
        "reopen": reopen_detail,
        "bounds": {
            "neverEnableHeartbeatScheduler": True,
            "neverMultiUuidReadmit": True,
            "harborOwnsReopen": True,
            "requiresStandingAuth": True,
        },
        "dryRun": args.dry_run,
    }
    if not args.dry_run:
        write_receipt(receipt)
        append_log(receipt)
    print(json.dumps(receipt, indent=None if args.json else 2, sort_keys=True))
    if should_reopen and reopen_detail and not reopen_detail.get("ok") and not args.dry_run:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
