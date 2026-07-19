#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
APPLICATOR = HERE / "apply-hermes-route-receipt.py"


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class ApplicatorTest(unittest.TestCase):
    def write_fixture(self, root: Path, *, second_preimage: bytes = b"beta\n") -> Path:
        source = root / "source"
        source.mkdir()
        (source / "first.txt").write_bytes(b"alpha\n")
        (source / "second.txt").write_bytes(second_preimage)
        patch = (
            "--- a/first.txt\n"
            "+++ b/first.txt\n"
            "@@ -1,1 +1,1 @@\n"
            "-alpha\n"
            "+ALPHA\n"
            "--- a/second.txt\n"
            "+++ b/second.txt\n"
            "@@ -1,1 +1,1 @@\n"
            "-beta\n"
            "+BETA\n"
            "--- /dev/null\n"
            "+++ b/new.txt\n"
            "@@ -0,0 +1,1 @@\n"
            "+new\n"
        ).encode()
        patch_path = root / "overlay.patch"
        patch_path.write_bytes(patch)
        archive_path = root / "source.tar.gz"
        archive_path.write_bytes(b"authoritative source archive fixture\n")
        lock = {
            "schemaVersion": 1,
            "upstream": {
                "commit": "0" * 40,
                "tree": "1" * 40,
                "archiveSha256": sha256(archive_path.read_bytes()),
            },
            "overlay": {
                "patch": patch_path.name,
                "patchSha256": sha256(patch),
            },
            "files": {
                "first.txt": {
                    "preimageSha256": sha256(b"alpha\n"),
                    "postimageSha256": sha256(b"ALPHA\n"),
                },
                "second.txt": {
                    "preimageSha256": sha256(b"beta\n"),
                    "postimageSha256": sha256(b"BETA\n"),
                },
                "new.txt": {
                    "preimage": "absent",
                    "postimageSha256": sha256(b"new\n"),
                },
            },
        }
        lock_path = root / "source-lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        return lock_path

    def run_applicator(
        self,
        source: Path,
        lock: Path,
        *extra: str,
        include_archive: bool = True,
    ):
        identity_args = (
            ["--source-archive", str(lock.parent / "source.tar.gz")]
            if include_archive
            else []
        )
        return subprocess.run(
            [
                sys.executable,
                str(APPLICATOR),
                "--root",
                str(source),
                "--lock",
                str(lock),
                *identity_args,
                *extra,
            ],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_exact_apply_and_verify(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root)
            source = root / "source"

            applied = self.run_applicator(source, lock)
            verified = self.run_applicator(source, lock, "--verify-only")

            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertEqual((source / "first.txt").read_bytes(), b"ALPHA\n")
            self.assertEqual((source / "second.txt").read_bytes(), b"BETA\n")
            self.assertEqual((source / "new.txt").read_bytes(), b"new\n")

    def test_preimage_drift_refuses_before_any_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root, second_preimage=b"drift\n")
            source = root / "source"

            result = self.run_applicator(source, lock)

            self.assertEqual(result.returncode, 1)
            self.assertIn("preimage digest mismatch", result.stderr)
            self.assertEqual((source / "first.txt").read_bytes(), b"alpha\n")
            self.assertEqual((source / "second.txt").read_bytes(), b"drift\n")
            self.assertFalse((source / "new.txt").exists())

    def test_symlink_target_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root)
            source = root / "source"
            outside = root / "outside"
            outside.mkdir()
            (source / "new.txt").symlink_to(outside / "captured")

            result = self.run_applicator(source, lock)

            self.assertEqual(result.returncode, 1)
            self.assertIn("symlink targets are not allowed", result.stderr)
            self.assertFalse((outside / "captured").exists())

    def test_git_identity_mismatch_refuses_before_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root)
            source = root / "source"
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(source),
                    "-c",
                    "user.name=Overlay Test",
                    "-c",
                    "user.email=overlay@example.invalid",
                    "commit",
                    "-qm",
                    "fixture",
                ],
                check=True,
            )

            result = self.run_applicator(source, lock)

            self.assertEqual(result.returncode, 1)
            self.assertIn("upstream commit mismatch", result.stderr)
            self.assertEqual((source / "first.txt").read_bytes(), b"alpha\n")

    def test_non_git_source_requires_exact_archive_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root)
            source = root / "source"

            missing = self.run_applicator(
                source,
                lock,
                include_archive=False,
            )
            (root / "source.tar.gz").write_bytes(b"wrong archive\n")
            wrong = self.run_applicator(source, lock)

            self.assertEqual(missing.returncode, 1)
            self.assertIn("--source-archive is required", missing.stderr)
            self.assertEqual(wrong.returncode, 1)
            self.assertIn("upstream archive digest mismatch", wrong.stderr)
            self.assertEqual((source / "first.txt").read_bytes(), b"alpha\n")

    def test_hard_interruption_recovers_without_mixed_overlay(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root)
            source = root / "source"
            driver = r"""
import importlib.util
import os
import pathlib
import sys

applicator, source, lock, archive = sys.argv[1:]
spec = importlib.util.spec_from_file_location("overlay_applicator", applicator)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
real_replace = module.os.replace
replacements = 0
source_path = pathlib.Path(source).resolve()

def interrupted_replace(src, dst):
    global replacements
    real_replace(src, dst)
    destination = pathlib.Path(dst).resolve()
    if (
        source_path in destination.parents
        and module.TRANSACTION_DIRECTORY not in destination.parts
    ):
        replacements += 1
        if replacements == 1:
            os._exit(91)

module.os.replace = interrupted_replace
sys.argv = [
    applicator,
    "--root", source,
    "--lock", lock,
    "--source-archive", archive,
]
module.main()
"""
            interrupted = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    driver,
                    str(APPLICATOR),
                    str(source),
                    str(lock),
                    str(root / "source.tar.gz"),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(interrupted.returncode, 91, interrupted.stderr)
            self.assertEqual((source / "first.txt").read_bytes(), b"ALPHA\n")
            self.assertEqual((source / "second.txt").read_bytes(), b"beta\n")
            self.assertFalse((source / "new.txt").exists())
            self.assertTrue(
                (source / ".gloops-route-receipt-transaction/journal.json").is_file()
            )

            verify_during_interruption = self.run_applicator(
                source,
                lock,
                "--verify-only",
            )
            recovered = self.run_applicator(source, lock)

            self.assertEqual(verify_during_interruption.returncode, 1)
            self.assertIn(
                "interrupted overlay transaction requires",
                verify_during_interruption.stderr,
            )
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            self.assertEqual((source / "first.txt").read_bytes(), b"ALPHA\n")
            self.assertEqual((source / "second.txt").read_bytes(), b"BETA\n")
            self.assertEqual((source / "new.txt").read_bytes(), b"new\n")
            self.assertFalse(
                (source / ".gloops-route-receipt-transaction").exists()
            )

    def test_apply_is_idempotent_after_durable_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = self.write_fixture(root)
            source = root / "source"

            first = self.run_applicator(source, lock)
            second = self.run_applicator(source, lock)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)


if __name__ == "__main__":
    unittest.main()
