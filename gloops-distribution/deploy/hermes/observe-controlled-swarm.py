#!/usr/bin/env python3
"""Read-only controlled-swarm operating snapshot."""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import shutil
import subprocess


UNITS = (
    "paperclip-campaign-deadman.service",
    "paperclip-hermes-execution.service",
    "paperclip-gloops.service",
)
CAMPAIGN_ID = (
    "controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139"
)


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=False, capture_output=True, text=True)


def unit_state(unit: str) -> dict[str, str]:
    return {
        "active": run("systemctl", "is-active", unit).stdout.strip(),
        "enabled": run("systemctl", "is-enabled", unit).stdout.strip(),
        "result": run(
            "systemctl", "show", "--property=Result", "--value", unit,
        ).stdout.strip(),
    }


def main() -> int:
    if os.geteuid() != 0:
        raise SystemExit("controlled-swarm observation must run as root")
    epoch_path = (
        pathlib.Path("/var/lib/paperclip-gloops/campaign-deadman")
        / CAMPAIGN_ID
        / "epoch.json"
    )
    deadman = None
    socket_path = pathlib.Path("/run/paperclip-campaign/deadman.sock")
    if socket_path.is_socket():
        status = run(
            "/usr/local/lib/paperclip-gloops/verify-campaign-deadman.py",
            "--wait-seconds",
            "1",
            "--campaign-id",
            CAMPAIGN_ID,
        )
        deadman = (
            {"verification": status.stdout.strip()}
            if status.returncode == 0
            else {
                "status": "verification_failed",
                "error": status.stderr.strip(),
            }
        )
    usage = shutil.disk_usage("/")
    memory = pathlib.Path("/proc/meminfo").read_text(encoding="utf-8").splitlines()
    memory_values = {
        key: int(value.split()[0])
        for key, value in (line.split(":", 1) for line in memory)
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}
    }
    containers = run(
        "docker",
        "ps",
        "-a",
        "--filter",
        "name=paperclip-",
        "--format",
        "{{.Names}}:{{.Status}}",
    ).stdout.splitlines()
    snapshot = {
        "schemaVersion": "gloops.controlled-swarm-observation.v1",
        "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="milliseconds",
        ).replace("+00:00", "Z"),
        "units": {unit: unit_state(unit) for unit in UNITS},
        "markers": {
            "paperclip": pathlib.Path(
                "/etc/paperclip-gloops/ACTIVATION_APPROVED",
            ).exists(),
            "hermes": pathlib.Path(
                "/etc/paperclip-gloops/HERMES_EXECUTION_APPROVED",
            ).exists(),
            "operatorApproval": pathlib.Path(
                "/etc/paperclip-gloops/CONTROLLED_SWARM_ACTIVATION_APPROVED",
            ).exists(),
        },
        "deadman": deadman,
        "epoch": json.loads(epoch_path.read_text(encoding="utf-8"))
        if epoch_path.is_file()
        else None,
        "containers": containers,
        "host": {
            "loadAverage": pathlib.Path("/proc/loadavg").read_text(
                encoding="utf-8",
            ).split()[:3],
            "memoryKiB": memory_values,
            "rootFilesystem": {
                "totalBytes": usage.total,
                "usedBytes": usage.used,
                "freeBytes": usage.free,
            },
        },
    }
    print(json.dumps(snapshot, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
