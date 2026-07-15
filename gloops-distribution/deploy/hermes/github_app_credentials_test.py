#!/usr/bin/env python3
"""Deterministic lifecycle tests for the host-only GitHub App broker."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


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
        )

    def test_partial_mint_revokes_the_first_token_and_leaves_no_artifact(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            first = ("ghs_first_installation_token", "2026-07-15T10:00:00Z", {"contents": "write"})
            with patch.object(broker, "mint", side_effect=[first, broker.CredentialError("second mint failed")]), \
                    patch.object(broker, "revoke_value") as revoke:
                with self.assertRaisesRegex(broker.CredentialError, "second mint failed"):
                    broker.refresh({})
            revoke.assert_called_once_with(first[0])
            self.assertFalse(broker.HERMES_TOKEN.exists())
            self.assertFalse(broker.PROJECTOR_TOKEN.exists())
            self.assertFalse(broker.HERMES_HOSTS.exists())

    def test_partial_mint_retains_a_root_cleanup_handle_when_revocation_fails(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker.os, "chown"):
            first = ("ghs_first_installation_token", "2026-07-15T10:00:00Z", {"contents": "write"})
            with patch.object(broker, "mint", side_effect=[first, broker.CredentialError("second mint failed")]), \
                    patch.object(broker, "revoke_value", side_effect=broker.CredentialError("revoke failed")):
                with self.assertRaisesRegex(broker.CredentialError, "second mint failed"):
                    broker.refresh({})
            self.assertEqual(broker.HERMES_TOKEN.read_text(), first[0] + "\n")
            self.assertFalse(broker.PROJECTOR_TOKEN.exists())

    def test_refresh_revokes_and_removes_any_prior_runtime_credentials_first(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME.mkdir(parents=True)
            broker.HERMES_TOKEN.write_text("ghs_old_write_token\n")
            broker.PROJECTOR_TOKEN.write_text("ghs_old_read_token\n")
            broker.PROJECTOR_ROTATED.write_text("rotated\n")
            with patch.object(broker, "revoke_value") as revoke, patch.object(broker, "refresh") as refresh:
                broker.command_refresh({"appId": 1})
            self.assertEqual({call.args[0] for call in revoke.call_args_list}, {"ghs_old_write_token", "ghs_old_read_token"})
            self.assertFalse(broker.PROJECTOR_ROTATED.exists())
            refresh.assert_called_once_with({"appId": 1})

    def test_successful_refresh_projects_separate_tokens_and_non_secret_receipt(self):
        config = {"appId": 1, "installationId": 2, "repositoryId": 3, "repository": "gloopsAI/gloops-paperclip-plugin"}
        write = ("ghs_write_installation_token", "2026-07-15T10:00:00Z", {"contents": "write"})
        read = ("ghs_read_installation_token", "2026-07-15T10:00:00Z", {"contents": "read"})
        writes: list[tuple[Path, str, int, int, int]] = []

        def record(path, value, mode, uid=0, gid=0):
            writes.append((path, value, mode, uid, gid))

        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)), \
                patch.object(broker, "mint", side_effect=[write, read]), \
                patch.object(broker, "atomic_write", side_effect=record):
            broker.refresh(config)

        self.assertEqual(writes[0][1], write[0] + "\n")
        self.assertEqual(writes[1][1], read[0] + "\n")
        self.assertEqual(writes[2][2:], (0o400, 10000, 10000))
        receipt = writes[3][1]
        self.assertNotIn(write[0], receipt)
        self.assertNotIn(read[0], receipt)
        self.assertIn("tokenFingerprint", receipt)
        self.assertIn('"revokedAt": null', receipt)

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
