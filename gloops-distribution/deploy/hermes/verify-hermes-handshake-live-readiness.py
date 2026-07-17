#!/usr/bin/env python3
"""Fail closed on installed-state drift before a Hermes handshake activation."""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import sys
from pathlib import Path

UNIT = "paperclip-hermes-handshake-egress.service"
EXPECTED_PROXY_SHA256 = "9d36abb8b879cc5b7bc5c67e3acb9a0668fb20471a7deb28a1637cf86e0a24a5"
EXPECTED_UNIT_SHA256 = "bf082d5a327b0956cfc9c3c6d96b1a2fe6fccea7b858ced7a7842f4dbcba4049"
EXPECTED_UNIT_LINES = {
    "ExecStartPost=/usr/bin/sh -ec 'for i in $(seq 1 50); do /usr/bin/ss -lntH sport = :18080 | /usr/bin/grep -Fq 172.30.241.1:18080 && exit 0; sleep 0.1; done; exit 1'",
    "DynamicUser=yes",
    "NoNewPrivileges=yes",
    "RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "SystemCallFilter=@system-service",
    "TasksMax=64",
    "MemoryMax=128M",
    "CPUQuota=50%",
    "LimitNOFILE=64",
    "RuntimeMaxSec=900",
}
DROPIN_DIRS = (
    f"{UNIT}.d",
    "paperclip-hermes-handshake-.service.d",
    "paperclip-hermes-.service.d",
    "paperclip-.service.d",
    "service.d",
)
DEPENDENCY_DIRS = (f"{UNIT}.wants", f"{UNIT}.requires", f"{UNIT}.upholds")


class ReadinessError(RuntimeError):
    pass


def _mapped(root: Path, absolute: str) -> Path:
    return root / absolute.lstrip("/")


def _require_path(
    path: Path,
    *,
    mode: int | None,
    uid: int,
    gid: int,
    directory: bool,
    label: str,
) -> None:
    try:
        value = path.lstat()
    except OSError as exc:
        raise ReadinessError(f"{label} is unavailable: {path}: {exc}") from exc
    if stat.S_ISLNK(value.st_mode):
        raise ReadinessError(f"{label} must not be a symbolic link: {path}")
    if directory and not stat.S_ISDIR(value.st_mode):
        raise ReadinessError(f"{label} is not a directory: {path}")
    if not directory and not stat.S_ISREG(value.st_mode):
        raise ReadinessError(f"{label} is not a regular file: {path}")
    actual_mode = stat.S_IMODE(value.st_mode)
    if mode is not None and actual_mode != mode:
        raise ReadinessError(
            f"{label} mode is {actual_mode:04o}, expected {mode:04o}: {path}"
        )
    if value.st_uid != uid or value.st_gid != gid:
        raise ReadinessError(
            f"{label} owner is {value.st_uid}:{value.st_gid}, expected {uid}:{gid}: {path}"
        )


def _require_protected_directory_chain(
    root: Path,
    absolute: str,
    *,
    uid: int,
    gid: int,
    require_final: bool,
    label: str,
) -> None:
    current = root
    parts = Path(absolute).parts
    for index, part in enumerate(parts[1:], start=1):
        current /= part
        final = index == len(parts) - 1
        if not current.exists() and not current.is_symlink():
            if require_final:
                raise ReadinessError(f"{label} is unavailable: {current}")
            return
        _require_path(
            current,
            mode=None,
            uid=uid,
            gid=gid,
            directory=True,
            label=label,
        )
        mode = stat.S_IMODE(current.stat().st_mode)
        if mode & 0o022 or mode & stat.S_IXOTH == 0:
            raise ReadinessError(
                f"{label} chain is not root-protected and traversable: {current}"
            )
        if final:
            return


def verify(root: Path, uid: int, gid: int) -> None:
    # DynamicUser has no deployment-specific supplementary group. Every
    # ancestor therefore needs the world-execute bit, not merely a correct
    # final-directory mode.
    for absolute in ("/", "/usr", "/usr/local", "/usr/local/lib"):
        path = root if absolute == "/" else _mapped(root, absolute)
        _require_path(
            path,
            mode=None,
            uid=uid,
            gid=gid,
            directory=True,
            label="proxy ancestor",
        )
        if stat.S_IMODE(path.stat().st_mode) & stat.S_IXOTH == 0:
            raise ReadinessError(
                f"proxy ancestor is not traversable by DynamicUser: {path}"
            )
        if stat.S_IMODE(path.stat().st_mode) & 0o022:
            raise ReadinessError(
                f"proxy ancestor is writable outside root and cannot protect its child path: {path}"
            )

    lib_dir = _mapped(root, "/usr/local/lib/paperclip-gloops")
    proxy = lib_dir / "hermes-handshake-egress-proxy.py"
    unit_source = _mapped(root, f"/usr/local/lib/systemd/system/{UNIT}")
    unit_mask = _mapped(root, f"/etc/systemd/system/{UNIT}")

    _require_path(
        lib_dir,
        mode=0o755,
        uid=uid,
        gid=gid,
        directory=True,
        label="proxy directory",
    )
    _require_path(
        proxy,
        mode=0o555,
        uid=uid,
        gid=gid,
        directory=False,
        label="proxy executable",
    )
    proxy_sha256 = hashlib.sha256(proxy.read_bytes()).hexdigest()
    if proxy_sha256 != EXPECTED_PROXY_SHA256:
        raise ReadinessError(
            f"installed egress proxy hash is {proxy_sha256}, expected {EXPECTED_PROXY_SHA256}"
        )
    _require_path(
        unit_source,
        mode=0o644,
        uid=uid,
        gid=gid,
        directory=False,
        label="installed egress unit",
    )

    protected_lookup_dirs = (
        "/etc/systemd/system",
        "/usr/local/lib/systemd/system",
    )
    for absolute in protected_lookup_dirs:
        _require_protected_directory_chain(
            root,
            absolute,
            uid=uid,
            gid=gid,
            require_final=True,
            label="systemd lookup directory",
        )

    if not unit_mask.is_symlink() or os.readlink(unit_mask) != "/dev/null":
        raise ReadinessError(
            f"egress unit is not masked by the exact /dev/null link: {unit_mask}"
        )
    # Reject every same-name unit or drop-in location that can override or
    # augment the governed /usr/local unit after the /etc mask is removed.
    override_roots = (
        "/etc/systemd/system.control",
        "/run/systemd/system.control",
        "/run/systemd/transient",
        "/run/systemd/generator.early",
        "/etc/systemd/system",
        "/etc/systemd/system.attached",
        "/run/systemd/system",
        "/run/systemd/system.attached",
        "/run/systemd/generator",
        "/usr/local/lib/systemd/system",
        "/usr/lib/systemd/system",
        "/run/systemd/generator.late",
    )
    overrides = []
    for base in override_roots:
        _require_protected_directory_chain(
            root,
            base,
            uid=uid,
            gid=gid,
            require_final=False,
            label="systemd override search directory",
        )
        if base != "/usr/local/lib/systemd/system" and base != "/etc/systemd/system":
            overrides.append(_mapped(root, f"{base}/{UNIT}"))
        for relative in (*DROPIN_DIRS, *DEPENDENCY_DIRS):
            overrides.append(_mapped(root, f"{base}/{relative}"))
    for override in overrides:
        if override.exists() or override.is_symlink():
            raise ReadinessError(f"higher-precedence egress unit override exists: {override}")

    unit_bytes = unit_source.read_bytes()
    unit_sha256 = hashlib.sha256(unit_bytes).hexdigest()
    if unit_sha256 != EXPECTED_UNIT_SHA256:
        raise ReadinessError(
            f"installed egress unit hash is {unit_sha256}, expected {EXPECTED_UNIT_SHA256}"
        )
    unit_lines = set(unit_bytes.decode("utf-8").splitlines())
    missing = sorted(EXPECTED_UNIT_LINES - unit_lines)
    if missing:
        raise ReadinessError(
            "installed egress unit is missing exact live-readiness/security lines: "
            + ", ".join(missing)
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("/"))
    parser.add_argument("--expected-owner", default="0:0")
    args = parser.parse_args()
    try:
        uid_text, gid_text = args.expected_owner.split(":", 1)
        uid, gid = int(uid_text), int(gid_text)
    except (TypeError, ValueError) as exc:
        parser.error(f"--expected-owner must be numeric UID:GID: {exc}")
    try:
        verify(args.root.resolve(), uid, gid)
    except (OSError, UnicodeError, ReadinessError) as exc:
        print(f"FAIL Hermes handshake installed live-readiness invariant: {exc}", file=sys.stderr)
        return 1
    print(
        "PASS Hermes handshake installed live-readiness invariant: "
        "full DynamicUser path and exact masked egress unit"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
