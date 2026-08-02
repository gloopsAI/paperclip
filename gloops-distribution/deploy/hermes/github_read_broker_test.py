#!/usr/bin/env python3
"""Deterministic tests for the root-owned read-only GitHub evidence broker."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import re
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


def build_hierarchical_fixture(num_dirs=40, files_per_dir=30):
    """Build a repo tree with >1000 entries spread ACROSS directories.

    Each directory stays within ``MAX_TREE_ENTRIES``; the total exceeds 1000 so
    full enumeration REQUIRES multiple non-recursive per-directory reads.  A
    buried ``dir039/deep/late.ts`` route proves late/deep discovery through
    repeated ``--path-prefix`` calls.  Returns ``(root_tree_sha, trees,
    total_files)`` where ``trees`` maps a 40-hex tree SHA to its immediate
    entries.
    """
    trees: dict[str, list] = {}
    root_sha = format(0x1000, "040x")
    root_entries = []
    total_files = 0
    for d in range(num_dirs):
        dir_name = f"dir{d:03d}"
        dir_sha = format(0x2000 + d, "040x")
        root_entries.append(
            {"path": dir_name, "type": "tree", "mode": "040000", "sha": dir_sha}
        )
        dir_entries = []
        for f in range(files_per_dir):
            dir_entries.append({
                "path": f"file{f:03d}.ts", "type": "blob", "mode": "100644",
                "sha": format(0x300000 + d * 1000 + f, "040x"), "size": 10,
            })
            total_files += 1
        if d == num_dirs - 1:
            deep_sha = format(0x9000, "040x")
            dir_entries.append(
                {"path": "deep", "type": "tree", "mode": "040000", "sha": deep_sha}
            )
            trees[deep_sha] = [{
                "path": "late.ts", "type": "blob", "mode": "100644",
                "sha": format(0x9999, "040x"), "size": 5,
            }]
        trees[dir_sha] = dir_entries
    trees[root_sha] = root_entries
    return root_sha, trees, total_files


def hierarchical_router(root_sha, trees, commit=VALID_SHA,
                        truncated_shas=frozenset()):
    """gh mock that serves the hierarchical fixture NON-recursively."""
    def mock(args, env=None):
        path = args[1]
        assert "recursive" not in path, f"recursive tree read is forbidden: {path}"
        if "/commits/" in path:
            return json.dumps({"sha": commit, "commit": {"tree": {"sha": root_sha}}})
        match = re.search(r"/git/trees/([0-9a-f]{40})$", path)
        if match:
            sha = match.group(1)
            if sha not in trees:
                raise AssertionError(f"unknown tree sha requested: {sha}")
            return json.dumps(
                {"sha": sha, "truncated": sha in truncated_shas, "tree": trees[sha]}
            )
        raise AssertionError(f"unexpected gh api path: {path}")
    return mock


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
                       default_branch="main", full_name=None, repo_object=True):
        resolved = sha if resolved is None else resolved
        full_name = repo if full_name is None else full_name

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
                if not repo_object:
                    return json.dumps(["unexpected", "array", "payload"])
                return json.dumps({
                    "default_branch": default_branch,
                    "full_name": full_name,
                    "private": True,
                })
            raise AssertionError(f"unexpected gh api path: {path}")

        return mock

    def _tree_mock(self, entries, truncated=False, tree_sha=TREE_SHA,
                   commit=VALID_SHA, root_tree=None):
        """Endpoint-aware router for the hierarchical (non-recursive) tree op.

        Resolves ``/commits/<sha>`` to the root tree SHA, then serves the flat
        ``entries`` for a single ``/git/trees/<tree_sha>`` read.  Asserts the
        request NEVER carries ``recursive=1``.
        """
        root_tree = tree_sha if root_tree is None else root_tree

        def mock(args, env=None):
            path = args[1]
            assert "recursive" not in path, f"recursive tree read is forbidden: {path}"
            if "/commits/" in path:
                return json.dumps({
                    "sha": commit,
                    "commit": {"tree": {"sha": root_tree}},
                })
            if "/git/trees/" in path:
                return json.dumps({
                    "sha": tree_sha, "truncated": truncated, "tree": entries,
                })
            raise AssertionError(f"unexpected gh api path: {path}")

        return mock

    def _file_mock(self, content_bytes, size=None, encoding="base64",
                   type_="file", path="src/app.ts", sha=BLOB_SHA):
        def mock(args, env=None):
            payload = {
                "type": type_,
                "path": path,
                "sha": sha,
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
        # Immediate directory entries: one blob and one child tree.  A
        # non-recursive read returns bare entry NAMES (never full paths).
        entries = [
            {"path": "app.ts", "mode": "100644", "type": "blob",
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
                self.assertEqual(data["pathPrefix"], "")
                self.assertEqual(data["rootTree"], TREE_SHA)
                self.assertEqual(data["totalReturned"], 2)
                # Deterministic sort by immediate name: app.ts precedes src.
                self.assertEqual(data["entries"][0]["path"], "app.ts")
                self.assertEqual(data["entries"][0]["type"], "blob")
                # Child tree entries carry the child tree SHA and type so Harbor
                # can recurse with a deeper --path-prefix.
                child = data["entries"][1]
                self.assertEqual(child["path"], "src")
                self.assertEqual(child["type"], "tree")
                self.assertEqual(child["sha"], TREE_SHA)
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
                # Receipt carries the verified blob sha.
                self.assertEqual(data["sha"], BLOB_SHA)

    def test_get_source_file_uses_exact_sha_as_ref(self):
        captured = []

        def mock(args, env=None):
            captured.append(args)
            return json.dumps({
                "type": "file", "path": "src/app.ts", "sha": BLOB_SHA,
                "encoding": "base64",
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

    # -- metadata exact-evidence integrity: identity / payload fail closed -----

    def test_metadata_rejects_non_object_repo_payload(self):
        repo = "gloopsAI/gloops-ui"
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._metadata_mock(
                    repo, VALID_SHA, repo_object=False)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "unexpected repository payload"):
                    broker.process_request({
                        "operation": "get-repo-source-metadata",
                        "repo": repo, "commit": VALID_SHA,
                    })

    def test_metadata_rejects_full_name_mismatch(self):
        repo = "gloopsAI/gloops-ui"
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._metadata_mock(
                    repo, VALID_SHA, full_name="gloopsAI/impostor-repo")):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "identity verification failed"):
                    broker.process_request({
                        "operation": "get-repo-source-metadata",
                        "repo": repo, "commit": VALID_SHA,
                    })

    def test_metadata_rejects_case_only_full_name_variant(self):
        # A case-only variant must FAIL closed (exact, non-normalized equality).
        repo = "gloopsAI/gloops-ui"
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._metadata_mock(
                    repo, VALID_SHA, full_name="gloopsAI/Gloops-UI")):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "identity verification failed"):
                    broker.process_request({
                        "operation": "get-repo-source-metadata",
                        "repo": repo, "commit": VALID_SHA,
                    })

    def test_metadata_rejects_missing_default_branch(self):
        repo = "gloopsAI/gloops-ui"
        for bad_branch in ("", None):
            with self.subTest(default_branch=bad_branch):
                with self.paths():
                    with patch.object(broker, "run_gh",
                                      side_effect=self._metadata_mock(
                                          repo, VALID_SHA,
                                          default_branch=bad_branch)):
                        with self.assertRaisesRegex(broker.BrokerError,
                                                    "missing a default branch"):
                            broker.process_request({
                                "operation": "get-repo-source-metadata",
                                "repo": repo, "commit": VALID_SHA,
                            })

    # -- file exact-evidence integrity: path / blob-sha / size fail closed -----

    def test_get_source_file_rejects_path_mismatch(self):
        # Upstream returns a different path than requested -> fail closed rather
        # than echo the requested coordinates against unrelated content.
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._file_mock(
                    b"content", path="some/other/file.ts")):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "path verification failed"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    def test_get_source_file_rejects_missing_or_malformed_blob_sha(self):
        # "A"*40 is a valid-length but UPPERCASE hex -> rejected (lowercase only).
        for bad_sha in (None, "not-a-sha", "abc123", "A" * 40):
            with self.subTest(sha=bad_sha):
                with self.paths():
                    with patch.object(broker, "run_gh",
                                      side_effect=self._file_mock(
                                          b"content", sha=bad_sha)):
                        with self.assertRaisesRegex(broker.BrokerError,
                                                    "exact blob SHA"):
                            broker.process_request({
                                "operation": "get-source-file",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                                "path": "src/app.ts",
                            })

    def test_get_source_file_rejects_size_mismatch(self):
        # Reported size (within the cap) disagrees with the decoded byte count.
        body = b"exactly-eleven"  # 14 bytes
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._file_mock(body, size=len(body) + 3)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "does not match the decoded byte count"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    def test_get_source_file_rejects_malformed_size(self):
        # The nonnegative-integer size gate on the FILE response: a missing,
        # boolean, string, float, or negative size must all fail closed.  (bool
        # is an int subclass in Python, so it must be rejected explicitly.)
        def raw_file_mock(size_value):
            def mock(args, env=None):
                return json.dumps({
                    "type": "file", "path": "src/app.ts", "sha": BLOB_SHA,
                    "encoding": "base64",
                    "content": base64.b64encode(b"content").decode(),
                    "size": size_value,
                })
            return mock

        for bad_size in (None, True, False, "100", 1.5, -1):
            with self.subTest(size=bad_size):
                with self.paths():
                    with patch.object(broker, "run_gh",
                                      side_effect=raw_file_mock(bad_size)):
                        with self.assertRaisesRegex(broker.BrokerError,
                                                    "missing or invalid size"):
                            broker.process_request({
                                "operation": "get-source-file",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                                "path": "src/app.ts",
                            })

    def test_get_source_file_rejects_non_file_type(self):
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._file_mock(
                    b"content", type_="dir")):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "does not reference a single file"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
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

    def test_list_source_tree_fails_closed_on_oversize_single_directory(self):
        # NEGATIVE fixture: >MAX_TREE_ENTRIES IMMEDIATE entries in ONE directory.
        # A Git tree object has no in-object continuation cursor, so the op MUST
        # fail typed/closed rather than silently slice and drop entries.
        entries = [
            {"path": f"f{i}.ts", "mode": "100644", "type": "blob",
             "sha": BLOB_SHA, "size": 1}
            for i in range(broker.MAX_TREE_ENTRIES + 50)
        ]
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._tree_mock(entries, truncated=False)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "bounded immediate-entry limit"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_list_source_tree_fails_closed_on_upstream_truncated(self):
        # An upstream ``truncated: true`` on a single non-recursive tree read
        # means the inventory would be incomplete -> fail typed/closed.
        entries = [{"path": "a.ts", "mode": "100644", "type": "blob",
                    "sha": BLOB_SHA, "size": 1}]
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._tree_mock(entries, truncated=True)):
                with self.assertRaisesRegex(broker.BrokerError, "incomplete"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_list_source_tree_fails_typed_on_upstream_ceiling(self):
        # A single directory whose raw response exceeds run_gh's ~512 KiB ceiling
        # surfaces as a TYPED BrokerError (never a silent slice).
        def mock(args, env=None):
            path = args[1]
            if "/commits/" in path:
                return json.dumps({"sha": VALID_SHA,
                                   "commit": {"tree": {"sha": TREE_SHA}}})
            raise broker.BrokerError(
                "gh CLI output exceeds the bounded-response ceiling")
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "exceeds the upstream response"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    # -- credential non-disclosure passes through the source ops --------------

    def test_source_file_response_strips_credentials(self):
        def mock(args, env=None):
            return json.dumps({
                "type": "file", "path": "src/app.ts", "sha": BLOB_SHA,
                "encoding": "base64",
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

    # -- hierarchical enumeration across >1000 entries (POSITIVE fixture) ------

    def test_deep_enumeration_discovers_late_routes_across_directories(self):
        root_sha, trees, total_files = build_hierarchical_fixture()
        self.assertGreater(total_files, 1000)
        router = hierarchical_router(root_sha, trees)
        seen_files = 0
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=router):
                root = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                })
                self.assertTrue(root["ok"])
                dir_entries = root["data"]["entries"]
                # Root holds only child trees; each within the immediate bound.
                self.assertTrue(all(e["type"] == "tree" for e in dir_entries))
                self.assertLessEqual(len(dir_entries), broker.MAX_TREE_ENTRIES)
                for dir_entry in dir_entries:
                    sub = broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "pathPrefix": dir_entry["path"],
                    })
                    self.assertTrue(sub["ok"])
                    seen_files += sum(
                        1 for e in sub["data"]["entries"] if e["type"] == "blob"
                    )
                # A late, deep route is only reachable via a two-component prefix.
                deep_prefix = f"{dir_entries[-1]['path']}/deep"
                deep = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                    "pathPrefix": deep_prefix,
                })
        # Full enumeration required many non-recursive per-directory reads and
        # surfaced more than 1000 blobs spread across directories.
        self.assertGreater(seen_files, 1000)
        self.assertTrue(deep["ok"])
        self.assertEqual(deep["data"]["pathPrefix"], deep_prefix)
        self.assertIn("late.ts", [e["path"] for e in deep["data"]["entries"]])

    def test_list_source_tree_authorization_separation(self):
        # gloops-ui and paperclip-gym each succeed independently; a third
        # gloopsAI repo outside the allowlist is rejected before any gh call.
        entries = [{"path": "src", "type": "tree", "mode": "040000", "sha": TREE_SHA}]
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
                self.assertEqual(result["data"]["repo"], repo)
        with self.paths():
            unreached = MagicMock()
            with patch.object(broker, "run_gh", unreached):
                with self.assertRaisesRegex(broker.BrokerError, "allowlist"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/secret-internal",
                        "commit": VALID_SHA,
                    })
            unreached.assert_not_called()

    def test_list_source_tree_never_requests_recursive(self):
        captured = []
        entries = [{"path": "src", "type": "tree", "mode": "040000", "sha": TREE_SHA}]
        base = self._tree_mock(entries)

        def mock(args, env=None):
            captured.append(list(args))
            return base(args)

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                })
        joined = " ".join(tok for call in captured for tok in call)
        self.assertNotIn("recursive", joined)
        self.assertTrue(any("/commits/" in tok for call in captured for tok in call))
        self.assertTrue(any("/git/trees/" in tok for call in captured for tok in call))

    def test_list_source_tree_rejects_pathprefix_traversal(self):
        bad_prefixes = [
            "../etc", "a/../../b", "/abs", "a/./b", "..", "a//b", "a\\b",
            "with\x00nul",
        ]
        for bad in bad_prefixes:
            with self.subTest(prefix=bad):
                with self.paths():
                    unreached = MagicMock()
                    with patch.object(broker, "run_gh", unreached):
                        with self.assertRaises(broker.BrokerError):
                            broker.process_request({
                                "operation": "list-source-tree",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                                "pathPrefix": bad,
                            })
                    unreached.assert_not_called()

    def test_list_source_tree_rejects_prefix_into_a_file(self):
        # 'app.ts' is a blob, so a prefix cannot descend into it.
        entries = [{"path": "app.ts", "type": "blob", "mode": "100644",
                    "sha": BLOB_SHA, "size": 1}]
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._tree_mock(entries)):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "does not resolve to a directory"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "pathPrefix": "app.ts",
                    })

    def test_list_source_tree_fails_closed_on_oversize_intermediate_directory(self):
        # An OVER-LIMIT INTERMEDIATE directory encountered mid-walk fails typed,
        # exactly like an over-limit target directory.
        root_sha = format(0x1000, "040x")
        big_dir_sha = format(0x2000, "040x")
        trees = {
            root_sha: [
                {"path": "big", "type": "tree", "mode": "040000", "sha": big_dir_sha}
            ],
            big_dir_sha: [
                {"path": f"file{i:04d}.ts", "type": "blob", "mode": "100644",
                 "sha": format(0x300000 + i, "040x"), "size": 1}
                for i in range(broker.MAX_TREE_ENTRIES + 5)
            ],
        }
        router = hierarchical_router(root_sha, trees)
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=router):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "bounded immediate-entry limit"):
                    # Walk THROUGH 'big' toward a deeper component so 'big' is an
                    # intermediate (not target) directory when it fails.
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "pathPrefix": "big/whatever",
                    })

    def test_list_source_tree_fails_closed_on_truncated_intermediate(self):
        root_sha, trees, _ = build_hierarchical_fixture()
        intermediate_sha = format(0x2000 + 39, "040x")  # dir039
        router = hierarchical_router(
            root_sha, trees, truncated_shas=frozenset({intermediate_sha})
        )
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=router):
                with self.assertRaisesRegex(broker.BrokerError, "incomplete"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "pathPrefix": "dir039/deep",
                    })

    # -- exact-evidence integrity: malformed tree payloads fail closed ---------

    def _raw_tree_mock(self, tree_payload, root_tree=TREE_SHA, commit=VALID_SHA):
        def mock(args, env=None):
            path = args[1]
            assert "recursive" not in path
            if "/commits/" in path:
                return json.dumps({"sha": commit,
                                   "commit": {"tree": {"sha": root_tree}}})
            if "/git/trees/" in path:
                return json.dumps(tree_payload)
            raise AssertionError(f"unexpected gh api path: {path}")
        return mock

    def test_tree_object_missing_response_sha_fails_closed(self):
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._raw_tree_mock({"tree": []})):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "SHA verification failed"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_tree_object_non_list_tree_fails_closed(self):
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._raw_tree_mock(
                    {"sha": TREE_SHA, "tree": "not-a-list"})):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "well-formed entry list"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_tree_object_non_dict_entry_fails_closed(self):
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._raw_tree_mock(
                    {"sha": TREE_SHA, "tree": [123]})):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "not an object"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_tree_object_entry_missing_sha_fails_closed(self):
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._raw_tree_mock(
                    {"sha": TREE_SHA,
                     "tree": [{"type": "blob", "path": "a.ts"}]})):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "exact 40-hex object SHA"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_tree_object_entry_unknown_type_fails_closed(self):
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=self._raw_tree_mock(
                    {"sha": TREE_SHA,
                     "tree": [{"type": "symlink-ish", "path": "a.ts",
                               "sha": BLOB_SHA}]})):
                with self.assertRaisesRegex(broker.BrokerError,
                                            "unknown or missing type"):
                    broker.process_request({
                        "operation": "list-source-tree",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                    })

    def test_tree_object_entry_unsafe_name_fails_closed(self):
        # A separator embedded in an "immediate" name (traversal smuggling) or a
        # control character must fail the whole directory closed.
        for bad_name in ("../escape", "a/b", "a\x01b", "\x00"):
            with self.subTest(name=bad_name):
                with self.paths():
                    with patch.object(
                            broker, "run_gh", side_effect=self._raw_tree_mock(
                                {"sha": TREE_SHA,
                                 "tree": [{"type": "blob", "path": bad_name,
                                           "sha": BLOB_SHA}]})):
                        with self.assertRaisesRegex(broker.BrokerError,
                                                    "separator, NUL, or"):
                            broker.process_request({
                                "operation": "list-source-tree",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                            })

    def test_tree_entry_mode_must_match_type(self):
        cases = [
            # blob wearing a tree mode
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "040000",
             "size": 1},
            # tree wearing a blob mode
            {"type": "tree", "path": "d", "sha": TREE_SHA, "mode": "100644"},
            # unknown blob mode
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "100600",
             "size": 1},
            # submodule with the wrong mode
            {"type": "commit", "path": "sub", "sha": BLOB_SHA, "mode": "040000"},
            # missing mode entirely
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "size": 1},
        ]
        for entry in cases:
            with self.subTest(entry=entry):
                with self.paths():
                    with patch.object(
                            broker, "run_gh", side_effect=self._raw_tree_mock(
                                {"sha": TREE_SHA, "tree": [entry]})):
                        with self.assertRaisesRegex(broker.BrokerError,
                                                    "mode is missing or inconsistent"):
                            broker.process_request({
                                "operation": "list-source-tree",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                            })

    def test_tree_entry_size_must_be_valid(self):
        cases = [
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "100644",
             "size": True},   # bool is not an int size
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "100644",
             "size": 1.5},    # float
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "100644",
             "size": -1},     # negative
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "100644",
             "size": "10"},   # string
            {"type": "blob", "path": "a.ts", "sha": BLOB_SHA, "mode": "100644"},
            # blob missing size entirely
        ]
        for entry in cases:
            with self.subTest(entry=entry):
                with self.paths():
                    with patch.object(
                            broker, "run_gh", side_effect=self._raw_tree_mock(
                                {"sha": TREE_SHA, "tree": [entry]})):
                        with self.assertRaisesRegex(broker.BrokerError,
                                                    "nonnegative size"):
                            broker.process_request({
                                "operation": "list-source-tree",
                                "repo": "gloopsAI/gloops-ui",
                                "commit": VALID_SHA,
                            })

    def test_tree_entry_accepts_submodule_and_special_blob_modes(self):
        # A submodule gitlink (mode 160000, no size) plus executable/symlink
        # blob modes are all legitimate and must enumerate cleanly.
        entries = [
            {"type": "commit", "path": "vendored", "sha": BLOB_SHA,
             "mode": "160000"},
            {"type": "blob", "path": "run.sh", "sha": BLOB_SHA,
             "mode": "100755", "size": 3},
            {"type": "blob", "path": "link", "sha": BLOB_SHA,
             "mode": "120000", "size": 3},
        ]
        with self.paths():
            with patch.object(broker, "run_gh",
                              side_effect=self._raw_tree_mock(
                                  {"sha": TREE_SHA, "tree": entries})):
                result = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                })
        self.assertTrue(result["ok"])
        names = {e["path"] for e in result["data"]["entries"]}
        self.assertEqual(names, {"vendored", "run.sh", "link"})

    # -- strict base64: malformed content fails closed ------------------------

    def test_get_source_file_rejects_malformed_base64(self):
        # validate=False would silently drop the '!' and decode 'abcdef'; strict
        # decoding MUST fail closed on the injected non-alphabet byte.
        def mock(args, env=None):
            return json.dumps({
                "type": "file", "path": "src/app.ts", "sha": BLOB_SHA,
                "encoding": "base64", "content": "YWJj!ZGVm", "size": 6,
            })
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                with self.assertRaisesRegex(broker.BrokerError, "not valid base64"):
                    broker.process_request({
                        "operation": "get-source-file",
                        "repo": "gloopsAI/gloops-ui",
                        "commit": VALID_SHA,
                        "path": "src/app.ts",
                    })

    def test_get_source_file_accepts_newline_wrapped_base64(self):
        # GitHub wraps base64 with '\n' every 60 chars; the documented newline
        # normalization must accept it and decode exactly.
        body = b"export const answer = 42;\n" * 8
        encoded = base64.b64encode(body).decode()
        wrapped = "\n".join(
            encoded[i:i + 60] for i in range(0, len(encoded), 60)
        ) + "\n"
        self.assertIn("\n", wrapped)

        def mock(args, env=None):
            return json.dumps({"type": "file", "path": "src/app.ts",
                               "sha": BLOB_SHA, "encoding": "base64",
                               "content": wrapped, "size": len(body)})
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                result = broker.process_request({
                    "operation": "get-source-file",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                    "path": "src/app.ts",
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["content"], body.decode())

    # -- exact-target regression: legitimate names must NOT be stranded --------

    # Real path/blob at gloops-ui head 84a78a998e02249be20b8fccad6c43bdafdd8b2b.
    ASTRO_PATH = "artifacts/gloops-public/src/pages/doctrine/[slug].astro"
    ASTRO_BLOB_SHA = "7cbbbe4c18823c12d5b12c52270a7d9213a5580b"
    ASTRO_SIZE = 1571

    def test_get_source_file_reads_bracketed_astro_route(self):
        captured = []
        # Exact upstream byte count so the size<->decoded reconciliation passes.
        body = b"x" * self.ASTRO_SIZE

        def mock(args, env=None):
            captured.append(list(args))
            return json.dumps({
                "type": "file", "path": self.ASTRO_PATH,
                "sha": self.ASTRO_BLOB_SHA, "encoding": "base64",
                "content": base64.b64encode(body).decode(),
                "size": self.ASTRO_SIZE,
            })

        with self.paths():
            with patch.object(broker, "run_gh", side_effect=mock):
                result = broker.process_request({
                    "operation": "get-source-file",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                    "path": self.ASTRO_PATH,
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["path"], self.ASTRO_PATH)
        self.assertEqual(result["data"]["content"], body.decode())
        # Receipt carries the VERIFIED blob sha and the reconciled size.
        self.assertEqual(result["data"]["sha"], self.ASTRO_BLOB_SHA)
        self.assertEqual(result["data"]["size"], self.ASTRO_SIZE)
        self.assertEqual(result["data"]["commit"], VALID_SHA)
        # The contents URL URL-encodes reserved characters while preserving the
        # '/' separators; the raw '[' / ']' never reach the API path unescaped.
        url = captured[0][1]
        self.assertIn("%5Bslug%5D.astro", url)
        self.assertNotIn("[slug]", url)
        self.assertIn(
            "/repos/gloopsAI/gloops-ui/contents/"
            "artifacts/gloops-public/src/pages/doctrine/", url)

    def test_list_source_tree_enumerates_bracketed_route(self):
        # A `[slug].astro` blob and a `[locale]` directory must be enumerable and
        # descendable -- exactly the Astro dynamic-route shapes on the target.
        root_sha = format(0x1000, "040x")
        locale_sha = format(0x2000, "040x")
        trees = {
            root_sha: [
                {"path": "[slug].astro", "type": "blob", "mode": "100644",
                 "sha": BLOB_SHA, "size": 3},
                {"path": "[locale]", "type": "tree", "mode": "040000",
                 "sha": locale_sha},
            ],
            locale_sha: [
                {"path": "index.astro", "type": "blob", "mode": "100644",
                 "sha": BLOB_SHA, "size": 3},
            ],
        }
        router = hierarchical_router(root_sha, trees)
        with self.paths():
            with patch.object(broker, "run_gh", side_effect=router):
                root = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                })
                names = [e["path"] for e in root["data"]["entries"]]
                self.assertIn("[slug].astro", names)
                self.assertIn("[locale]", names)
                # Descend into the bracketed directory via --path-prefix.
                nested = broker.process_request({
                    "operation": "list-source-tree",
                    "repo": "gloopsAI/gloops-ui",
                    "commit": VALID_SHA,
                    "pathPrefix": "[locale]",
                })
        self.assertTrue(nested["ok"])
        self.assertEqual([e["path"] for e in nested["data"]["entries"]],
                         ["index.astro"])

    def test_is_safe_path_component_accepts_legitimate_git_names(self):
        legitimate = [
            "[slug].astro", "[...rest].tsx", "[locale]", "file with spaces.md",
            "café.ts", "naïve.json", "index@2x.png", "a+b.txt", "(group)",
            "package.json", "README", "a.b.c.d", "__init__.py", "x-y_z.ts",
            "こんにちは.md", "emoji😀.txt",
        ]
        for name in legitimate:
            with self.subTest(name=name):
                self.assertTrue(broker.is_safe_path_component(name),
                                f"legitimate name rejected: {name!r}")

    def test_is_safe_path_component_rejects_dangerous_components(self):
        dangerous = [
            "", ".", "..", "a/b", "a\\b", "a\x00b", "a\nb", "a\tb", "\x7f",
            "\x1f", "\x9f", "a" * 256,
        ]
        for name in dangerous:
            with self.subTest(name=name):
                self.assertFalse(broker.is_safe_path_component(name),
                                 f"dangerous name accepted: {name!r}")

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
