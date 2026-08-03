#!/usr/bin/env python3
"""Optional host poller for Induct SDLC steward signals (S3).

Default: detect only. Auto-apply of induct-lease-refresh is **off**.

Env:
  SDLC_STEWARD_AUTO_APPLY_LEASE=1  — if the only recommended recipe is
      induct-lease-refresh, run refresh-induct-lease.py --apply --only-if-stale
  SDLC_PREFLIGHT_LAST_JSON         — path to last preflight JSON
      (default /var/lib/paperclip-gloops/sdlc-preflight/last.json)
  SDLC_PREFLIGHT_BIN               — host preflight script
  REFRESH_INDUCT_LEASE_BIN         — lease refresh script

Authority bounds:
  - Never enable HEARTBEAT_SCHEDULER
  - Never open campaigns
  - Never multi-UUID READMIT
  - Never bulk hostctl
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DETECT = HERE / "detect.py"
LAST_JSON = Path(
    os.environ.get(
        "SDLC_PREFLIGHT_LAST_JSON",
        "/var/lib/paperclip-gloops/sdlc-preflight/last.json",
    )
)
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


def ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_last_preflight() -> dict[str, Any] | None:
    if not LAST_JSON.is_file():
        return None
    try:
        data = json.loads(LAST_JSON.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def run_preflight() -> dict[str, Any] | None:
    if not PREFLIGHT_BIN.is_file():
        return None
    proc = subprocess.run(
        ["bash", str(PREFLIGHT_BIN)],
        text=True,
        capture_output=True,
        check=False,
    )
    for line in (proc.stdout or "").splitlines():
        if line.startswith("PREFLIGHT_JSON="):
            try:
                return json.loads(line[len("PREFLIGHT_JSON=") :])
            except json.JSONDecodeError:
                return None
    return None


def detect_from_text(text: str) -> dict[str, Any]:
    sys.path.insert(0, str(HERE))
    import detect  # type: ignore

    matches = detect.detect_in_text(text)
    return detect.build_report(matches, sources=["sdlc-steward-poller"])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--run-preflight", action="store_true", help="Invoke S0 preflight")
    ap.add_argument("--json", action="store_true", help="Print report JSON only")
    args = ap.parse_args(argv)

    preflight = load_last_preflight()
    if args.run_preflight or preflight is None:
        preflight = run_preflight() or preflight

    text_bits: list[str] = []
    if preflight:
        text_bits.append(json.dumps(preflight))
        for code in preflight.get("criticalCodes") or preflight.get("codes") or []:
            text_bits.append(str(code))
    else:
        text_bits.append("sdlc-preflight missing last.json")

    report = detect_from_text("\n".join(text_bits))
    recipes = list(report.get("recommendedRecipes") or [])

    auto_apply = os.environ.get("SDLC_STEWARD_AUTO_APPLY_LEASE", "").strip() in (
        "1",
        "true",
        "yes",
    )
    applied = False
    apply_detail = None
    if auto_apply and recipes == ["induct-lease-refresh"] and REFRESH_BIN.is_file():
        proc = subprocess.run(
            [
                "python3",
                str(REFRESH_BIN),
                "--apply",
                "--only-if-stale",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        applied = proc.returncode == 0
        apply_detail = {
            "command": "refresh-induct-lease.py --apply --only-if-stale",
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "")[-2000:],
            "stderr": (proc.stderr or "")[-1000:],
        }
    elif auto_apply and recipes and recipes != ["induct-lease-refresh"]:
        apply_detail = {
            "skipped": True,
            "reason": "auto-apply only when sole recipe is induct-lease-refresh",
            "recipes": recipes,
        }

    out = {
        "schemaVersion": "gloops.sdlc-steward-poller.v1",
        "ts": ts(),
        "preflightOk": None if preflight is None else bool(preflight.get("ok")),
        "recommendedRecipes": recipes,
        "autoApplyLease": auto_apply,
        "applied": applied,
        "applyDetail": apply_detail,
        "detect": report,
        "notes": [
            "Default auto-apply off (SDLC_STEWARD_AUTO_APPLY_LEASE unset).",
            "Never opens campaigns, never enables HEARTBEAT_SCHEDULER, never multi-UUID READMIT.",
        ],
    }
    print(json.dumps(out, indent=2 if not args.json else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
