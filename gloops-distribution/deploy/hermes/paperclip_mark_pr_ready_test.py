#!/usr/bin/env python3
"""Network-free exact-head tests for the protected merge helper."""

from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock

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

    def test_ci_merge_kill_switch_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "disabled by kill switch"):
            MODULE.require_ci_merge_enabled({})
        MODULE.require_ci_merge_enabled({"PAPERCLIP_CI_MERGE_ENABLED": "1"})

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

    def test_merge_queue_policy_requires_single_entry_ir_and_no_app_b_bypass(self):
        rules = [
            {"ruleset_id": 10, "type": "merge_queue", "parameters": {
                "grouping_strategy": "ALLGREEN", "merge_method": "SQUASH", "max_entries_to_merge": 1,
            }},
            {"ruleset_id": 10, "type": "required_status_checks", "parameters": {
                "strict_required_status_checks_policy": True,
                "required_status_checks": [{"context": "gloops / independent-review", "integration_id": 4071335}],
            }},
        ]
        with mock.patch.object(MODULE, "gh_api", return_value=rules):
            self.assertEqual(MODULE.merge_queue_policy("gloopsAI/paperclip", "gloops/stable", "token"), {
                "queueRulesetIds": [10],
            })
        wrong_checks = [{**rules[0]}, {**rules[1], "parameters": {
            **rules[1]["parameters"],
            "required_status_checks": [{"context": "gloops / independent-review", "integration_id": 1}],
        }}]
        with mock.patch.object(MODULE, "gh_api", return_value=wrong_checks):
            with self.assertRaisesRegex(RuntimeError, "required check is absent"):
                MODULE.merge_queue_policy("gloopsAI/paperclip", "gloops/stable", "token")

    def test_response_loss_reconciles_only_exact_reviewed_squash(self):
        base = "b" * 40
        head = "a" * 40
        merged = {
            "merged": True,
            "head": {"sha": head},
            "base": {"ref": "gloops/stable"},
            "merge_commit_sha": "c" * 40,
        }
        with mock.patch.object(MODULE, "gh_api", return_value={"parents": [{"sha": base}]}):
            self.assertEqual(MODULE.reconcile_merged_pr(
                repo="gloopsAI/paperclip", pr=merged, expected_head=head,
                expected_base="gloops/stable", expected_base_sha=base, token="token",
            ), "c" * 40)
        with mock.patch.object(MODULE, "gh_api", return_value={"parents": [{"sha": "d" * 40}]}):
            with self.assertRaisesRegex(RuntimeError, "parent drifted"):
                MODULE.reconcile_merged_pr(
                    repo="gloopsAI/paperclip", pr=merged, expected_head=head,
                    expected_base="gloops/stable", expected_base_sha=base, token="token",
                )

    def test_queue_base_drift_dequeues_without_publishing_integration_review(self):
        entry = {
            "id": "queue-entry",
            "state": "AWAITING_CHECKS",
            "baseCommit": {"oid": "c" * 40},
            "headCommit": {"oid": "d" * 40},
            "pullRequest": {"id": "pr-node"},
        }
        binding = {
            "repositoryId": 1299155335, "repository": "gloopsAI/paperclip",
            "pullRequestNumber": 305, "reviewedBaseSha": "b" * 40,
            "reviewedHeadSha": "a" * 40, "sourceRunId": "source-run",
            "reviewRunId": "review-run",
        }
        state = {"schemaVersion": "exact-merge-queue-attempts@1", "attempts": {
            MODULE.queue_attempt_key(binding): {
                "binding": binding, "state": "enqueued", "queueEntryId": "queue-entry",
            },
        }}
        with mock.patch.object(MODULE, "load_queue_attempts", return_value=state), mock.patch.object(
            MODULE, "save_queue_attempts"
        ), mock.patch.object(MODULE, "queue_entry", return_value=entry), mock.patch.object(
            MODULE, "dequeue_entry"
        ) as dequeue, mock.patch.object(MODULE, "ensure_integration_review_check") as publish:
            with self.assertRaisesRegex(RuntimeError, "fresh review required"):
                MODULE.enqueue_exact_merge_group(
                    queue_token="queue-token", check_token="check-token",
                    node_id="pr-node", repo="gloopsAI/paperclip",
                    repository_id=1299155335, pull_request_number=305,
                    expected_base_sha="b" * 40, expected_head_sha="a" * 40,
                    source_run_id="source-run", review_run_id="review-run",
                )
        dequeue.assert_called_once_with("queue-token", "pr-node", "queue-entry")
        publish.assert_not_called()

    def test_dequeue_uses_pull_request_node_and_binds_returned_entry(self):
        with mock.patch.object(MODULE, "graphql", return_value={
            "dequeuePullRequest": {"mergeQueueEntry": {"id": "entry-1"}},
        }) as graphql:
            MODULE.dequeue_entry("token", "pr-node", "entry-1")
        self.assertEqual(graphql.call_args.args[2], {"id": "pr-node"})
        with mock.patch.object(MODULE, "graphql", return_value={
            "dequeuePullRequest": {"mergeQueueEntry": {"id": "entry-2"}},
        }):
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                MODULE.dequeue_entry("token", "pr-node", "entry-1")

    def test_finished_queue_attempt_is_not_reenqueued(self):
        binding = {
            "repositoryId": 1299155335, "repository": "gloopsAI/paperclip",
            "pullRequestNumber": 305, "reviewedBaseSha": "b" * 40,
            "reviewedHeadSha": "a" * 40, "sourceRunId": "source-run",
            "reviewRunId": "review-run",
        }
        state = {"schemaVersion": "exact-merge-queue-attempts@1", "attempts": {
            MODULE.queue_attempt_key(binding): {
                "binding": binding, "state": "integration_review_published",
                "queueEntryId": "old-entry",
            },
        }}
        with mock.patch.object(MODULE, "load_queue_attempts", return_value=state), mock.patch.object(
            MODULE, "queue_entry", return_value=None
        ), mock.patch.object(MODULE, "graphql") as graphql:
            result = MODULE.enqueue_exact_merge_group(
                queue_token="queue-token", check_token="check-token",
                node_id="pr-node", repo="gloopsAI/paperclip",
                repository_id=1299155335, pull_request_number=305,
                expected_base_sha="b" * 40, expected_head_sha="a" * 40,
                source_run_id="source-run", review_run_id="review-run",
            )
        self.assertEqual(result, {
            "queueEnded": True,
            "priorQueueEntryId": "old-entry",
            "attemptState": "integration_review_published",
        })
        graphql.assert_not_called()

    def test_queue_attempt_state_is_durable_and_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "state.json"
            value = {"schemaVersion": "exact-merge-queue-attempts@1", "attempts": {
                "key": {"state": "reserved"},
            }}
            MODULE.save_queue_attempts(value, path)
            self.assertEqual(MODULE.load_queue_attempts(path), value)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_integration_review_check_binds_full_queue_tuple(self):
        base = "b" * 40
        head = "a" * 40
        integration = "d" * 40
        with mock.patch.object(MODULE, "gh_api", side_effect=[
            {"check_runs": []},
            {"head_sha": integration, "external_id": mock.ANY},
        ]) as api:
            external_id = MODULE.ensure_integration_review_check(
                repo="gloopsAI/paperclip", repository_id=1299155335,
                pull_request_number=305, source_run_id="source-run",
                review_run_id="review-run", expected_base_sha=base,
                expected_head_sha=head, integration_sha=integration,
                queue_entry_id="queue-entry", token="token",
            )
        self.assertRegex(external_id, r"^gloops-ir-group-v1:[0-9a-f]{64}$")
        published = api.call_args_list[1].args[3]
        self.assertEqual(published["head_sha"], integration)
        self.assertEqual(published["external_id"], external_id)
        self.assertIn(base, published["output"]["text"])
        self.assertIn(head, published["output"]["text"])
        self.assertIn(integration, published["output"]["text"])


if __name__ == "__main__":
    unittest.main()
