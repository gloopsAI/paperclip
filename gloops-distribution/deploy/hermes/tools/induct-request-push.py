#!/usr/bin/env python3
"""Agent-facing: request Induct push/PR (writes request file for host poller).

Hermes cannot mint Induct App tokens (root key). Agents stage commits then:

  python3 /opt/data/bin/induct-request-push.py \\
    --cwd /opt/data/workspace/induct-main \\
    --branch agent/wren/glo-XXXX \\
    --title "..." [--body "..."] [--pr]

Host poller: induct-push-poller.py (root timer/manual) executes via Induct App.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import uuid
from pathlib import Path

BRANCH_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")
ALLOW_MARKERS = ("/induct-main",)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--branch", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--body", default="")
    ap.add_argument("--pr", action="store_true", help="Also open PR after push")
    ap.add_argument("--base", default="main")
    args = ap.parse_args()
    cwd = Path(args.cwd).resolve()
    if not any(m in str(cwd) for m in ALLOW_MARKERS):
        print(json.dumps({"ok": False, "errorCode": "cwd_not_induct", "error": str(cwd)}))
        return 2
    if not BRANCH_RE.fullmatch(args.branch):
        print(json.dumps({"ok": False, "errorCode": "bad_branch"}))
        return 2
    req_dir = cwd / ".paperclip" / "induct-push-requests"
    req_dir.mkdir(parents=True, exist_ok=True)
    rid = str(uuid.uuid4())
    payload = {
        "schemaVersion": "gloops.induct-push-request.v1",
        "id": rid,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cwd": str(cwd),
        "branch": args.branch,
        "title": args.title or f"Induct push {args.branch}",
        "body": args.body,
        "openPr": bool(args.pr),
        "base": args.base,
        "status": "pending",
    }
    path = req_dir / f"{rid}.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps({"ok": True, "requestId": rid, "path": str(path), "status": "pending"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
