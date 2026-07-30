#!/usr/bin/env python3
"""Poll Paperclip board approvals for trust_substrate_ir decisions.

On approved: run wopr-review-publisher --force-after-action-required for that PR.
On rejected: leave IR blocked; write rejection marker.
Idempotent; state under /var/lib/paperclip-gloops/wopr-review-clearance.
"""
from __future__ import annotations
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path

API=os.environ.get("PAPERCLIP_API","http://127.0.0.1:3100").rstrip("/")
CID=os.environ.get("PAPERCLIP_COMPANY_ID","89ed0964-d918-4fcc-b830-5be49d2d4089")
TOKEN_FILE=Path(os.environ.get("PAPERCLIP_BOARD_TOKEN_FILE","/etc/paperclip-gloops/operator-board-token"))
PUBLISHER=Path(os.environ.get("WOPR_REVIEW_PUBLISHER","/usr/local/lib/paperclip-gloops/wopr-review-publisher.py"))
STATE_DIR=Path("/var/lib/paperclip-gloops/wopr-review-clearance")

def token(): return TOKEN_FILE.read_text().strip()

def api(method, path, body=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(API+path, data=data, method=method, headers={
        "Authorization":f"Bearer {token()}","Accept":"application/json",
        **({"Content-Type":"application/json"} if body is not None else {}),
    })
    with urllib.request.urlopen(req, timeout=45) as r:
        raw=r.read(); return json.loads(raw) if raw else {}

def main():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    apps=api("GET", f"/api/companies/{CID}/approvals")
    if not isinstance(apps, list):
        print("no approvals list"); return 0
    handled=0
    for a in apps:
        payload=a.get("payload") or {}
        if payload.get("kind")!="trust_substrate_ir":
            continue
        pr=int(payload.get("pr") or 0)
        if pr<=0: continue
        status=a.get("status")
        aid=a.get("id")
        marker=STATE_DIR/f"approval-{aid}.handled"
        if marker.exists():
            continue
        if status=="pending":
            print(f"pending substrate approval pr={pr} id={aid}")
            continue
        if status=="approved":
            print(f"approved substrate clearance pr={pr} id={aid} -> force publish")
            r=subprocess.run([sys.executable, str(PUBLISHER), "--pr", str(pr), "--verdict", "accepted", "--force-after-action-required"], capture_output=True, text=True)
            print(r.stdout); print(r.stderr, file=sys.stderr)
            if r.returncode==0:
                marker.write_text(json.dumps({"handledAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"status":"approved","pr":pr})+"\n")
                handled+=1
            else:
                print(f"publisher failed rc={r.returncode}", file=sys.stderr)
                return r.returncode or 1
        elif status in ("rejected","cancelled","canceled"):
            print(f"rejected/cancelled substrate approval pr={pr} id={aid}")
            marker.write_text(json.dumps({"handledAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"status":status,"pr":pr})+"\n")
            handled+=1
    print(f"handled={handled}")
    return 0

if __name__=="__main__":
    raise SystemExit(main())
