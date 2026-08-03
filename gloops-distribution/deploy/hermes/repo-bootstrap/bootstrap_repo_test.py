#!/usr/bin/env python3
"""Unit tests for bootstrap_repo.py (mocks; no live network)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import bootstrap_repo as br


class BootstrapRepoTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.dest_root = self.root / "workspace"
        self.dest_root.mkdir()
        self.env = mock.patch.dict(
            os.environ,
            {
                "REPO_BOOTSTRAP_DEST_ROOTS": str(self.dest_root),
                "REPO_BOOTSTRAP_TEST_MODE": "1",
                "REPO_BOOTSTRAP_TEST_TOKEN": "ghs_unit_test_token",
            },
            clear=False,
        )
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.temp.cleanup()

    def _bare_repo_with_commit(self) -> tuple[Path, str]:
        """Create a local bare-ish repo we can clone via file://."""
        src = self.root / "src-repo"
        src.mkdir()
        subprocess.run(["git", "init"], cwd=src, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "t@example.com"],
            cwd=src,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "t"],
            cwd=src,
            check=True,
            capture_output=True,
        )
        (src / "file.txt").write_text("hello\n", encoding="utf-8")
        subprocess.run(["git", "add", "file.txt"], cwd=src, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=src,
            check=True,
            capture_output=True,
        )
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=src,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        return src, sha

    def test_reject_short_sha(self) -> None:
        with self.assertRaises(br.BootstrapError) as ctx:
            br.require_sha40("abc123")
        self.assertEqual(ctx.exception.code, "invalid_sha")

    def test_reject_branch_name(self) -> None:
        with self.assertRaises(br.BootstrapError) as ctx:
            br.require_sha40("main")
        self.assertEqual(ctx.exception.code, "invalid_sha")

    def test_reject_repo_not_allowlisted(self) -> None:
        with self.assertRaises(br.BootstrapError) as ctx:
            br.require_repo("evil/not-allowed")
        self.assertEqual(ctx.exception.code, "repo_not_allowlisted")

    def test_allowlisted_repos(self) -> None:
        for repo in ("gloopsAI/gloops-ui", "gloopsAI/paperclip", "gloopsAI/paperclip-gym"):
            self.assertEqual(br.require_repo(repo), repo)

    def test_reject_dest_outside_roots(self) -> None:
        with self.assertRaises(br.BootstrapError) as ctx:
            br.require_dest("/tmp/nope")
        self.assertEqual(ctx.exception.code, "dest_not_allowlisted")

    def test_dest_under_root_ok(self) -> None:
        dest = self.dest_root / "gloops-ui-main"
        self.assertEqual(br.require_dest(dest), dest.resolve())

    def test_dry_run(self) -> None:
        sha = "a" * 40
        report = br.materialize(
            repo="gloopsAI/gloops-ui",
            sha=sha,
            dest=self.dest_root / "gloops-ui-main",
            dry_run=True,
        )
        self.assertTrue(report["ok"])
        self.assertTrue(report["dryRun"])
        self.assertEqual(report["sha"], sha)
        self.assertFalse((self.dest_root / "gloops-ui-main").exists())

    def test_materialize_from_local_clone(self) -> None:
        """Apply path with mocked clone URL pointing at local repo."""
        src, sha = self._bare_repo_with_commit()
        dest = self.dest_root / "paperclip-pin"

        real_run_git = br.run_git

        def fake_run_git(args, **kwargs):
            # Rewrite clone URL to local path
            if args and args[0] == "clone":
                new_args = list(args)
                # clone --no-checkout <url> <path>
                url_idx = next(i for i, a in enumerate(new_args) if a.startswith("http") or a.startswith("file"))
                new_args[url_idx] = str(src)
                return real_run_git(new_args, **kwargs)
            if args[:3] == ["remote", "set-url", "origin"] and "x-access-token" in args[3]:
                # skip auth remote set; use local
                return real_run_git(["remote", "set-url", "origin", str(src)], **kwargs)
            if args[:2] == ["fetch", "--no-tags"]:
                # local already has commit
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            return real_run_git(args, **kwargs)

        with mock.patch.object(br, "run_git", side_effect=fake_run_git):
            report = br.materialize(
                repo="gloopsAI/paperclip",
                sha=sha,
                dest=dest,
                dry_run=False,
                token="ghs_unit_test_token",
            )
        self.assertTrue(report["ok"])
        self.assertEqual(report["head"], sha)
        self.assertTrue((dest / "file.txt").exists())
        # remote scrubbed (not containing token)
        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=dest,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertNotIn("ghs_unit_test_token", remote)

    def test_cli_dry_run(self) -> None:
        rc = br.main(
            [
                "--repo",
                "gloopsAI/gloops-ui",
                "--sha",
                "b" * 40,
                "--dest",
                str(self.dest_root / "ui"),
            ]
        )
        self.assertEqual(rc, 0)

    def test_cli_rejects_bad_sha(self) -> None:
        rc = br.main(
            [
                "--repo",
                "gloopsAI/gloops-ui",
                "--sha",
                "main",
                "--dest",
                str(self.dest_root / "ui"),
                "--apply",
            ]
        )
        self.assertEqual(rc, 1)

    def test_mint_test_mode_token(self) -> None:
        token = br.mint_installation_token()
        self.assertEqual(token, "ghs_unit_test_token")

    def test_redact(self) -> None:
        self.assertEqual(br.redact("token=ghs_secret err", "ghs_secret"), "token=[redacted] err")


if __name__ == "__main__":
    unittest.main()
