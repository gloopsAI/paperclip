#!/usr/bin/env python3
"""Unit tests for refresh_pws_catalog.py (no live network)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import refresh_pws_catalog as rpc


class RefreshPwsCatalogTest(unittest.TestCase):
    def test_load_catalog(self) -> None:
        catalog = rpc.load_catalog()
        ids = {e["id"] for e in catalog["entries"]}
        self.assertIn("gloops-ui-main", ids)
        self.assertIn("paperclip-pin", ids)
        self.assertIn("paperclip-gym", ids)

    def test_target_sha_uses_pin(self) -> None:
        pin = "a" * 40
        entry = {
            "id": "paperclip-pin",
            "repo": "gloopsAI/paperclip",
            "defaultBranch": "gloops/stable",
            "pinSha": pin,
            "refreshPolicy": {"mode": "pin-or-branch"},
        }
        self.assertEqual(rpc.target_sha_for_entry(entry), pin)

    def test_target_sha_resolves_branch(self) -> None:
        sha = "b" * 40

        def ls_remote(repo: str, branch: str) -> str:
            self.assertEqual(repo, "gloopsAI/gloops-ui")
            self.assertEqual(branch, "main")
            return sha

        entry = {
            "id": "gloops-ui-main",
            "repo": "gloopsAI/gloops-ui",
            "defaultBranch": "main",
            "pinSha": None,
            "refreshPolicy": {"mode": "track-branch-sha"},
        }
        self.assertEqual(rpc.target_sha_for_entry(entry, ls_remote_fn=ls_remote), sha)

    def test_reject_non_sha_resolution(self) -> None:
        def ls_remote(repo: str, branch: str) -> str:
            return "main"

        entry = {
            "id": "x",
            "repo": "gloopsAI/gloops-ui",
            "defaultBranch": "main",
            "pinSha": None,
            "refreshPolicy": {"mode": "track-branch-sha"},
        }
        with self.assertRaises(rpc.CatalogError):
            rpc.target_sha_for_entry(entry, ls_remote_fn=ls_remote)

    def test_refresh_dry_run(self) -> None:
        sha = "c" * 40

        def ls_remote(repo: str, branch: str) -> str:
            return sha

        def materialize(**kwargs):
            self.assertTrue(kwargs["dry_run"])
            self.assertEqual(kwargs["sha"], sha)
            return {
                "ok": True,
                "dryRun": True,
                "dest": kwargs["dest"],
                "sha": sha,
            }

        catalog = rpc.load_catalog()
        report = rpc.refresh_catalog(
            catalog,
            dry_run=True,
            only={"gloops-ui-main"},
            ls_remote_fn=ls_remote,
            materialize_fn=materialize,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["entryCount"], 1)
        self.assertEqual(report["entries"][0]["sha"], sha)
        self.assertTrue(report["entries"][0]["ok"])

    def test_refresh_apply_propagates_materialize(self) -> None:
        sha = "d" * 40
        calls: list[dict] = []

        def ls_remote(repo: str, branch: str) -> str:
            return sha

        def materialize(**kwargs):
            calls.append(kwargs)
            return {"ok": True, "dryRun": False, "head": sha, "dest": kwargs["dest"]}

        catalog = rpc.load_catalog()
        report = rpc.refresh_catalog(
            catalog,
            dry_run=False,
            only={"paperclip-gym"},
            ls_remote_fn=ls_remote,
            materialize_fn=materialize,
        )
        self.assertTrue(report["ok"])
        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0]["dry_run"])
        self.assertEqual(calls[0]["repo"], "gloopsAI/paperclip-gym")

    def test_row_isolates_errors(self) -> None:
        def ls_remote(repo: str, branch: str) -> str:
            if "gym" in repo:
                raise rpc.CatalogError("boom")
            return "e" * 40

        def materialize(**kwargs):
            return {"ok": True, "dryRun": True, "dest": kwargs["dest"]}

        catalog = rpc.load_catalog()
        report = rpc.refresh_catalog(
            catalog,
            dry_run=True,
            ls_remote_fn=ls_remote,
            materialize_fn=materialize,
        )
        by_id = {r["id"]: r for r in report["entries"]}
        self.assertFalse(by_id["paperclip-gym"]["ok"])
        self.assertIn("boom", by_id["paperclip-gym"]["error"] or "")
        self.assertTrue(by_id["gloops-ui-main"]["ok"])

    def test_cli_print_catalog(self) -> None:
        rc = rpc.main(["--print-catalog"])
        self.assertEqual(rc, 0)

    def test_cli_dry_run_with_mocks_via_env_catalog(self) -> None:
        # Full CLI path still needs network for resolve — use only + inject by
        # testing library path above. Here ensure missing catalog fails typed.
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "nope.json"
            rc = rpc.main(["--catalog", str(bad)])
            self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
