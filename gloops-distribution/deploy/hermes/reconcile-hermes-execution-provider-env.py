#!/usr/bin/env python3
"""Remove the undeclared Ollama endpoint override from the Hermes env file.

The accepted endpoint is pinned in the root-owned execution profile auth.json.
This tool deliberately knows only the legacy override key and preserves every
other line byte-for-byte.  It is explicit operator repair, never a preflight
side effect.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import tempfile


UNDECLARED_PROVIDER_KEY = b"OLLAMA_BASE_URL"
DEFAULT_ENV_FILE = Path("/etc/paperclip-gloops/hermes-execution.env")


class ReconciliationError(RuntimeError):
    pass


def reconcile(content: bytes) -> tuple[bytes, bool]:
    lines = content.splitlines(keepends=True)
    matched = []
    retained = []
    for line in lines:
        assignment = line.rstrip(b"\r\n")
        if assignment.startswith(UNDECLARED_PROVIDER_KEY + b"="):
            matched.append(line)
        else:
            retained.append(line)

    if len(matched) > 1:
        raise ReconciliationError(
            "duplicate undeclared Ollama endpoint override; refusing ambiguous repair"
        )
    if not matched:
        return content, False
    return b"".join(retained), True


def repair(path: Path, *, apply: bool) -> bool:
    try:
        before = path.lstat()
    except FileNotFoundError as exc:
        raise ReconciliationError("Hermes execution environment is missing") from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ReconciliationError("Hermes execution environment must be a regular file")

    original = path.read_bytes()
    updated, changed = reconcile(original)
    if not changed or not apply:
        return changed

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(before.st_mode))
        os.chown(temporary, before.st_uid, before.st_gid)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconcile the Hermes provider environment without exposing values."
    )
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="atomically remove the undeclared endpoint override",
    )
    args = parser.parse_args()
    try:
        changed = repair(args.env_file, apply=args.apply)
    except ReconciliationError as exc:
        parser.error(str(exc))

    if changed and not args.apply:
        print("DRIFT undeclared Ollama endpoint override is present")
        return 1
    if changed:
        print("REPAIRED undeclared Ollama endpoint override removed")
    else:
        print("PASS no undeclared Ollama endpoint override")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
