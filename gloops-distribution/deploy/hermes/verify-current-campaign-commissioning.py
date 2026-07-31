#!/usr/bin/env python3
"""Fail-closed verifier for a non-renewing successor campaign commissioning receipt.

This deliberately does not mutate the barrier or restart Paperclip.  It is
the read-only predicate that both preflight and post-start validation must
pass before the successor commissioning transaction may be considered live.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import stat
from pathlib import Path


class VerificationError(RuntimeError):
    pass


def read_json(path: Path, label: str) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise VerificationError(f"{label} is unreadable") from error
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must be a JSON object")
    return value


def parse_runtime(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise VerificationError("runtime environment is unreadable") from error
    for line in lines:
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not key or key in values:
            raise VerificationError("runtime environment is malformed")
        values[key] = value
    return values


def parse_time(value: object, label: str) -> dt.datetime:
    if not isinstance(value, str):
        raise VerificationError(f"{label} must be an ISO-8601 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise VerificationError(f"{label} is invalid") from error
    if parsed.tzinfo is None:
        raise VerificationError(f"{label} must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def authorization_for(
    authorization_dir: Path, campaign_id: str, approved_image: str,
) -> tuple[dict[str, object], bytes]:
    matches: list[tuple[dict[str, object], bytes]] = []
    for candidate in sorted(authorization_dir.glob("*.json")):
        try:
            raw = candidate.read_bytes()
            value = json.loads(raw)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            continue
        scope = value.get("scope")
        if not isinstance(scope, dict):
            continue
        if (
            value.get("schemaVersion") == "gloops.campaign-successor-authorization.v1"
            and scope.get("authorization") == "commission_ollama_only_successor_epoch"
            and scope.get("campaignId") == campaign_id
            and scope.get("approvedImage") == approved_image
            and scope.get("providerRoute") == ["ollama-cloud"]
        ):
            matches.append((value, raw))
    if len(matches) != 1:
        raise VerificationError("current campaign authorization is missing or ambiguous")
    return matches[0]


def require_root_protected(path: Path, label: str) -> None:
    try:
        metadata = path.stat()
    except OSError as error:
        raise VerificationError(f"{label} is missing") from error
    if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise VerificationError(f"{label} must be root-owned mode 0600")


def verify(args: argparse.Namespace) -> None:
    runtime = parse_runtime(args.runtime_env)
    campaign_id = runtime.get("PAPERCLIP_CAMPAIGN_ID")
    if not campaign_id or not re.fullmatch(r"supervisor-product-sequence-20\d{6}", campaign_id):
        raise VerificationError("runtime campaign is not a successor product-sequence identity")
    if runtime.get("PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED") != "true":
        raise VerificationError("successor commissioning requires an exact true barrier")
    approved_image = args.approved_image.read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"ghcr\.io/gloopsai/paperclip-gloops@sha256:[0-9a-f]{64}", approved_image):
        raise VerificationError("approved image is invalid")
    authorization, authorization_bytes = authorization_for(args.authorization_dir, campaign_id, approved_image)
    authorized_at = parse_time(authorization.get("authorizedAt"), "authorization authorizedAt")
    campaign_day = dt.datetime.strptime(campaign_id.rsplit("-", 1)[1], "%Y%m%d").replace(tzinfo=dt.timezone.utc)
    if authorized_at < campaign_day:
        raise VerificationError("authorization predates successor campaign")

    epoch = read_json(args.epoch_path, "campaign epoch")
    if epoch.get("campaignId") != campaign_id:
        raise VerificationError("epoch is not bound to runtime campaign")
    deadline = parse_time(epoch.get("deadlineAt"), "epoch deadlineAt")
    now = parse_time(args.now, "now") if args.now else dt.datetime.now(dt.timezone.utc)
    if not now < deadline:
        raise VerificationError("successor campaign epoch is expired")

    if not args.skip_ownership_check:
        require_root_protected(args.receipt, "commissioning receipt")
    receipt = read_json(args.receipt, "commissioning receipt")
    required_keys = {
        "schemaVersion", "authorization", "campaignId", "approvedImage", "providerRoute",
        "workItem", "authorizedAt", "authorizationSha256",
    }
    if set(receipt) != required_keys:
        raise VerificationError("commissioning receipt has an inexact schema")
    if (
        receipt.get("schemaVersion") != "gloops.supervisor-operational-closure-commissioning.v2"
        or receipt.get("authorization") != "commission_ollama_only_supervisor_closure"
        or receipt.get("campaignId") != campaign_id
        or receipt.get("approvedImage") != approved_image
        or receipt.get("providerRoute") != ["ollama-cloud"]
        or not isinstance(receipt.get("workItem"), str)
        or not re.fullmatch(r"GLO-[1-9][0-9]*", receipt["workItem"])
        or receipt.get("authorizationSha256") != "sha256:" + hashlib.sha256(authorization_bytes).hexdigest()
    ):
        raise VerificationError("commissioning receipt is not bound to the active authorization")
    receipt_at = parse_time(receipt.get("authorizedAt"), "receipt authorizedAt")
    if not authorized_at <= receipt_at <= now:
        raise VerificationError("commissioning receipt timestamp is outside authorization window")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-env", type=Path, default=Path("/etc/paperclip-gloops/runtime.env"))
    parser.add_argument("--approved-image", type=Path, default=Path("/etc/paperclip-gloops/approved-image"))
    parser.add_argument("--authorization-dir", type=Path, default=Path("/var/lib/paperclip-gloops/campaign-deadman/authorizations"))
    parser.add_argument("--epoch-path", type=Path, default=Path("/var/lib/paperclip-gloops/campaign-deadman/epoch.json"))
    parser.add_argument("--receipt", type=Path, default=Path("/var/lib/paperclip-gloops/controlled-swarm/supervisor-operational-closure.json"))
    parser.add_argument("--now", help="test-only ISO-8601 timestamp")
    parser.add_argument("--skip-ownership-check", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--verify-if-successor",
        action="store_true",
        help="return success for an inert or legacy runtime; verify a commissioned successor",
    )
    args = parser.parse_args()
    try:
        if args.verify_if_successor:
            runtime = parse_runtime(args.runtime_env)
            campaign = runtime.get("PAPERCLIP_CAMPAIGN_ID", "")
            if not re.fullmatch(r"supervisor-product-sequence-20\d{6}", campaign):
                print("PASS legacy campaign delegated to legacy verifier")
                return 0
            if runtime.get("PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED") == "false":
                print("PASS successor campaign remains inert")
                return 0
        verify(args)
    except VerificationError as error:
        print(f"REFUSED: {error}")
        return 1
    print("PASS current successor campaign commissioning receipt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
