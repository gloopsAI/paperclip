#!/usr/bin/env python3
"""Deterministic lifecycle tests for the host-only GitHub App broker."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone


MODULE_PATH = Path(__file__).with_name("github-app-credentials.py")
SPEC = importlib.util.spec_from_file_location("github_app_credentials", MODULE_PATH)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


class BrokerLifecycleTests(unittest.TestCase):
    def paths(self, root: Path):
        return patch.multiple(
            broker,
            LEGACY_RUNTIME=root / "run",
            RUNTIME=root / "state/credential-runtime",
            HERMES_TOKEN=root / "state/credential-runtime/hermes-token",
            PROJECTOR_TOKEN=root / "state/credential-runtime/projector-token",
            PROJECTOR_ROTATED=root / "state/credential-runtime/projector-rotated",
            HERMES_HOSTS=root / "profile/gh/hosts.yml",
            RECEIPT=root / "state/credential-runtime/credential-receipt.json",
            HISTORY=root / "state/credential-history.jsonl",
            HISTORY_LOCK=root / "state/credential-history.lock",
            COMMAND_LOCK=root / "state/credential-runtime/credential-lifecycle.lock",
            MINT_INTENTS=root / "state/credential-runtime/mint-intents.json",
            MIGRATION_BASELINE=root / "state/credential-runtime/migration-baseline.json",
            EXPIRY_HISTORY=root / "state/credential-expiry-history.jsonl",
            EXPIRY_HISTORY_LOCK=root / "state/credential-expiry-history.lock",
        )

    def test_pre_mint_intent_is_durable_before_the_external_request(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        minted = ("ghs_durable_intent_token", "2026-07-15T10:00:00Z", {"contents": "write"})

        def mint(_config, _permissions):
            ledger = broker.json.loads(broker.MINT_INTENTS.read_text())
            intent = ledger["intents"]["hermes"]
            self.assertRegex(intent["attemptId"], r"^[0-9a-f-]{36}$")
            self.assertLess(intent["startedAt"], intent["safeAfter"])
            return minted

        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker, "mint", side_effect=mint), patch.object(broker.os, "chown"):
            broker.refresh_role(config, "hermes")
            self.assertFalse(broker.MINT_INTENTS.exists())
            self.assertEqual(broker.HERMES_TOKEN.read_text(), minted[0] + "\n")

    def test_runtime_parent_is_fsynced_before_the_external_request(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        minted = ("ghs_durable_parent_token", "2026-07-15T10:00:00Z", {"contents": "write"})
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            events = []
            real_fsync_directory = broker.fsync_directory

            def fsync(path):
                events.append(("fsync", path))
                real_fsync_directory(path)

            def mint(_config, _permissions):
                events.append(("mint", None))
                return minted

            with patch.object(broker, "fsync_directory", side_effect=fsync), \
                    patch.object(broker, "mint", side_effect=mint):
                broker.refresh_role(config, "hermes")
            mint_index = events.index(("mint", None))
            self.assertIn(("fsync", broker.RUNTIME.parent.parent), events[:mint_index])
            self.assertIn(("fsync", broker.RUNTIME.parent), events[:mint_index])

    def test_uncertain_mint_failure_leaves_token_free_expiry_quarantine(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker, "mint", side_effect=broker.CredentialError("response lost")), \
                patch.object(broker.os, "chown"):
            with self.assertRaisesRegex(broker.CredentialError, "response lost"):
                broker.refresh_role({}, "projector")
            intents = broker.load_mint_intents()
            self.assertEqual(set(intents), {"projector"})
            self.assertFalse(broker.PROJECTOR_TOKEN.exists())

    def test_token_free_uncertain_mint_gets_a_post_crash_expiry_horizon(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.write_mint_intents({
                "hermes": {
                    "attemptId": "11111111-1111-4111-8111-111111111111",
                    "startedAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                },
            })
            broker.reconcile_expired_mint_intents()
            observed = broker.load_mint_intents()["hermes"]
            self.assertIn("observedAt", observed)
            self.assertGreater(observed["safeAfter"], observed["observedAt"])
            observed["observedAt"] = "2026-07-15T00:00:00Z"
            observed["safeAfter"] = "2026-07-15T01:05:00Z"
            broker.write_mint_intents({"hermes": observed})
            broker.reconcile_expired_mint_intents()
            self.assertFalse(broker.MINT_INTENTS.exists())
            clearance = broker.json.loads(broker.EXPIRY_HISTORY.read_text())
            self.assertEqual(clearance["schemaVersion"], "gloops.github-app-uncertainty-clearance.v1")
            self.assertEqual(clearance["disposition"], "token-free-uncertainty-cleared")
            self.assertNotIn("tokenFingerprint", clearance)

    def test_token_handle_mtime_extends_the_offline_expiry_horizon(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.write_mint_intents({
                "projector": {
                    "attemptId": "11111111-1111-4111-8111-111111111111",
                    "startedAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                },
            })
            broker.PROJECTOR_TOKEN.write_text("ghs_delayed_response_handle\n")
            broker.reconcile_expired_mint_intents()
            intent = broker.load_mint_intents()["projector"]
            self.assertTrue(broker.PROJECTOR_TOKEN.exists())
            self.assertIn("observedAt", intent)
            self.assertGreater(
                datetime.fromisoformat(intent["safeAfter"].replace("Z", "+00:00")),
                datetime.now(timezone.utc) + timedelta(seconds=3800),
            )

    def test_expired_token_handle_is_disposed_offline_with_chained_evidence(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.write_mint_intents({
                "hermes": {
                    "attemptId": "22222222-2222-4222-8222-222222222222",
                    "startedAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                },
            })
            broker.HERMES_TOKEN.write_text("ghs_expired_cleanup_handle\n")
            os.utime(broker.HERMES_TOKEN, (0, 0))
            broker.HERMES_HOSTS.parent.mkdir(parents=True)
            broker.HERMES_HOSTS.write_text("secret projection")
            with patch.object(broker, "revoke_value") as revoke:
                broker.reconcile_expired_mint_intents()
            revoke.assert_not_called()
            self.assertFalse(broker.HERMES_TOKEN.exists())
            self.assertFalse(broker.HERMES_HOSTS.exists())
            self.assertFalse(broker.MINT_INTENTS.exists())
            records = [broker.json.loads(line) for line in broker.EXPIRY_HISTORY.read_text().splitlines()]
            broker.validate_expiry_history(records)
            self.assertEqual(records[0]["disposition"], "expired-by-envelope")
            self.assertEqual(records[0]["role"], "hermes")
            self.assertNotIn("ghs_expired_cleanup_handle", broker.EXPIRY_HISTORY.read_text())

    def test_expired_recorded_token_terminally_reconciles_its_lifecycle_receipt(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            token = "ghs_expired_recorded_handle"
            fingerprint = broker.hashlib.sha256(token.encode()).hexdigest()
            broker.write_mint_intents({
                "hermes": {
                    "attemptId": "33333333-3333-4333-8333-333333333333",
                    "startedAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                },
            })
            broker.HERMES_TOKEN.write_text(token + "\n")
            os.utime(broker.HERMES_TOKEN, (0, 0))
            broker.RECEIPT.write_text(broker.json.dumps({
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "appId": 1,
                "installationId": 2,
                "repositoryId": 3,
                "repository": "gloopsAI/gloops-paperclip-plugin",
                "lifecycleId": "expired-recorded-lifecycle",
                "startedAt": "2026-07-15T00:00:00Z",
                "hermes": {"revokedAt": None, "expiredAt": None, "tokenFingerprint": fingerprint},
                "projector": {"revokedAt": "2026-07-15T00:01:00Z", "tokenFingerprint": "b" * 64},
            }))
            broker.reconcile_expired_mint_intents()
            receipt = broker.json.loads(broker.RECEIPT.read_text())
            self.assertIsInstance(receipt["hermes"]["expiredAt"], str)
            self.assertRegex(receipt["hermes"]["expiryReceiptDigest"], r"^[0-9a-f]{64}$")
            history = [broker.json.loads(line) for line in broker.HISTORY.read_text().splitlines()]
            broker.validate_history(history)
            self.assertEqual(receipt, history[-1])

    def test_post_mint_failure_revokes_the_token_and_leaves_no_artifact(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            minted = ("ghs_first_installation_token", "2026-07-15T10:00:00Z", {"contents": "write"})
            with patch.object(broker, "mint", return_value=minted), \
                    patch.object(broker, "record_mint", side_effect=OSError("receipt failed")), \
                    patch.object(broker, "revoke_value") as revoke:
                with self.assertRaisesRegex(OSError, "receipt failed"):
                    broker.refresh_role({}, "hermes")
            revoke.assert_called_once_with(minted[0])
            self.assertFalse(broker.HERMES_TOKEN.exists())
            self.assertFalse(broker.HERMES_HOSTS.exists())

    def test_post_mint_failure_retains_a_root_cleanup_handle_for_any_revocation_error(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            minted = ("ghs_first_installation_token", "2026-07-15T10:00:00Z", {"contents": "write"})
            with patch.object(broker, "mint", return_value=minted), \
                    patch.object(broker, "record_mint", side_effect=OSError("receipt failed")), \
                    patch.object(broker, "revoke_value", side_effect=OSError("network failed")):
                with self.assertRaisesRegex(OSError, "network failed"):
                    broker.refresh_role({}, "hermes")
            self.assertEqual(broker.HERMES_TOKEN.read_text(), minted[0] + "\n")
            self.assertTrue(broker.HERMES_HOSTS.exists())

    def test_independent_refresh_commands_own_only_their_service_token(self):
        with patch.object(broker, "refresh_role") as refresh_role:
            broker.command_refresh_hermes({"appId": 1})
            broker.command_refresh_projector({"appId": 1})
        self.assertEqual(
            [call.args for call in refresh_role.call_args_list],
            [({"appId": 1}, "hermes"), ({"appId": 1}, "projector")],
        )

    def test_successful_independent_refreshes_merge_a_non_secret_receipt(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        write = ("ghs_write_installation_token", "2026-07-15T10:00:00Z", {"contents": "write"})
        read = ("ghs_read_installation_token", "2026-07-15T10:00:00Z", {"contents": "read"})
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker, "mint", side_effect=[write, read]), \
                patch.object(broker.os, "chown"):
            broker.refresh_role(config, "hermes")
            broker.refresh_role(config, "projector")
            receipt = broker.RECEIPT.read_text()

            self.assertEqual(broker.HERMES_TOKEN.read_text(), write[0] + "\n")
            self.assertEqual(broker.PROJECTOR_TOKEN.read_text(), read[0] + "\n")
            self.assertNotIn(write[0], receipt)
            self.assertNotIn(read[0], receipt)
            self.assertIn('"hermes"', receipt)
            self.assertIn('"projector"', receipt)
            self.assertIn('"revokedAt": null', receipt)
            self.assertIn('"lifecycleId"', receipt)
            self.assertIn('"mintedAt"', receipt)

    def test_projector_token_is_revoked_even_when_secret_rotation_fails(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME.mkdir(parents=True)
            broker.PROJECTOR_TOKEN.write_text("ghs_projector_installation_token\n")
            broker.PROJECTOR_ROTATED.write_text("rotated\n")
            with patch.object(broker, "rotate_projector", side_effect=broker.CredentialError("Paperclip unavailable")), \
                    patch.object(broker, "revoke_value") as revoke:
                with self.assertRaisesRegex(broker.CredentialError, "could not be cleared"):
                    broker.command_clear_projector({})
            revoke.assert_called_once_with("ghs_projector_installation_token")
            self.assertFalse(broker.PROJECTOR_TOKEN.exists())
            self.assertFalse(broker.PROJECTOR_ROTATED.exists())

    def test_board_credentials_must_be_root_owned_and_protected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "board-token"
            path.write_text("pcp_board_" + "a" * 48)
            path.chmod(0o644)
            with self.assertRaisesRegex(broker.CredentialError, "root-owned mode"):
                broker.read_root_secret(path, "Paperclip board token")

    def test_projector_rotation_derives_the_exact_secret_from_plugin_config(self):
        company_id = "22222222-2222-4222-8222-222222222222"
        secret_id = "77777777-7777-4777-8777-777777777777"

        def paperclip(method, path, _token, body=None):
            if method == "GET" and path.endswith("/config"):
                return {"configJson": {"companyId": company_id, "githubTokenSecretRef": secret_id}}
            if method == "GET" and path == f"/companies/{company_id}/secrets":
                return [{"id": secret_id, "companyId": company_id, "scope": "company", "status": "active"}]
            if method == "POST" and path == f"/secrets/{secret_id}/rotate":
                self.assertEqual(body, {"value": "ghs_new_value"})
                return {"id": secret_id}
            raise AssertionError((method, path))

        with patch.object(broker, "read_root_secret", return_value="pcp_board_" + "a" * 48), \
                patch.object(broker, "paperclip_request", side_effect=paperclip) as request:
            broker.rotate_projector({"boardTokenPath": "/root/board"}, "ghs_new_value")
        self.assertEqual(request.call_count, 3)

    def test_projector_rotation_refuses_a_secret_outside_the_configured_company(self):
        company_id = "22222222-2222-4222-8222-222222222222"
        secret_id = "77777777-7777-4777-8777-777777777777"
        responses = [
            {"configJson": {"companyId": company_id, "githubTokenSecretRef": secret_id}},
            [],
        ]
        with patch.object(broker, "read_root_secret", return_value="pcp_board_" + "a" * 48), \
                patch.object(broker, "paperclip_request", side_effect=responses) as request:
            with self.assertRaisesRegex(broker.CredentialError, "absent from its configured company"):
                broker.rotate_projector({"boardTokenPath": "/root/board"}, "ghs_new_value")
        self.assertEqual(request.call_count, 2)

    def test_mint_validation_cleanup_surfaces_a_token_for_durable_retention(self):
        token = "ghs_" + "a" * 36
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        response = {
            "token": token,
            "expires_at": expires_at,
            "permissions": {**broker.WRITE_PERMISSIONS, "metadata": "read"},
        }
        with patch.object(broker, "app_jwt", return_value="jwt"), \
                patch.object(broker, "request_json", return_value=response), \
                patch.object(broker, "verify_repository", side_effect=broker.CredentialError("boundary drift")), \
                patch.object(broker, "revoke_value", side_effect=OSError("network failed")):
            with self.assertRaises(broker.CredentialRetentionError) as raised:
                broker.mint({"installationId": 1, "repositoryId": 2}, broker.WRITE_PERMISSIONS)
        self.assertEqual(raised.exception.token, token)

    def test_refresh_persists_a_cleanup_handle_returned_by_failed_mint_validation(self):
        token = "ghs_" + "a" * 36
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            with patch.object(broker, "mint", side_effect=broker.CredentialRetentionError(token)):
                with self.assertRaises(broker.CredentialRetentionError):
                    broker.refresh_role({}, "projector")
            self.assertEqual(broker.PROJECTOR_TOKEN.read_text(), token + "\n")
            self.assertEqual(set(broker.load_mint_intents()), {"projector"})

    def test_mint_intent_remains_until_receipt_is_durable(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        minted = ("ghs_receipt_order_token", "2026-07-15T10:00:00Z", {"contents": "write"})
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            def record(*_args):
                self.assertTrue(broker.HERMES_TOKEN.exists())
                self.assertEqual(set(broker.load_mint_intents()), {"hermes"})

            with patch.object(broker, "mint", return_value=minted), patch.object(broker, "record_mint", side_effect=record):
                broker.refresh_role(config, "hermes")
            self.assertFalse(broker.MINT_INTENTS.exists())

    def test_failure_after_receipt_persistence_records_revocation_before_cleanup(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        minted = ("ghs_recorded_before_cleanup", "2026-07-15T10:00:00Z", {"contents": "write"})
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"), patch.object(broker, "mint", return_value=minted), \
                patch.object(broker, "revoke_value") as revoke, \
                patch.object(broker, "clear_mint_intent", side_effect=[OSError("clear failed"), None]):
            with self.assertRaisesRegex(OSError, "clear failed"):
                broker.refresh_role(config, "hermes")
            revoke.assert_called_once_with(minted[0])
            receipt = broker.json.loads(broker.RECEIPT.read_text())
            self.assertIsInstance(receipt["hermes"]["revokedAt"], str)
            self.assertFalse(broker.HERMES_TOKEN.exists())

    def test_revocation_receipt_is_bound_to_the_exact_token_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            token = "ghs_exact_projector_token"
            broker.RUNTIME.mkdir(parents=True)
            broker.PROJECTOR_TOKEN.write_text(token + "\n")
            receipt = {
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "hermes": {"tokenFingerprint": "0" * 64, "revokedAt": None},
                "projector": {
                    "tokenFingerprint": broker.hashlib.sha256(token.encode()).hexdigest(),
                    "revokedAt": None,
                },
            }
            (broker.RUNTIME / "credential-receipt.json").write_text(broker.json.dumps(receipt))
            with patch.object(broker, "revoke_value"), patch.object(broker.os, "chown"):
                broker.revoke(broker.PROJECTOR_TOKEN)
            updated = broker.json.loads((broker.RUNTIME / "credential-receipt.json").read_text())
            self.assertRegex(updated["projector"]["revokedAt"], r"Z$")
            self.assertIsNone(updated["hermes"]["revokedAt"])

    def test_complete_lifecycle_is_archived_once_with_a_digest(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.RUNTIME.mkdir(parents=True)
            receipt = {
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "appId": 1,
                "installationId": 2,
                "repositoryId": 3,
                "repository": "gloopsAI/gloops-paperclip-plugin",
                "lifecycleId": "one",
                "startedAt": "2026-07-15T00:00:00Z",
                "hermes": {"revokedAt": "2026-07-15T00:01:00Z"},
                "projector": {"revokedAt": "2026-07-15T00:02:00Z"},
            }
            broker.RECEIPT.write_text(broker.json.dumps(receipt))
            broker.archive_completed_receipt()
            broker.archive_completed_receipt()
            lines = broker.HISTORY.read_text().splitlines()
            current = broker.json.loads(broker.RECEIPT.read_text())
            archived = broker.json.loads(lines[0])
            self.assertEqual(len(lines), 1)
            self.assertEqual(current["receiptDigest"], archived["receiptDigest"])
            self.assertRegex(current["receiptDigest"], r"^[0-9a-f]{64}$")
            self.assertEqual(archived["sequence"], 1)
            self.assertIsNone(archived["previousReceiptDigest"])

    def test_archived_lifecycle_cannot_be_mutated_under_its_existing_identity(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            original = {
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "lifecycleId": "immutable",
                "completedAt": "2026-07-15T00:00:00Z",
            }
            broker.append_credential_history(original)
            with self.assertRaisesRegex(broker.CredentialError, "changed after archival"):
                broker.append_credential_history({**original, "unexpected": True})

    def test_reconcile_after_recorded_revocation_preserves_exact_history_tail(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            token = "ghs_already_terminal_handle"
            fingerprint = broker.hashlib.sha256(token.encode()).hexdigest()
            archived = broker.append_credential_history({
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "lifecycleId": "terminal-before-crash",
                "completedAt": "2026-07-15T00:02:00Z",
                "hermes": {"revokedAt": "2026-07-15T00:01:00Z", "tokenFingerprint": fingerprint},
                "projector": {"revokedAt": "2026-07-15T00:02:00Z", "tokenFingerprint": "b" * 64},
            })
            broker.RECEIPT.parent.mkdir(parents=True, exist_ok=True)
            broker.RECEIPT.write_text(broker.json.dumps(archived))
            broker.write_mint_intents({
                "hermes": {
                    "attemptId": "55555555-5555-4555-8555-555555555555",
                    "startedAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                },
            })
            broker.HERMES_TOKEN.write_text(token + "\n")
            os.utime(broker.HERMES_TOKEN, (0, 0))
            broker.reconcile_expired_mint_intents()
            current = broker.json.loads(broker.RECEIPT.read_text())
            tail = broker.json.loads(broker.HISTORY.read_text().splitlines()[-1])
            self.assertFalse(broker.HERMES_TOKEN.exists())
            self.assertFalse(broker.MINT_INTENTS.exists())
            self.assertEqual(current, tail)
            self.assertEqual(current["receiptDigest"], broker.history_digest(current))

    def test_concurrent_history_appends_preserve_both_lifecycles(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            barrier = threading.Barrier(2)
            errors = []

            def append(lifecycle):
                try:
                    barrier.wait()
                    broker.append_credential_history({
                        "schemaVersion": "gloops.github-app-credential-receipt.v1",
                        "lifecycleId": lifecycle,
                        "completedAt": "2026-07-15T00:00:00Z",
                    })
                except Exception as error:  # pragma: no cover - asserted below
                    errors.append(error)

            threads = [threading.Thread(target=append, args=(value,)) for value in ("one", "two")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            records = [broker.json.loads(line) for line in broker.HISTORY.read_text().splitlines()]
            broker.validate_history(records)
        self.assertEqual(errors, [])
        self.assertEqual(len(records), 2)

    def test_refresh_refuses_to_overwrite_complete_receipt_if_archive_fails(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME.mkdir(parents=True)
            complete = {
                **broker.receipt_base(config),
                "hermes": {"revokedAt": "2026-07-15T00:01:00Z"},
                "projector": {"revokedAt": "2026-07-15T00:02:00Z"},
            }
            broker.RECEIPT.write_text(broker.json.dumps(complete))
            with patch.object(broker, "archive_completed_receipt", side_effect=OSError("disk full")), \
                    patch.object(broker, "mint") as mint:
                with self.assertRaisesRegex(OSError, "disk full"):
                    broker.refresh_role(config, "hermes")
            mint.assert_not_called()

    def test_failed_revocation_retains_the_token_for_retry_and_dark_refusal(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME.mkdir(parents=True)
            broker.HERMES_TOKEN.write_text("ghs_retryable_write_token\n")
            with patch.object(broker, "revoke_value", side_effect=broker.CredentialError("unavailable")):
                with self.assertRaisesRegex(broker.CredentialError, "unavailable"):
                    broker.revoke(broker.HERMES_TOKEN)
            self.assertEqual(broker.HERMES_TOKEN.read_text(), "ghs_retryable_write_token\n")

    def test_reboot_after_recorded_revocation_clears_handle_without_second_api_call(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            token = "ghs_already_revoked_write_token"
            broker.RUNTIME.mkdir(parents=True)
            broker.HERMES_TOKEN.write_text(token + "\n")
            broker.RECEIPT.write_text(broker.json.dumps({
                "hermes": {
                    "tokenFingerprint": broker.hashlib.sha256(token.encode()).hexdigest(),
                    "revokedAt": "2026-07-15T00:00:00Z",
                },
            }))
            with patch.object(broker, "revoke_value") as revoke, patch.object(broker.os, "chown"):
                broker.revoke(broker.HERMES_TOKEN)
            revoke.assert_not_called()
            self.assertFalse(broker.HERMES_TOKEN.exists())

    def test_invalid_remote_token_is_terminal_revocation_evidence(self):
        with patch.object(
            broker,
            "request_json",
            side_effect=broker.GitHubAPIError("DELETE", "/installation/token", 401),
        ):
            broker.revoke_value("ghs_expired_or_revoked_token")

    def test_revoked_token_is_removed_even_when_receipt_persistence_fails(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME.mkdir(parents=True)
            broker.HERMES_TOKEN.write_text("ghs_revoked_write_token\n")
            with patch.object(broker, "revoke_value"), \
                    patch.object(broker, "record_revocation", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    broker.revoke(broker.HERMES_TOKEN)
            self.assertFalse(broker.HERMES_TOKEN.exists())

    def test_legacy_runtime_receipt_and_cleanup_handle_migrate_durably(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.LEGACY_RUNTIME.mkdir(parents=True)
            legacy_token = broker.LEGACY_RUNTIME / "hermes-github-token"
            legacy_receipt = broker.LEGACY_RUNTIME / "credential-receipt.json"
            legacy_token.write_text("ghs_legacy_cleanup_handle\n")
            legacy_receipt.write_text('{"schemaVersion":"gloops.github-app-credential-receipt.v1"}\n')
            broker.migrate_persistent_state()
            self.assertEqual(broker.HERMES_TOKEN.read_text(), "ghs_legacy_cleanup_handle\n")
            self.assertTrue(broker.RECEIPT.exists())
            self.assertFalse(legacy_token.exists())
            self.assertFalse(legacy_receipt.exists())
            self.assertEqual(broker.load_migration_baseline()["status"], "pending")

    def test_missing_legacy_current_receipt_creates_full_expiry_quarantine(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.append_credential_history({
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "lifecycleId": "completed-before-reboot",
                "completedAt": "2026-07-15T00:00:00Z",
            })
            broker.migrate_persistent_state()
            self.assertTrue(broker.RECEIPT.exists())
            self.assertEqual(set(broker.load_mint_intents()), {"hermes", "projector"})

    def test_first_ever_missing_legacy_state_creates_full_expiry_quarantine(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.migrate_persistent_state()
            baseline = broker.load_migration_baseline()
            self.assertEqual(baseline["status"], "pending")
            self.assertEqual(set(broker.load_mint_intents()), {"hermes", "projector"})
            self.assertFalse(broker.RECEIPT.exists())

    def test_expired_quarantine_completes_migration_baseline(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.ensure_runtime()
            broker.atomic_write(
                broker.MIGRATION_BASELINE,
                broker.json.dumps({
                    "schemaVersion": "gloops.github-app-migration-baseline.v1",
                    "status": "pending",
                    "createdAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                }) + "\n",
                0o600,
            )
            broker.write_mint_intents({
                role: {
                    "attemptId": f"{index}" * 8 + "-1111-4111-8111-111111111111",
                    "startedAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                }
                for index, role in enumerate(("hermes", "projector"), 1)
            })
            broker.reconcile_expired_mint_intents()
            completed = broker.load_migration_baseline()
            self.assertEqual(completed["status"], "complete")
            self.assertEqual(completed["basis"], "expiry-quarantine-completed")
            self.assertEqual(completed["safeAfter"], "2026-07-15T01:05:00Z")

    def test_complete_legacy_receipt_still_requires_full_migration_quarantine(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.LEGACY_RUNTIME.mkdir(parents=True)
            (broker.LEGACY_RUNTIME / "credential-receipt.json").write_text(broker.json.dumps({
                "schemaVersion": "gloops.github-app-credential-receipt.v1",
                "appId": 1,
                "installationId": 2,
                "repositoryId": 3,
                "repository": "gloopsAI/gloops-paperclip-plugin",
                "hermes": {"revokedAt": "2026-07-15T00:00:01Z", "tokenFingerprint": "a" * 64},
                "projector": {"revokedAt": "2026-07-15T00:00:02Z", "tokenFingerprint": "b" * 64},
            }))
            broker.migrate_persistent_state()
            self.assertEqual(broker.load_migration_baseline()["status"], "pending")
            self.assertEqual(set(broker.load_mint_intents()), {"hermes", "projector"})

    def test_legacy_artifacts_cannot_reappear_after_migration_completed(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.ensure_runtime()
            broker.atomic_write(
                broker.MIGRATION_BASELINE,
                broker.json.dumps({
                    "schemaVersion": "gloops.github-app-migration-baseline.v1",
                    "status": "complete",
                    "createdAt": "2026-07-15T00:00:00Z",
                    "safeAfter": "2026-07-15T01:05:00Z",
                    "completedAt": "2026-07-15T01:05:00Z",
                    "basis": "expiry-quarantine-completed",
                }) + "\n",
                0o600,
            )
            broker.LEGACY_RUNTIME.mkdir(parents=True)
            (broker.LEGACY_RUNTIME / "credential-receipt.json").write_text("{}")
            with self.assertRaisesRegex(broker.CredentialError, "reappeared"):
                broker.migrate_persistent_state()

    def test_completed_migration_baseline_cannot_precede_its_full_horizon(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            broker.ensure_runtime()
            broker.MIGRATION_BASELINE.write_text(broker.json.dumps({
                "schemaVersion": "gloops.github-app-migration-baseline.v1",
                "status": "complete",
                "createdAt": "2026-07-15T00:00:00Z",
                "safeAfter": "2026-07-15T00:00:01Z",
                "completedAt": "2026-07-15T00:00:01Z",
                "basis": "expiry-quarantine-completed",
            }))
            with self.assertRaisesRegex(broker.CredentialError, "timestamps are malformed"):
                broker.load_migration_baseline()

    def test_projector_revoke_does_not_hide_an_uncleared_persistent_secret(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker, "revoke_value"), patch.object(broker.os, "chown"):
            broker.RUNTIME.mkdir(parents=True)
            broker.PROJECTOR_TOKEN.write_text("ghs_projector_installation_token\n")
            broker.PROJECTOR_ROTATED.write_text("rotated\n")
            with self.assertRaisesRegex(broker.CredentialError, "must be cleared"):
                broker.command_revoke_projector({})
            self.assertFalse(broker.PROJECTOR_TOKEN.exists())
            self.assertTrue(broker.PROJECTOR_ROTATED.exists())


if __name__ == "__main__":
    unittest.main()
