#!/usr/bin/env python3
"""Unit tests for plane-steward apply_recipe.py (no network / hermes)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import apply_recipe


class ApplyRecipeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ws_root = self.root / "workspace"
        self.ws_root.mkdir()
        self.cwd = self.ws_root / "repo"
        self.cwd.mkdir()
        self.env_patch = mock.patch.dict(
            os.environ,
            {
                "PLANE_STEWARD_PATH_ROOTS": str(self.ws_root),
                "PLANE_STEWARD_EXCLUSIVE_WRITER": "1",
                "PLANE_STEWARD_TEST_MODE": "1",
            },
            clear=False,
        )
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()
        self.temp.cleanup()

    def _git_init_commit(self) -> str:
        subprocess.run(["git", "init"], cwd=self.cwd, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.cwd,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "test"],
            cwd=self.cwd,
            check=True,
            capture_output=True,
        )
        (self.cwd / "README").write_text("hi\n", encoding="utf-8")
        subprocess.run(["git", "add", "README"], cwd=self.cwd, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=self.cwd,
            check=True,
            capture_output=True,
        )
        sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.cwd,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        return sha

    def test_list_recipes(self) -> None:
        rc = apply_recipe.main(["--list"])
        self.assertEqual(rc, 0)

    def test_unknown_recipe(self) -> None:
        rc = apply_recipe.main(["--recipe", "not-a-recipe"])
        self.assertEqual(rc, 1)

    def test_path_outside_allowlist(self) -> None:
        with self.assertRaises(apply_recipe.RecipeError):
            apply_recipe.recipe_dirty_tree_clean(
                dry_run=True,
                params={"cwd": "/tmp/not-allowed"},
                pack=apply_recipe.load_recipes(),
            )

    def test_dirty_tree_dry_run(self) -> None:
        self._git_init_commit()
        (self.cwd / "junk.txt").write_text("x", encoding="utf-8")
        report = apply_recipe.recipe_dirty_tree_clean(
            dry_run=True,
            params={"cwd": str(self.cwd)},
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertTrue(report["dryRun"])
        self.assertTrue(report["wouldMutate"])
        # file still present in dry-run
        self.assertTrue((self.cwd / "junk.txt").exists())

    def test_dirty_tree_apply(self) -> None:
        self._git_init_commit()
        (self.cwd / "junk.txt").write_text("x", encoding="utf-8")
        report = apply_recipe.recipe_dirty_tree_clean(
            dry_run=False,
            params={"cwd": str(self.cwd)},
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertFalse((self.cwd / "junk.txt").exists())

    def test_wrong_head_rejects_branch_name(self) -> None:
        self._git_init_commit()
        with self.assertRaises(apply_recipe.RecipeError) as ctx:
            apply_recipe.recipe_wrong_head_rebase(
                dry_run=True,
                params={"cwd": str(self.cwd), "expectedSha": "main"},
                pack=apply_recipe.load_recipes(),
            )
        self.assertIn("40-char", str(ctx.exception))

    def test_wrong_head_dry_run(self) -> None:
        sha = self._git_init_commit()
        report = apply_recipe.recipe_wrong_head_rebase(
            dry_run=True,
            params={"cwd": str(self.cwd), "expectedSha": sha},
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertTrue(report["alreadyAtHead"])

    def test_exclusive_writer_required(self) -> None:
        self._git_init_commit()
        os.environ["PLANE_STEWARD_EXCLUSIVE_WRITER"] = "0"
        with self.assertRaises(apply_recipe.RecipeError):
            apply_recipe.recipe_dirty_tree_clean(
                dry_run=True,
                params={"cwd": str(self.cwd)},
                pack=apply_recipe.load_recipes(),
            )

    def test_null_issue_id_rejected(self) -> None:
        with self.assertRaises(apply_recipe.RecipeError):
            apply_recipe.recipe_null_issue_wake_reject(
                dry_run=True,
                params={"issueId": None, "agentId": "agent-1"},
                pack=apply_recipe.load_recipes(),
            )

    def test_null_issue_wake_dry_run(self) -> None:
        report = apply_recipe.recipe_null_issue_wake_reject(
            dry_run=True,
            params={
                "issueId": "a2b3db2c-9fbe-457f-96bd-bb6c643029b3",
                "agentId": "agent-1",
            },
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertFalse(report["companyUnfreeze"])

    def test_scheduler_refuse_enable(self) -> None:
        with self.assertRaises(apply_recipe.RecipeError):
            apply_recipe.recipe_never_enable_scheduler(
                dry_run=True,
                params={"enable": "true"},
                pack=apply_recipe.load_recipes(),
            )

    def test_scheduler_dry_run_observes_runtime(self) -> None:
        runtime = self.root / "runtime.env"
        runtime.write_text("HEARTBEAT_SCHEDULER_ENABLED=false\n", encoding="utf-8")
        os.environ["PLANE_STEWARD_RUNTIME_ENV"] = str(runtime)
        report = apply_recipe.recipe_never_enable_scheduler(
            dry_run=True,
            params={},
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["heartbeatSchedulerEnabled"], "false")
        self.assertFalse(report["wouldForceFalse"])

    def test_readmit_dry_run(self) -> None:
        report = apply_recipe.recipe_readmit_budget_bound_wake(
            dry_run=True,
            params={
                "issueId": "a2b3db2c-9fbe-457f-96bd-bb6c643029b3",
                "agentId": "wren",
            },
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertIn("resourceBudget", report)

    def test_acl_fix_dry_run(self) -> None:
        report = apply_recipe.recipe_acl_fix(
            dry_run=True,
            params={"cwd": str(self.cwd)},
            pack=apply_recipe.load_recipes(),
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["uid"], 995)

    def test_cli_dry_run_dirty(self) -> None:
        self._git_init_commit()
        rc = apply_recipe.main(
            [
                "--recipe",
                "dirty-tree-clean",
                "--param",
                f"cwd={self.cwd}",
            ]
        )
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main()
