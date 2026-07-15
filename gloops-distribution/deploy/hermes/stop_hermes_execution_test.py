#!/usr/bin/env python3
"""Unit tests for the fail-closed Hermes stop helper."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("stop-hermes-execution.py")
SPEC = importlib.util.spec_from_file_location("stop_hermes_execution", MODULE_PATH)
assert SPEC and SPEC.loader
stopper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stopper)


def result(code: int = 0, stdout: str = "", stderr: str = ""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class StopHermesExecutionTests(unittest.TestCase):
    def test_planned_stop_requires_observed_stopped_state(self):
        calls = [result(), result(), result(stdout="stopped\n")]
        with patch.object(stopper, "run", side_effect=calls):
            accepted, detail = stopper.planned_stop()
        self.assertTrue(accepted)
        self.assertEqual(detail, "")

    def test_container_disappearance_before_state_is_not_graceful(self):
        with patch.object(stopper, "run", side_effect=[result(), result(1)]):
            accepted, detail = stopper.planned_stop()
        self.assertFalse(accepted)
        self.assertIn("before gateway_state=stopped", detail)

    def test_receipt_history_is_append_only_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(stopper, "HISTORY", Path(directory) / "history.jsonl"), \
                patch.object(stopper.os, "chown"):
            receipt = {"schemaVersion": "gloops.hermes-stop-receipt.v1", "status": "succeeded"}
            stopper.append_receipt(receipt)
            stopper.append_receipt(receipt)
            lines = stopper.HISTORY.read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertRegex(stopper.json.loads(lines[0])["receiptDigest"], r"^[0-9a-f]{64}$")

    def test_main_forces_dark_but_fails_when_application_stop_fails(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(stopper, "HISTORY", Path(directory) / "history.jsonl"), \
                patch.object(stopper.os, "geteuid", return_value=0), \
                patch.object(stopper.os, "chown"), \
                patch.object(stopper, "read_lifecycle_id", return_value="lifecycle"), \
                patch.object(stopper, "container_exists", return_value=True), \
                patch.object(stopper, "planned_stop", return_value=(False, "unexpected signal")), \
                patch.object(stopper, "stop_container", return_value=(True, "")):
            self.assertEqual(stopper.main(), 1)
            saved = stopper.json.loads(stopper.HISTORY.read_text())
        self.assertEqual(saved["status"], "failed")
        self.assertTrue(saved["containerStopped"])


if __name__ == "__main__":
    unittest.main()

