#!/usr/bin/env python3
"""Host poller: execute pending Induct push requests with Option A App.

Run as root (manual or timer):
  python3 /usr/local/lib/paperclip-gloops/bin/induct-push-poller.py --once
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HOST_LEASE = Path("/opt/paperclip/hermes-execution-state/workspace/induct-main")
PUSH_BIN = Path("/usr/local/lib/paperclip-gloops/tools/induct-git-push.py")
REQ_GLOB = ".paperclip/induct-push-requests/*.json"


def process_one(path: Path) -> dict:
    data = json.loads(path.read_text())
    if data.get("status") not in (None, "pending"):
        return {"path": str(path), "skipped": data.get("status")}
    branch = data["branch"]
    # Map container cwd to host if needed
    cwd = data.get("cwd") or str(HOST_LEASE)
    if cwd.startswith("/opt/data/workspace/"):
        host_cwd = str(HOST_LEASE) if "induct-main" in cwd else cwd
    else:
        host_cwd = cwd
    if data.get("openPr"):
        cmd = [
            "python3",
            str(PUSH_BIN),
            "push-pr",
            "--cwd",
            host_cwd,
            "--branch",
            branch,
            "--title",
            data.get("title") or branch,
            "--body",
            data.get("body") or "",
            "--base",
            data.get("base") or "main",
        ]
    else:
        cmd = ["python3", str(PUSH_BIN), "push", "--cwd", host_cwd, "--branch", branch]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    result = {
        "exit": proc.returncode,
        "stdout": (proc.stdout or "")[:2000],
        "stderr": (proc.stderr or "")[:1000],
    }
    data["status"] = "done" if proc.returncode == 0 else "failed"
    data["result"] = result
    path.write_text(json.dumps(data, indent=2) + "\n")
    # also write sibling result for agents
    path.with_suffix(".result.json").write_text(json.dumps(data, indent=2) + "\n")
    return {"path": str(path), "status": data["status"], "result": result}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--lease", type=Path, default=HOST_LEASE)
    args = ap.parse_args()
    root = args.lease / ".paperclip" / "induct-push-requests"
    if not root.is_dir():
        print(json.dumps({"ok": True, "processed": 0, "note": "no request dir"}))
        return 0
    rows = []
    for path in sorted(root.glob("*.json")):
        if path.name.endswith(".result.json"):
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        if data.get("status") not in (None, "pending"):
            continue
        rows.append(process_one(path))
        if args.once and rows:
            break
    print(json.dumps({"ok": True, "processed": len(rows), "rows": rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
