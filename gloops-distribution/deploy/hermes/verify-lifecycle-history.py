#!/usr/bin/env python3
"""Verify durable credential/stop histories and optional ephemeral tail."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
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
            if not (
                isinstance(entry.get("revokedAt"), str)
                or isinstance(entry.get("expiredAt"), str)
            ):
                raise HistoryError(f"credential role is not terminal: {role}")
            fingerprint = entry.get("tokenFingerprint")
            if not isinstance(fingerprint, str) or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
                raise HistoryError(f"credential fingerprint is malformed: {role}")
            if isinstance(entry.get("expiredAt"), str):
                expiry_digest = entry.get("expiryReceiptDigest")
                if not isinstance(expiry_digest, str) or re.fullmatch(r"[0-9a-f]{64}", expiry_digest) is None:
                    raise HistoryError(f"credential expiry receipt binding is malformed: {role}")


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


def verify_expirations(records: list[dict[str, object]]) -> None:
    verify_chain(records, "attemptId")
    for record in records:
        if record.get("role") not in {"hermes", "projector"}:
            raise HistoryError("expiry role is malformed")
        if record.get("schemaVersion") == "gloops.github-app-expiry-receipt.v1":
            expected_keys = {
                "schemaVersion", "attemptId", "role", "safeAfter", "disposedAt",
                "tokenFingerprint", "disposition", "sequence", "previousReceiptDigest", "receiptDigest",
            }
            if set(record) != expected_keys:
                raise HistoryError("expiry fields are malformed")
            if record.get("disposition") != "expired-by-envelope":
                raise HistoryError("expiry disposition is malformed")
            fingerprint = record.get("tokenFingerprint")
            if not isinstance(fingerprint, str) or re.fullmatch(r"[0-9a-f]{64}", fingerprint) is None:
                raise HistoryError("expiry fingerprint is malformed")
            try:
                safe_after = datetime.fromisoformat(str(record["safeAfter"]).replace("Z", "+00:00"))
                disposed_at = datetime.fromisoformat(str(record["disposedAt"]).replace("Z", "+00:00"))
            except (KeyError, ValueError) as error:
                raise HistoryError("expiry timestamps are malformed") from error
            if safe_after.tzinfo is None or disposed_at.tzinfo is None or disposed_at < safe_after:
                raise HistoryError("credential handle was disposed before its expiry envelope")
        elif record.get("schemaVersion") == "gloops.github-app-uncertainty-clearance.v1":
            expected_keys = {
                "schemaVersion", "attemptId", "role", "startedAt", "observedAt", "safeAfter",
                "clearedAt", "disposition", "sequence", "previousReceiptDigest", "receiptDigest",
            }
            if set(record) != expected_keys:
                raise HistoryError("token-free clearance fields are malformed")
            if record.get("disposition") != "token-free-uncertainty-cleared" or "tokenFingerprint" in record:
                raise HistoryError("token-free clearance disposition is malformed")
            try:
                started_at = datetime.fromisoformat(str(record["startedAt"]).replace("Z", "+00:00"))
                observed_at = datetime.fromisoformat(str(record["observedAt"]).replace("Z", "+00:00"))
                safe_after = datetime.fromisoformat(str(record["safeAfter"]).replace("Z", "+00:00"))
                cleared_at = datetime.fromisoformat(str(record["clearedAt"]).replace("Z", "+00:00"))
            except (KeyError, ValueError) as error:
                raise HistoryError("token-free clearance timestamps are malformed") from error
            if (
                any(value.tzinfo is None for value in (started_at, observed_at, safe_after, cleared_at))
                or observed_at < started_at
                or (safe_after - observed_at).total_seconds() < 3900
                or cleared_at < safe_after
            ):
                raise HistoryError("token-free uncertainty cleared before its observed expiry envelope")
        else:
            raise HistoryError("expiry schema is malformed")


def verify_bundle(credential_path: Path, stop_path: Path, expiry_path: Path, current_path: Path) -> str:
    credentials = load(credential_path)
    stops = load(stop_path)
    expirations = load(expiry_path)
    if credentials:
        verify_credentials(credentials)
    if stops:
        verify_stops(stops)
    if expirations:
        verify_expirations(expirations)
    expirations_by_digest = {record["receiptDigest"]: record for record in expirations}
    for credential in credentials:
        for role in ("hermes", "projector"):
            entry = credential[role]
            if not isinstance(entry.get("expiredAt"), str):
                continue
            expiration = expirations_by_digest.get(entry.get("expiryReceiptDigest"))
            if not isinstance(expiration, dict) or not (
                expiration.get("role") == role
                and expiration.get("tokenFingerprint") == entry.get("tokenFingerprint")
                and expiration.get("disposedAt") == entry.get("expiredAt")
            ):
                raise HistoryError("credential expiry binding has no exact expiry receipt")

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
    if len(sys.argv) != 5:
        raise HistoryError("usage: verify-lifecycle-history.py CREDENTIAL_HISTORY STOP_HISTORY EXPIRY_HISTORY CURRENT_RECEIPT")
    disposition = verify_bundle(*(Path(value) for value in sys.argv[1:]))
    print(f"PASS lifecycle histories are {disposition}, chained, and exact")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (HistoryError, OSError, json.JSONDecodeError) as error:
        print(f"verify-lifecycle-history: {error}", file=sys.stderr)
        raise SystemExit(1)
