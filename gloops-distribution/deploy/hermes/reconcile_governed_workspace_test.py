#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("reconcile-governed-workspace.py")
SPEC = importlib.util.spec_from_file_location("reconcile_governed_workspace", MODULE_PATH)
assert SPEC and SPEC.loader
handoff = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(handoff)


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(cwd), *args], text=True, capture_output=True)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class GovernedWorkspaceHandoffTests(unittest.TestCase):
    def fixture(self, root: Path) -> tuple[Path, str]:
        workspace_root = root / "workspaces"
        cwd = workspace_root / "paperclip"
        cwd.mkdir(parents=True)
        git(cwd, "init")
        git(cwd, "config", "user.name", "Handoff Test")
        git(cwd, "config", "user.email", "handoff@example.com")
        (cwd / "proof.txt").write_text("proof\n")
        git(cwd, "add", "proof.txt")
        git(cwd, "commit", "-m", "proof")
        os.chmod(cwd, 0o755)
        return cwd, git(cwd, "rev-parse", "HEAD")

    def args(self, root: Path, cwd: Path, head: str):
        return type("Args", (), {
            "cwd": str(cwd),
            "recorded_cwd": str(cwd),
            "workspace_root": str(root / "workspaces"),
            "expected_head": head,
            "project_workspace_id": "55555555-5555-4555-8555-555555555555",
            "service_uid": os.getuid(),
            "shared_gid": os.getgid(),
            "receipt": str(root / "receipts" / "handoff.json"),
        })()

    def test_apply_and_rollback_change_only_checkout_root_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            proof_before = (cwd / "proof.txt").stat()
            args = self.args(root, cwd, head)
            receipt = handoff.apply(args)
            self.assertEqual(stat.S_IMODE(cwd.stat().st_mode), 0o2770)
            self.assertEqual((cwd / "proof.txt").stat().st_ino, proof_before.st_ino)
            stored = json.loads(Path(args.receipt).read_text())
            self.assertEqual(stored["receiptDigest"], handoff.receipt_digest(stored))
            restored = handoff.rollback(args)
            self.assertTrue(restored["ok"])
            rollback_path = Path(f"{args.receipt}.rollback")
            stored_rollback = json.loads(rollback_path.read_text())
            self.assertEqual(stored_rollback, restored)
            self.assertEqual(
                stored_rollback["receiptDigest"],
                handoff.receipt_digest(stored_rollback),
            )
            self.assertEqual(stored_rollback["handoffReceiptDigest"], stored["receiptDigest"])
            self.assertEqual(stat.S_IMODE(cwd.stat().st_mode), 0o755)
            self.assertEqual((cwd / "proof.txt").stat().st_ino, proof_before.st_ino)
            before_replay = cwd.stat()
            with self.assertRaisesRegex(handoff.HandoffError, "rollback receipt already exists"):
                handoff.rollback(args)
            after_replay = cwd.stat()
            self.assertEqual(
                (before_replay.st_uid, before_replay.st_gid, stat.S_IMODE(before_replay.st_mode)),
                (after_replay.st_uid, after_replay.st_gid, stat.S_IMODE(after_replay.st_mode)),
            )

    def test_rejects_metadata_drift_dirty_tree_symlink_and_wrong_head(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            args.recorded_cwd = str(root / "workspaces")
            with self.assertRaisesRegex(handoff.HandoffError, "metadata does not name"):
                handoff.apply(args)
            args = self.args(root, cwd, "f" * 40)
            with self.assertRaisesRegex(handoff.HandoffError, "HEAD conflicts"):
                handoff.apply(args)
            args = self.args(root, cwd, head)
            (cwd / "dirty.txt").write_text("dirty\n")
            with self.assertRaisesRegex(handoff.HandoffError, "dirty"):
                handoff.apply(args)
            (cwd / "dirty.txt").unlink()
            alias = root / "workspaces" / "alias"
            alias.symlink_to(cwd, target_is_directory=True)
            args.cwd = str(alias)
            args.recorded_cwd = str(alias)
            with self.assertRaisesRegex(handoff.HandoffError, "symlink"):
                handoff.apply(args)

    def test_existing_receipt_blocks_reapplication_before_metadata_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            handoff.apply(args)
            before = cwd.stat()
            with self.assertRaisesRegex(handoff.HandoffError, "already exists"):
                handoff.apply(args)
            after = cwd.stat()
            self.assertEqual(
                (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)),
                (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)),
            )

    def test_receipt_failure_restores_exact_prior_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            before = cwd.stat()
            with patch.object(handoff, "durable_write", side_effect=OSError("injected")):
                with self.assertRaisesRegex(OSError, "injected"):
                    handoff.apply(args)
            after = cwd.stat()
            self.assertEqual(
                (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)),
                (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)),
            )

    def test_candidate_fsmonitor_cannot_execute_during_root_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            marker = root / "fsmonitor-executed"
            hook = root / "hostile-fsmonitor.sh"
            hook.write_text(f"#!/bin/sh\ntouch {marker}\nexit 0\n", encoding="utf-8")
            hook.chmod(0o755)
            git(cwd, "config", "core.fsmonitor", str(hook))
            args = self.args(root, cwd, head)
            receipt = handoff.apply(args)
            self.assertEqual(receipt["expectedHead"], head)
            self.assertFalse(marker.exists())

    def test_root_owned_sticky_group_writable_parent_is_rename_protected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            workspace_root = root / "workspaces"
            os.chmod(workspace_root, 0o3770)
            args = self.args(root, cwd, head)
            receipt = handoff.apply(args)
            self.assertEqual(receipt["expectedHead"], head)

    def test_nonsticky_group_writable_parent_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            os.chmod(root / "workspaces", 0o2770)
            args = self.args(root, cwd, head)
            with self.assertRaisesRegex(handoff.HandoffError, "parent chain"):
                handoff.apply(args)

    def test_post_inspection_symlink_replacement_cannot_redirect_apply_or_compensation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            moved = root / "workspaces" / "moved"
            target = root / "target"
            target.mkdir()
            target_before = target.stat()
            cwd_before = cwd.stat()
            real_fchown = os.fchown
            replaced = False

            def replace_then_fchown(descriptor, uid, gid):
                nonlocal replaced
                if not replaced:
                    cwd.rename(moved)
                    cwd.symlink_to(target, target_is_directory=True)
                    replaced = True
                return real_fchown(descriptor, uid, gid)

            with patch.object(handoff.os, "fchown", side_effect=replace_then_fchown):
                with self.assertRaisesRegex(handoff.HandoffError, "path identity changed"):
                    handoff.apply(args)
            target_after = target.stat()
            moved_after = moved.stat()
            self.assertEqual(
                (target_before.st_uid, target_before.st_gid, stat.S_IMODE(target_before.st_mode)),
                (target_after.st_uid, target_after.st_gid, stat.S_IMODE(target_after.st_mode)),
            )
            self.assertEqual(
                (cwd_before.st_uid, cwd_before.st_gid, stat.S_IMODE(cwd_before.st_mode)),
                (moved_after.st_uid, moved_after.st_gid, stat.S_IMODE(moved_after.st_mode)),
            )

    def test_receipt_failure_compensates_descriptor_after_path_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            moved = root / "workspaces" / "moved"
            target = root / "target"
            target.mkdir()
            target_before = target.stat()
            cwd_before = cwd.stat()

            def replace_then_fail(*_values, **_kwargs):
                cwd.rename(moved)
                cwd.symlink_to(target, target_is_directory=True)
                raise OSError("injected receipt race")

            with patch.object(handoff, "durable_write", side_effect=replace_then_fail):
                with self.assertRaisesRegex(OSError, "injected receipt race"):
                    handoff.apply(args)
            target_after = target.stat()
            moved_after = moved.stat()
            self.assertEqual(
                (target_before.st_uid, target_before.st_gid, stat.S_IMODE(target_before.st_mode)),
                (target_after.st_uid, target_after.st_gid, stat.S_IMODE(target_after.st_mode)),
            )
            self.assertEqual(
                (cwd_before.st_uid, cwd_before.st_gid, stat.S_IMODE(cwd_before.st_mode)),
                (moved_after.st_uid, moved_after.st_gid, stat.S_IMODE(moved_after.st_mode)),
            )

    def test_explicit_rollback_cannot_follow_post_inspection_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            handoff.apply(args)
            moved = root / "workspaces" / "moved"
            target = root / "target"
            target.mkdir()
            target_before = target.stat()
            real_fchown = os.fchown
            replaced = False

            def replace_then_fchown(descriptor, uid, gid):
                nonlocal replaced
                if not replaced:
                    cwd.rename(moved)
                    cwd.symlink_to(target, target_is_directory=True)
                    replaced = True
                return real_fchown(descriptor, uid, gid)

            with patch.object(handoff.os, "fchown", side_effect=replace_then_fchown):
                with self.assertRaisesRegex(handoff.HandoffError, "path identity changed"):
                    handoff.rollback(args)
            target_after = target.stat()
            moved_after = moved.stat()
            self.assertEqual(
                (target_before.st_uid, target_before.st_gid, stat.S_IMODE(target_before.st_mode)),
                (target_after.st_uid, target_after.st_gid, stat.S_IMODE(target_after.st_mode)),
            )
            self.assertEqual(stat.S_IMODE(moved_after.st_mode), 0o2770)

    def test_explicit_rollback_compensates_when_fchmod_fails_after_fchown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            handoff.apply(args)
            after = cwd.stat()
            real_fchmod = os.fchmod
            calls = 0

            def fail_first_fchmod(descriptor, mode):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("injected fchmod failure")
                return real_fchmod(descriptor, mode)

            with patch.object(handoff.os, "fchmod", side_effect=fail_first_fchmod):
                with self.assertRaisesRegex(OSError, "injected fchmod failure"):
                    handoff.rollback(args)
            current = cwd.stat()
            self.assertEqual(
                (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)),
                (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)),
            )
            self.assertFalse(Path(f"{args.receipt}.rollback").exists())

    def test_apply_cleanup_failure_still_compensates_and_marks_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            moved = root / "workspaces" / "moved"
            target = root / "target"
            target.mkdir()
            before = cwd.stat()
            real_write = handoff.durable_write

            def publish_then_replace(path, value):
                real_write(path, value)
                if Path(path) == Path(args.receipt):
                    cwd.rename(moved)
                    cwd.symlink_to(target, target_is_directory=True)

            with patch.object(handoff, "durable_write", side_effect=publish_then_replace):
                with patch.object(handoff, "durable_unlink", side_effect=OSError("injected unlink failure")):
                    with self.assertRaisesRegex(handoff.HandoffError, "reconciliation required"):
                        handoff.apply(args)
            current = moved.stat()
            self.assertEqual(
                (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)),
                (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)),
            )
            marker_path = Path(f"{args.receipt}.reconciliation-required")
            marker = json.loads(marker_path.read_text())
            self.assertEqual(marker["status"], "reconciliation_required")
            self.assertEqual(marker["cleanupErrorClass"], "OSError")
            self.assertEqual(marker["compensationErrorClass"], None)
            self.assertEqual(marker["receiptDigest"], handoff.receipt_digest(marker))

    def test_apply_post_link_sync_failure_removes_receipt_and_compensates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            before = cwd.stat()
            real_fsync = os.fsync
            calls = 0

            def fail_directory_sync(descriptor):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("injected post-link sync failure")
                return real_fsync(descriptor)

            with patch.object(handoff.os, "fsync", side_effect=fail_directory_sync):
                with self.assertRaisesRegex(OSError, "injected post-link sync failure"):
                    handoff.apply(args)
            current = cwd.stat()
            self.assertEqual(
                (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)),
                (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)),
            )
            self.assertFalse(Path(args.receipt).exists())

    def test_rollback_cleanup_failure_still_compensates_and_marks_reconciliation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            handoff.apply(args)
            moved = root / "workspaces" / "moved"
            target = root / "target"
            target.mkdir()
            after = cwd.stat()
            rollback_path = Path(f"{args.receipt}.rollback")
            real_write = handoff.durable_write

            def publish_then_replace(path, value):
                real_write(path, value)
                if Path(path) == rollback_path:
                    cwd.rename(moved)
                    cwd.symlink_to(target, target_is_directory=True)

            with patch.object(handoff, "durable_write", side_effect=publish_then_replace):
                with patch.object(handoff, "durable_unlink", side_effect=OSError("injected unlink failure")):
                    with self.assertRaisesRegex(handoff.HandoffError, "reconciliation required"):
                        handoff.rollback(args)
            current = moved.stat()
            self.assertEqual(
                (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)),
                (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)),
            )
            marker_path = Path(f"{rollback_path}.reconciliation-required")
            marker = json.loads(marker_path.read_text())
            self.assertEqual(marker["status"], "reconciliation_required")
            self.assertEqual(marker["cleanupErrorClass"], "OSError")
            self.assertEqual(marker["compensationErrorClass"], None)
            self.assertEqual(marker["receiptDigest"], handoff.receipt_digest(marker))

    def test_rollback_post_link_sync_failure_removes_receipt_and_compensates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            handoff.apply(args)
            after = cwd.stat()
            rollback_path = Path(f"{args.receipt}.rollback")
            real_fsync = os.fsync
            calls = 0

            def fail_directory_sync(descriptor):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("injected post-link sync failure")
                return real_fsync(descriptor)

            with patch.object(handoff.os, "fsync", side_effect=fail_directory_sync):
                with self.assertRaisesRegex(OSError, "injected post-link sync failure"):
                    handoff.rollback(args)
            current = cwd.stat()
            self.assertEqual(
                (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)),
                (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)),
            )
            self.assertFalse(rollback_path.exists())

    def test_post_receipt_replacement_removes_false_success_and_compensates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd, head = self.fixture(root)
            args = self.args(root, cwd, head)
            moved = root / "workspaces" / "moved"
            target = root / "target"
            target.mkdir()
            cwd_before = cwd.stat()
            real_write = handoff.durable_write

            def publish_then_replace(path, value):
                real_write(path, value)
                cwd.rename(moved)
                cwd.symlink_to(target, target_is_directory=True)

            with patch.object(handoff, "durable_write", side_effect=publish_then_replace):
                with self.assertRaisesRegex(handoff.HandoffError, "path identity changed"):
                    handoff.apply(args)
            self.assertFalse(Path(args.receipt).exists())
            moved_after = moved.stat()
            self.assertEqual(
                (cwd_before.st_uid, cwd_before.st_gid, stat.S_IMODE(cwd_before.st_mode)),
                (moved_after.st_uid, moved_after.st_gid, stat.S_IMODE(moved_after.st_mode)),
            )


if __name__ == "__main__":
    unittest.main()
