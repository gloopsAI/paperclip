#!/usr/bin/env python3
"""Bind one governed project workspace checkout to the Paperclip service UID.

Only the checkout root metadata changes. Repository contents are never copied,
deleted, or recursively chowned. The exact clean Git head and recorded cwd are
verified before apply and again before rollback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
from typing import Any


class HandoffError(RuntimeError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def receipt_digest(value: dict[str, Any]) -> str:
    projection = {key: item for key, item in value.items() if key != "receiptDigest"}
    payload = b"gloops.governed-workspace-handoff.v1\0" + canonical_json(projection).encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def git(cwd: Path, run_uid: int, run_gid: int, *args: str, descriptor: int | None = None) -> str:
    if run_uid == 0:
        raise HandoffError("workspace Git inspection refuses a root-owned checkout")
    preexec = None
    if os.geteuid() == 0:
        def drop_privileges() -> None:
            os.setgroups([])
            os.setgid(run_gid)
            os.setuid(run_uid)
        preexec = drop_privileges
    elif os.geteuid() != run_uid:
        raise HandoffError("workspace Git inspection cannot assume the source owner")
    use_descriptor = descriptor is not None and Path("/proc/self/fd").is_dir()
    if use_descriptor:
        inspection_cwd = Path(f"/proc/self/fd/{descriptor}")
    else:
        inspection_cwd = cwd
    completed = subprocess.run(
        [
            "/usr/bin/git",
            "-c", f"safe.directory={cwd}",
            "-c", "core.fsmonitor=false",
            "-c", "core.hooksPath=/dev/null",
            "-c", "core.attributesFile=/dev/null",
            "-c", "core.excludesFile=/dev/null",
            "-C", str(inspection_cwd), *args,
        ],
        text=True,
        capture_output=True,
        timeout=30,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": "/var/empty",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_OPTIONAL_LOCKS": "0",
        },
        preexec_fn=preexec,
        pass_fds=((descriptor,) if use_descriptor else ()),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise HandoffError(f"workspace Git inspection failed: {(detail[-1] if detail else 'unknown')[:500]}")
    return completed.stdout.strip()


def verify_path_identity(cwd: Path, descriptor: int) -> os.stat_result:
    descriptor_stat = os.fstat(descriptor)
    current = os.lstat(cwd)
    if stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) != (
        descriptor_stat.st_dev,
        descriptor_stat.st_ino,
    ):
        raise HandoffError("workspace path identity changed during handoff")
    return descriptor_stat


def trusted_parent_chain(root: Path, cwd: Path) -> list[dict[str, int | str]]:
    trusted_uid = 0 if os.geteuid() == 0 else os.geteuid()
    result: list[dict[str, int | str]] = []
    cursor = root
    stop = cwd.parent
    while True:
        metadata = os.lstat(cursor)
        mode = stat.S_IMODE(metadata.st_mode)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise HandoffError("workspace parent chain contains a non-directory or symlink")
        group_writable_sticky = bool(mode & 0o020) and bool(mode & stat.S_ISVTX) and not bool(mode & 0o002)
        if metadata.st_uid != trusted_uid or (mode & 0o022 and not group_writable_sticky):
            raise HandoffError("workspace parent chain is not trusted and non-writable")
        result.append({"path": str(cursor), "device": metadata.st_dev, "inode": metadata.st_ino})
        if cursor == stop:
            return result
        relative = stop.relative_to(cursor)
        cursor = cursor / relative.parts[0]


def inspect_checkout(cwd_text: str, root_text: str, expected_head: str) -> tuple[Path, os.stat_result, int]:
    if not expected_head or len(expected_head) != 40 or any(c not in "0123456789abcdef" for c in expected_head):
        raise HandoffError("expected head must be a lowercase full SHA-1")
    cwd_input = Path(cwd_text)
    root_input = Path(root_text)
    if cwd_input.is_symlink() or root_input.is_symlink():
        raise HandoffError("workspace root and cwd must not be symlinks")
    root = root_input.resolve(strict=True)
    cwd = cwd_input.resolve(strict=True)
    if cwd == root or root not in cwd.parents:
        raise HandoffError("workspace cwd must be a child of the governed workspace root")
    relative = cwd.relative_to(root)
    cursor = root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise HandoffError("workspace path contains a symlink")
    parent_identity = trusted_parent_chain(root, cwd)
    metadata = cwd.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise HandoffError("workspace cwd is not a directory")
    descriptor = os.open(cwd, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        descriptor_stat = verify_path_identity(cwd, descriptor)
        if (descriptor_stat.st_uid, descriptor_stat.st_gid) != (metadata.st_uid, metadata.st_gid):
            raise HandoffError("workspace metadata changed before Git inspection")
        top_level = Path(git(
            cwd, metadata.st_uid, metadata.st_gid,
            "rev-parse", "--show-toplevel", descriptor=descriptor,
        ))
        top_stat = os.stat(top_level)
        if (top_stat.st_dev, top_stat.st_ino) != (descriptor_stat.st_dev, descriptor_stat.st_ino):
            raise HandoffError("workspace cwd is not the exact Git checkout root")
        if git(cwd, metadata.st_uid, metadata.st_gid, "rev-parse", "HEAD", descriptor=descriptor).lower() != expected_head:
            raise HandoffError("workspace HEAD conflicts with the governed claim")
        if git(cwd, metadata.st_uid, metadata.st_gid, "status", "--porcelain=v1", "--untracked-files=all", descriptor=descriptor):
            raise HandoffError("workspace checkout is dirty")
        if git(cwd, metadata.st_uid, metadata.st_gid, "rev-parse", "--is-shallow-repository", descriptor=descriptor) != "false":
            raise HandoffError("workspace checkout must not be shallow")
        for key in ("extensions.partialClone", "remote.origin.promisor"):
            try:
                value = git(cwd, metadata.st_uid, metadata.st_gid, "config", "--get", key, descriptor=descriptor)
            except HandoffError as error:
                if "workspace Git inspection failed: unknown" not in str(error):
                    # A missing key exits 1 with no diagnostic; any diagnostic is fatal.
                    raise
                value = ""
            if value:
                raise HandoffError("workspace checkout must not be partial/promisor")
        verify_path_identity(cwd, descriptor)
        if trusted_parent_chain(root, cwd) != parent_identity:
            raise HandoffError("workspace parent identity changed during Git inspection")
        return cwd, metadata, descriptor
    except BaseException:
        os.close(descriptor)
        raise


def durable_write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, stage = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(canonical_json(value) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.link(stage, path)
        os.unlink(stage)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.unlink(stage)
        except FileNotFoundError:
            pass
        raise


def inspect_durable_value(path: Path, value: dict[str, Any]) -> str:
    expected = (canonical_json(value) + "\n").encode()
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unexpected"
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
            return "unexpected"
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        return "exact" if b"".join(chunks) == expected else "unexpected"
    except OSError:
        return "unexpected"
    finally:
        os.close(descriptor)


def durable_unlink(path: Path) -> None:
    path.unlink()
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def record_reconciliation_required(
    receipt_path: Path,
    operation: str,
    original_error: BaseException,
    compensation_error: BaseException | None,
    cleanup_error: BaseException | None,
    descriptor: int,
) -> Path:
    marker_path = receipt_path.with_name(f"{receipt_path.name}.reconciliation-required")
    marker: dict[str, Any] = {
        "schemaVersion": "gloops.governed-workspace-handoff-reconciliation.v1",
        "operation": operation,
        "receiptPath": str(receipt_path),
        "checkoutIdentity": {
            "device": os.fstat(descriptor).st_dev,
            "inode": os.fstat(descriptor).st_ino,
        },
        "originalErrorClass": type(original_error).__name__,
        "compensationErrorClass": type(compensation_error).__name__ if compensation_error else None,
        "cleanupErrorClass": type(cleanup_error).__name__ if cleanup_error else None,
        "status": "reconciliation_required",
    }
    marker["receiptDigest"] = receipt_digest(marker)
    durable_write(marker_path, marker)
    return marker_path


def apply(args: argparse.Namespace) -> dict[str, Any]:
    if not re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        args.project_workspace_id,
    ):
        raise HandoffError("project workspace id must be a canonical UUID")
    cwd, before, descriptor = inspect_checkout(args.cwd, args.workspace_root, args.expected_head)
    receipt_publication_state = "absent"
    try:
        if Path(args.recorded_cwd).resolve(strict=True) != cwd:
            raise HandoffError("project-workspace metadata does not name the inspected checkout")
        if Path(args.receipt).exists():
            raise HandoffError("handoff receipt already exists")
        os.fchown(descriptor, args.service_uid, args.shared_gid)
        os.fchmod(descriptor, 0o2770)
        after = verify_path_identity(cwd, descriptor)
        if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (
            args.service_uid,
            args.shared_gid,
            0o2770,
        ):
            raise HandoffError("workspace ownership handoff could not be proved")
        receipt: dict[str, Any] = {
            "schemaVersion": "gloops.governed-workspace-handoff.v1",
            "projectWorkspaceId": args.project_workspace_id,
            "cwd": str(cwd),
            "expectedHead": args.expected_head,
            "before": {"uid": before.st_uid, "gid": before.st_gid, "mode": stat.S_IMODE(before.st_mode)},
            "after": {"uid": after.st_uid, "gid": after.st_gid, "mode": stat.S_IMODE(after.st_mode)},
            "checkoutIdentity": {"device": after.st_dev, "inode": after.st_ino},
            "scope": "checkout_root_metadata_only",
        }
        receipt["receiptDigest"] = receipt_digest(receipt)
        try:
            durable_write(Path(args.receipt), receipt)
        finally:
            receipt_publication_state = inspect_durable_value(Path(args.receipt), receipt)
        if receipt_publication_state != "exact":
            raise HandoffError("handoff receipt publication could not be proved")
        verify_path_identity(cwd, descriptor)
        return receipt
    except BaseException as error:
        compensation_error: BaseException | None = None
        try:
            os.fchown(descriptor, before.st_uid, before.st_gid)
            os.fchmod(descriptor, stat.S_IMODE(before.st_mode))
            restored = os.fstat(descriptor)
            if (restored.st_uid, restored.st_gid, stat.S_IMODE(restored.st_mode)) != (
                before.st_uid,
                before.st_gid,
                stat.S_IMODE(before.st_mode),
            ):
                raise HandoffError("automatic metadata restoration could not be proved")
        except BaseException as caught:
            compensation_error = caught
        cleanup_error: BaseException | None = None
        if receipt_publication_state == "exact":
            try:
                durable_unlink(Path(args.receipt))
            except BaseException as caught:
                cleanup_error = caught
        elif receipt_publication_state == "unexpected":
            cleanup_error = HandoffError("handoff receipt publication state is unexpected")
        if compensation_error or cleanup_error:
            marker_error: BaseException | None = None
            marker_path: Path | None = None
            try:
                marker_path = record_reconciliation_required(
                    Path(args.receipt), "apply", error, compensation_error, cleanup_error, descriptor,
                )
            except BaseException as caught:
                marker_error = caught
            raise HandoffError(
                "workspace handoff reconciliation required: "
                f"compensation={type(compensation_error).__name__ if compensation_error else 'proved'}, "
                f"receiptCleanup={type(cleanup_error).__name__ if cleanup_error else 'proved'}, "
                f"marker={str(marker_path) if marker_path else type(marker_error).__name__}"
            ) from error
        raise
    finally:
        os.close(descriptor)


def rollback(args: argparse.Namespace) -> dict[str, Any]:
    receipt_path = Path(args.receipt)
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("receiptDigest") != receipt_digest(receipt):
        raise HandoffError("handoff receipt digest is invalid")
    cwd, current, descriptor = inspect_checkout(receipt["cwd"], args.workspace_root, receipt["expectedHead"])
    rollback_path = receipt_path.with_name(f"{receipt_path.name}.rollback")
    try:
        if rollback_path.exists() or rollback_path.is_symlink():
            raise HandoffError("workspace rollback receipt already exists")
        expected_identity = receipt.get("checkoutIdentity")
        if expected_identity != {"device": current.st_dev, "inode": current.st_ino}:
            raise HandoffError("workspace checkout identity differs from the handoff receipt")
        after = receipt["after"]
        if (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) != (
            after["uid"], after["gid"], after["mode"],
        ):
            raise HandoffError("workspace metadata drifted after handoff")
        before = receipt["before"]
        mutation_attempted = False
        rollback_receipt_publication_state = "absent"
        try:
            mutation_attempted = True
            os.fchown(descriptor, before["uid"], before["gid"])
            os.fchmod(descriptor, before["mode"])
            restored = verify_path_identity(cwd, descriptor)
            if (restored.st_uid, restored.st_gid, stat.S_IMODE(restored.st_mode)) != (
                before["uid"], before["gid"], before["mode"],
            ):
                raise HandoffError("workspace rollback could not be proved")
            result: dict[str, Any] = {
                "ok": True,
                "schemaVersion": "gloops.governed-workspace-handoff-rollback.v1",
                "handoffReceiptDigest": receipt["receiptDigest"],
                "cwd": str(cwd),
                "checkoutIdentity": expected_identity,
            }
            result["receiptDigest"] = receipt_digest(result)
            try:
                durable_write(rollback_path, result)
            finally:
                rollback_receipt_publication_state = inspect_durable_value(rollback_path, result)
            if rollback_receipt_publication_state != "exact":
                raise HandoffError("workspace rollback receipt publication could not be proved")
            verify_path_identity(cwd, descriptor)
            return result
        except BaseException as error:
            compensation_error: BaseException | None = None
            if mutation_attempted:
                try:
                    os.fchown(descriptor, after["uid"], after["gid"])
                    os.fchmod(descriptor, after["mode"])
                    compensated = os.fstat(descriptor)
                    if (compensated.st_uid, compensated.st_gid, stat.S_IMODE(compensated.st_mode)) != (
                        after["uid"], after["gid"], after["mode"],
                    ):
                        raise HandoffError("workspace rollback compensation could not be proved")
                except BaseException as caught:
                    compensation_error = caught
            cleanup_error: BaseException | None = None
            if rollback_receipt_publication_state == "exact":
                try:
                    durable_unlink(rollback_path)
                except BaseException as caught:
                    cleanup_error = caught
            elif rollback_receipt_publication_state == "unexpected":
                cleanup_error = HandoffError("workspace rollback receipt publication state is unexpected")
            if compensation_error or cleanup_error:
                marker_error: BaseException | None = None
                marker_path: Path | None = None
                try:
                    marker_path = record_reconciliation_required(
                        rollback_path, "rollback", error, compensation_error, cleanup_error, descriptor,
                    )
                except BaseException as caught:
                    marker_error = caught
                raise HandoffError(
                    "workspace rollback reconciliation required: "
                    f"compensation={type(compensation_error).__name__ if compensation_error else 'proved'}, "
                    f"receiptCleanup={type(cleanup_error).__name__ if cleanup_error else 'proved'}, "
                    f"marker={str(marker_path) if marker_path else type(marker_error).__name__}"
                ) from error
            raise
    finally:
        os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("apply", "rollback"))
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--cwd")
    parser.add_argument("--recorded-cwd")
    parser.add_argument("--expected-head")
    parser.add_argument("--project-workspace-id")
    parser.add_argument("--service-uid", type=int)
    parser.add_argument("--shared-gid", type=int)
    args = parser.parse_args()
    if args.mode == "apply" and any(
        value is None for value in (
            args.cwd, args.recorded_cwd, args.expected_head, args.project_workspace_id,
            args.service_uid, args.shared_gid,
        )
    ):
        raise HandoffError("apply requires exact workspace, identity, head, uid, and gid arguments")
    if os.geteuid() != 0 and os.environ.get("GLOOPS_HANDOFF_TEST_MODE") != "1":
        raise HandoffError("workspace handoff requires root")
    result = apply(args) if args.mode == "apply" else rollback(args)
    print(canonical_json(result))


if __name__ == "__main__":
    try:
        main()
    except HandoffError as error:
        raise SystemExit(f"governed-workspace-handoff: {error}")
