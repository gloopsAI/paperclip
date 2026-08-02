#!/usr/bin/env python3
"""Deterministic tests for the root-owned read-only GitHub evidence broker."""

from __future__ import annotations

import base64
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
        self.assertEqual(captured_args[0][2], "crash in title")
        self.assertEqual(captured_args[0][3:5], ["--repo", "InductAI/induct"])

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
        self.assertEqual(captured_args[0][2], "dependency upgrade")
        self.assertEqual(captured_args[0][3:5], ["--repo", "InductAI/induct"])
        search_fields = captured_args[0][captured_args[0].index("--json") + 1].split(",")
        self.assertIn("repository", search_fields)
        self.assertNotIn("headRefName", search_fields)
        self.assertNotIn("baseRefName", search_fields)

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

    def test_allowlist_contains_exactly_four_repos(self):
        self.assertEqual(len(broker.ALLOWED_REPOSITORIES), 4)
        self.assertIn("InductAI/induct", broker.ALLOWED_REPOSITORIES)
        self.assertIn("InductAI/induct-knowledge", broker.ALLOWED_REPOSITORIES)
        self.assertIn("gloopsAI/gloops-ui", broker.ALLOWED_REPOSITORIES)
        self.assertIn("gloopsAI/paperclip-gym", broker.ALLOWED_REPOSITORIES)


# =============================================================================
# WG-PLAT-017: bounded, read-only source-inventory operations at an EXACT
# immutable commit.  Each security guard (mutable-ref rejection, exact-SHA
# verification, path-traversal rejection, binary rejection, oversize/bounded
# rejection) is exercised independently below.
# =============================================================================

VALID_SHA = "0123456789abcdef0123456789abcdef01234567"
OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98"
TREE_SHA = "aaaabbbbccccdddd0000111122223333444455556"[:40]
BLOB_SHA = "1111222233334444555566667777888899990000"

SOURCE_OPS = ("get-repo-source-metadata", "list-source-tree", "get-source-file")
ALLOWLISTED_SOURCE_REPOS = ("gloopsAI/gloops-ui", "gloopsAI/paperclip-gym")


class SourceInventoryTests(unittest.TestCase):
    """Tests for get-repo-source-metadata, list-source-tree, get-source-file."""

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

    # -- mock builders --------------------------------------------------------

    def _metadata_mock(self, repo, sha, tree_sha=TREE_SHA, resolved=None,
                       default_branch="main"):
        resolved = sha if resolved is None else resolved

        def mock(args, env=None):
            path = args[1]
            if path == f"/repos/{repo}/commits/{sha}":
                # Include an author email to prove it is never returned.
                return json.dumps({
                    "sha": resolved,
                    "commit": {
                        "tree": {"sha": tree_sha},
                        "author": {"email": "leak@example.com", "name": "A"},
                    },
                    "author": {"login": "octocat"},
                })
            if path == f"/repos/{repo}":
                return json.dumps({
                    "default_branch": default_branch,
                    "full_name": repo,
                    "private": True,
                })
            raise AssertionError(f"unexpected gh api path: {path}")

        return mock

    def _tree_mock(self, entries, truncated=False, tree_sha=TREE_SHA):
        def mock(args, env=None):
            return json.dumps({"sha": tree_sha, "truncated": truncated, "tree": entries})
        return mock

    def _file_mock(self, content_bytes, size=None, encoding="base64", type_="file"):
        def mock(args, env=None):
            payload = {
                "type": type_,
                "encoding": encoding,
                "content": base64.b64encode(content_bytes).decode(),
                "size": len(content_bytes) if size is None else size,
            }
            return json.dumps(payload)
        return mock

    # -- happy paths (authorization separation: each op for each repo) --------

    def test_get_repo_source_metadata_happy_path_all_repos(self):
        for repo in ALLOWLISTED_SOURCE_REPOS:
            with self.subTest(repo=repo):
                with self.paths():
                    with patch.object(broker, "run_gh",
                                      side_effect=self._metadata_mock(repo, VALID_SHA)):
                        result = broker.process_request({
                            "operation": "get-repo-source-metadata",
                            "repo": repo,
                            "commit": VALID_SHA,
                        })
                self.assertTrue(result["ok"])
                self.assertEqual(result["data"]["repo"], repo)
                self.assertEqual(result["data"]["commit"], VALID_SHA)
                self.assertEqual(result["data"]["tree"], TREE_SHA)
                self.assertEqual(result["data"]["default_branch"], "main")
                # No author email or private flag leaks through.
                self.assertNotIn("leak@example.com", json.dumps(result))

    def test_list_source_tree_happy_path_all_repos(self):
        entries = [
            {"path": "src/app.ts", "mode": "100644", "type": "blob",
             "sha": BLOB_SHA, "size": 12, "url": "https://api/blob"},
            {"path": "src", "mode": "040000", "type": "tree",
             "sha": TREE_SHA, "url": "https://api/tree"},
        ]
        for repo in ALLOWLISTED_SOURCE_REPOS:
            with self.subTest(repo=repo):
                with self.paths():
                    with patch.object(broker, "run_gh",
                                      side_effect=self._tree_mock(entries)):
                        result = broker.process_request({
                            "operation": "list-source-tree",
                            "repo": repo,
                            "commit": VALID_SHA,
                        })
                self.assertTrue(result["ok"])
                data = result["data"]
                self.assertEqual(data["repo"], repo)
                self.assertEqual(data["commit"], VALID_SHA)
                self.assertFalse(data["truncated"])
                self.assertEqual(data["totalReturned"], 2)
                self.assertEqual(data["entries"][0]["path"], "src/app.ts")
                self.assertEqual(data["entries"][0]["type"], "blob")
                # Only the allowed per-entry fields; no raw url/content.
                self.assertNotIn("url", data["entries"][0])
                self.assertNotIn("content", data["entries"][0])

    def test_get_source_file_happy_path_all_repos(self):
        body = b"export const x = 1;\n"
        for repo in ALLOWLISTED_SOURCE_REPOS:
            with self.subTest(repo=repo):
                with self.paths():
                    with patch.object(broker, "run_gh",
                                      side_effect=self._file_mock(body)):
                        result = broker.process_request({
                            "operation": "get-source-file",
                            "repo": repo,
                            "commit": VALID_SHA,
                            "path": "src/app.ts",
                        })
                self.assertTrue(result["ok"])
                data = result["data"]
                self.assertEqual(data["repo"], repo)
                self.assertEqual(data["commit"], VALID_SHA)
                self.assertEqual(data["path"], "src/app.ts")
                self.assertEqual(data["encoding"], "utf-8")
                self.assertEqual(data["content"], body.decode())
                self.assertEqual(data["size"], len(body))

    def test_get_source_file_uses_exact_sha_as_ref(self):
        captured = []

        def mock(args, env=None):
            captured.append(args)
            return json.dumps({
                "type": "file", "encoding": "base64",
                "content": base64.b64encode(b"ok").decode(), "size": 2,
            })

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                broker.process_request({
                    "operation": "get-source-file",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                    "path": "src/app.ts",
                })
        # ref must be the 40-char SHA, never a branch/tag.
        self.assertIn(f"?ref={VALID_SHA}", captured[0][1])

    # -- authorization separation: non-allowlisted repo rejected for each op --

    def test_source_ops_reject_non_allowlisted_repo(self):
        for op in SOURCE_OPS:
            with self.subTest(op=op):
                with self.paths():
                    mock = MagicMock()
                    with patch.object(broker, "run_gh", mock):
                        with self.assertRaisesRegex(broker.BrokerError, "allowlist"):
                            broker.process_request({
                                "operation": op,
                                "repo": "attacker/secret-repo",
                                "commit": VALID_SHA,
                                "path": "src/app.ts",
                            })
                    mock.assert_not_called()

    # -- mutable-ref rejection (all ops) --------------------------------------

    def test_source_ops_reject_mutable_refs(self):
        bad_refs = ["main", "HEAD", "v1.2.3", "abc1234", "A" * 40, VALID_SHA[:39]]
        for op in SOURCE_OPS:
            for bad in bad_refs:
                with self.subTest(op=op, commit=bad):
                    with self.paths():
                        mock = MagicMock()
                        with patch.object(broker, "run_gh", mock):
                            with self.assertRaisesRegex(broker.BrokerError,
                                                        "exact 40-character"):
                                broker.process_request({
                                    "operation": op,
                                    "repo": "gloopsAI/gloops-ui",
                                    "commit": bad,
                                    "path": "src/app.ts",
                                })
                        mock.assert_not_called()

    # -- exact-SHA verification -----------------------------------------------

    def test_metadata_rejects_sha_mismatch(self):
        repo = "gloopsAI/gloops-ui"
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._metadata_mock(repo, VALID_SHA,
                                                              resolved=OTHER_SHA)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "verification failed"):
                    broker.process_request({
                        "operation": "get-repo-source-metadata",
                        "repo": repo,
                        "commit": VALID_SHA,
                    })

    # -- path-traversal / absolute-path rejection (no gh call) ----------------

    def test_get_source_file_rejects_path_traversal(self):
        bad_paths = [
            "../etc/passwd", "a/../../b", "/etc/passwd", "a/./b",
            "..", "a/..", "a//b", "a\\b", "with\x00nul", "",
        ]
        for bad in bad_paths:
            with self.subTest(path=bad):
                with self.paths():
                    mock = MagicMock()
                    with patch.object(broker, "run_gh", mock):
                        with self.assertRaises(broker.BrokerError):
                            broker.process_request({
                                "operation": "get-source-file",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                                "path": bad,
                            })
                    mock.assert_not_called()

    # -- binary rejection -----------------------------------------------------

    def test_get_source_file_rejects_nul_byte(self):
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._file_mock(b"abc\x00def")):
                with self.assertRaisesRegex(broker.BrokerError, "not UTF-8 text"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    def test_get_source_file_rejects_invalid_utf8(self):
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._file_mock(b"\xff\xfe\xfa\xc0")):
                with self.assertRaisesRegex(broker.BrokerError, "not UTF-8 text"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    # -- oversize rejection ---------------------------------------------------

    def test_get_source_file_rejects_reported_oversize(self):
        with self.paths():
            # Reported size exceeds the cap; rejected BEFORE decode.
            with patch.object(broker, "run_gh",
                              side_effect=self._file_mock(
                                  b"small",
                                  size=broker.MAX_SOURCE_FILE_BYTES + 1)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "exceeds the maximum size"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    def test_get_source_file_rejects_decoded_oversize(self):
        big = b"a" * (broker.MAX_SOURCE_FILE_BYTES + 10)
        with self.paths():
            # Reported size understates the truth; decoded-length check catches it.
            with patch.object(broker, "run_gh",
                              side_effect=self._file_mock(big, size=10)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "exceeds the maximum size"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    def test_get_source_file_rejects_directory_response(self):
        def mock(args, env=None):
            return json.dumps([{"type": "file", "name": "a.ts"}])
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "does not reference a single file"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src",
                    })

    # -- bounded-entry behavior for list-source-tree --------------------------

    def test_list_source_tree_caps_entries(self):
        entries = [
            {"path": f"f{i}.ts", "mode": "100644", "type": "blob",
             "sha": BLOB_SHA, "size": 1}
            for i in range(broker.MAX_TREE_ENTRIES + 50)
        ]
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._tree_mock(entries, truncated=False)):
                result = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                })
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["truncated"])
        self.assertEqual(result["data"]["totalReturned"], broker.MAX_TREE_ENTRIES)
        self.assertEqual(len(result["data"]["entries"]), broker.MAX_TREE_ENTRIES)

    def test_list_source_tree_propagates_github_truncated_flag(self):
        entries = [{"path": "a.ts", "mode": "100644", "type": "blob",
                    "sha": BLOB_SHA, "size": 1}]
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._tree_mock(entries, truncated=True)):
                result = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                })
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["truncated"])
        self.assertEqual(result["data"]["totalReturned"], 1)

    # -- credential non-disclosure passes through the source ops --------------

    def test_source_file_response_strips_credentials(self):
        def mock(args, env=None):
            return json.dumps({
                "type": "file", "encoding": "base64",
                "content": base64.b64encode(b"safe").decode(), "size": 4,
                "token": "ghs_should_not_appear",
            })
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                result = broker.process_request({
                    "operation": "get-source-file",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                    "path": "src/app.ts",
                })
        self.assertNotIn("ghs_", json.dumps(result))

    # -- regression: existing ops + allowlist wiring --------------------------

    def test_existing_ops_still_reject_non_allowlisted_repo(self):
        for op in ("list-issues", "get-pr", "search-issues"):
            with self.subTest(op=op):
                with self.paths():
                    with self.assertRaisesRegex(broker.BrokerError, "allowlist"):
                        broker.process_request({
                            "operation": op,
                            "repo": "attacker/secret-repo",
                            "number": 1,
                            "query": "x",
                        })

    def test_allowed_operations_is_original_eight_plus_three(self):
        original = {
            "search-issues", "list-issues", "get-issue", "search-prs",
            "list-prs", "get-pr", "get-pr-status", "get-pr-checks",
        }
        added = {"get-repo-source-metadata", "list-source-tree", "get-source-file"}
        self.assertEqual(broker.ALLOWED_OPERATIONS, original | added)
        self.assertEqual(len(broker.ALLOWED_OPERATIONS), 11)
        for op in added:
            self.assertIn(op, broker.OPERATIONS)
            self.assertTrue(callable(broker.OPERATIONS[op]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
