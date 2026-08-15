import hashlib
import hmac
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("github-webhook-receiver.py")
SPEC = importlib.util.spec_from_file_location("github_webhook_receiver", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FakeReceiver(MODULE.Receiver):
    def __init__(self, secret=b"s" * 32, limit=120):
        super().__init__(
            secret,
            "http://127.0.0.1:3100/api/plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/webhooks/github-checks",
            MODULE.SlidingWindowLimiter(limit),
        )
        self.calls = []
        self.status = 200

    def forward(self, body, headers):
        self.calls.append((body, headers))
        return self.status


class RunningReceiver:
    def __init__(self, receiver):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MODULE.handler_class(receiver))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def signed_headers(secret, body, delivery="delivery-1", event="check_suite"):
    signature = hmac.new(secret, body, hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": f"sha256={signature}",
    }


def completed_body():
    return json.dumps({
        "action": "completed",
        "repository": {"full_name": "gloopsAI/paperclip"},
        "check_suite": {
            "head_branch": "gloops/stable",
            "head_sha": "a" * 40,
        },
    }, separators=(",", ":")).encode()


def request(url, method="POST", body=b"{}", headers=None):
    candidate = urllib.request.Request(url, data=body if method != "GET" else None, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(candidate, timeout=3) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        finally:
            error.close()


class ReceiverTest(unittest.TestCase):
    def test_valid_delivery_forwards_exact_bytes_and_headers(self):
        receiver = FakeReceiver()
        body = completed_body()
        with RunningReceiver(receiver) as base:
            status, payload = request(
                base + MODULE.WEBHOOK_PATH,
                body=body,
                headers=signed_headers(receiver.secret, body),
            )
        self.assertEqual((status, payload), (200, {"status": "accepted"}))
        self.assertEqual(receiver.calls[0][0], body)
        self.assertEqual(receiver.calls[0][1]["X-GitHub-Delivery"], "delivery-1")

    def test_accepted_delivery_persists_minimal_durable_ci_merge_trigger(self):
        with tempfile.TemporaryDirectory() as root:
            trigger = pathlib.Path(root, "trigger.json")
            receiver = FakeReceiver()
            receiver.trigger_path = str(trigger)
            body = completed_body()
            with RunningReceiver(receiver) as base:
                status, payload = request(
                    base + MODULE.WEBHOOK_PATH,
                    body=body,
                    headers=signed_headers(receiver.secret, body, delivery="delivery-atomic"),
                )
            self.assertEqual((status, payload), (200, {"status": "accepted"}))
            evidence = json.loads(trigger.read_text())
            self.assertEqual(evidence["schema"], "gloops.ci-merge-trigger.v1")
            self.assertEqual(evidence["deliveryId"], "delivery-atomic")
            self.assertEqual(evidence["repository"], "gloopsAI/paperclip")
            self.assertEqual(evidence["headSha"], "a" * 40)
            self.assertNotIn("check_suite", evidence)
            self.assertEqual(trigger.stat().st_mode & 0o777, 0o600)

    def test_ci_merge_trigger_retries_short_writes(self):
        real_write = MODULE.os.write
        write_calls = []

        def short_write(descriptor, payload):
            write_calls.append(len(payload))
            size = max(1, len(payload) // 2)
            return real_write(descriptor, payload[:size])

        with tempfile.TemporaryDirectory() as root:
            trigger = pathlib.Path(root, "trigger.json")
            receiver = FakeReceiver()
            receiver.trigger_path = str(trigger)
            with mock.patch.object(MODULE.os, "write", side_effect=short_write):
                receiver.persist_ci_merge_trigger(completed_body(), "delivery-short-write")
            evidence = json.loads(trigger.read_text())
            self.assertEqual(evidence["deliveryId"], "delivery-short-write")
            self.assertEqual(evidence["headSha"], "a" * 40)
        self.assertGreater(len(write_calls), 1)

    def test_trigger_failure_is_retryable_and_never_false_green(self):
        receiver = FakeReceiver()
        receiver.trigger_path = "/missing-parent/trigger.json"
        body = completed_body()
        with RunningReceiver(receiver) as base:
            result = request(
                base + MODULE.WEBHOOK_PATH,
                body=body,
                headers=signed_headers(receiver.secret, body),
            )
        self.assertEqual(result, (503, {"error": "ci_merge_trigger_failed"}))
        self.assertEqual(len(receiver.calls), 1)

    def test_invalid_signature_never_forwards(self):
        receiver = FakeReceiver()
        with RunningReceiver(receiver) as base:
            status, payload = request(
                base + MODULE.WEBHOOK_PATH,
                headers={
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "check_suite",
                    "X-GitHub-Delivery": "delivery-1",
                    "X-Hub-Signature-256": "sha256=" + "0" * 64,
                },
            )
        self.assertEqual((status, payload), (401, {"error": "signature_invalid"}))
        self.assertEqual(receiver.calls, [])

    def test_wrong_event_and_delivery_fail_after_signature(self):
        receiver = FakeReceiver()
        body = b"{}"
        with RunningReceiver(receiver) as base:
            status, payload = request(
                base + MODULE.WEBHOOK_PATH,
                body=body,
                headers=signed_headers(receiver.secret, body, event="push"),
            )
            self.assertEqual((status, payload), (422, {"error": "event_invalid"}))
            status, payload = request(
                base + MODULE.WEBHOOK_PATH,
                body=body,
                headers=signed_headers(receiver.secret, body, delivery="bad delivery"),
            )
        self.assertEqual((status, payload), (422, {"error": "delivery_invalid"}))
        self.assertEqual(receiver.calls, [])

    def test_path_method_health_and_body_limit_are_closed(self):
        receiver = FakeReceiver()
        with RunningReceiver(receiver) as base:
            self.assertEqual(request(base + "/other")[0], 404)
            self.assertEqual(request(base + MODULE.WEBHOOK_PATH, method="PUT")[0], 405)
            self.assertEqual(request(base + MODULE.HEALTH_PATH, method="GET"), (200, {"status": "ready"}))
            oversized = urllib.request.Request(
                base + MODULE.WEBHOOK_PATH,
                data=b"x",
                method="POST",
                headers={"Content-Length": str(MODULE.MAX_BODY_BYTES + 1)},
            )
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(oversized, timeout=3)
            caught.exception.close()
        self.assertEqual(caught.exception.code, 413)
        self.assertEqual(receiver.calls, [])

    def test_rate_limit_is_fail_closed(self):
        receiver = FakeReceiver(limit=1)
        body = completed_body()
        with RunningReceiver(receiver) as base:
            headers = signed_headers(receiver.secret, body)
            self.assertEqual(request(base + MODULE.WEBHOOK_PATH, body=body, headers=headers)[0], 200)
            self.assertEqual(request(base + MODULE.WEBHOOK_PATH, body=body, headers=headers), (429, {"error": "rate_limited"}))
        self.assertEqual(len(receiver.calls), 1)

    def test_private_upstream_failure_is_not_reported_as_success(self):
        receiver = FakeReceiver()
        receiver.status = 502
        body = completed_body()
        with RunningReceiver(receiver) as base:
            result = request(base + MODULE.WEBHOOK_PATH, body=body, headers=signed_headers(receiver.secret, body))
        self.assertEqual(result, (502, {"error": "private_upstream_failed"}))

    def test_signed_empty_or_invalid_check_suite_never_reaches_persistence(self):
        receiver = FakeReceiver()
        with RunningReceiver(receiver) as base:
            empty = b""
            self.assertEqual(
                request(
                    base + MODULE.WEBHOOK_PATH,
                    body=empty,
                    headers=signed_headers(receiver.secret, empty),
                ),
                (422, {"error": "body_invalid"}),
            )
            invalid = b"{}"
            self.assertEqual(
                request(
                    base + MODULE.WEBHOOK_PATH,
                    body=invalid,
                    headers=signed_headers(receiver.secret, invalid),
                ),
                (422, {"error": "payload_invalid"}),
            )
            wrong_action = completed_body().replace(b'"completed"', b'"requested"')
            self.assertEqual(
                request(
                    base + MODULE.WEBHOOK_PATH,
                    body=wrong_action,
                    headers=signed_headers(receiver.secret, wrong_action),
                ),
                (422, {"error": "payload_invalid"}),
            )
        self.assertEqual(receiver.calls, [])

    def test_private_upstream_transport_error_is_not_reported_as_success(self):
        receiver = MODULE.Receiver(
            b"s" * 32,
            "http://127.0.0.1:3100/api/plugins/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/webhooks/github-checks",
            MODULE.SlidingWindowLimiter(1),
        )
        with mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=urllib.error.URLError("injected")):
            self.assertEqual(
                receiver.forward(
                    b"{}",
                    {
                        "X-GitHub-Event": "check_suite",
                        "X-GitHub-Delivery": "delivery-1",
                        "X-Hub-Signature-256": "sha256=" + "0" * 64,
                    },
                ),
                0,
            )

    def test_secret_and_upstream_validation(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root, "secret")
            path.write_bytes(b"x" * 32 + b"\n")
            self.assertEqual(MODULE.load_secret(str(path)), b"x" * 32)
            path.write_bytes(b"short")
            with self.assertRaises(ValueError):
                MODULE.load_secret(str(path))
            path.write_bytes(b"x" * 31 + b"\ninside")
            with self.assertRaises(ValueError):
                MODULE.load_secret(str(path))
        with self.assertRaises(ValueError):
            MODULE.Receiver(b"x" * 32, "https://example.com/hook", MODULE.SlidingWindowLimiter(1))


if __name__ == "__main__":
    unittest.main()
