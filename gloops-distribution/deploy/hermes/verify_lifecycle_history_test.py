#!/usr/bin/env python3
"""Focused tests for lifecycle history continuity and reboot behavior."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("verify-lifecycle-history.py")
SPEC = importlib.util.spec_from_file_location("verify_lifecycle_history", MODULE_PATH)
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


def chain(records):
    prior = None
    for sequence, record in enumerate(records, 1):
        record["sequence"] = sequence
        record["previousReceiptDigest"] = prior
        record["receiptDigest"] = verify.digest(record)
        prior = record["receiptDigest"]
    return records


def credential(lifecycle="life", legacy=False):
    value = {
        "schemaVersion": "gloops.github-app-credential-receipt.v1",
        "lifecycleId": lifecycle,
        "hermes": {"revokedAt": "2026-07-15T00:00:01Z", "tokenFingerprint": "a" * 64},
        "projector": {"revokedAt": "2026-07-15T00:00:02Z", "tokenFingerprint": "b" * 64},
    }
    if legacy:
        value["legacyReceipt"] = True
    return value


def stop(lifecycle="life", attempt="attempt"):
    return {
        "schemaVersion": "gloops.hermes-stop-receipt.v1",
        "attemptId": attempt,
        "lifecycleId": lifecycle,
        "status": "succeeded",
        "plannedStopAccepted": True,
        "gatewayState": "stopped",
        "containerStopped": True,
    }


class LifecycleHistoryTests(unittest.TestCase):
    def paths(self, root):
        return root / "credentials.jsonl", root / "stops.jsonl", root / "current.json"

    def write(self, path, records):
        path.write_text("".join(json.dumps(record, sort_keys=True) + "\n" for record in records))

    def test_valid_history_requires_its_durable_current_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path, stop_path, current_path = self.paths(Path(directory))
            credentials = chain([credential()])
            self.write(credential_path, credentials)
            self.write(stop_path, chain([stop()]))
            current_path.write_text(json.dumps(credentials[-1]))
            self.assertEqual(verify.verify_bundle(credential_path, stop_path, current_path), "correlated")

    def test_missing_durable_current_receipt_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path, stop_path, current_path = self.paths(Path(directory))
            self.write(credential_path, chain([credential()]))
            self.write(stop_path, chain([stop()]))
            with self.assertRaisesRegex(verify.HistoryError, "durable current receipt is missing"):
                verify.verify_bundle(credential_path, stop_path, current_path)

    def test_nonlegacy_credential_without_stop_history_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path, stop_path, current_path = self.paths(Path(directory))
            self.write(credential_path, chain([credential()]))
            with self.assertRaisesRegex(verify.HistoryError, "no stop history"):
                verify.verify_bundle(credential_path, stop_path, current_path)

    def test_formal_legacy_migration_may_precede_stop_history(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path, stop_path, current_path = self.paths(Path(directory))
            records = chain([credential(legacy=True)])
            self.write(credential_path, records)
            current_path.write_text(json.dumps(records[-1]))
            self.assertEqual(verify.verify_bundle(credential_path, stop_path, current_path), "legacy-only")

    def test_mutated_current_receipt_with_copied_digest_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path, stop_path, current_path = self.paths(Path(directory))
            credentials = chain([credential()])
            self.write(credential_path, credentials)
            self.write(stop_path, chain([stop()]))
            current = dict(credentials[-1])
            current["lifecycleId"] = "tampered"
            current_path.write_text(json.dumps(current))
            with self.assertRaisesRegex(verify.HistoryError, "exactly equal"):
                verify.verify_bundle(credential_path, stop_path, current_path)

    def test_deleted_credential_prefix_breaks_chain(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path, stop_path, current_path = self.paths(Path(directory))
            records = chain([credential("one", True), credential("two", True)])
            self.write(credential_path, records[1:])
            with self.assertRaisesRegex(verify.HistoryError, "sequence or hash chain"):
                verify.verify_bundle(credential_path, stop_path, current_path)


if __name__ == "__main__":
    unittest.main()
