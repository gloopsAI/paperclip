from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name(
    "rehearse-controlled-swarm-commissioning-recovery.py",
)


class CommissioningRecoveryRehearsalTest(unittest.TestCase):
    def test_sigkill_rehearsal_emits_content_addressed_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--allow-source-root",
                    str(SCRIPT.parent),
                    "--receipt-dir",
                    str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            receipt_path = Path(result.stdout.strip())
            payload = receipt_path.read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            self.assertEqual(
                receipt_path.name,
                f"controlled-swarm-commissioning-recovery-{digest}.json",
            )
            receipt = json.loads(payload)
            self.assertEqual(receipt["outcome"], "passed")
            self.assertFalse(receipt["providersInvoked"])
            self.assertFalse(receipt["productionStateMutated"])
            self.assertTrue(receipt["recoveryUnitRootOnly"])
            self.assertTrue(receipt["recoveryUnitRequiresOrphanJournal"])
            self.assertTrue(receipt["recoveryUnitRequiresFalseBarrier"])
            self.assertTrue(receipt["wrapperFencesBeforeRecovery"])
            self.assertTrue(receipt["corruptJournalRefused"])
            self.assertTrue(receipt["rollbackFailureRemainedDark"])
            self.assertEqual(
                [row["phase"] for row in receipt["phases"]],
                [
                    "journal_recorded",
                    "configs_applied",
                    "configs_verified",
                    "receipt_written",
                    "barrier_enabled",
                    "control_plane_restarted",
                    "live_verified",
                ],
            )
            self.assertTrue(
                all(row["crashSignal"] == "SIGKILL" for row in receipt["phases"]),
            )
            self.assertTrue(
                all(row["repeatedRecoveryNoOp"] for row in receipt["phases"]),
            )


if __name__ == "__main__":
    unittest.main()
