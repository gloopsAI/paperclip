#!/usr/bin/env python3
"""Apply the pinned Hermes route-receipt overlay without fuzz or guessing."""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterator


HERE = Path(__file__).resolve().parent
LOCK_PATH = HERE / "hermes-source-lock.json"
HUNK_RE = re.compile(
    r"^@@ -(?P<old_start>\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?P<new_start>\d+)(?:,(?P<new_count>\d+))? @@"
)
TRANSACTION_DIRECTORY = ".gloops-route-receipt-transaction"
JOURNAL_SCHEMA = "gloops.hermes-overlay-transaction.v1"


class OverlayError(RuntimeError):
    pass


@dataclass(frozen=True)
class Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    lines: tuple[str, ...]


@dataclass(frozen=True)
class FilePatch:
    old_path: str
    new_path: str
    hunks: tuple[Hunk, ...]

    @property
    def path(self) -> str:
        selected = self.new_path if self.new_path != "/dev/null" else self.old_path
        return selected[2:] if selected.startswith(("a/", "b/")) else selected


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        .encode("utf-8")
        + b"\n"
    )


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def locked_root(root: Path) -> Iterator[None]:
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def target_path(root: Path, relative: str) -> Path:
    candidate = PurePosixPath(relative)
    if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
        raise OverlayError(f"unsafe overlay path: {relative!r}")
    target = root.joinpath(*candidate.parts)
    current = root
    for part in candidate.parts:
        current = current / part
        if current.is_symlink():
            raise OverlayError(f"{relative}: symlink targets are not allowed")
    return target


def parse_patch(text: str) -> list[FilePatch]:
    lines = text.splitlines(keepends=True)
    patches: list[FilePatch] = []
    index = 0
    while index < len(lines):
        if not lines[index].startswith("--- "):
            raise OverlayError(f"unexpected patch line {index + 1}: {lines[index]!r}")
        old_path = lines[index][4:].strip()
        index += 1
        if index >= len(lines) or not lines[index].startswith("+++ "):
            raise OverlayError("missing new-file header")
        new_path = lines[index][4:].strip()
        index += 1
        hunks: list[Hunk] = []
        while index < len(lines) and not lines[index].startswith("--- "):
            match = HUNK_RE.match(lines[index])
            if not match:
                raise OverlayError(f"invalid hunk header at line {index + 1}")
            old_start = int(match.group("old_start"))
            old_count = int(match.group("old_count") or "1")
            new_start = int(match.group("new_start"))
            new_count = int(match.group("new_count") or "1")
            index += 1
            body: list[str] = []
            while index < len(lines):
                line = lines[index]
                if line.startswith(("@@ ", "--- ")):
                    break
                if line.startswith("\\ No newline at end of file"):
                    index += 1
                    continue
                if not line.startswith((" ", "+", "-")):
                    raise OverlayError(f"invalid hunk body at line {index + 1}")
                body.append(line)
                index += 1
            hunks.append(Hunk(old_start, old_count, new_start, new_count, tuple(body)))
        patches.append(FilePatch(old_path, new_path, tuple(hunks)))
    return patches


def apply_file_patch(original: bytes, file_patch: FilePatch) -> bytes:
    try:
        source = original.decode("utf-8").splitlines(keepends=True)
    except UnicodeDecodeError as exc:
        raise OverlayError(f"{file_patch.path}: preimage is not UTF-8") from exc
    output: list[str] = []
    cursor = 0
    for hunk in file_patch.hunks:
        target = max(hunk.old_start - 1, 0)
        if target < cursor or target > len(source):
            raise OverlayError(f"{file_patch.path}: invalid or overlapping hunk")
        output.extend(source[cursor:target])
        cursor = target
        old_seen = 0
        new_seen = 0
        for patch_line in hunk.lines:
            marker, content = patch_line[0], patch_line[1:]
            if marker in {" ", "-"}:
                if cursor >= len(source) or source[cursor] != content:
                    raise OverlayError(
                        f"{file_patch.path}: exact hunk mismatch at source line {cursor + 1}"
                    )
                if marker == " ":
                    output.append(content)
                cursor += 1
                old_seen += 1
                if marker == " ":
                    new_seen += 1
            if marker == "+":
                output.append(content)
                new_seen += 1
        if old_seen != hunk.old_count or new_seen != hunk.new_count:
            raise OverlayError(f"{file_patch.path}: hunk count mismatch")
    output.extend(source[cursor:])
    return "".join(output).encode("utf-8")


def select_files(lock: dict, mode: str) -> dict[str, dict]:
    files = lock["files"]
    if mode == "runtime":
        return {path: facts for path, facts in files.items() if not path.startswith("tests/")}
    return files


def verify_image(root: Path, files: dict[str, dict], *, expected: str) -> None:
    for relative, facts in files.items():
        path = target_path(root, relative)
        if expected == "preimage" and facts.get("preimage") == "absent":
            if path.exists():
                raise OverlayError(f"{relative}: expected to be absent")
            continue
        digest_key = f"{expected}Sha256"
        if not path.is_file():
            raise OverlayError(f"{relative}: required file is missing")
        actual = sha256(path.read_bytes())
        if actual != facts[digest_key]:
            raise OverlayError(
                f"{relative}: {expected} digest mismatch: expected "
                f"{facts[digest_key]}, got {actual}"
            )


def image_matches(root: Path, files: dict[str, dict], *, expected: str) -> bool:
    try:
        verify_image(root, files, expected=expected)
    except OverlayError:
        return False
    return True


def verify_upstream_identity(
    root: Path,
    lock: dict,
    source_archive: Path | None,
) -> None:
    expected = lock["upstream"]
    if (root / ".git").exists():
        for expression, key in (("HEAD", "commit"), ("HEAD^{tree}", "tree")):
            try:
                actual = subprocess.check_output(
                    ["git", "-C", str(root), "rev-parse", expression],
                    text=True,
                    stderr=subprocess.DEVNULL,
                ).strip()
            except (OSError, subprocess.CalledProcessError) as exc:
                raise OverlayError("cannot verify pinned upstream Git identity") from exc
            if actual != expected[key]:
                raise OverlayError(
                    f"upstream {key} mismatch: expected {expected[key]}, got {actual}"
                )
        return

    archive_digest = expected.get("archiveSha256")
    if (
        not isinstance(archive_digest, str)
        or len(archive_digest) != 64
        or any(character not in "0123456789abcdef" for character in archive_digest)
    ):
        raise OverlayError("source lock lacks a valid authoritative archiveSha256")
    if source_archive is None:
        raise OverlayError(
            "source tree has no Git identity; --source-archive is required"
        )
    archive = source_archive.resolve()
    if not archive.is_file():
        raise OverlayError(f"authoritative source archive is missing: {archive}")
    actual = sha256_file(archive)
    if actual != archive_digest:
        raise OverlayError(
            f"upstream archive digest mismatch: expected {archive_digest}, got {actual}"
        )


def _durable_write(path: Path, content: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
    )
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError(f"short write: {path}")
            view = view[written:]
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_journal(transaction: Path, journal: dict[str, Any]) -> None:
    temporary = transaction / "journal.next"
    try:
        temporary.unlink()
    except FileNotFoundError:
        pass
    _durable_write(temporary, canonical_json(journal), 0o600)
    os.replace(temporary, transaction / "journal.json")
    fsync_directory(transaction)


def _read_journal(transaction: Path) -> dict[str, Any]:
    path = transaction / "journal.json"
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        facts = os.fstat(descriptor)
        if not stat.S_ISREG(facts.st_mode):
            raise OverlayError("overlay transaction journal is not a regular file")
        raw = b""
        while chunk := os.read(descriptor, 1024 * 1024):
            raw += chunk
    finally:
        os.close(descriptor)
    value = json.loads(raw)
    if not isinstance(value, dict) or raw != canonical_json(value):
        raise OverlayError("overlay transaction journal is not canonical JSON")
    return value


def _planned_directories(root: Path, files: dict[str, dict]) -> list[str]:
    planned: set[str] = set()
    for relative in files:
        parent = PurePosixPath(relative).parent
        while str(parent) not in {"", "."}:
            candidate = root.joinpath(*parent.parts)
            if candidate.exists():
                break
            planned.add(parent.as_posix())
            parent = parent.parent
    return sorted(planned, key=lambda value: (value.count("/"), value))


def _journal_for(
    *,
    root: Path,
    files: dict[str, dict],
    patch_sha256: str,
    mode: str,
) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for relative in sorted(files):
        facts = files[relative]
        path = target_path(root, relative)
        existed = facts.get("preimage") != "absent"
        entries.append(
            {
                "existed": existed,
                "mode": stat.S_IMODE(path.stat().st_mode) if existed else 0o644,
                "path": relative,
                "postimageSha256": facts["postimageSha256"],
                "preimageSha256": facts.get("preimageSha256"),
            }
        )
    return {
        "applied": [],
        "createdDirectories": _planned_directories(root, files),
        "files": entries,
        "mode": mode,
        "patchSha256": patch_sha256,
        "phase": "prepared",
        "schemaVersion": JOURNAL_SCHEMA,
    }


def _validate_journal(
    journal: dict[str, Any],
    *,
    root: Path,
    files: dict[str, dict],
    patch_sha256: str,
    mode: str,
) -> None:
    expected = _journal_for(
        root=root,
        files=files,
        patch_sha256=patch_sha256,
        mode=mode,
    )
    # Modes are captured from the preimage during preparation. During recovery
    # a target may already be a staged postimage, so compare the durable
    # identity fields separately from the captured modes and progress.
    if set(journal) != set(expected):
        raise OverlayError("overlay transaction journal keys differ")
    if journal["schemaVersion"] != JOURNAL_SCHEMA:
        raise OverlayError("unsupported overlay transaction journal schema")
    for key in ("files", "mode", "patchSha256"):
        if key == "files":
            expected_files = [
                {field: value for field, value in entry.items() if field != "mode"}
                for entry in expected[key]
            ]
            actual_files = journal[key]
            if not isinstance(actual_files, list) or [
                {field: value for field, value in entry.items() if field != "mode"}
                for entry in actual_files
            ] != expected_files:
                raise OverlayError("overlay transaction file identity differs")
            if any(
                not isinstance(entry.get("mode"), int)
                or entry["mode"] < 0
                or entry["mode"] > 0o7777
                for entry in actual_files
            ):
                raise OverlayError("overlay transaction captured mode is invalid")
        elif journal[key] != expected[key]:
            raise OverlayError(f"overlay transaction {key} differs")
    created_directories = journal["createdDirectories"]
    allowed_directories = {
        parent.as_posix()
        for relative in files
        for parent in PurePosixPath(relative).parents
        if str(parent) not in {"", "."}
    }
    if (
        not isinstance(created_directories, list)
        or len(created_directories) != len(set(created_directories))
        or any(
            not isinstance(relative, str)
            or relative not in allowed_directories
            for relative in created_directories
        )
    ):
        raise OverlayError("overlay transaction created-directory set is invalid")
    if journal["phase"] not in {"prepared", "committing", "committed"}:
        raise OverlayError("overlay transaction phase is invalid")
    paths = [entry["path"] for entry in journal["files"]]
    applied = journal["applied"]
    if not isinstance(applied, list) or len(applied) != len(set(applied)):
        raise OverlayError("overlay transaction applied set is invalid")
    if any(path not in paths for path in applied):
        raise OverlayError("overlay transaction applied path is unknown")


def _remove_transaction(transaction: Path, root: Path) -> None:
    shutil.rmtree(transaction)
    fsync_directory(root)


def _remove_created_directories(root: Path, relative_directories: list[str]) -> None:
    for relative in reversed(relative_directories):
        path = target_path(root, relative)
        try:
            path.rmdir()
        except (FileNotFoundError, OSError):
            continue
        fsync_directory(path.parent)


def _rollback_transaction(
    root: Path,
    transaction: Path,
    journal: dict[str, Any],
) -> None:
    for entry in reversed(journal["files"]):
        relative = entry["path"]
        target = target_path(root, relative)
        post_digest = entry["postimageSha256"]
        pre_digest = entry["preimageSha256"]
        existed = entry["existed"]
        if target.exists():
            if target.is_symlink() or not target.is_file():
                raise OverlayError(f"{relative}: unsafe target during rollback")
            current = sha256_file(target)
        else:
            current = None

        if existed and current == pre_digest:
            continue
        if not existed and current is None:
            continue
        if current != post_digest:
            raise OverlayError(
                f"{relative}: interrupted target is neither preimage nor postimage"
            )

        if existed:
            backup = target_path(transaction / "backup", relative)
            if not backup.is_file() or sha256_file(backup) != pre_digest:
                raise OverlayError(f"{relative}: durable rollback backup is unavailable")
            os.replace(backup, target)
        else:
            target.unlink()
        fsync_directory(target.parent)

    _remove_created_directories(root, journal["createdDirectories"])
    _remove_transaction(transaction, root)


def recover_transaction(
    root: Path,
    files: dict[str, dict],
    *,
    patch_sha256: str,
    mode: str,
) -> None:
    transaction = root / TRANSACTION_DIRECTORY
    if not transaction.exists():
        return
    if transaction.is_symlink() or not transaction.is_dir():
        raise OverlayError("unsafe overlay transaction path")
    journal_path = transaction / "journal.json"
    if not journal_path.exists():
        # The journal is published only after all staging and backups are
        # durable, and no target mutation occurs before that publication.
        verify_image(root, files, expected="preimage")
        _remove_transaction(transaction, root)
        return
    journal = _read_journal(transaction)
    _validate_journal(
        journal,
        root=root,
        files=files,
        patch_sha256=patch_sha256,
        mode=mode,
    )
    if journal["phase"] == "committed":
        verify_image(root, files, expected="postimage")
        _remove_transaction(transaction, root)
        return
    if journal["phase"] == "prepared":
        verify_image(root, files, expected="preimage")
        _remove_transaction(transaction, root)
        return
    _rollback_transaction(root, transaction, journal)


def stage_transaction(
    root: Path,
    files: dict[str, dict],
    rendered: dict[str, bytes],
    *,
    patch_sha256: str,
    mode: str,
) -> tuple[Path, dict[str, Any]]:
    transaction = root / TRANSACTION_DIRECTORY
    try:
        transaction.mkdir(mode=0o700)
    except FileExistsError as exc:
        raise OverlayError("overlay transaction already exists") from exc
    fsync_directory(root)
    (transaction / "stage").mkdir(mode=0o700)
    (transaction / "backup").mkdir(mode=0o700)

    journal = _journal_for(
        root=root,
        files=files,
        patch_sha256=patch_sha256,
        mode=mode,
    )
    for entry in journal["files"]:
        relative = entry["path"]
        stage = target_path(transaction / "stage", relative)
        _durable_write(stage, rendered[relative], entry["mode"])
        if entry["existed"]:
            source = target_path(root, relative)
            backup = target_path(transaction / "backup", relative)
            _durable_write(backup, source.read_bytes(), entry["mode"])
    for directory in sorted(
        {path for path in transaction.rglob("*") if path.is_dir()},
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        fsync_directory(directory)
    _write_journal(transaction, journal)
    return transaction, journal


def commit_transaction(
    root: Path,
    transaction: Path,
    journal: dict[str, Any],
    files: dict[str, dict],
) -> None:
    journal["phase"] = "committing"
    _write_journal(transaction, journal)
    try:
        for relative in journal["createdDirectories"]:
            directory = target_path(root, relative)
            directory.mkdir()
            fsync_directory(directory.parent)
            fsync_directory(directory)

        for entry in journal["files"]:
            relative = entry["path"]
            target = target_path(root, relative)
            if entry["existed"]:
                if not target.is_file() or sha256_file(target) != entry["preimageSha256"]:
                    raise OverlayError(f"{relative}: preimage changed during transaction")
            elif target.exists():
                raise OverlayError(f"{relative}: absent preimage appeared during transaction")
            staged = target_path(transaction / "stage", relative)
            if not staged.is_file() or sha256_file(staged) != entry["postimageSha256"]:
                raise OverlayError(f"{relative}: staged postimage changed")
            os.replace(staged, target)
            fsync_directory(target.parent)
            journal["applied"].append(relative)
            _write_journal(transaction, journal)

        journal["phase"] = "committed"
        _write_journal(transaction, journal)
        verify_image(root, files, expected="postimage")
        _remove_transaction(transaction, root)
    except BaseException:
        if journal["phase"] == "committed":
            raise
        try:
            _rollback_transaction(root, transaction, journal)
        except BaseException as rollback_error:
            raise OverlayError(
                f"overlay commit failed and rollback requires recovery: {rollback_error}"
            ) from rollback_error
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--lock", type=Path, default=LOCK_PATH)
    parser.add_argument("--mode", choices=("runtime", "source"), default="source")
    parser.add_argument(
        "--source-archive",
        type=Path,
        help=(
            "immutable upstream archive used as source identity when the target "
            "does not contain the pinned Git commit/tree"
        ),
    )
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    try:
        root = args.root.resolve(strict=True)
    except FileNotFoundError as exc:
        raise OverlayError(f"overlay root is missing: {args.root}") from exc
    if not root.is_dir():
        raise OverlayError(f"overlay root is not a directory: {root}")

    lock_path = args.lock.resolve()
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schemaVersion") != 1:
        raise OverlayError("unsupported source-lock schema")
    patch_path = lock_path.parent / lock["overlay"]["patch"]
    patch_bytes = patch_path.read_bytes()
    if sha256(patch_bytes) != lock["overlay"]["patchSha256"]:
        raise OverlayError("overlay patch digest does not match source lock")

    selected = select_files(lock, args.mode)
    parsed_patch = parse_patch(patch_bytes.decode("utf-8"))
    patch_by_path = {item.path: item for item in parsed_patch}
    if len(patch_by_path) != len(parsed_patch):
        raise OverlayError("patch contains a duplicate file path")
    if set(patch_by_path) != set(lock["files"]):
        raise OverlayError(
            "patch/source-lock file inventories differ: patch="
            + ",".join(sorted(patch_by_path))
            + " lock="
            + ",".join(sorted(lock["files"]))
        )

    verify_upstream_identity(root, lock, args.source_archive)
    with locked_root(root):
        transaction = root / TRANSACTION_DIRECTORY
        if args.verify_only:
            if transaction.exists():
                raise OverlayError(
                    "interrupted overlay transaction requires a non-verify apply recovery"
                )
            verify_image(root, selected, expected="postimage")
            return 0

        recover_transaction(
            root,
            selected,
            patch_sha256=lock["overlay"]["patchSha256"],
            mode=args.mode,
        )
        if image_matches(root, selected, expected="postimage"):
            return 0

        verify_image(root, selected, expected="preimage")
        rendered: dict[str, bytes] = {}
        for relative in selected:
            facts = selected[relative]
            path = target_path(root, relative)
            original = b"" if facts.get("preimage") == "absent" else path.read_bytes()
            rendered[relative] = apply_file_patch(original, patch_by_path[relative])
            if sha256(rendered[relative]) != facts["postimageSha256"]:
                raise OverlayError(f"{relative}: rendered postimage digest mismatch")

        # No target is written until every preimage, hunk, postimage, stage,
        # backup, and transaction journal is durable.
        transaction, journal = stage_transaction(
            root,
            selected,
            rendered,
            patch_sha256=lock["overlay"]["patchSha256"],
            mode=args.mode,
        )
        commit_transaction(root, transaction, journal, selected)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except OverlayError as exc:
        print(f"route-receipt overlay refused: {exc}", file=sys.stderr)
        raise SystemExit(1)
