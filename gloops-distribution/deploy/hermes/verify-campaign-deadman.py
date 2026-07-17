#!/usr/bin/env python3
"""Verify the installed campaign broker and its durable epoch fail closed."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import socket
import stat
import subprocess
import sys


SCHEMA_VERSION = "gloops.campaign-deadman.v1"


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", type=pathlib.Path, default=pathlib.Path("/run/paperclip-campaign/deadman.sock"))
    parser.add_argument("--state-dir", type=pathlib.Path, default=pathlib.Path("/var/lib/paperclip-gloops/campaign-deadman"))
    parser.add_argument("--campaign-id", default="controlled-swarm-20260717")
    parser.add_argument("--allow-non-root-for-test", action="store_true")
    args = parser.parse_args()
    socket_stat = args.socket.stat()
    if not stat.S_ISSOCK(socket_stat.st_mode):
        raise SystemExit("campaign deadman endpoint is not a Unix socket")
    if stat.S_IMODE(socket_stat.st_mode) != 0o660 or socket_stat.st_gid != 985:
        raise SystemExit("campaign deadman socket ownership or mode has drifted")
    status = request(args.socket, args.campaign_id)
    if (
        status.get("schemaVersion") != SCHEMA_VERSION
        or status.get("campaignId") != args.campaign_id
        or status.get("durationSeconds") != 86_400
        or status.get("status") not in {"unarmed", "active"}
        or status.get("allowed") is not True
    ):
        raise SystemExit(f"campaign deadman is not admission-ready: {status}")
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
