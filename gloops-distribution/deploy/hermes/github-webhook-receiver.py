#!/usr/bin/env python3
"""Narrow public GitHub webhook receiver for the private Paperclip pilot."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
import sys
import threading
import time
import secrets
import urllib.error
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

LISTEN_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
WEBHOOK_PATH = "/github-webhooks/paperclip-check-suite"
HEALTH_PATH = "/healthz"
MAX_BODY_BYTES = 1_048_576
MAX_REQUESTS_PER_MINUTE = 120
DELIVERY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
HMAC_SECRET_RE = re.compile(rb"^[A-Za-z0-9._~+/=-]{32,256}$")
UPSTREAM_RE = re.compile(
    r"^http://127\.0\.0\.1:3100/api/plugins/"
    r"[0-9a-f-]{36}/webhooks/github-checks$"
)


def datetime_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("durable write made no progress")
        view = view[written:]


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: int = 60) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._entries: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        observed = time.monotonic() if now is None else now
        floor = observed - self.window_seconds
        with self._lock:
            entries = self._entries[key]
            while entries and entries[0] <= floor:
                entries.popleft()
            if len(entries) >= self.limit:
                return False
            entries.append(observed)
            return True


def load_secret(path: str) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 257:
            raise ValueError("webhook secret file is invalid")
        value = os.read(fd, 258)
    finally:
        os.close(fd)
    if value.endswith(b"\n"):
        value = value[:-1]
    if HMAC_SECRET_RE.fullmatch(value) is None:
        raise ValueError("webhook secret length is invalid")
    return value


def verify_signature(secret: bytes, body: bytes, supplied: str | None) -> bool:
    if supplied is None or not supplied.startswith("sha256="):
        return False
    supplied_hex = supplied.removeprefix("sha256=")
    if re.fullmatch(r"[0-9a-fA-F]{64}", supplied_hex) is None:
        return False
    expected = hmac.new(secret, body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied_hex.lower())


def completed_check_suite(body: bytes) -> dict[str, str] | None:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("action") != "completed":
        return None
    repository = payload.get("repository")
    suite = payload.get("check_suite")
    if not isinstance(repository, dict) or not isinstance(suite, dict):
        return None
    full_name = repository.get("full_name")
    head_branch = suite.get("head_branch")
    head_sha = suite.get("head_sha")
    valid = (
        isinstance(full_name, str)
        and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}", full_name) is not None
        and isinstance(head_branch, str)
        and 1 <= len(head_branch) <= 255
        and isinstance(head_sha, str)
        and re.fullmatch(r"[0-9a-f]{40}", head_sha) is not None
    )
    if not valid:
        return None
    return {
        "repository": full_name,
        "headBranch": head_branch,
        "headSha": head_sha,
    }


def valid_completed_check_suite(body: bytes) -> bool:
    return completed_check_suite(body) is not None


def client_key(headers: object, peer: str) -> str:
    forwarded = getattr(headers, "get")("X-Forwarded-For")
    if forwarded:
        candidate = forwarded.split(",", 1)[0].strip()
        if candidate and len(candidate) <= 64:
            return candidate
    return peer


class Receiver:
    def __init__(
        self,
        secret: bytes,
        upstream_url: str,
        limiter: SlidingWindowLimiter,
        trigger_path: str | None = None,
    ) -> None:
        parsed = urlparse(upstream_url)
        if parsed.scheme != "http" or not UPSTREAM_RE.fullmatch(upstream_url):
            raise ValueError("upstream URL is outside the loopback plugin allowlist")
        self.secret = secret
        self.upstream_url = upstream_url
        self.limiter = limiter
        self.trigger_path = trigger_path

    def persist_ci_merge_trigger(self, body: bytes, delivery: str) -> None:
        if self.trigger_path is None:
            return
        evidence = completed_check_suite(body)
        if evidence is None:
            raise ValueError("completed check suite evidence is invalid")
        path = os.path.abspath(self.trigger_path)
        parent, leaf = os.path.split(path)
        if not parent or not leaf or leaf in (".", ".."):
            raise ValueError("CI merge trigger path is invalid")
        directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temp_leaf = f".{leaf}.{os.getpid()}.{threading.get_ident()}.{secrets.token_hex(6)}.tmp"
        temp_fd = -1
        try:
            temp_fd = os.open(
                temp_leaf,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory_fd,
            )
            payload = json.dumps({
                "schema": "gloops.ci-merge-trigger.v1",
                "deliveryId": delivery,
                **evidence,
                "receivedAt": datetime_now(),
            }, sort_keys=True, separators=(",", ":")).encode() + b"\n"
            write_all(temp_fd, payload)
            os.fsync(temp_fd)
            os.close(temp_fd)
            temp_fd = -1
            os.rename(temp_leaf, leaf, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
            os.fsync(directory_fd)
        finally:
            if temp_fd >= 0:
                os.close(temp_fd)
            try:
                os.unlink(temp_leaf, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
            os.close(directory_fd)

    def forward(self, body: bytes, headers: dict[str, str]) -> int:
        request = urllib.request.Request(
            self.upstream_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "User-Agent": "gloops-github-webhook-receiver/1",
                "X-GitHub-Event": headers["X-GitHub-Event"],
                "X-GitHub-Delivery": headers["X-GitHub-Delivery"],
                "X-Hub-Signature-256": headers["X-Hub-Signature-256"],
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                response.read(MAX_BODY_BYTES + 1)
                return response.status
        except urllib.error.HTTPError as error:
            error.read(MAX_BODY_BYTES + 1)
            return error.code
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0


def handler_class(receiver: Receiver) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "GLoopsWebhookReceiver/1"

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _json(self, status: int, value: dict[str, object]) -> None:
            payload = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self) -> None:  # noqa: N802
            if self.path != HEALTH_PATH:
                self._json(404, {"error": "not_found"})
                return
            self._json(200, {"status": "ready"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != WEBHOOK_PATH:
                self._json(404, {"error": "not_found"})
                return
            key = client_key(self.headers, self.client_address[0])
            if not receiver.limiter.allow(key):
                self._json(429, {"error": "rate_limited"})
                return
            content_length = self.headers.get("Content-Length")
            if content_length is None or not content_length.isdigit():
                self._json(411, {"error": "content_length_required"})
                return
            length = int(content_length)
            if length == 0:
                self._json(422, {"error": "body_invalid"})
                return
            if length > MAX_BODY_BYTES:
                self._json(413, {"error": "body_too_large"})
                return
            body = self.rfile.read(length)
            if len(body) != length:
                self._json(400, {"error": "body_incomplete"})
                return
            signature = self.headers.get("X-Hub-Signature-256")
            if not verify_signature(receiver.secret, body, signature):
                self._json(401, {"error": "signature_invalid"})
                return
            event = self.headers.get("X-GitHub-Event")
            delivery = self.headers.get("X-GitHub-Delivery")
            if event != "check_suite":
                self._json(422, {"error": "event_invalid"})
                return
            if delivery is None or DELIVERY_RE.fullmatch(delivery) is None:
                self._json(422, {"error": "delivery_invalid"})
                return
            if not valid_completed_check_suite(body):
                self._json(422, {"error": "payload_invalid"})
                return
            upstream_status = receiver.forward(
                body,
                {
                    "X-GitHub-Event": event,
                    "X-GitHub-Delivery": delivery,
                    "X-Hub-Signature-256": signature,
                },
            )
            if upstream_status < 200 or upstream_status >= 300:
                self._json(502, {"error": "private_upstream_failed"})
                return
            try:
                receiver.persist_ci_merge_trigger(body, delivery)
            except (OSError, ValueError):
                self._json(503, {"error": "ci_merge_trigger_failed"})
                return
            self._json(200, {"status": "accepted"})

        def do_PUT(self) -> None:  # noqa: N802
            self._json(405, {"error": "method_not_allowed"})

        do_PATCH = do_PUT
        do_DELETE = do_PUT

    return Handler


def main() -> int:
    port = int(os.environ.get("WEBHOOK_RECEIVER_PORT", str(DEFAULT_PORT)))
    if port < 1024 or port > 65535:
        raise ValueError("receiver port is invalid")
    credentials_dir = os.environ.get("CREDENTIALS_DIRECTORY", "")
    secret_path = os.environ.get(
        "WEBHOOK_HMAC_PATH",
        os.path.join(credentials_dir, "github_webhook_hmac"),
    )
    upstream = os.environ.get("PAPERCLIP_PLUGIN_WEBHOOK_URL", "")
    receiver = Receiver(
        load_secret(secret_path),
        upstream,
        SlidingWindowLimiter(MAX_REQUESTS_PER_MINUTE),
        os.environ.get("CI_MERGE_TRIGGER_PATH") or None,
    )
    server = ThreadingHTTPServer((LISTEN_HOST, port), handler_class(receiver))
    print(json.dumps({"event": "receiver.ready", "host": LISTEN_HOST, "port": port}), flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"event": "receiver.failed", "errorClass": type(error).__name__}), file=sys.stderr)
        raise
