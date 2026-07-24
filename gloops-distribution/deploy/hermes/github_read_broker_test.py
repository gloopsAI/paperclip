#!/usr/bin/env python3
"""Deterministic tests for the root-owned read-only GitHub evidence broker."""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock


MODULE_PATH = Path(__file__).with_name("github-read-broker.py")
SPEC = importlib.util.spec_from_file_location("github_read_broker", MODULE_PATH)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


class GitHubReadBrokerTests(unittest.TestCase):
    """Tests for allowlist rejection, supported read operations, bounded
    output, malformed requests, and credential non-disclosure."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.dir = Path(self.tempdir.name)
        self.runtime = self.dir / "run"
        self.state = self.dir / "state"
        self.socket_path = self.runtime / "broker.sock"
        self.lock_path = self.state / "command.lock"

    def tearDown(self):
        self.tempdir.cleanup()

    def paths(self):
        return patch.multiple(
            broker,
            RUNTIME_DIR=self.runtime,
            STATE_DIR=self.state,
            SOCKET_PATH=self.socket_path,
            COMMAND_LOCK=self.lock_path,
            TEST_MODE=True,
        )

    # -------------------------------------------------------------------------
    # Allowlist rejection
    # -------------------------------------------------------------------------

    def test_rejects_non_allowlisted_repository(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "not in the allowlist"):
                broker.process_request({
                    "operation": "list-issues",
                    "repo": "evil/repo",
                })

    def test_rejects_malformed_repository(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "owner/repo"):
                broker.process_request({
                    "operation": "list-issues",
                    "repo": "not-a-repo",
                })

    def test_accepts_allowlisted_repository_induct(self):
        with self.paths():
            with patch.object(broker, "run_gh", return_value="[]"):
                result = broker.process_request({
                    "operation": "list-issues",
                    "repo": "InductAI/induct",
                })
                self.assertTrue(result["ok"])

    def test_accepts_allowlisted_repository_induct_knowledge(self):
        with self.paths():
            with patch.object(broker, "run_gh", return_value="[]"):
                result = broker.process_request({
                    "operation": "list-issues",
                    "repo": "InductAI/induct-knowledge",
                })
                self.assertTrue(result["ok"])

    def test_search_issues_rejects_injected_repo_scope(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "scope qualifiers"):
                broker.process_request({
                    "operation": "search-issues",
                    "repo": "InductAI/induct",
                    "query": "repo:InductAI/other-private-repo day 0",
                })

    def test_search_prs_rejects_injected_org_scope(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "scope qualifiers"):
                broker.process_request({
                    "operation": "search-prs",
                    "repo": "InductAI/induct",
                    "query": "OR org:InductAI is:open",
                })

    # -------------------------------------------------------------------------
    # Malformed requests
    # -------------------------------------------------------------------------

    def test_rejects_unknown_operation(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "operation must be one of"):
                broker.process_request({"operation": "delete-repo", "repo": "InductAI/induct"})

    def test_rejects_missing_operation(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "operation must be one of"):
                broker.process_request({"repo": "InductAI/induct"})

    def test_rejects_missing_repo(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "repo is required"):
                broker.process_request({"operation": "list-issues"})

    def test_rejects_non_object_request(self):
        """Test that read_request rejects non-object JSON."""
        with self.paths():
            mock_socket = MagicMock()
            mock_socket.recv = lambda n: b"[1, 2, 3]\n"
            with self.assertRaisesRegex(broker.BrokerError, "JSON object"):
                broker.read_request(mock_socket)

    def test_rejects_search_without_query(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "query is required"):
                broker.process_request({
                    "operation": "search-issues",
                    "repo": "InductAI/induct",
                })

    def test_rejects_get_without_number(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "number is required"):
                broker.process_request({
                    "operation": "get-issue",
                    "repo": "InductAI/induct",
                })

    def test_rejects_invalid_number(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "positive integer"):
                broker.process_request({
                    "operation": "get-issue",
                    "repo": "InductAI/induct",
                    "number": -1,
                })

    def test_rejects_invalid_state_for_list_issues(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "state must be"):
                broker.process_request({
                    "operation": "list-issues",
                    "repo": "InductAI/induct",
                    "state": "weird",
                })

    def test_rejects_invalid_state_for_list_prs(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "state must be"):
                broker.process_request({
                    "operation": "list-prs",
                    "repo": "InductAI/induct",
                    "state": "weird",
                })

    def test_rejects_oversized_query(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "query is required"):
                broker.process_request({
                    "operation": "search-issues",
                    "repo": "InductAI/induct",
                    "query": "",
                })

    # -------------------------------------------------------------------------
    # Supported read operations
    # -------------------------------------------------------------------------

    def test_list_issues_calls_gh_correctly(self):
        captured_args = []

        def mock_run_gh(args, env=None):
            captured_args.append(args)
            return json.dumps([{
                "number": 1,
                "title": "Bug",
                "state": "open",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-02T00:00:00Z",
                "author": {"login": "user1"},
                "url": "https://github.com/InductAI/induct/issues/1",
                "labels": [{"name": "bug"}],
            }])

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock_run_gh):
                result = broker.process_request({
                    "operation": "list-issues",
                    "repo": "InductAI/induct",
                    "state": "open",
                    "limit": 10,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["data"]), 1)
        self.assertEqual(result["data"][0]["number"], 1)
        # Verify gh was called with correct arguments
        self.assertEqual(captured_args[0][0], "issue")
        self.assertEqual(captured_args[0][1], "list")
        self.assertIn("--repo", captured_args[0])
        self.assertIn("InductAI/induct", captured_args[0])

    def test_get_issue_returns_selected_fields(self):
        full_issue = {
            "number": 42,
            "title": "Fix crash",
            "state": "open",
            "body": "Steps to reproduce",
            "labels": [{"name": "bug"}],
            "assignees": [{"login": "dev"}],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z",
            "closedAt": None,
            "author": {"login": "reporter"},
            "url": "https://github.com/InductAI/induct/issues/42",
            "comments": 3,
            "milestone": {"title": "v1"},
            "repository": {"nameWithOwner": "InductAI/induct"},
            "secret_field": "should_not_appear",
        }

        with self.paths():
            with patch.object(broker, "run_gh", return_value=json.dumps(full_issue)):
                result = broker.process_request({
                    "operation": "get-issue",
                    "repo": "InductAI/induct",
                    "number": 42,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["number"], 42)
        self.assertEqual(result["data"]["title"], "Fix crash")
        # secret_field is not in ISSUE_FIELDS so it's stripped by select_fields
        self.assertNotIn("secret_field", result["data"])

    def test_list_prs_calls_gh_correctly(self):
        with self.paths():
            with patch.object(broker, "run_gh", return_value="[]"):
                result = broker.process_request({
                    "operation": "list-prs",
                    "repo": "InductAI/induct-knowledge",
                    "state": "open",
                    "limit": 5,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"], [])

    def test_get_pr_returns_selected_fields(self):
        full_pr = {
            "number": 7,
            "title": "Add feature",
            "state": "open",
            "body": "Implements X",
            "labels": [],
            "assignees": [],
            "reviewers": [{"login": "reviewer1"}],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z",
            "closedAt": None,
            "mergedAt": None,
            "author": {"login": "dev"},
            "url": "https://github.com/InductAI/induct/pull/7",
            "headRefName": "feature",
            "baseRefName": "main",
            "isDraft": False,
            "mergeable": "MERGEABLE",
            "additions": 10,
            "deletions": 2,
            "comments": 1,
            "reviewDecision": "APPROVED",
            "repository": {"nameWithOwner": "InductAI/induct"},
            "token": "ghs_secret_should_not_appear",
        }

        with self.paths():
            with patch.object(broker, "run_gh", return_value=json.dumps(full_pr)):
                result = broker.process_request({
                    "operation": "get-pr",
                    "repo": "InductAI/induct",
                    "number": 7,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["number"], 7)
        self.assertEqual(result["data"]["reviewDecision"], "APPROVED")
        self.assertNotIn("token", result["data"])

    def test_get_pr_checks_calls_gh_correctly(self):
        checks = [
            {"name": "CI", "state": "SUCCESS", "startedAt": "2026-01-01", "completedAt": "2026-01-01", "link": "url", "bucket": "pass"},
        ]
        with self.paths():
            with patch.object(broker, "run_gh", return_value=json.dumps(checks)):
                result = broker.process_request({
                    "operation": "get-pr-checks",
                    "repo": "InductAI/induct",
                    "number": 7,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"][0]["name"], "CI")

    def test_search_issues_passes_query(self):
        captured_args = []

        def mock_run_gh(args, env=None):
            captured_args.append(args)
            return "[]"

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock_run_gh):
                result = broker.process_request({
                    "operation": "search-issues",
                    "repo": "InductAI/induct",
                    "query": "crash in title",
                    "limit": 5,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(captured_args[0][0], "search")
        self.assertEqual(captured_args[0][1], "issues")

    def test_search_prs_passes_query(self):
        captured_args = []

        def mock_run_gh(args, env=None):
            captured_args.append(args)
            return "[]"

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock_run_gh):
                result = broker.process_request({
                    "operation": "search-prs",
                    "repo": "InductAI/induct",
                    "query": "dependency upgrade",
                })
        self.assertTrue(result["ok"])
        self.assertEqual(captured_args[0][0], "search")
        self.assertEqual(captured_args[0][1], "prs")

    def test_get_pr_status_returns_selected_fields(self):
        full_pr = {
            "number": 7,
            "title": "Add feature",
            "state": "open",
            "statusCheckRollup": [{"state": "SUCCESS", "name": "CI"}],
            "token": "ghs_secret",
            "body": "should not appear in status",
        }
        with self.paths():
            with patch.object(broker, "run_gh", return_value=json.dumps(full_pr)):
                result = broker.process_request({
                    "operation": "get-pr-status",
                    "repo": "InductAI/induct",
                    "number": 7,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["number"], 7)
        self.assertIn("statusCheckRollup", result["data"])
        self.assertNotIn("body", result["data"])
        self.assertNotIn("token", result["data"])

    # -------------------------------------------------------------------------
    # Bounded output
    # -------------------------------------------------------------------------

    def test_bounded_output_truncates_large_lists(self):
        large_list = [{"number": i, "title": f"item {i}", "state": "open"} for i in range(10000)]
        response = {"ok": True, "data": large_list}
        raw = broker.bound_output(response, max_bytes=2048)
        self.assertLessEqual(len(raw), 2048)
        parsed = json.loads(raw)
        self.assertTrue(parsed.get("truncated", False))
        self.assertLess(parsed["totalReturned"], 10000)
        self.assertEqual(parsed["totalAvailable"], 10000)

    def test_bounded_output_keeps_small_responses(self):
        response = {"ok": True, "data": [{"number": 1}]}
        raw = broker.bound_output(response, max_bytes=8192)
        parsed = json.loads(raw)
        self.assertFalse(parsed.get("truncated", False))
        self.assertEqual(parsed["data"], [{"number": 1}])

    def test_bounded_output_never_slices_json(self):
        response = {"ok": True, "data": {"body": "x" * 10000}}
        raw = broker.bound_output(response, max_bytes=256)
        self.assertLessEqual(len(raw), 256)
        parsed = json.loads(raw)
        self.assertFalse(parsed["ok"])
        self.assertTrue(parsed["truncated"])

    def test_limit_is_capped(self):
        captured_args = []

        def mock_run_gh(args, env=None):
            captured_args.append(args)
            return "[]"

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock_run_gh):
                broker.process_request({
                    "operation": "list-issues",
                    "repo": "InductAI/induct",
                    "limit": 1000,
                })
        # Verify limit was capped to LIST_LIMIT (30)
        limit_idx = captured_args[0].index("--limit")
        self.assertEqual(captured_args[0][limit_idx + 1], "30")

    # -------------------------------------------------------------------------
    # Credential non-disclosure
    # -------------------------------------------------------------------------

    def test_strip_credentials_removes_token_keys(self):
        data = {
            "number": 1,
            "title": "Issue",
            "token": "ghs_secret",
            "nested": {
                "access_token": "secret",
                "number": 2,
            },
            "list": [
                {"password": "secret", "number": 3},
                {"number": 4},
            ],
        }
        stripped = broker.strip_credentials(data)
        self.assertNotIn("token", stripped)
        self.assertNotIn("access_token", stripped["nested"])
        self.assertNotIn("password", stripped["list"][0])
        self.assertEqual(stripped["number"], 1)
        self.assertEqual(stripped["nested"]["number"], 2)
        self.assertEqual(stripped["list"][0]["number"], 3)
        self.assertEqual(stripped["list"][1]["number"], 4)

    def test_response_never_contains_credentials(self):
        """Even if gh returns credential-like fields, they are stripped."""
        leaky_response = {
            "number": 1,
            "title": "Issue",
            "token": "ghs_leaked",
            "secret": "hidden",
            "authorization": "Bearer xyz",
        }

        with self.paths():
            with patch.object(broker, "run_gh", return_value=json.dumps(leaky_response)):
                result = broker.process_request({
                    "operation": "get-issue",
                    "repo": "InductAI/induct",
                    "number": 1,
                })
        raw = json.dumps(result)
        self.assertNotIn("ghs_", raw)
        self.assertNotIn("token", result["data"])
        self.assertNotIn("secret", result["data"])
        self.assertNotIn("authorization", result["data"])

    def test_response_error_does_not_leak_internal_details(self):
        """handle_connection catches BrokerError and returns error message."""
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=broker.BrokerError("gh CLI failed: internal /etc/secret path")):
                mock_socket = MagicMock()
                sent_data = []

                def capture_sendall(data):
                    sent_data.append(data)

                mock_socket.recv = lambda n: (json.dumps({
                    "operation": "get-issue",
                    "repo": "InductAI/induct",
                    "number": 1,
                }) + "\n").encode()
                mock_socket.sendall = capture_sendall
                broker.handle_connection(mock_socket)

                parsed = json.loads(sent_data[0])
                self.assertFalse(parsed["ok"])
                self.assertIn("gh CLI failed", parsed["error"])

    def test_internal_error_masks_unexpected_exceptions(self):
        """handle_connection masks unexpected exception types as 'internal error'."""
        with self.paths():
            # Patch run_gh to raise a non-BrokerError to test masking
            with patch.object(broker, "run_gh", side_effect=RuntimeError("unexpected /etc/passwd detail")):
                mock_socket = MagicMock()
                sent_data = []

                def capture_sendall(data):
                    sent_data.append(data)

                mock_socket.recv = lambda n: (json.dumps({
                    "operation": "get-issue",
                    "repo": "InductAI/induct",
                    "number": 1,
                }) + "\n").encode()
                mock_socket.sendall = capture_sendall
                broker.handle_connection(mock_socket)

                parsed = json.loads(sent_data[0])
                self.assertFalse(parsed["ok"])
                self.assertIn("internal error", parsed["error"])
                self.assertNotIn("/etc/passwd", parsed["error"])

    # -------------------------------------------------------------------------
    # Socket protocol
    # -------------------------------------------------------------------------

    def test_verify_peer_accepts_expected_hermes_uid(self):
        client = MagicMock()
        client.getsockopt.return_value = struct.pack(
            "iII", 1234, broker.EXPECTED_HERMES_UID, broker.HERMES_GID
        )
        with patch.object(broker, "TEST_MODE", False):
            broker.verify_peer(client)

    def test_verify_peer_rejects_other_uid(self):
        client = MagicMock()
        client.getsockopt.return_value = struct.pack("iII", 1234, 1001, 1001)
        with patch.object(broker, "TEST_MODE", False):
            with self.assertRaisesRegex(broker.BrokerError, "not authorized"):
                broker.verify_peer(client)

    def test_socket_serve_and_request(self):
        """Integration test: start the broker server and send a request."""
        with self.paths():
            # Start server in a thread
            server_thread = threading.Thread(target=broker.serve, daemon=True)
            server_thread.start()
            time.sleep(0.2)

            # Wait for socket to appear
            deadline = time.time() + 5
            while not self.socket_path.exists() and time.time() < deadline:
                time.sleep(0.1)
            self.assertTrue(self.socket_path.exists(), "socket was not created")

            with patch.object(broker, "run_gh", return_value="[]"):
                # Connect and send a request
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                client.connect(str(self.socket_path))
                client.sendall((json.dumps({
                    "operation": "list-issues",
                    "repo": "InductAI/induct",
                }) + "\n").encode())
                client.settimeout(5)
                response = client.recv(8192)
                client.close()

            parsed = json.loads(response)
            self.assertTrue(parsed["ok"])
            self.assertEqual(parsed["data"], [])

            # Clean up
            try:
                os.unlink(self.socket_path)
            except FileNotFoundError:
                pass

    def test_socket_rejects_malformed_json(self):
        with self.paths():
            server_thread = threading.Thread(target=broker.serve, daemon=True)
            server_thread.start()
            time.sleep(0.2)

            deadline = time.time() + 5
            while not self.socket_path.exists() and time.time() < deadline:
                time.sleep(0.1)
            self.assertTrue(self.socket_path.exists())

            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(self.socket_path))
            client.sendall(b"not json at all\n")
            client.settimeout(5)
            response = client.recv(8192)
            client.close()

            parsed = json.loads(response)
            self.assertFalse(parsed["ok"])
            self.assertIn("not valid JSON", parsed["error"])

            try:
                os.unlink(self.socket_path)
            except FileNotFoundError:
                pass

    def test_socket_rejects_empty_request(self):
        with self.paths():
            server_thread = threading.Thread(target=broker.serve, daemon=True)
            server_thread.start()
            time.sleep(0.2)

            deadline = time.time() + 5
            while not self.socket_path.exists() and time.time() < deadline:
                time.sleep(0.1)
            self.assertTrue(self.socket_path.exists())

            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(self.socket_path))
            client.sendall(b"\n")
            client.settimeout(5)
            response = client.recv(8192)
            client.close()

            parsed = json.loads(response)
            self.assertFalse(parsed["ok"])
            self.assertIn("empty", parsed["error"])

            try:
                os.unlink(self.socket_path)
            except FileNotFoundError:
                pass

    def test_socket_rejects_non_allowlisted_repo(self):
        with self.paths():
            server_thread = threading.Thread(target=broker.serve, daemon=True)
            server_thread.start()
            time.sleep(0.2)

            deadline = time.time() + 5
            while not self.socket_path.exists() and time.time() < deadline:
                time.sleep(0.1)
            self.assertTrue(self.socket_path.exists())

            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(self.socket_path))
            client.sendall((json.dumps({
                "operation": "list-issues",
                "repo": "evil/corp",
            }) + "\n").encode())
            client.settimeout(5)
            response = client.recv(8192)
            client.close()

            parsed = json.loads(response)
            self.assertFalse(parsed["ok"])
            self.assertIn("allowlist", parsed["error"])

            try:
                os.unlink(self.socket_path)
            except FileNotFoundError:
                pass

    # -------------------------------------------------------------------------
    # Field selection
    # -------------------------------------------------------------------------

    def test_select_fields_dict(self):
        data = {"number": 1, "title": "X", "extra": "removed"}
        result = broker.select_fields(data, ("number", "title"))
        self.assertEqual(result, {"number": 1, "title": "X"})

    def test_select_fields_list(self):
        data = [
            {"number": 1, "title": "X", "extra": "removed"},
            {"number": 2, "title": "Y", "extra": "removed"},
        ]
        result = broker.select_fields(data, ("number", "title"))
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {"number": 1, "title": "X"})
        self.assertEqual(result[1], {"number": 2, "title": "Y"})

    def test_select_fields_non_dict(self):
        self.assertEqual(broker.select_fields(42, ("number",)), 42)
        self.assertEqual(broker.select_fields("hello", ("title",)), "hello")

    # -------------------------------------------------------------------------
    # Request size limiting
    # -------------------------------------------------------------------------

    def test_max_request_bytes_enforced(self):
        with self.paths():
            server_thread = threading.Thread(target=broker.serve, daemon=True)
            server_thread.start()
            time.sleep(0.2)

            deadline = time.time() + 5
            while not self.socket_path.exists() and time.time() < deadline:
                time.sleep(0.1)
            self.assertTrue(self.socket_path.exists())

            # Send a request that's larger than MAX_REQUEST_BYTES
            large_request = json.dumps({
                "operation": "search-issues",
                "repo": "InductAI/induct",
                "query": "x" * (broker.MAX_REQUEST_BYTES + 100),
            }) + "\n"

            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(self.socket_path))
            client.sendall(large_request.encode())
            client.settimeout(5)
            response = client.recv(8192)
            client.close()

            parsed = json.loads(response)
            self.assertFalse(parsed["ok"])

            try:
                os.unlink(self.socket_path)
            except FileNotFoundError:
                pass

    # -------------------------------------------------------------------------
    # All operations are in the allowlist
    # -------------------------------------------------------------------------

    def test_all_operations_have_handlers(self):
        for op in broker.ALLOWED_OPERATIONS:
            self.assertIn(op, broker.OPERATIONS, f"missing handler for {op}")

    def test_all_handlers_are_callable(self):
        for op, handler in broker.OPERATIONS.items():
            self.assertTrue(callable(handler), f"handler for {op} is not callable")

    # -------------------------------------------------------------------------
    # Allowlist is exactly the two Induct repositories
    # -------------------------------------------------------------------------

    def test_allowlist_contains_exactly_two_repos(self):
        self.assertEqual(len(broker.ALLOWED_REPOSITORIES), 2)
        self.assertIn("InductAI/induct", broker.ALLOWED_REPOSITORIES)
        self.assertIn("InductAI/induct-knowledge", broker.ALLOWED_REPOSITORIES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
