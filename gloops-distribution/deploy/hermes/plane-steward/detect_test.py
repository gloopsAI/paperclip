#!/usr/bin/env python3
"""Unit tests for plane-steward detect.py (no network)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import detect


class DetectTest(unittest.TestCase):
    def test_recipes_load(self) -> None:
        pack = detect.load_recipes()
        ids = {r["id"] for r in pack["recipes"]}
        self.assertIn("dirty-tree-clean", ids)
        self.assertIn("null-issueId-wake-reject", ids)
        self.assertIn("never-enable-global-heartbeat-scheduler", ids)

    def test_dirty_tree_error_code(self) -> None:
        matches = detect.detect_events(
            [{"errorCode": "workspace_admit.dirty_tree", "issueId": "a2b3db2c-9fbe-457f-96bd-bb6c643029b3"}]
        )
        self.assertTrue(any(m["recipeId"] == "dirty-tree-clean" for m in matches))
        self.assertTrue(any(m["signal"] == "dirty_tree" for m in matches))

    def test_head_mismatch(self) -> None:
        matches = detect.detect_events(
            [{"errorCode": "workspace_admit.head_mismatch", "detail": "expected f5c… got e766…"}]
        )
        self.assertTrue(any(m["recipeId"] == "wrong-head-rebase" for m in matches))

    def test_null_issue_id_recommends_bound_wake(self) -> None:
        matches = detect.detect_events(
            [
                {
                    "kind": "wakeup",
                    "payload": {"issueId": None},
                    "errorCode": "execution_admission.issue_unbound",
                }
            ]
        )
        recipes = {m["recipeId"] for m in matches}
        self.assertIn("null-issueId-wake-reject", recipes)

    def test_heartbeat_scheduler(self) -> None:
        matches = detect.detect_in_text("HEARTBEAT_SCHEDULER_ENABLED=true preflight death spiral")
        self.assertTrue(
            any(m["recipeId"] == "never-enable-global-heartbeat-scheduler" for m in matches)
        )

    def test_log_file_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "x.log"
            log.write_text("workspace_admit.cwd_not_readable EACCES uid 995\n", encoding="utf-8")
            rc = detect.main(["--log-file", str(log)])
            self.assertEqual(rc, 0)

    def test_missing_input_fails(self) -> None:
        rc = detect.main([])
        self.assertEqual(rc, 2)

    def test_campaign_deadline_imminent(self) -> None:
        matches = detect.detect_in_text("CRITICAL campaign.deadline_lt_6h hours_remaining=3.2")
        self.assertTrue(any(m["recipeId"] == "campaign-deadline-alert" for m in matches))
        self.assertTrue(any(m["signal"] == "campaign_deadline_imminent" for m in matches))

    def test_harbor_campaign_reopen_signal(self) -> None:
        matches = detect.detect_in_text(
            "Harbor standing reopen residual campaign.deadline_lt_6h OPEN CAMPAIGN 24H"
        )
        self.assertTrue(any(m["recipeId"] == "harbor-campaign-reopen" for m in matches))

    def test_recipes_include_harbor_campaign_reopen(self) -> None:
        pack = detect.load_recipes()
        ids = {r["id"] for r in pack["recipes"]}
        self.assertIn("harbor-campaign-reopen", ids)

    def test_induct_lease_stale(self) -> None:
        matches = detect.detect_events(
            [{"errorCode": "lease.dirty_or_missing", "detail": "verify-induct-lease failed"}]
        )
        self.assertTrue(any(m["recipeId"] == "induct-lease-refresh" for m in matches))
        self.assertTrue(any(m["signal"] == "induct_lease_stale" for m in matches))

    def test_recipes_include_sdlc_ids(self) -> None:
        pack = detect.load_recipes()
        ids = {r["id"] for r in pack["recipes"]}
        self.assertIn("induct-lease-refresh", ids)
        self.assertIn("sdlc-preflight-check", ids)
        self.assertIn("campaign-deadline-alert", ids)


if __name__ == "__main__":
    unittest.main()
