#!/usr/bin/env python3
"""Deterministic coverage for Argus-accept → App-B publication handoff."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("closed-loop-argus-publish-poller.py")
SPEC = importlib.util.spec_from_file_location("closed_loop_argus_publish_poller", MODULE_PATH)
assert SPEC and SPEC.loader
poller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(poller)


HEAD = "a" * 40
ARGUS_ID = "843c62bc-6f32-420e-9b62-7a2d6a34846f"
RUN_ID = "11111111-1111-4111-8111-111111111111"
BINDING = {
    "kind": "implementation_exact_head_v2",
    "parentIssueId": "22222222-2222-4222-8222-222222222222",
    "sourceRunId": "33333333-3333-4333-8333-333333333333",
    "implementerAgentId": "44444444-4444-4444-8444-444444444444",
    "reviewerAgentId": ARGUS_ID,
    "alternateReviewerAgentIds": [],
    "projectWorkspaceId": "55555555-5555-4555-8555-555555555555",
    "repositoryId": "1299155335",
    "repositoryFullName": "gloopsAI/paperclip",
    "baseRef": "gloops/stable",
    "exactBaseSha": "b" * 40,
    "exactHeadSha": HEAD,
    "pullRequestNumber": 300,
    "pullRequestUrl": "https://github.com/gloopsAI/paperclip/pull/300",
}


class ArgusPublishPollerTests(unittest.TestCase):
    def test_merged_pr_remains_reconcilable_after_base_ref_advances(self):
        binding = {
            "repositoryId": "1299155335",
            "baseRef": "gloops/stable",
            "exactBaseSha": "b" * 40,
            "exactHeadSha": HEAD,
        }
        self.assertTrue(poller.pr_matches_review_binding({
            "state": "closed",
            "merged": True,
            "head": {"sha": HEAD},
            "base": {
                "ref": "gloops/stable", "sha": "c" * 40,
                "repo": {"id": 1299155335},
            },
        }, binding))
        self.assertFalse(poller.pr_matches_review_binding({
            "state": "open",
            "merged": False,
            "head": {"sha": HEAD},
            "base": {
                "ref": "gloops/stable", "sha": "c" * 40,
                "repo": {"id": 1299155335},
            },
        }, binding))

    def test_extracts_explicit_exact_head_approval(self):
        self.assertEqual(
            poller.extract_approved_heads(f"APPROVE exact head {HEAD}"), {HEAD}
        )

    def test_ignores_template_text_without_a_head(self):
        self.assertEqual(
            poller.extract_approved_heads("Verdict: APPROVE or CHANGES_REQUESTED"), set()
        )

    def test_extracts_approved_swarm_marker(self):
        text = f'PAPERCLIP_SWARM_V1:{{"action":"accepted","headSha":"{HEAD}"}}'
        self.assertEqual(poller.extract_approved_heads(text), {HEAD})

    def test_collects_only_server_bound_reviewer_run(self):
        issue = {
            "id": "review-1",
            "identifier": "GLO-3000",
            "assigneeAgentId": ARGUS_ID,
            "executionWorkspaceSettings": {"reviewProvenance": BINDING},
        }
        with patch.object(
            poller, "list_review_issues", return_value=[issue]
        ), patch.object(poller, "issue_detail", return_value=issue
        ), patch.object(
            poller,
            "issue_comments",
            return_value=[{
                "authorAgentId": ARGUS_ID,
                "authorUserId": None,
                "createdByRunId": RUN_ID,
                "body": f"APPROVE {HEAD}",
            }],
        ), patch.object(poller, "api", return_value={
            "companyId": poller.COMPANY,
            "agentId": ARGUS_ID,
            "status": "succeeded",
            "contextSnapshot": {"issueId": "review-1"},
            "resultJson": {"providerInvocationAttempted": True},
        }
        ):
            values = poller.collect_approved_bindings()
            self.assertEqual(len(values), 1)
            self.assertEqual(values[0]["repositoryFullName"], "gloopsAI/paperclip")
            self.assertEqual(values[0]["reviewRunId"], RUN_ID)

    def test_rejects_user_untrusted_and_non_assignee_approvals(self):
        issue = {
            "id": "review-1",
            "identifier": "GLO-3000",
            "assigneeAgentId": ARGUS_ID,
        }
        comments = [
            {"authorAgentId": None, "authorUserId": "board-user", "body": f"APPROVE {HEAD}"},
            {"authorAgentId": "other-agent", "authorUserId": None, "body": f"APPROVE {HEAD}"},
            {"authorAgentId": ARGUS_ID, "authorUserId": "also-user", "body": f"APPROVE {HEAD}"},
        ]
        issue["executionWorkspaceSettings"] = {"reviewProvenance": BINDING}
        with patch.object(
            poller, "list_review_issues", return_value=[issue]
        ), patch.object(poller, "issue_detail", return_value=issue), patch.object(poller, "issue_comments", return_value=comments):
            self.assertEqual(poller.collect_approved_bindings(), [])

        issue["assigneeAgentId"] = "other-agent"
        with patch.object(
            poller, "list_review_issues", return_value=[issue]
        ), patch.object(poller, "issue_detail", return_value=issue), patch.object(
            poller,
            "issue_comments",
            return_value=[{"authorAgentId": ARGUS_ID, "authorUserId": None, "createdByRunId": RUN_ID, "body": f"APPROVE {HEAD}"}],
        ):
            self.assertEqual(poller.collect_approved_bindings(), [])

    def test_exact_approved_head_publishes_and_arms_merge(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            binding = {**BINDING, "sourceIssue": "GLO-3000", "reviewIssueId": "review-1", "reviewRunId": RUN_ID}
            pr = {"number": 300, "title": "surface", "state": "open", "head": {"sha": HEAD}, "base": {"ref": "gloops/stable", "sha": "b" * 40, "repo": {"id": 1299155335}}}
            with patch.object(poller, "STATE_PATH", state), patch.object(
                poller, "collect_approved_bindings", return_value=[binding]
            ), patch.object(poller, "gh_json", return_value=pr), patch.object(poller, "independent_review_ok", return_value=False), patch.object(
                poller, "publish"
            ) as publish, patch.object(
                poller,
                "mark_ready_and_merge",
                return_value={"ok": True, "repo": "gloopsAI/paperclip", "pr": 300, "headSha": HEAD, "baseRef": "gloops/stable", "baseSha": "b" * 40, "mergePending": True},
            ) as merge_path, patch.object(
                poller.sys, "argv", ["poller", "--once"]
            ):
                self.assertEqual(poller.main(), 0)
                self.assertIn("1299155335:300:" + HEAD, poller.load_state()["publishedForPr"])
            publish.assert_called_once_with(binding, "accepted")
            merge_path.assert_called_once_with(binding)

    def test_ended_queue_attempt_is_terminally_suppressed(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            binding = {**BINDING, "sourceIssue": "GLO-3000", "reviewIssueId": "review-1", "reviewRunId": RUN_ID}
            pr = {"number": 300, "title": "surface", "state": "open", "head": {"sha": HEAD}, "base": {"ref": "gloops/stable", "sha": "b" * 40, "repo": {"id": 1299155335}}}
            with patch.object(poller, "STATE_PATH", state), patch.object(
                poller, "collect_approved_bindings", return_value=[binding]
            ), patch.object(poller, "gh_json", return_value=pr), patch.object(
                poller, "independent_review_ok", return_value=False
            ), patch.object(poller, "publish"), patch.object(
                poller, "mark_ready_and_merge", return_value={
                    "ok": True, "repo": "gloopsAI/paperclip", "pr": 300,
                    "headSha": HEAD, "baseRef": "gloops/stable",
                    "baseSha": "b" * 40, "queueEnded": True,
                    "queueEvidence": {"attemptState": "integration_review_published"},
                },
            ), patch.object(poller.sys, "argv", ["poller", "--once"]):
                self.assertEqual(poller.main(), 0)
                receipt = poller.load_state()["publishedForPr"]["1299155335:300:" + HEAD]
            self.assertEqual(receipt["result"], "review_published_queue_terminal_suppressed")

    def test_nonmatching_head_does_not_publish(self):
        other = "b" * 40
        binding = {**BINDING, "sourceIssue": "GLO-3000", "reviewIssueId": "review-1", "reviewRunId": RUN_ID}
        with patch.object(poller, "collect_approved_bindings", return_value=[binding]), patch.object(
            poller, "gh_json", return_value={"number":300,"state":"open","title":"surface","head":{"sha":other},"base":{"ref":"gloops/stable","sha":"b"*40,"repo":{"id":1299155335}}}
        ), patch.object(poller, "publish") as publish, patch.object(
            poller.sys, "argv", ["poller", "--dry-run"]
        ):
            self.assertEqual(poller.main(), 0)
        publish.assert_not_called()

    def test_merge_helper_failure_is_receipted_and_never_false_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            binding = {**BINDING, "sourceIssue": "GLO-3000", "reviewIssueId": "review-1", "reviewRunId": RUN_ID}
            pr = {"number":300,"state":"open","title":"surface","head":{"sha":HEAD},"base":{"ref":"gloops/stable","sha":"b"*40,"repo":{"id":1299155335}}}
            with patch.object(poller, "STATE_PATH", state), patch.object(
                poller, "collect_approved_bindings", return_value=[binding]
            ), patch.object(poller, "gh_json", return_value=pr), patch.object(poller, "independent_review_ok", return_value=False), patch.object(
                poller, "publish"
            ) as publish, patch.object(
            poller, "mark_ready_and_merge", side_effect=RuntimeError("injected")
            ), patch.object(poller.sys, "argv", ["poller", "--once"]):
                self.assertEqual(poller.main(), 1)
                receipt = poller.load_state()["publishedForPr"]["1299155335:300:" + HEAD]
            publish.assert_called_once_with(binding, "accepted")
            self.assertEqual(receipt["result"], "review_published_merge_pending")
            self.assertEqual(receipt["mergePathErrorClass"], "RuntimeError")

    def test_independent_review_recovery_requires_exact_app_and_external_id(self):
        binding = {**BINDING, "sourceIssue": "GLO-3000", "reviewIssueId": "review-1", "reviewRunId": RUN_ID}
        exact = {
            "name": "gloops / independent-review",
            "app": {"id": 4071335},
            "head_sha": HEAD,
            "external_id": f"gloops-ir-v2:1299155335:300:{HEAD}:{BINDING['sourceRunId']}:{RUN_ID}",
            "status": "completed",
            "conclusion": "success",
        }
        with patch.object(poller, "gh_json", return_value={"check_runs": [exact]}):
            self.assertTrue(poller.independent_review_ok(binding))
        with patch.object(poller, "gh_json", return_value={"check_runs": [{**exact, "app": {"id": 1}}]}):
            self.assertFalse(poller.independent_review_ok(binding))
        with patch.object(poller, "gh_json", return_value={"check_runs": [{**exact, "external_id": "spoof"}]}):
            self.assertFalse(poller.independent_review_ok(binding))

    def test_state_receipt_is_private_and_durable_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            with patch.object(poller, "STATE_PATH", state):
                poller.save_state({"publishedForPr": {}, "lastRunAt": "now", "lastActions": []})
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)

    def test_state_receipt_retries_short_writes(self):
        real_write = poller.os.write
        write_calls = []

        def short_write(descriptor, payload):
            write_calls.append(len(payload))
            size = max(1, len(payload) // 2)
            return real_write(descriptor, payload[:size])

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            with patch.object(poller, "STATE_PATH", state), patch.object(
                poller.os, "write", side_effect=short_write
            ):
                poller.save_state({"publishedForPr": {"300:" + HEAD: {"result": "published"}}})
                self.assertEqual(
                    poller.load_state()["publishedForPr"]["300:" + HEAD]["result"],
                    "published",
                )
        self.assertGreater(len(write_calls), 1)


if __name__ == "__main__":
    unittest.main()
