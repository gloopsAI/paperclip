#!/usr/bin/env python3
"""Verify durable credential/stop histories and optional ephemeral tail."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys


class HistoryError(RuntimeError):
    pass


def digest(record: dict[str, object]) -> str:
    payload = dict(record)
    payload.pop("receiptDigest", None)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def load(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    if path.stat().st_size == 0:
        raise HistoryError(f"history is empty: {path}")
    records = [json.loads(line) for line in path.read_text().splitlines()]
    if not records or not all(isinstance(record, dict) for record in records):
        raise HistoryError(f"history is malformed: {path}")
    return records


def verify_chain(records: list[dict[str, object]], identity: str) -> None:
    prior: str | None = None
    seen: set[str] = set()
    for sequence, record in enumerate(records, 1):
        value = record.get(identity)
        if not isinstance(value, str) or not value or value in seen:
            raise HistoryError(f"duplicate or missing {identity}")
        if record.get("sequence") != sequence or record.get("previousReceiptDigest") != prior:
            raise HistoryError("history sequence or hash chain is malformed")
        if record.get("receiptDigest") != digest(record):
            raise HistoryError("history digest is malformed")
        seen.add(value)
        prior = str(record["receiptDigest"])


def verify_credentials(records: list[dict[str, object]]) -> None:
    verify_chain(records, "lifecycleId")
    for record in records:
        if record.get("schemaVersion") != "gloops.github-app-credential-receipt.v1":
            raise HistoryError("credential schema is malformed")
        for role in ("hermes", "projector"):
            entry = record.get(role)
            if not isinstance(entry, dict):
                raise HistoryError(f"credential role is missing: {role}")
            if not isinstance(entry.get("revokedAt"), str):
                raise HistoryError(f"credential role is not revoked: {role}")
            fingerprint = entry.get("tokenFingerprint")
            if not isinstance(fingerprint, str) or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
                raise HistoryError(f"credential fingerprint is malformed: {role}")


def verify_stops(records: list[dict[str, object]]) -> None:
    verify_chain(records, "attemptId")
    for record in records:
        if record.get("schemaVersion") != "gloops.hermes-stop-receipt.v1":
            raise HistoryError("stop schema is malformed")
        status = record.get("status")
        if status == "succeeded":
            if not (
                record.get("plannedStopAccepted") is True
                and record.get("gatewayState") == "stopped"
                and record.get("containerStopped") is True
            ):
                raise HistoryError("successful stop lacks graceful terminal evidence")
        elif status == "failed":
            if record.get("containerStopped") is not True or not isinstance(record.get("error"), str):
                raise HistoryError("failed stop lacks forced-dark evidence")
        elif status == "not-present":
            if record.get("containerPresent") is not False:
                raise HistoryError("not-present stop receipt is contradictory")
        else:
            raise HistoryError("stop status is malformed")


def verify_bundle(credential_path: Path, stop_path: Path, current_path: Path) -> str:
    credentials = load(credential_path)
    stops = load(stop_path)
    if credentials:
        verify_credentials(credentials)
    if stops:
        verify_stops(stops)

    if stops and not credentials:
        raise HistoryError("stop history exists without credential history")
    if credentials and not stops:
        if not all(record.get("legacyReceipt") is True for record in credentials):
            raise HistoryError("non-legacy credential history has no stop history")
        disposition = "legacy-only"
    elif credentials and stops:
        credential_ids = {record["lifecycleId"] for record in credentials}
        for stop in stops:
            lifecycle = stop.get("lifecycleId")
            if lifecycle is not None and lifecycle not in credential_ids:
                raise HistoryError("stop lifecycle has no credential lifecycle")
        for credential in credentials:
            if credential.get("legacyReceipt") is not True and not any(
                stop.get("lifecycleId") == credential["lifecycleId"] for stop in stops
            ):
                raise HistoryError("credential lifecycle has no stop attempt")
        disposition = "correlated"
    else:
        disposition = "none"

    if credentials and not current_path.exists():
        raise HistoryError("durable current receipt is missing despite credential history")
    if current_path.exists():
        if not credentials:
            raise HistoryError("durable current receipt exists without persistent history")
        current = json.loads(current_path.read_text())
        if current != credentials[-1]:
            raise HistoryError("durable current receipt does not exactly equal credential-history tail")
    return disposition


def main() -> int:
    if len(sys.argv) != 4:
        raise HistoryError("usage: verify-lifecycle-history.py CREDENTIAL_HISTORY STOP_HISTORY CURRENT_RECEIPT")
    disposition = verify_bundle(*(Path(value) for value in sys.argv[1:]))
    print(f"PASS lifecycle histories are {disposition}, chained, and exact")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HistoryError, OSError, json.JSONDecodeError) as error:
        print(f"verify-lifecycle-history: {error}", file=sys.stderr)
        raise SystemExit(1)
