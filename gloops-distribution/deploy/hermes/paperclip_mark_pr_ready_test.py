#!/usr/bin/env python3
"""Network-free exact-head tests for the protected merge helper."""

from __future__ import annotations

import importlib.util
import pathlib
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name("paperclip-mark-pr-ready.py")
SPEC = importlib.util.spec_from_file_location("paperclip_mark_pr_ready", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MarkPrReadyTest(unittest.TestCase):
    def test_governed_repository_is_bound_to_canonical_base(self):
        binding = MODULE.governed_repository("gloopsAI/personal-delegate", "main")
        self.assertEqual(binding["repositoryId"], 1308141485)
        with self.assertRaisesRegex(RuntimeError, "outside the governed allowlist"):
            MODULE.governed_repository("gloopsAI/personal-delegate", "gloops/stable")
        with self.assertRaisesRegex(RuntimeError, "outside the governed allowlist"):
            MODULE.governed_repository("acme/foreign", "main")

    def test_exact_head_and_base_are_required(self):
        head = "a" * 40
        pr = {
            "state": "open",
            "merged": False,
            "head": {"sha": head},
            "base": {"ref": "gloops/stable", "sha": "b" * 40},
        }
        MODULE.assert_exact_pr(pr, head, "gloops/stable", "b" * 40)
        with self.assertRaisesRegex(RuntimeError, "head drifted"):
            MODULE.assert_exact_pr(pr, "c" * 40, "gloops/stable", "b" * 40)
        with self.assertRaisesRegex(RuntimeError, "base drifted"):
            MODULE.assert_exact_pr(pr, head, "main", "b" * 40)
        with self.assertRaisesRegex(RuntimeError, "base SHA drifted"):
            MODULE.assert_exact_pr(pr, head, "gloops/stable", "c" * 40)

    def test_closed_unmerged_pr_is_never_success(self):
        head = "a" * 40
        with self.assertRaisesRegex(RuntimeError, "closed without merge"):
            MODULE.assert_exact_pr({
                "state": "closed",
                "merged": False,
                "head": {"sha": head},
                "base": {"ref": "gloops/stable", "sha": "b" * 40},
            }, head, "gloops/stable", "b" * 40)

    def test_independent_review_check_is_exact_and_unambiguous(self):
        head = "a" * 40
        external_id = f"gloops-ir-v2:1299155335:305:{head}:source-run:review-run"
        check = {
            "name": "gloops / independent-review",
            "app": {"id": 4071335},
            "head_sha": head,
            "external_id": external_id,
            "status": "completed",
            "conclusion": "success",
        }
        MODULE.assert_exact_independent_review(
            {"check_runs": [check]}, repository_id=1299155335,
            pull_request_number=305, expected_head_sha=head,
            source_run_id="source-run", review_run_id="review-run",
        )
        with self.assertRaisesRegex(RuntimeError, "absent or ambiguous"):
            MODULE.assert_exact_independent_review(
                {"check_runs": [{**check, "app": {"id": 1}}]}, repository_id=1299155335,
                pull_request_number=305, expected_head_sha=head,
                source_run_id="source-run", review_run_id="review-run",
            )
        with self.assertRaisesRegex(RuntimeError, "absent or ambiguous"):
            MODULE.assert_exact_independent_review(
                {"check_runs": [check, check]}, repository_id=1299155335,
                pull_request_number=305, expected_head_sha=head,
                source_run_id="source-run", review_run_id="review-run",
            )

    def test_squash_commit_must_have_the_reviewed_base_as_its_only_parent(self):
        base = "b" * 40
        MODULE.assert_exact_squash_commit({"parents": [{"sha": base}]}, base)
        with self.assertRaisesRegex(RuntimeError, "not an exact squash"):
            MODULE.assert_exact_squash_commit({"parents": [{"sha": base}, {"sha": "a" * 40}]}, base)
        with self.assertRaisesRegex(RuntimeError, "parent drifted"):
            MODULE.assert_exact_squash_commit({"parents": [{"sha": "c" * 40}]}, base)


if __name__ == "__main__":
    unittest.main()
