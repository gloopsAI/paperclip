#!/usr/bin/env python3
"""Deterministic lifecycle tests for the host-only GitHub App broker."""

from __future__ import annotations

import importlib.util
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
            RUNTIME=root / "run",
            HERMES_TOKEN=root / "run/hermes-token",
            PROJECTOR_TOKEN=root / "run/projector-token",
            PROJECTOR_ROTATED=root / "run/projector-rotated",
            HERMES_HOSTS=root / "profile/gh/hosts.yml",
            RECEIPT=root / "run/credential-receipt.json",
            HISTORY=root / "state/credential-history.jsonl",
            HISTORY_LOCK=root / "state/credential-history.lock",
            COMMAND_LOCK=root / "run/credential-lifecycle.lock",
        )

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

    def test_revoked_token_is_removed_even_when_receipt_persistence_fails(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME.mkdir(parents=True)
            broker.HERMES_TOKEN.write_text("ghs_revoked_write_token\n")
            with patch.object(broker, "revoke_value"), \
                    patch.object(broker, "record_revocation", side_effect=OSError("disk failure")):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    broker.revoke(broker.HERMES_TOKEN)
            self.assertFalse(broker.HERMES_TOKEN.exists())


if __name__ == "__main__":
    unittest.main()
