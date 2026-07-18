from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("verify-predecessor-campaign-epoch.py")
SPEC = importlib.util.spec_from_file_location(
    "verify_predecessor_campaign_epoch",
    SCRIPT,
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
UTC = dt.timezone.utc


def epoch_value(**overrides: object) -> dict[str, object]:
    admitted = dt.datetime(2026, 7, 17, 20, 32, 14, 151000, tzinfo=UTC)
    value: dict[str, object] = {
        "schemaVersion": MODULE.SCHEMA_VERSION,
        "campaignId": MODULE.PREDECESSOR_CAMPAIGN_ID,
        "companyId": "89ed0964-d918-4fcc-b830-5be49d2d4089",
        "firstRunId": "8891e031-4b1d-4b37-b703-0522b181cd8e",
        "firstAdmittedAt": admitted.isoformat(timespec="milliseconds").replace(
            "+00:00",
            "Z",
        ),
        "deadlineAt": (
            admitted + dt.timedelta(seconds=86_400)
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "durationSeconds": 86_400,
    }
    value.update(overrides)
    digest_input = {key: item for key, item in value.items() if key != "epochSha256"}
    value["epochSha256"] = (
        "sha256:"
        + hashlib.sha256(MODULE.canonical_json(digest_input)).hexdigest()
    )
    return value


class PredecessorEpochTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.epoch = Path(self.temporary.name) / "epoch.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write(self, **overrides: object) -> None:
        self.epoch.write_text(
            json.dumps(epoch_value(**overrides), sort_keys=True) + "\n",
            encoding="utf-8",
        )
        self.epoch.chmod(0o600)

    def verify(self) -> dict[str, object]:
        expected_raw_sha256 = hashlib.sha256(self.epoch.read_bytes()).hexdigest()
        return MODULE.verify(
            self.epoch,
            now=dt.datetime(2026, 7, 18, 21, 0, tzinfo=UTC),
            require_root=False,
            require_immutable=False,
            expected_raw_sha256=expected_raw_sha256,
        )

    def test_accepts_expired_integral_predecessor(self) -> None:
        self.write()
        self.assertEqual(
            self.verify()["campaignId"],
            MODULE.PREDECESSOR_CAMPAIGN_ID,
        )

    def test_rejects_successor_identity_at_predecessor_path(self) -> None:
        self.write(campaignId=MODULE.SUCCESSOR_CAMPAIGN_ID)
        with self.assertRaisesRegex(
            MODULE.PredecessorEpochError,
            "identity, integrity, duration, or expiry",
        ):
            self.verify()

    def test_rejects_unexpired_predecessor(self) -> None:
        self.write()
        with self.assertRaisesRegex(
            MODULE.PredecessorEpochError,
            "identity, integrity, duration, or expiry",
        ):
            MODULE.verify(
                self.epoch,
                now=dt.datetime(2026, 7, 18, 19, 0, tzinfo=UTC),
                require_root=False,
                require_immutable=False,
                expected_raw_sha256=hashlib.sha256(
                    self.epoch.read_bytes(),
                ).hexdigest(),
            )

    def test_rejects_tampering(self) -> None:
        self.write(companyId="changed")
        value = json.loads(self.epoch.read_text(encoding="utf-8"))
        value["companyId"] = "tampered-after-digest"
        self.epoch.write_text(json.dumps(value) + "\n", encoding="utf-8")
        self.epoch.chmod(0o600)
        with self.assertRaisesRegex(
            MODULE.PredecessorEpochError,
            "identity, integrity, duration, or expiry",
        ):
            self.verify()

    def test_rejects_raw_fixture_digest_drift(self) -> None:
        self.write()
        with self.assertRaisesRegex(
            MODULE.PredecessorEpochError,
            "identity, integrity, duration, or expiry",
        ):
            MODULE.verify(
                self.epoch,
                now=dt.datetime(2026, 7, 18, 21, 0, tzinfo=UTC),
                require_root=False,
                require_immutable=False,
                expected_raw_sha256="0" * 64,
            )

    def test_rejects_wrong_mode(self) -> None:
        self.write()
        self.epoch.chmod(0o644)
        with self.assertRaisesRegex(
            MODULE.PredecessorEpochError,
            "mode 0600",
        ):
            self.verify()


if __name__ == "__main__":
    unittest.main()
