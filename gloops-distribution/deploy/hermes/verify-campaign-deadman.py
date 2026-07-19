#!/usr/bin/env python3
"""Verify the installed campaign broker and its durable epoch fail closed."""

from __future__ import annotations

import argparse
import json
import pathlib
import socket
import stat
import subprocess
import time
from collections.abc import Callable


SCHEMA_VERSION = "gloops.campaign-deadman.v1"


class DeadmanVerificationError(RuntimeError):
    pass


def request(socket_path: pathlib.Path, campaign_id: str) -> dict[str, object]:
    payload = json.dumps({
        "schemaVersion": SCHEMA_VERSION,
        "operation": "status",
        "campaignId": campaign_id,
    }, separators=(",", ":")).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(2)
        client.connect(str(socket_path))
        client.sendall(payload)
        response = b""
        while b"\n" not in response and len(response) <= 16 * 1024:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk
    return json.loads(response.split(b"\n", 1)[0])


def load_status(socket_path: pathlib.Path, campaign_id: str) -> dict[str, object]:
    socket_stat = socket_path.stat()
    if not stat.S_ISSOCK(socket_stat.st_mode):
        raise DeadmanVerificationError("campaign deadman endpoint is not a Unix socket")
    if stat.S_IMODE(socket_stat.st_mode) != 0o660 or socket_stat.st_gid != 985:
        raise DeadmanVerificationError("campaign deadman socket ownership or mode has drifted")
    return request(socket_path, campaign_id)


def wait_for_status(
    loader: Callable[[], dict[str, object]],
    *,
    wait_seconds: float,
    monotonic: Callable[[], float] = time.monotonic,
    sleeper: Callable[[float], None] = time.sleep,
) -> dict[str, object]:
    deadline = monotonic() + wait_seconds
    last_error: Exception | None = None
    while True:
        try:
            return loader()
        except DeadmanVerificationError:
            raise
        except (OSError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
        if monotonic() >= deadline:
            raise DeadmanVerificationError(
                f"campaign deadman transport was not ready within {wait_seconds:g}s: {last_error}",
            ) from last_error
        sleeper(min(0.1, max(0.0, deadline - monotonic())))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", type=pathlib.Path, default=pathlib.Path("/run/paperclip-campaign/deadman.sock"))
    parser.add_argument("--state-dir", type=pathlib.Path, default=pathlib.Path("/var/lib/paperclip-gloops/campaign-deadman"))
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--allow-non-root-for-test", action="store_true")
    parser.add_argument("--wait-seconds", type=float, default=0)
    parser.add_argument("--require-status", choices=("unarmed", "active"))
    args = parser.parse_args()
    if not 0 <= args.wait_seconds <= 30:
        raise SystemExit("--wait-seconds must be between 0 and 30")
    try:
        status = wait_for_status(
            lambda: load_status(args.socket, args.campaign_id),
            wait_seconds=args.wait_seconds,
        )
    except DeadmanVerificationError as error:
        raise SystemExit(str(error)) from error
    if (
        status.get("schemaVersion") != SCHEMA_VERSION
        or status.get("campaignId") != args.campaign_id
        or status.get("durationSeconds") != 86_400
        or status.get("status") not in {"unarmed", "active"}
        or status.get("allowed") is not True
    ):
        raise SystemExit(f"campaign deadman is not admission-ready: {status}")
    if args.require_status is not None and status["status"] != args.require_status:
        raise SystemExit(
            f"campaign deadman must be {args.require_status}, observed {status['status']}",
        )
    if status["status"] == "active":
        epoch = args.state_dir / args.campaign_id / "epoch.json"
        epoch_stat = epoch.stat()
        if stat.S_IMODE(epoch_stat.st_mode) != 0o600:
            raise SystemExit("campaign epoch mode has drifted")
        if not args.allow_non_root_for_test and epoch_stat.st_uid != 0:
            raise SystemExit("campaign epoch is not root-owned")
        if not args.allow_non_root_for_test:
            attributes = subprocess.run(
                ["/usr/bin/lsattr", "-d", str(epoch)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.split(maxsplit=1)[0]
            if "i" not in attributes:
                raise SystemExit("campaign epoch is not immutable")
        if status.get("epochSha256") is None:
            raise SystemExit("campaign epoch receipt digest is absent")
    print(f"PASS campaign deadman is {status['status']} and non-renewing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
