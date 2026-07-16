#!/usr/bin/env python3
"""Stop the bounded Hermes gateway through its planned-stop lifecycle.

The helper always attempts to leave the container dark.  It returns failure
unless Hermes itself recorded a graceful stop before the container was
terminated, and it persists an append-only, non-secret lifecycle receipt.
"""

from __future__ import annotations

import hashlib
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4


CONTAINER = "paperclip-hermes-execution"
DOCKER = "/usr/bin/docker"
HERMES = "/opt/hermes/.venv/bin/hermes"
CREDENTIAL_RECEIPT = Path("/var/lib/paperclip-gloops/credential-runtime/credential-receipt.json")
HISTORY = Path("/var/lib/paperclip-gloops/hermes-stop-history.jsonl")
HISTORY_LOCK = Path("/var/lib/paperclip-gloops/hermes-stop-history.lock")
SYSTEMD_STOP_TIMEOUT_SECONDS = 120
HELPER_BUDGET_SECONDS = 100
CONTAINER_STOP_TIMEOUT_SECONDS = 20
RECEIPT_RESERVE_SECONDS = 12
FORCED_DARK_RESERVE_SECONDS = CONTAINER_STOP_TIMEOUT_SECONDS + RECEIPT_RESERVE_SECONDS
PLANNED_STOP_TIMEOUT_SECONDS = HELPER_BUDGET_SECONDS - FORCED_DARK_RESERVE_SECONDS
STATE_COMMAND = (
    "import json,os,pathlib; "
    "p=pathlib.Path(os.environ.get('HERMES_HOME','/opt/data'))/'gateway_state.json'; "
    "r=json.loads(p.read_text()) if p.exists() else {}; "
    "pid=r.get('pid'); alive=False; "
    "\ntry:\n os.kill(pid,0); alive=True\nexcept (OSError,TypeError):\n pass\n"
    "print(json.dumps({'gateway_state':r.get('gateway_state'),"
    "'pid':pid,'updated_at':r.get('updated_at'),'alive':alive},sort_keys=True))"
)


class StopError(RuntimeError):
    pass


class ReceiptDeadlineExceeded(StopError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(args: list[str], timeout: float = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout)


def timeout_before(deadline: float, maximum: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise subprocess.TimeoutExpired("stop-hermes-execution deadline", 0)
    return min(maximum, remaining)


def container_exists(deadline: float | None = None) -> bool:
    timeout = 5 if deadline is None else timeout_before(deadline, 5)
    return run([DOCKER, "inspect", CONTAINER], timeout=timeout).returncode == 0


def read_lifecycle_id() -> str | None:
    if not CREDENTIAL_RECEIPT.exists():
        return None
    raw = json.loads(CREDENTIAL_RECEIPT.read_text())
    value = raw.get("lifecycleId") if isinstance(raw, dict) else None
    return value if isinstance(value, str) and value else None


def fsync_directory(path: Path) -> None:
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def atomic_write(path: Path, value: str) -> None:
    parent_created = not path.parent.exists()
    path.parent.mkdir(parents=True, exist_ok=True)
    if parent_created:
        fsync_directory(path.parent.parent)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def record_digest(record: dict[str, object]) -> str:
    payload = dict(record)
    payload.pop("receiptDigest", None)
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def validate_history(records: list[dict[str, object]]) -> None:
    prior: str | None = None
    attempts: set[str] = set()
    for sequence, record in enumerate(records, 1):
        if record.get("sequence") != sequence or record.get("previousReceiptDigest") != prior:
            raise StopError("Hermes stop history sequence or hash chain is malformed")
        if record.get("receiptDigest") != record_digest(record):
            raise StopError("Hermes stop history digest is malformed")
        attempt = record.get("attemptId")
        if not isinstance(attempt, str) or attempt in attempts:
            raise StopError("Hermes stop history attempt identity is malformed")
        attempts.add(attempt)
        prior = str(record["receiptDigest"])


def acquire_history_lock(lock_fd: int, deadline: float) -> None:
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ReceiptDeadlineExceeded("Hermes stop receipt lock deadline exceeded")
            time.sleep(min(0.05, remaining))


def append_receipt(receipt: dict[str, object], deadline: float | None = None) -> None:
    attempt_id = receipt.get("attemptId")
    if not isinstance(attempt_id, str) or not attempt_id:
        raise StopError("Hermes stop receipt has no attempt identity")
    if deadline is None:
        deadline = time.monotonic() + RECEIPT_RESERVE_SECONDS
    HISTORY_LOCK.parent.mkdir(parents=True, exist_ok=True)
    lock_fd = os.open(HISTORY_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    alarm_armed = False
    previous_handler = None
    try:
        os.chmod(HISTORY_LOCK, 0o600)
        os.chown(HISTORY_LOCK, 0, 0)
        acquire_history_lock(lock_fd, deadline)
        if threading.current_thread() is threading.main_thread() and hasattr(signal, "SIGALRM"):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ReceiptDeadlineExceeded("Hermes stop receipt persistence deadline exceeded")

            def receipt_alarm(_signum, _frame):
                raise ReceiptDeadlineExceeded("Hermes stop receipt persistence deadline exceeded")

            previous_handler = signal.getsignal(signal.SIGALRM)
            signal.signal(signal.SIGALRM, receipt_alarm)
            signal.setitimer(signal.ITIMER_REAL, remaining)
            alarm_armed = True
        records = [json.loads(line) for line in HISTORY.read_text().splitlines()] if HISTORY.exists() else []
        if not all(isinstance(record, dict) for record in records):
            raise StopError("Hermes stop history is malformed")
        validate_history(records)
        if any(record.get("attemptId") == attempt_id for record in records):
            return
        record = {
            **receipt,
            "sequence": len(records) + 1,
            "previousReceiptDigest": records[-1]["receiptDigest"] if records else None,
        }
        record["receiptDigest"] = record_digest(record)
        payload = "".join(json.dumps(value, sort_keys=True) + "\n" for value in [*records, record])
        atomic_write(HISTORY, payload)
        persisted = [json.loads(line) for line in HISTORY.read_text().splitlines()]
        validate_history(persisted)
        if persisted[-1].get("attemptId") != attempt_id:
            raise StopError("Hermes stop receipt was not durably projected")
    finally:
        if alarm_armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(lock_fd)


def read_gateway_record(deadline: float) -> dict[str, object] | None:
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
        timeout=timeout_before(deadline, 5),
    )
    if state.returncode != 0:
        return None
    value = json.loads(state.stdout)
    return value if isinstance(value, dict) else None


def planned_stop(deadline: float) -> tuple[bool, str]:
    before = read_gateway_record(deadline)
    if (
        not isinstance(before, dict)
        or before.get("gateway_state") != "running"
        or before.get("alive") is not True
        or not isinstance(before.get("pid"), int)
        or not isinstance(before.get("updated_at"), str)
    ):
        return False, "gateway was not observably running before planned stop"
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
        timeout=timeout_before(deadline, 30),
    )
    if command.returncode != 0:
        return False, (command.stderr or command.stdout).strip()[-500:]

    while time.monotonic() < deadline:
        if not container_exists(deadline):
            return False, "container exited before gateway_state=stopped was observed"
        state = read_gateway_record(deadline)
        if (
            isinstance(state, dict)
            and state.get("gateway_state") == "stopped"
            and state.get("pid") == before["pid"]
            and state.get("alive") is False
            and isinstance(state.get("updated_at"), str)
            and state["updated_at"] > before["updated_at"]
        ):
            return True, ""
        time.sleep(min(0.25, max(0, deadline - time.monotonic())))
    return False, (
        "gateway_state did not become stopped within "
        f"{PLANNED_STOP_TIMEOUT_SECONDS} seconds"
    )


def stop_container(deadline: float) -> tuple[bool, str]:
    if not container_exists(deadline):
        return True, ""
    stopped = run(
        [DOCKER, "stop", "--time", "10", CONTAINER],
        timeout=timeout_before(deadline, CONTAINER_STOP_TIMEOUT_SECONDS),
    )
    if stopped.returncode == 0 or not container_exists(deadline):
        return True, ""
    return False, (stopped.stderr or stopped.stdout).strip()[-500:]


def main() -> int:
    if os.geteuid() != 0:
        raise StopError("run as root")

    helper_deadline = time.monotonic() + HELPER_BUDGET_SECONDS
    planned_stop_deadline = helper_deadline - FORCED_DARK_RESERVE_SECONDS
    receipt: dict[str, object] = {
        "schemaVersion": "gloops.hermes-stop-receipt.v1",
        "attemptId": str(uuid4()),
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
            graceful, detail = planned_stop(planned_stop_deadline)
            receipt["plannedStopAccepted"] = graceful
            receipt["gatewayState"] = "stopped" if graceful else None
            if not graceful:
                errors.append(detail or "planned stop failed")
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            errors.append(f"planned stop failed: {error}")

    try:
        stop_deadline = helper_deadline - RECEIPT_RESERVE_SECONDS
        stopped, detail = stop_container(stop_deadline)
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
    append_receipt(receipt, helper_deadline)

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
