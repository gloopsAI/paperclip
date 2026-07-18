#!/usr/bin/env python3
"""Time-accelerated host proof for the exact installed 24-hour deadman."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import stat
import subprocess
import threading
import time
import uuid
from typing import Any


UTC = dt.timezone.utc
PRODUCTION_UNITS = (
    "paperclip-gloops.service",
    "paperclip-gloops-handshake.service",
    "paperclip-hermes-execution.service",
    "paperclip-hermes-handshake.service",
    "paperclip-hermes-handshake-egress.service",
    "paperclip-campaign-deadman.service",
    "paperclip-controlled-swarm-commissioning-recovery.service",
)
TARGET = "paperclip-campaign-deadman-rehearsal-target.service"
CAMPAIGN_ID = "controlled-swarm-deadman-rehearsal"
SOURCE = pathlib.Path("/usr/local/lib/paperclip-gloops/campaign-deadman.py")
STOP_ACTUATOR = pathlib.Path(
    "/usr/local/lib/paperclip-gloops/campaign-deadman-rehearsal-stop.sh",
)
RUN_DIR = pathlib.Path("/run/paperclip-campaign-rehearsal")
RECEIPT_DIR = pathlib.Path("/var/lib/paperclip-gloops/rehearsals")
REHEARSAL_STATE_DIR = pathlib.Path(
    "/var/lib/paperclip-gloops/campaign-deadman-rehearsal",
)


class MutableClock:
    def __init__(self, value: dt.datetime) -> None:
        self.value = value

    def now(self) -> dt.datetime:
        return self.value


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, capture_output=True, text=True)


def request(socket_path: pathlib.Path, operation: str, **extra: str) -> dict[str, Any]:
    payload = {
        "schemaVersion": "gloops.campaign-deadman.v1",
        "campaignId": CAMPAIGN_ID,
        "operation": operation,
        **extra,
    }
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(str(socket_path))
        client.sendall(json.dumps(payload).encode() + b"\n")
        response = b""
        while b"\n" not in response:
            response += client.recv(4096)
    return json.loads(response.split(b"\n", 1)[0])


def wait_for(predicate, *, seconds: float, message: str) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise RuntimeError(message)


def assert_dark() -> None:
    for unit in PRODUCTION_UNITS:
        if run("systemctl", "is-active", "--quiet", unit, check=False).returncode == 0:
            raise RuntimeError(f"production unit is active: {unit}")
        enabled = run("systemctl", "is-enabled", unit, check=False).stdout.strip()
        if enabled != "masked":
            raise RuntimeError(f"production unit is not masked: {unit} ({enabled})")
    for marker in (
        pathlib.Path("/etc/paperclip-gloops/ACTIVATION_APPROVED"),
        pathlib.Path("/etc/paperclip-gloops/HERMES_EXECUTION_APPROVED"),
        pathlib.Path("/etc/paperclip-gloops/CONTROLLED_SWARM_ACTIVATION_APPROVED"),
        pathlib.Path("/run/paperclip-campaign/deadman.sock"),
    ):
        if marker.exists() or marker.is_socket():
            raise RuntimeError(f"production activation surface exists: {marker}")
    production_epoch = pathlib.Path(
        "/var/lib/paperclip-gloops/campaign-deadman/controlled-swarm-20260717/epoch.json",
    )
    if production_epoch.exists():
        raise RuntimeError("production campaign epoch is already armed")
    if run("systemctl", "is-active", "--quiet", TARGET, check=False).returncode == 0:
        raise RuntimeError("campaign deadman rehearsal target is active")
    if RUN_DIR.exists():
        raise RuntimeError("campaign deadman rehearsal runtime state remains")
    if REHEARSAL_STATE_DIR.exists() and any(REHEARSAL_STATE_DIR.iterdir()):
        raise RuntimeError("campaign deadman rehearsal durable state remains")


def load_module():
    spec = importlib.util.spec_from_file_location("installed_campaign_deadman", SOURCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load installed campaign deadman")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def file_sha256(path: pathlib.Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-source-path", type=pathlib.Path)
    args = parser.parse_args()
    global SOURCE
    if args.allow_source_path is not None:
        SOURCE = args.allow_source_path.resolve()
    if os.geteuid() != 0:
        raise SystemExit("deadman rehearsal must run as root")
    assert_dark()
    if not SOURCE.is_file() or not STOP_ACTUATOR.is_file():
        raise SystemExit("exact installed rehearsal assets are missing")

    run_id = f"{dt.datetime.now(UTC):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"
    state_root = REHEARSAL_STATE_DIR / run_id
    socket_path = RUN_DIR / "deadman.sock"
    clock = MutableClock(dt.datetime.now(UTC))
    module = load_module()
    server = None
    thread = None
    epoch_path = state_root / CAMPAIGN_ID / "epoch.json"
    started = time.monotonic()
    evidence: dict[str, Any] = {}

    RECEIPT_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(RECEIPT_DIR, 0, 0)
    RUN_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(RUN_DIR, 0, 0)
    (RUN_DIR / "stop.json").unlink(missing_ok=True)
    socket_path.unlink(missing_ok=True)

    def start_server():
        nonlocal server, thread
        store = module.CampaignEpochStore(
            state_dir=state_root,
            campaign_id=CAMPAIGN_ID,
            duration_seconds=86_400,
            require_immutable=True,
            now=clock.now,
        )
        server = module.DeadmanServer(
            store=store,
            socket_path=socket_path,
            socket_gid=0,
            stop_command=str(STOP_ACTUATOR),
        )
        thread = threading.Thread(target=server.serve, daemon=True)
        thread.start()
        wait_for(
            lambda: socket_path.is_socket(),
            seconds=5,
            message="rehearsal deadman socket did not become ready",
        )
        return store

    def stop_server() -> None:
        nonlocal server, thread
        if server is not None:
            server.stop()
        if thread is not None:
            thread.join(timeout=4)
            if thread.is_alive():
                raise RuntimeError("rehearsal deadman did not stop")
        server = None
        thread = None

    try:
        run(
            "systemd-run",
            "--unit",
            TARGET.removesuffix(".service"),
            "--property=CollectMode=inactive-or-failed",
            "/usr/bin/sleep",
            "infinity",
        )
        wait_for(
            lambda: run(
                "systemctl", "is-active", "--quiet", TARGET, check=False,
            ).returncode == 0,
            seconds=5,
            message="rehearsal target did not become active",
        )
        store = start_server()
        armed = request(
            socket_path,
            "admit",
            companyId="controlled-swarm-rehearsal-company",
            runId="deadman-rehearsal-first-run",
        )
        if armed.get("status") != "armed" or armed.get("allowed") is not True:
            raise RuntimeError(f"first rehearsal admission did not arm: {armed}")
        file_stat = epoch_path.stat()
        immutable = "i" in run(
            "/usr/bin/lsattr", "-d", str(epoch_path),
        ).stdout.split(maxsplit=1)[0]
        if (
            file_stat.st_uid != 0
            or file_stat.st_gid != 0
            or stat.S_IMODE(file_stat.st_mode) != 0o600
            or not immutable
        ):
            raise RuntimeError("rehearsal epoch is not root:root 0600 immutable")
        unprivileged_remove = run(
            "/usr/sbin/runuser",
            "-u",
            "paperclip",
            "--",
            "/usr/bin/rm",
            "-f",
            str(epoch_path),
            check=False,
        )
        if unprivileged_remove.returncode == 0 or not epoch_path.exists():
            raise RuntimeError("paperclip identity could remove the immutable epoch")

        original_deadline = armed["deadlineAt"]
        original_first_run = armed["firstRunId"]
        clock.value += dt.timedelta(hours=12)
        stop_server()
        store = start_server()
        active = request(
            socket_path,
            "admit",
            companyId="controlled-swarm-rehearsal-company",
            runId="deadman-rehearsal-restart-run",
        )
        if (
            active.get("deadlineAt") != original_deadline
            or active.get("firstRunId") != original_first_run
            or active.get("status") != "active"
        ):
            raise RuntimeError("restart renewed or replaced the fixed epoch")

        clock.value += dt.timedelta(hours=12, seconds=1)
        server._invoke_stop_if_expired()
        wait_for(
            lambda: run(
                "systemctl", "is-active", "--quiet", TARGET, check=False,
            ).returncode != 0,
            seconds=5,
            message="expired deadman did not stop the rehearsal target",
        )
        stop_receipt = RUN_DIR / "stop.json"
        if not stop_receipt.is_file() or not store.stop_receipt_path.is_file():
            raise RuntimeError("expired deadman emitted no stop receipt")
        denied = request(
            socket_path,
            "admit",
            companyId="controlled-swarm-rehearsal-company",
            runId="deadman-rehearsal-denied-run",
        )
        if denied.get("allowed") is not False or denied.get("status") != "denied":
            raise RuntimeError("expired campaign admitted more work")
        stop_server()
        restarted = module.CampaignEpochStore(
            state_dir=state_root,
            campaign_id=CAMPAIGN_ID,
            duration_seconds=86_400,
            require_immutable=True,
            now=clock.now,
        )
        if restarted.status().get("status") != "expired":
            raise RuntimeError("process restart renewed the expired epoch")

        approved_image = pathlib.Path("/etc/paperclip-gloops/approved-image").read_text(
            encoding="utf-8",
        ).strip()
        evidence = {
            "schemaVersion": "gloops.campaign-deadman-rehearsal.v1",
            "runId": run_id,
            "campaignId": CAMPAIGN_ID,
            "logicalDurationSeconds": 86_400,
            "installedBroker": str(SOURCE),
            "installedBrokerSha256": file_sha256(SOURCE),
            "installedStopActuatorSha256": file_sha256(STOP_ACTUATOR),
            "approvedImage": approved_image,
            "firstRunId": original_first_run,
            "deadlineAt": original_deadline,
            "epochRootOwned": True,
            "epochMode": "0600",
            "epochImmutable": True,
            "unprivilegedEpochRemovalDenied": True,
            "restartPreservedEpoch": True,
            "expiryStoppedTarget": TARGET,
            "postExpiryAdmissionDenied": True,
            "postExpiryRestartRemainedExpired": True,
            "providersInvoked": False,
            "paperclipActivated": False,
            "productionEpochCreated": False,
        }
    finally:
        if server is not None:
            stop_server()
        run("systemctl", "stop", TARGET, check=False)
        socket_path.unlink(missing_ok=True)
        if epoch_path.exists():
            run("/usr/bin/chattr", "-i", str(epoch_path))
        shutil.rmtree(state_root)
        shutil.rmtree(RUN_DIR)
        assert_dark()
    evidence.update({
        "completedAt": dt.datetime.now(UTC).isoformat(
            timespec="milliseconds",
        ).replace("+00:00", "Z"),
        "wallDurationSeconds": round(time.monotonic() - started, 3),
        "cleanupVerifiedDark": True,
        "outcome": "passed",
    })
    receipt_path = RECEIPT_DIR / f"campaign-deadman-{run_id}.json"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    fd = os.open(receipt_path, flags, 0o600)
    try:
        os.write(
            fd,
            json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()
            + b"\n",
        )
        os.fsync(fd)
    finally:
        os.close(fd)
    os.chown(receipt_path, 0, 0)
    print(json.dumps({**evidence, "receiptPath": str(receipt_path)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
