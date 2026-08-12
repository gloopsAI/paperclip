#!/usr/bin/env python3
"""Atomically set the controlled-swarm commissioning barrier."""

from __future__ import annotations

import argparse
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import tempfile


KEY = "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED"
DEFAULT_RUNTIME_ENV = Path("/etc/paperclip-gloops/runtime.env")
HOSTCTL = Path("/usr/local/lib/paperclip-gloops/paperclip-hostctl.py")
HOST_WRITER_LOCK = Path(
    os.environ.get("PAPERCLIP_HOSTCTL_LOCK", "/var/lock/paperclip-gloops-writer.lock")
)


def read_barrier(path: Path) -> bool:
    source = path.read_text(encoding="utf-8")
    false_line = f"{KEY}=false\n"
    true_line = f"{KEY}=true\n"
    if source.count(false_line) + source.count(true_line) != 1:
        raise ValueError("commissioning barrier line is missing or duplicated")
    return true_line in source


def set_barrier(path: Path, commissioned: bool) -> bool:
    current = read_barrier(path)
    if current == commissioned:
        return False

    source = path.read_text(encoding="utf-8")
    false_line = f"{KEY}=false\n"
    true_line = f"{KEY}=true\n"
    target_line = true_line if commissioned else false_line
    current_line = true_line if true_line in source else false_line

    file_stat = path.stat()
    mode = stat.S_IMODE(file_stat.st_mode)
    replacement = source.replace(current_line, target_line)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(replacement)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, file_stat.st_uid, file_stat.st_gid)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def barrier_matches_under_writer_lock(path: Path, commissioned: bool) -> bool:
    """Linearize a no-op check without entering a dirty host-writer journal."""
    HOST_WRITER_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with HOST_WRITER_LOCK.open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        try:
            return read_barrier(path) == commissioned
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("value", choices=("true", "false"))
    parser.add_argument(
        "--runtime-env",
        type=Path,
        default=DEFAULT_RUNTIME_ENV,
    )
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit("commissioning barrier mutation must run as root")
    commissioned = args.value == "true"
    if barrier_matches_under_writer_lock(args.runtime_env, commissioned):
        return 0
    if args.runtime_env == DEFAULT_RUNTIME_ENV and HOSTCTL.exists():
        command = [
            str(HOSTCTL),
            "apply",
            "--agent-slug",
            os.environ.get("PAPERCLIP_HOST_WRITER_AGENT", "legacy-root-commissioner"),
            "--session-id",
            os.environ.get("PAPERCLIP_HOST_WRITER_SESSION", f"pid-{os.getpid()}"),
            "--mission-id",
            os.environ.get("PAPERCLIP_HOST_WRITER_MISSION", "controlled-swarm-commissioning"),
            "--intent",
            f"set controlled-swarm commissioning barrier {args.value}",
            "--set",
            f"{KEY}={args.value}",
        ]
        return subprocess.run(command, check=False).returncode
    set_barrier(args.runtime_env, commissioned)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
