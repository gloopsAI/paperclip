import argparse
import datetime as dt
import json
import os
import pathlib
import socket
import tempfile
import threading
import time
import unittest

from importlib.machinery import SourceFileLoader


MODULE = SourceFileLoader(
    "campaign_deadman",
    str(pathlib.Path(__file__).with_name("campaign-deadman.py")),
).load_module()
UTC = dt.timezone.utc


class MutableClock:
    def __init__(self, value: dt.datetime) -> None:
        self.value = value

    def now(self) -> dt.datetime:
        return self.value


class CampaignDurationBoundTest(unittest.TestCase):
    """The duration is a bounded invariant: 1h..30d, defaulting to 24h."""

    def _store(self, directory: str, duration_seconds: object):
        return MODULE.CampaignEpochStore(
            state_dir=pathlib.Path(directory),
            campaign_id="controlled-swarm-test",
            duration_seconds=duration_seconds,
            require_immutable=False,
            now=MutableClock(dt.datetime(2026, 7, 17, 7, tzinfo=UTC)).now,
        )

    def test_named_bounds_frame_the_default(self) -> None:
        self.assertEqual(MODULE.MIN_CAMPAIGN_DURATION_SECONDS, 3_600)
        self.assertEqual(MODULE.MAX_CAMPAIGN_DURATION_SECONDS, 2_592_000)
        self.assertEqual(MODULE.DEFAULT_CAMPAIGN_DURATION_SECONDS, 86_400)

    def test_durations_inside_the_range_are_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for duration in (3_600, 86_400, 2_592_000):
                with self.subTest(duration=duration):
                    self.assertEqual(
                        self._store(directory, duration).duration_seconds,
                        duration,
                    )

    def test_durations_outside_the_range_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for duration in (3_599, 2_592_001, 0, -1, 86_400.0, "86400", None):
                with self.subTest(duration=duration):
                    with self.assertRaises(MODULE.DeadmanError) as caught:
                        self._store(directory, duration)
                    message = str(caught.exception)
                    self.assertIn(repr(duration), message)
                    self.assertIn("3600", message)
                    self.assertIn("2592000", message)

    def test_a_thirty_day_epoch_writes_a_thirty_day_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = self._store(directory, 2_592_000)
            armed = store.admit(company_id="company-1", run_id="run-1")
            self.assertEqual(armed["durationSeconds"], 2_592_000)
            self.assertEqual(
                MODULE.parse_utc(armed["deadlineAt"])
                - MODULE.parse_utc(armed["firstAdmittedAt"]),
                dt.timedelta(days=30),
            )
            self.assertEqual(
                self._store(directory, 2_592_000).status()["status"],
                "active",
            )

    def test_the_cli_refuses_the_same_range_as_the_store(self) -> None:
        for accepted in ("3600", "86400", "2592000"):
            with self.subTest(accepted=accepted):
                self.assertEqual(
                    MODULE.duration_seconds_argument(accepted),
                    int(accepted),
                )
        for refused in ("3599", "2592001", "0", "-1", "86400.0", "nope"):
            with self.subTest(refused=refused):
                with self.assertRaises(argparse.ArgumentTypeError):
                    MODULE.duration_seconds_argument(refused)


class CampaignDeadmanTest(unittest.TestCase):
    def test_epoch_survives_restart_and_cannot_renew_after_expiry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = MutableClock(dt.datetime(2026, 7, 17, 7, tzinfo=UTC))
            kwargs = {
                "state_dir": pathlib.Path(directory),
                "campaign_id": "controlled-swarm-test",
                "duration_seconds": 86_400,
                "require_immutable": False,
                "now": clock.now,
            }
            first = MODULE.CampaignEpochStore(**kwargs)
            armed = first.admit(company_id="company-1", run_id="run-1")
            original_deadline = armed["deadlineAt"]
            self.assertEqual(armed["status"], "armed")

            clock.value += dt.timedelta(hours=12)
            restarted = MODULE.CampaignEpochStore(**kwargs)
            active = restarted.admit(company_id="company-1", run_id="run-2")
            self.assertEqual(active["status"], "active")
            self.assertEqual(active["deadlineAt"], original_deadline)
            self.assertEqual(active["firstRunId"], "run-1")

            clock.value += dt.timedelta(hours=12)
            with self.assertRaisesRegex(MODULE.DeadmanError, "expired"):
                MODULE.CampaignEpochStore(**kwargs).admit(
                    company_id="company-1",
                    run_id="run-3",
                )
            self.assertEqual(
                MODULE.CampaignEpochStore(**kwargs).status()["status"],
                "expired",
            )

    def test_epoch_is_company_bound_and_integrity_checked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = MutableClock(dt.datetime(2026, 7, 17, 7, tzinfo=UTC))
            store = MODULE.CampaignEpochStore(
                state_dir=pathlib.Path(directory),
                campaign_id="controlled-swarm-test",
                duration_seconds=86_400,
                require_immutable=False,
                now=clock.now,
            )
            store.admit(company_id="company-1", run_id="run-1")
            with self.assertRaisesRegex(MODULE.DeadmanError, "different company"):
                store.admit(company_id="company-2", run_id="run-2")

            epoch_path = pathlib.Path(directory) / "controlled-swarm-test" / "epoch.json"
            epoch_path.write_text(epoch_path.read_text().replace("company-1", "company-x"))
            with self.assertRaisesRegex(MODULE.DeadmanError, "integrity"):
                store.status()

    def test_unix_broker_returns_the_same_epoch_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            clock = MutableClock(dt.datetime(2026, 7, 17, 7, tzinfo=UTC))
            store = MODULE.CampaignEpochStore(
                state_dir=root / "state",
                campaign_id="controlled-swarm-test",
                duration_seconds=86_400,
                require_immutable=False,
                now=clock.now,
            )
            socket_path = root / "run" / "deadman.sock"
            server = MODULE.DeadmanServer(
                store=store,
                socket_path=socket_path,
                socket_uid=os.getuid(),
                socket_gid=os.getgid(),
                stop_command="/usr/bin/true",
            )
            thread = threading.Thread(target=server.serve)
            thread.start()
            deadline = time.monotonic() + 3
            while not socket_path.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(socket_path.exists())

            def request(operation: str, **extra: str):
                payload = {
                    "schemaVersion": MODULE.SCHEMA_VERSION,
                    "operation": operation,
                    "campaignId": "controlled-swarm-test",
                    **extra,
                }
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(socket_path))
                    client.sendall(json.dumps(payload).encode() + b"\n")
                    response = b""
                    while b"\n" not in response:
                        response += client.recv(4096)
                return json.loads(response)

            try:
                armed = request("admit", companyId="company-1", runId="run-1")
                active = request("admit", companyId="company-1", runId="run-2")
                self.assertEqual(armed["status"], "armed")
                self.assertEqual(active["status"], "active")
                self.assertEqual(active["firstRunId"], "run-1")
                self.assertEqual(active["deadlineAt"], armed["deadlineAt"])
            finally:
                server.stop()
                thread.join(timeout=3)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
