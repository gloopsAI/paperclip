import pathlib
import subprocess
import sys
import unittest

from importlib.machinery import SourceFileLoader


MODULE = SourceFileLoader(
    "verify_campaign_deadman",
    str(pathlib.Path(__file__).with_name("verify-campaign-deadman.py")),
).load_module()


class MutableMonotonic:
    def __init__(self) -> None:
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class VerifyCampaignDeadmanTest(unittest.TestCase):
    def test_campaign_id_is_required(self) -> None:
        result = subprocess.run(
            [sys.executable, MODULE.__file__],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--campaign-id", result.stderr)

    def test_waits_for_a_transient_transport_race(self) -> None:
        clock = MutableMonotonic()
        attempts = 0
        expected = {"status": "unarmed"}

        def loader():
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise FileNotFoundError("socket not created yet")
            return expected

        self.assertIs(
            MODULE.wait_for_status(
                loader,
                wait_seconds=1,
                monotonic=clock.now,
                sleeper=clock.sleep,
            ),
            expected,
        )
        self.assertEqual(attempts, 3)

    def test_times_out_fail_closed(self) -> None:
        clock = MutableMonotonic()

        with self.assertRaisesRegex(
            MODULE.DeadmanVerificationError,
            "was not ready within 0.2s",
        ):
            MODULE.wait_for_status(
                lambda: (_ for _ in ()).throw(ConnectionRefusedError("not ready")),
                wait_seconds=0.2,
                monotonic=clock.now,
                sleeper=clock.sleep,
            )

    def test_semantic_drift_is_not_retried(self) -> None:
        clock = MutableMonotonic()
        attempts = 0

        def loader():
            nonlocal attempts
            attempts += 1
            raise MODULE.DeadmanVerificationError("wrong socket mode")

        with self.assertRaisesRegex(MODULE.DeadmanVerificationError, "wrong socket mode"):
            MODULE.wait_for_status(
                loader,
                wait_seconds=1,
                monotonic=clock.now,
                sleeper=clock.sleep,
            )
        self.assertEqual(attempts, 1)


if __name__ == "__main__":
    unittest.main()
