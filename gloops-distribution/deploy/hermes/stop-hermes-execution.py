#!/usr/bin/env python3
"""Stop the bounded Hermes gateway through its planned-stop lifecycle.

The helper always attempts to leave the container dark.  It returns failure
unless Hermes itself recorded a graceful stop before the container was
terminated, and it persists an append-only, non-secret lifecycle receipt.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone


CONTAINER = "paperclip-hermes-execution"
DOCKER = "/usr/bin/docker"
HERMES = "/opt/hermes/.venv/bin/hermes"
CREDENTIAL_RECEIPT = Path("/run/paperclip-gloops/credential-receipt.json")
HISTORY = Path("/var/lib/paperclip-gloops/hermes-stop-history.jsonl")
STATE_COMMAND = (
    "import json,pathlib; "
    "p=pathlib.Path('/opt/data/gateway_state.json'); "
    "print((json.loads(p.read_text()) if p.exists() else {}).get('state',''))"
)


class StopError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(args: list[str], timeout: float = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout)


def container_exists() -> bool:
    return run([DOCKER, "inspect", CONTAINER], timeout=5).returncode == 0


def read_lifecycle_id() -> str | None:
    if not CREDENTIAL_RECEIPT.exists():
        return None
    raw = json.loads(CREDENTIAL_RECEIPT.read_text())
    value = raw.get("lifecycleId") if isinstance(raw, dict) else None
    return value if isinstance(value, str) and value else None


def atomic_write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def append_receipt(receipt: dict[str, object]) -> None:
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    record = {**receipt, "receiptDigest": digest}
    existing = HISTORY.read_text() if HISTORY.exists() else ""
    for line in existing.splitlines():
        try:
            if json.loads(line).get("receiptDigest") == digest:
                return
        except (json.JSONDecodeError, AttributeError):
            raise StopError("Hermes stop history is malformed")
    atomic_write(HISTORY, existing + json.dumps(record, sort_keys=True) + "\n")


def planned_stop() -> tuple[bool, str]:
    command = run(
        [
            DOCKER,
            "exec",
            "--user",
            "10000:10000",
            "--env",
            "HOME=/opt/data",
            "--env",
            "HERMES_HOME=/opt/data",
            CONTAINER,
            HERMES,
            "gateway",
            "stop",
        ],
        timeout=30,
    )
    if command.returncode != 0:
        return False, (command.stderr or command.stdout).strip()[-500:]

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not container_exists():
            return False, "container exited before gateway_state=stopped was observed"
        state = run(
            [
                DOCKER,
                "exec",
                "--user",
                "10000:10000",
                CONTAINER,
                "/opt/hermes/.venv/bin/python",
                "-c",
                STATE_COMMAND,
            ],
            timeout=5,
        )
        if state.returncode == 0 and state.stdout.strip() == "stopped":
            return True, ""
        time.sleep(0.25)
    return False, "gateway_state did not become stopped within 30 seconds"


def stop_container() -> tuple[bool, str]:
    if not container_exists():
        return True, ""
    stopped = run([DOCKER, "stop", "--time", "10", CONTAINER], timeout=20)
    if stopped.returncode == 0 or not container_exists():
        return True, ""
    return False, (stopped.stderr or stopped.stdout).strip()[-500:]


def main() -> int:
    if os.geteuid() != 0:
        raise StopError("run as root")

    receipt: dict[str, object] = {
        "schemaVersion": "gloops.hermes-stop-receipt.v1",
        "lifecycleId": read_lifecycle_id(),
        "requestedAt": now(),
        "containerPresent": container_exists(),
        "plannedStopAccepted": False,
        "gatewayState": None,
        "containerStopped": False,
        "status": "failed",
        "error": None,
    }
    errors: list[str] = []
    if receipt["containerPresent"]:
        try:
            graceful, detail = planned_stop()
            receipt["plannedStopAccepted"] = graceful
            receipt["gatewayState"] = "stopped" if graceful else None
            if not graceful:
                errors.append(detail or "planned stop failed")
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            errors.append(f"planned stop failed: {error}")

    try:
        stopped, detail = stop_container()
        receipt["containerStopped"] = stopped
        if not stopped:
            errors.append(detail or "container stop failed")
    except (OSError, subprocess.SubprocessError) as error:
        errors.append(f"container stop failed: {error}")

    if receipt["containerPresent"] and receipt["plannedStopAccepted"] and receipt["containerStopped"]:
        receipt["status"] = "succeeded"
    elif not receipt["containerPresent"]:
        receipt["status"] = "not-present"
    receipt["error"] = "; ".join(errors) or None
    receipt["completedAt"] = now()
    append_receipt(receipt)

    if receipt["status"] not in {"succeeded", "not-present"}:
        print(f"stop-hermes-execution: {receipt['error']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (StopError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"stop-hermes-execution: {error}", file=sys.stderr)
        raise SystemExit(1)

