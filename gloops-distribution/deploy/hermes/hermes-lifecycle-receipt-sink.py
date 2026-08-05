#!/usr/bin/env python3
"""HMAC-verified Hermes outbound lifecycle receipt sink (notify only)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RECEIPT_DIR = Path(os.environ.get("HERMES_LIFECYCLE_RECEIPT_DIR", "/receipts"))
SECRET = os.environ.get("HERMES_OUTBOUND_WEBHOOK_SECRET", "")
HOST = os.environ.get("HERMES_LIFECYCLE_SINK_HOST", "0.0.0.0")
PORT = int(os.environ.get("HERMES_LIFECYCLE_SINK_PORT", "8765"))
SIG_RE = re.compile(r"^sha256=([0-9a-fA-F]+)$")


def _verify(body: bytes, header: str | None) -> bool:
    if not SECRET or not header:
        return False
    m = SIG_RE.match(header.strip())
    if not m:
        return False
    expected = hmac.new(SECRET.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m.group(1).lower())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # quieter, no secrets
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/health":
            self._json(200, {"status": "ok", "service": "hermes-lifecycle-receipt-sink"})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/hermes-events":
            self._json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1_048_576:
            self._json(413, {"error": "payload_too_large_or_empty"})
            return
        body = self.rfile.read(length)
        sig = self.headers.get("X-Hermes-Signature-256")
        if not _verify(body, sig):
            self._json(401, {"error": "invalid_signature"})
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self._json(400, {"error": "invalid_json"})
            return
        delivery = (
            self.headers.get("X-Hermes-Delivery")
            or (payload.get("delivery_id") if isinstance(payload, dict) else None)
            or hashlib.sha256(body).hexdigest()[:16]
        )
        event = self.headers.get("X-Hermes-Event") or (
            payload.get("hook_event_name") if isinstance(payload, dict) else "unknown"
        )
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        RECEIPT_DIR.mkdir(parents=True, exist_ok=True)
        out = RECEIPT_DIR / f"{ts}-{delivery}.json"
        receipt = {
            "schema": "gloops.hermes.lifecycle_receipt.v1",
            "receivedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "event": event,
            "deliveryId": delivery,
            "payload": payload,
        }
        tmp = out.with_suffix(".tmp")
        tmp.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(out)
        self._json(200, {"status": "accepted", "receipt": out.name})

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    if not SECRET:
        print("HERMES_OUTBOUND_WEBHOOK_SECRET is required", file=sys.stderr)
        return 2
    RECEIPT_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"hermes-lifecycle-receipt-sink listening on {HOST}:{PORT}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
