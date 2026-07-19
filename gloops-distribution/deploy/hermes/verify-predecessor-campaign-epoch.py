#!/usr/bin/env python3
"""Verify that the consumed predecessor campaign remains immutable evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import stat
import subprocess
from typing import Any


SCHEMA_VERSION = "gloops.campaign-deadman.v1"
PREDECESSOR_CAMPAIGN_ID = "controlled-swarm-20260717"
SUCCESSOR_CAMPAIGN_ID = (
    "controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139"
)
PREDECESSOR_EPOCH = pathlib.Path(
    "/var/lib/paperclip-gloops/campaign-deadman/"
    f"{PREDECESSOR_CAMPAIGN_ID}/epoch.json",
)
PREDECESSOR_EPOCH_FILE_SHA256 = (
    "af8260a4c30f92c79a1c138e2951cbb40041ed58da40b86273a27881b2d07b0b"
)
UTC = dt.timezone.utc


class PredecessorEpochError(RuntimeError):
    pass


def canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def parse_utc(value: object) -> dt.datetime:
    if not isinstance(value, str):
        raise PredecessorEpochError("predecessor epoch timestamp is not a string")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PredecessorEpochError("predecessor epoch timestamp is invalid") from error
    if parsed.tzinfo is None:
        raise PredecessorEpochError("predecessor epoch timestamp lacks a timezone")
    return parsed.astimezone(UTC)


def verify(
    epoch_path: pathlib.Path,
    *,
    now: dt.datetime | None = None,
    require_root: bool = True,
    require_immutable: bool = True,
    expected_raw_sha256: str = PREDECESSOR_EPOCH_FILE_SHA256,
) -> dict[str, Any]:
    if PREDECESSOR_CAMPAIGN_ID == SUCCESSOR_CAMPAIGN_ID:
        raise PredecessorEpochError("predecessor and successor campaign IDs collide")
    if epoch_path.is_symlink() or not epoch_path.is_file():
        raise PredecessorEpochError("predecessor epoch is absent or not a regular file")
    file_stat = epoch_path.stat()
    if require_root and (file_stat.st_uid != 0 or file_stat.st_gid != 0):
        raise PredecessorEpochError("predecessor epoch is not root:root")
    if stat.S_IMODE(file_stat.st_mode) != 0o600:
        raise PredecessorEpochError("predecessor epoch is not mode 0600")
    if require_immutable:
        attributes = subprocess.run(
            ["/usr/bin/lsattr", "-d", str(epoch_path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split(maxsplit=1)[0]
        if "i" not in attributes:
            raise PredecessorEpochError("predecessor epoch is not immutable")
    try:
        raw_epoch = epoch_path.read_bytes()
        epoch = json.loads(raw_epoch)
    except (OSError, json.JSONDecodeError) as error:
        raise PredecessorEpochError("predecessor epoch is unreadable") from error
    required = {
        "schemaVersion",
        "campaignId",
        "companyId",
        "firstRunId",
        "firstAdmittedAt",
        "deadlineAt",
        "durationSeconds",
        "epochSha256",
    }
    if not isinstance(epoch, dict) or set(epoch) != required:
        raise PredecessorEpochError("predecessor epoch schema has drifted")
    digest_input = {key: value for key, value in epoch.items() if key != "epochSha256"}
    expected_digest = (
        "sha256:" + hashlib.sha256(canonical_json(digest_input)).hexdigest()
    )
    admitted_at = parse_utc(epoch["firstAdmittedAt"])
    deadline = parse_utc(epoch["deadlineAt"])
    observed_at = (now or dt.datetime.now(UTC)).astimezone(UTC)
    if (
        epoch["schemaVersion"] != SCHEMA_VERSION
        or epoch["campaignId"] != PREDECESSOR_CAMPAIGN_ID
        or epoch["campaignId"] == SUCCESSOR_CAMPAIGN_ID
        or hashlib.sha256(raw_epoch).hexdigest() != expected_raw_sha256
        or epoch["durationSeconds"] != 86_400
        or epoch["epochSha256"] != expected_digest
        or deadline - admitted_at != dt.timedelta(seconds=86_400)
        or observed_at < deadline
    ):
        raise PredecessorEpochError(
            "predecessor epoch identity, integrity, duration, or expiry is invalid",
        )
    return epoch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epoch", type=pathlib.Path, default=PREDECESSOR_EPOCH)
    parser.add_argument("--allow-non-root-for-test", action="store_true")
    parser.add_argument("--allow-mutable-for-test", action="store_true")
    args = parser.parse_args()
    try:
        verify(
            args.epoch,
            require_root=not args.allow_non_root_for_test,
            require_immutable=not args.allow_mutable_for_test,
        )
    except (OSError, subprocess.SubprocessError, PredecessorEpochError) as error:
        raise SystemExit(str(error)) from error
    print(
        "PASS consumed predecessor campaign epoch remains expired, "
        "immutable, and distinct from the successor",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
