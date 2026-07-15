#!/usr/bin/env python3
"""Unit tests for the fail-closed Hermes stop helper."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
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
    def test_state_probe_uses_the_immutable_runtime_schema(self):
        self.assertIn("'gateway_state':r.get('gateway_state')", stopper.STATE_COMMAND)

    def test_state_probe_parses_real_runtime_record_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            record = {
                "gateway_state": "stopped",
                "pid": 99999999,
                "updated_at": "2026-07-15T00:00:01Z",
            }
            Path(directory, "gateway_state.json").write_text(json.dumps(record))
            probe = subprocess.run(
                [sys.executable, "-c", stopper.STATE_COMMAND],
                text=True,
                capture_output=True,
                check=True,
                env={**os.environ, "HERMES_HOME": directory},
            )
        parsed = json.loads(probe.stdout)
        self.assertEqual(parsed["gateway_state"], "stopped")
        self.assertFalse(parsed["alive"])

    def test_planned_stop_requires_fresh_transition_and_dead_gateway_pid(self):
        before = {"gateway_state": "running", "pid": 42, "updated_at": "2026-07-15T00:00:00Z", "alive": True}
        after = {"gateway_state": "stopped", "pid": 42, "updated_at": "2026-07-15T00:00:01Z", "alive": False}
        with patch.object(stopper, "read_gateway_record", side_effect=[before, after]), \
                patch.object(stopper, "container_exists", return_value=True), \
                patch.object(stopper, "run", return_value=result()):
            accepted, detail = stopper.planned_stop()
        self.assertTrue(accepted)
        self.assertEqual(detail, "")

    def test_stale_stopped_state_cannot_masquerade_as_a_transition(self):
        stale = {"gateway_state": "stopped", "pid": 42, "updated_at": "2026-07-15T00:00:00Z", "alive": False}
        with patch.object(stopper, "read_gateway_record", return_value=stale), \
                patch.object(stopper, "run") as command:
            accepted, detail = stopper.planned_stop()
        self.assertFalse(accepted)
        self.assertIn("not observably running", detail)
        command.assert_not_called()

    def test_container_disappearance_before_state_is_not_graceful(self):
        before = {"gateway_state": "running", "pid": 42, "updated_at": "2026-07-15T00:00:00Z", "alive": True}
        with patch.object(stopper, "read_gateway_record", return_value=before), \
                patch.object(stopper, "run", return_value=result()), \
                patch.object(stopper, "container_exists", return_value=False):
            accepted, detail = stopper.planned_stop()
        self.assertFalse(accepted)
        self.assertIn("before gateway_state=stopped", detail)

    def test_receipt_history_is_append_only_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(stopper, "HISTORY", Path(directory) / "history.jsonl"), \
                patch.object(stopper, "HISTORY_LOCK", Path(directory) / "history.lock"), \
                patch.object(stopper.os, "chown"):
            receipt = {"schemaVersion": "gloops.hermes-stop-receipt.v1", "attemptId": "same", "status": "succeeded"}
            stopper.append_receipt(receipt)
            stopper.append_receipt(receipt)
            lines = stopper.HISTORY.read_text().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertRegex(stopper.json.loads(lines[0])["receiptDigest"], r"^[0-9a-f]{64}$")

    def test_concurrent_appends_preserve_both_records_and_hash_chain(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(stopper, "HISTORY", Path(directory) / "history.jsonl"), \
                patch.object(stopper, "HISTORY_LOCK", Path(directory) / "history.lock"), \
                patch.object(stopper.os, "chown"):
            barrier = threading.Barrier(2)
            errors = []

            def append(attempt):
                try:
                    barrier.wait()
                    stopper.append_receipt({"schemaVersion": "gloops.hermes-stop-receipt.v1", "attemptId": attempt})
                except Exception as error:  # pragma: no cover - asserted below
                    errors.append(error)

            threads = [threading.Thread(target=append, args=(value,)) for value in ("one", "two")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            records = [stopper.json.loads(line) for line in stopper.HISTORY.read_text().splitlines()]
        self.assertEqual(errors, [])
        self.assertEqual(len(records), 2)
        stopper.validate_history(records)

    def test_main_forces_dark_but_fails_when_application_stop_fails(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(stopper, "HISTORY", Path(directory) / "history.jsonl"), \
                patch.object(stopper, "HISTORY_LOCK", Path(directory) / "history.lock"), \
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
