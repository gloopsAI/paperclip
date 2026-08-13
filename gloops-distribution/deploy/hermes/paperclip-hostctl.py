#!/usr/bin/env python3
"""Exclusive, receipted mutation entrypoint for the Paperclip host."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


LOCK_PATH = Path(os.environ.get("PAPERCLIP_HOSTCTL_LOCK", "/var/lock/paperclip-gloops-writer.lock"))
JOURNAL_PATH = Path(
    os.environ.get(
        "PAPERCLIP_HOSTCTL_JOURNAL",
        "/var/log/paperclip-gloops/host-writer-journal.jsonl",
    )
)
HOLDER_PATH = Path(
    os.environ.get(
        "PAPERCLIP_HOSTCTL_HOLDER",
        "/run/paperclip-gloops/host-writer-holder.json",
    )
)
RUNTIME_ENV = Path(
    os.environ.get("PAPERCLIP_HOSTCTL_RUNTIME_ENV", "/etc/paperclip-gloops/runtime.env")
)
APPROVED_IMAGE = Path(
    os.environ.get("PAPERCLIP_HOSTCTL_APPROVED_IMAGE", "/etc/paperclip-gloops/approved-image")
)
SYSTEMCTL = os.environ.get("PAPERCLIP_HOSTCTL_SYSTEMCTL", "systemctl")
TEST_MODE = os.environ.get("PAPERCLIP_HOSTCTL_TEST_MODE") == "1"

TRACKED_KEYS = (
    "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED",
    "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS",
    "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS",
    "HEARTBEAT_SCHEDULER_ENABLED",
    "PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED",
)
ALLOWED_KEYS = frozenset(
    (
        *TRACKED_KEYS,
        "PAPERCLIP_IMAGE",
        "PAPERCLIP_ALLOWED_HOSTNAMES",
        "PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS",
    )
)
ALLOWED_ACTIONS = frozenset(("start", "stop", "restart", "mask", "unmask", "reset-failed"))
ALLOWED_UNITS = frozenset(
    (
        "paperclip-gloops.service",
        "paperclip-controlled-swarm.service",
        "paperclip-hermes-execution.service",
        "paperclip-github-push-broker.service",
        "paperclip-github-read-broker.service",
        "paperclip-platform-ops-broker.service",
        "paperclip-campaign-deadman.service",
        "paperclip-controlled-swarm-commissioning-recovery.service",
        "paperclip-gloops-handshake.service",
        "paperclip-hermes-handshake.service",
        "paperclip-hermes-handshake-egress.service",
    )
)


class HostctlError(RuntimeError):
    pass


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def runtime_hash() -> str:
    return "sha256:" + hashlib.sha256(RUNTIME_ENV.read_bytes()).hexdigest()


def read_runtime() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in RUNTIME_ENV.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in values:
            raise HostctlError(f"runtime.env contains duplicate key: {key}")
        values[key] = value
    return values


def atomic_write(path: Path, content: str, mode: int, uid: int, gid: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        if not TEST_MODE:
            os.chown(temporary, uid, gid)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def update_runtime(updates: dict[str, str]) -> None:
    unknown = sorted(set(updates) - ALLOWED_KEYS)
    if unknown:
        raise HostctlError(f"runtime key is not allowlisted: {', '.join(unknown)}")
    source = RUNTIME_ENV.read_text(encoding="utf-8")
    lines = source.splitlines()
    seen = {key: 0 for key in updates}
    output: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0]
        if key in updates:
            seen[key] += 1
            output.append(f"{key}={updates[key]}")
        else:
            output.append(line)
    duplicates = {key: count for key, count in seen.items() if count > 1}
    if duplicates:
        raise HostctlError(f"runtime.env keys must not be duplicated: {duplicates}")
    for key, count in seen.items():
        if count == 0:
            output.append(f"{key}={updates[key]}")
    file_stat = RUNTIME_ENV.stat()
    atomic_write(
        RUNTIME_ENV,
        "\n".join(output) + "\n",
        stat.S_IMODE(file_stat.st_mode),
        file_stat.st_uid,
        file_stat.st_gid,
    )


def append_journal(event: dict[str, Any]) -> None:
    JOURNAL_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(JOURNAL_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, (json.dumps(event, sort_keys=True, separators=(",", ":")) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def read_journal() -> list[dict[str, Any]]:
    if not JOURNAL_PATH.exists():
        return []
    events: list[dict[str, Any]] = []
    for number, line in enumerate(JOURNAL_PATH.read_text(encoding="utf-8").splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise HostctlError(f"journal line {number} is malformed") from error
        if not isinstance(event, dict):
            raise HostctlError(f"journal line {number} is not an object")
        events.append(event)
    return events


def dangling_pre(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    open_windows: dict[str, dict[str, Any]] = {}
    for event in events:
        window_id = event.get("window_id")
        if not isinstance(window_id, str):
            continue
        if event.get("event") == "pre":
            open_windows[window_id] = event
        elif event.get("event") == "post":
            open_windows.pop(window_id, None)
    return next(reversed(open_windows.values()), None) if open_windows else None


def last_recorded_hash(events: list[dict[str, Any]]) -> str | None:
    for event in reversed(events):
        if event.get("event") in ("post", "reconcile"):
            value = event.get("runtime_env_sha256")
            if isinstance(value, str):
                return value
    return None


def pid_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_holder() -> dict[str, Any]:
    try:
        value = json.loads(HOLDER_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def write_holder(holder: dict[str, Any]) -> None:
    atomic_write(HOLDER_PATH, json.dumps(holder, sort_keys=True) + "\n", 0o600, 0, 0)


def remove_holder() -> None:
    try:
        HOLDER_PATH.unlink()
    except FileNotFoundError:
        pass


def acquire_lock() -> Any:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = LOCK_PATH.open("a+")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        holder = read_holder()
        identity = holder.get("holder", holder) if holder else {"state": "identity unavailable"}
        handle.close()
        raise HostctlError(f"host writer lock held by {json.dumps(identity, sort_keys=True)}") from error
    return handle


def run_systemctl(action: str, unit: str) -> None:
    if action not in ALLOWED_ACTIONS:
        raise HostctlError(f"systemctl action is not allowlisted: {action}")
    if unit not in ALLOWED_UNITS:
        raise HostctlError(f"systemd unit is not allowlisted: {unit}")
    result = subprocess.run(
        [SYSTEMCTL, action, unit],
        text=True,
        capture_output=True,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise HostctlError(f"systemctl {action} {unit} failed: {detail}")


def unit_state(unit: str) -> str:
    result = subprocess.run(
        [SYSTEMCTL, "is-active", unit],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    return result.stdout.strip() or "inactive"


def snapshot(exit_status: int) -> dict[str, Any]:
    runtime = read_runtime()
    approved = APPROVED_IMAGE.read_text(encoding="utf-8").strip() if APPROVED_IMAGE.exists() else "missing"
    return {
        "commissioned": runtime.get(TRACKED_KEYS[0], "missing"),
        "controlled_swarm_readmit": runtime.get(TRACKED_KEYS[1], "missing"),
        "backlog_bankruptcy_readmit": runtime.get(TRACKED_KEYS[2], "missing"),
        "scheduler": runtime.get(TRACKED_KEYS[3], "missing"),
        "execution_recovery": runtime.get(TRACKED_KEYS[4], "missing"),
        "pin_digest": approved,
        "unit_state": {
            "paperclip-gloops.service": unit_state("paperclip-gloops.service"),
            "paperclip-controlled-swarm.service": unit_state("paperclip-controlled-swarm.service"),
            "paperclip-hermes-execution.service": unit_state("paperclip-hermes-execution.service"),
        },
        "runtime_env_sha256": runtime_hash(),
        "exit_status": exit_status,
    }


def identity(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "agent_slug": args.agent_slug,
        "session_id": args.session_id,
        "pid": os.getpid(),
    }


def verify_clean_history(events: list[dict[str, Any]]) -> None:
    dangling = dangling_pre(events)
    if dangling:
        raise HostctlError(
            "unreconciled writer window refuses mutation: "
            + json.dumps({"window_id": dangling.get("window_id"), "holder": dangling.get("holder")}, sort_keys=True)
        )
    recorded_hash = last_recorded_hash(events)
    if recorded_hash is not None and recorded_hash != runtime_hash():
        raise HostctlError(
            f"runtime.env hash mismatch refuses mutation: recorded={recorded_hash} actual={runtime_hash()}"
        )


def apply(args: argparse.Namespace) -> dict[str, Any]:
    lock = acquire_lock()
    window_id = str(uuid4())
    holder = {
        "window_id": window_id,
        "holder": identity(args),
        "mission_id": args.mission_id,
        "intent": args.intent,
        "acquired_at": timestamp(),
    }
    try:
        events = read_journal()
        verify_clean_history(events)
        pre = {
            "event": "pre",
            "ts": timestamp(),
            **holder,
            "planned_ops": [*args.set_values, *args.systemctl],
        }
        append_journal(pre)
        write_holder(holder)
        terminal_written = False
        try:
            updates: dict[str, str] = {}
            for assignment in args.set_values:
                if "=" not in assignment:
                    raise HostctlError("--set requires KEY=VALUE")
                key, value = assignment.split("=", 1)
                if key in updates:
                    raise HostctlError(f"duplicate --set key: {key}")
                updates[key] = value
            if updates:
                update_runtime(updates)
            for operation in args.systemctl:
                if ":" not in operation:
                    raise HostctlError("--systemctl requires ACTION:UNIT")
                action, unit = operation.split(":", 1)
                run_systemctl(action, unit)
            post_state = snapshot(0)
            append_journal({"event": "post", "ts": timestamp(), **holder, **post_state})
            terminal_written = True
            return {"ok": True, "window_id": window_id, "post_state": post_state}
        except Exception:
            try:
                post_state = snapshot(1)
                append_journal({"event": "post", "ts": timestamp(), **holder, **post_state})
                terminal_written = True
            except Exception:
                pass
            raise
        finally:
            if terminal_written:
                remove_holder()
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def reconcile(args: argparse.Namespace) -> dict[str, Any]:
    lock = acquire_lock()
    try:
        events = read_journal()
        dangling = dangling_pre(events)
        if dangling:
            old_holder = dangling.get("holder", {})
            if pid_alive(old_holder.get("pid") if isinstance(old_holder, dict) else None):
                raise HostctlError(f"cannot break live writer: {json.dumps(old_holder, sort_keys=True)}")
            append_journal(
                {
                    "event": "break",
                    "ts": timestamp(),
                    "broken_window_id": dangling.get("window_id"),
                    "broken_holder": old_holder,
                    "reason": args.reason,
                    "holder": identity(args),
                    "mission_id": args.mission_id,
                }
            )
        state = snapshot(0)
        append_journal(
            {
                "event": "reconcile",
                "ts": timestamp(),
                "holder": identity(args),
                "mission_id": args.mission_id,
                "reason": args.reason,
                **state,
            }
        )
        remove_holder()
        return {"ok": True, "reconciled_dangling": dangling is not None, "post_state": state}
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def status() -> dict[str, Any]:
    events = read_journal()
    return {
        "ok": True,
        "holder": read_holder() or None,
        "dangling_pre": dangling_pre(events),
        "last_recorded_hash": last_recorded_hash(events),
        "runtime_env_sha256": runtime_hash(),
        "post_state": snapshot(0),
    }


def add_identity_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--agent-slug", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--mission-id", required=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    status_parser = subparsers.add_parser("status")
    status_parser.set_defaults(handler=lambda _args: status())

    reconcile_parser = subparsers.add_parser("reconcile")
    add_identity_arguments(reconcile_parser)
    reconcile_parser.add_argument("--reason", required=True)
    reconcile_parser.set_defaults(handler=reconcile)

    apply_parser = subparsers.add_parser("apply")
    add_identity_arguments(apply_parser)
    apply_parser.add_argument("--intent", required=True)
    apply_parser.add_argument("--set", dest="set_values", action="append", default=[])
    apply_parser.add_argument("--systemctl", action="append", default=[])
    apply_parser.set_defaults(handler=apply)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not TEST_MODE and args.command != "status" and os.geteuid() != 0:
        raise SystemExit("paperclip-hostctl mutations and host receipts require root")
    try:
        result = args.handler(args)
    except (HostctlError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
