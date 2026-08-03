#!/usr/bin/env python3
"""S5 — Campaign T−4h alert (once per epoch).

Reads campaign epoch deadline under /var/lib/paperclip-gloops/campaign-deadman/.
If hours remaining is in (0, 4), emit alert once per epoch id.

Channels (best-effort; missing channels do not fail):
  1) logger + append alerts.jsonl under sdlc-preflight state dir
  2) Slack when PAPERCLIP_SUBSTRATE_SLACK_CHANNEL + SLACK_BOT_TOKEN available
  3) board/paperclip skip unless trivial

Never renews or opens a campaign.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_DIR = Path(
    os.environ.get(
        "SDLC_PREFLIGHT_STATE_DIR",
        "/var/lib/paperclip-gloops/sdlc-preflight",
    )
)
ALERT_STATE = STATE_DIR / "campaign-alert-state.json"
ALERTS_JSONL = STATE_DIR / "alerts.jsonl"
CAMPAIGN_DIR = Path(
    os.environ.get(
        "PAPERCLIP_CAMPAIGN_DEADMAN_DIR",
        "/var/lib/paperclip-gloops/campaign-deadman",
    )
)
RUNTIME_ENV = Path(
    os.environ.get("PAPERCLIP_RUNTIME_ENV", "/etc/paperclip-gloops/runtime.env")
)
ALERT_HOURS = float(os.environ.get("SDLC_CAMPAIGN_ALERT_HOURS", "4"))


def ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def parse_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def find_epoch(campaign_id: str | None) -> Path | None:
    if campaign_id:
        p = CAMPAIGN_DIR / campaign_id / "epoch.json"
        if p.is_file():
            return p
    if not CAMPAIGN_DIR.is_dir():
        return None
    for p in sorted(CAMPAIGN_DIR.glob("controlled-swarm-repair-cell-*/epoch.json")):
        if campaign_id:
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if data.get("campaignId") == campaign_id:
                    return p
            except (OSError, json.JSONDecodeError):
                continue
        else:
            return p
    # any epoch as last resort
    for p in sorted(CAMPAIGN_DIR.glob("*/epoch.json")):
        return p
    return None


def load_state() -> dict[str, Any]:
    if not ALERT_STATE.is_file():
        return {"schemaVersion": "gloops.campaign-alert-state.v1", "alertedEpochs": {}}
    try:
        data = json.loads(ALERT_STATE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("alertedEpochs", {})
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"schemaVersion": "gloops.campaign-alert-state.v1", "alertedEpochs": {}}


def save_state(state: dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        ALERT_STATE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError as e:
        print(f"WARN could not write alert state: {e}", file=sys.stderr)


def append_alert(record: dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with ALERTS_JSONL.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError as e:
        print(f"WARN could not append alerts.jsonl: {e}", file=sys.stderr)


def slack_token() -> str:
    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    if token:
        return token
    for p in (
        Path("/etc/paperclip-gloops/communications.env"),
        Path("/var/lib/paperclip-gloops/communications.env"),
    ):
        try:
            if p.is_file():
                for line in p.read_text(encoding="utf-8").splitlines():
                    if line.startswith("SLACK_BOT_TOKEN="):
                        return line.split("=", 1)[1].strip().strip("\"'")
        except OSError:
            continue
    return ""


def notify_slack(text: str) -> None:
    channel = os.environ.get("PAPERCLIP_SUBSTRATE_SLACK_CHANNEL", "").strip()
    token = slack_token()
    if not channel or not token:
        print("slack notify skipped (missing channel or token)", file=sys.stderr)
        return
    try:
        req = urllib.request.Request(
            "https://slack.com/api/chat.postMessage",
            data=json.dumps({"channel": channel, "text": text}).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        print("slack notify", "ok" if data.get("ok") else data.get("error"))
    except Exception as e:  # noqa: BLE001 — best-effort
        print(f"WARN slack: {e}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Write state + send notifications (default dry-run prints only)",
    )
    ap.add_argument("--force", action="store_true", help="Ignore once-per-epoch state")
    args = ap.parse_args(argv)

    runtime = load_runtime_env()
    campaign_id = (
        os.environ.get("PAPERCLIP_CAMPAIGN_ID")
        or runtime.get("PAPERCLIP_CAMPAIGN_ID")
        or ""
    ).strip() or None

    epoch_path = find_epoch(campaign_id)
    deadline_at = None
    epoch_sha = None
    if epoch_path and epoch_path.is_file():
        try:
            epoch = json.loads(epoch_path.read_text(encoding="utf-8"))
            deadline_at = epoch.get("deadlineAt")
            campaign_id = campaign_id or epoch.get("campaignId")
            epoch_sha = epoch.get("epochSha256")
        except (OSError, json.JSONDecodeError) as e:
            print(f"epoch unreadable: {e}", file=sys.stderr)
            return 0
    elif os.environ.get("PAPERCLIP_CAMPAIGN_DEADLINE_AT") or runtime.get(
        "PAPERCLIP_CAMPAIGN_DEADLINE_AT"
    ):
        deadline_at = os.environ.get("PAPERCLIP_CAMPAIGN_DEADLINE_AT") or runtime.get(
            "PAPERCLIP_CAMPAIGN_DEADLINE_AT"
        )
    else:
        print("no campaign epoch/deadline; nothing to alert")
        return 0

    if not deadline_at:
        print("no deadlineAt; nothing to alert")
        return 0

    try:
        deadline = parse_utc(str(deadline_at))
    except ValueError as e:
        print(f"bad deadline: {e}", file=sys.stderr)
        return 0

    now = datetime.now(timezone.utc)
    hours = (deadline - now).total_seconds() / 3600.0
    print(f"campaign={campaign_id} hours_remaining={hours:.4f} deadline={deadline_at}")

    if hours <= 0 or hours >= ALERT_HOURS:
        print(f"outside alert window (0, {ALERT_HOURS}); no alert")
        return 0

    epoch_key = str(epoch_sha or campaign_id or deadline_at)
    state = load_state()
    if not args.force and epoch_key in (state.get("alertedEpochs") or {}):
        print(f"already alerted for epoch {epoch_key}; skip")
        return 0

    message = (
        f"*Campaign deadline T−{ALERT_HOURS:.0f}h alert*\n"
        f"campaign=`{campaign_id}`\n"
        f"hours_remaining=`{hours:.2f}`\n"
        f"deadlineAt=`{deadline_at}`\n"
        f"epoch=`{epoch_path}`\n"
        "Action: operator must open a *new* campaign after review — agents never open campaigns."
    )
    record = {
        "schemaVersion": "gloops.campaign-deadline-alert.v1",
        "ts": ts(),
        "campaignId": campaign_id,
        "deadlineAt": deadline_at,
        "hoursRemaining": round(hours, 4),
        "epochPath": str(epoch_path) if epoch_path else None,
        "epochKey": epoch_key,
        "message": message,
    }

    print(message)
    if not args.apply:
        print("dry-run: pass --apply to persist state and notify")
        return 0

    append_alert(record)
    print(f"appended {ALERTS_JSONL}")
    notify_slack(message)
    state.setdefault("alertedEpochs", {})[epoch_key] = {
        "ts": ts(),
        "hoursRemaining": round(hours, 4),
        "deadlineAt": deadline_at,
    }
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
