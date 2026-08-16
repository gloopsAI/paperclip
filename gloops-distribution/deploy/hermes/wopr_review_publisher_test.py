#!/usr/bin/env python3
"""Regression coverage for the App B Paperclip API origin."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("wopr-review-publisher.py")
SPEC = importlib.util.spec_from_file_location("wopr_review_publisher", MODULE_PATH)
assert SPEC and SPEC.loader
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PaperclipApiBaseTests(unittest.TestCase):
    def test_accepts_origin(self):
        self.assertEqual(
            publisher.normalize_paperclip_api_base("http://127.0.0.1:3100"),
            "http://127.0.0.1:3100",
        )

    def test_removes_legacy_api_suffix(self):
        self.assertEqual(
            publisher.normalize_paperclip_api_base("http://127.0.0.1:3100/api/"),
            "http://127.0.0.1:3100",
        )

    def test_verifies_server_bound_exact_head_review(self):
        head = "a" * 40
        reviewer = "11111111-1111-4111-8111-111111111111"
        run_id = "22222222-2222-4222-8222-222222222222"
        issue_id = "33333333-3333-4333-8333-333333333333"
        provenance = {
            "kind": "implementation_exact_head_v2",
            "sourceRunId": "44444444-4444-4444-8444-444444444444",
            "implementerAgentId": "55555555-5555-4555-8555-555555555555",
            "reviewerAgentId": reviewer,
            "alternateReviewerAgentIds": [],
            "repositoryId": "1299155335",
            "repositoryFullName": "gloopsAI/paperclip",
            "baseRef": "gloops/stable",
            "exactBaseSha": "b" * 40,
            "exactHeadSha": head,
            "pullRequestNumber": 300,
            "pullRequestUrl": "https://github.com/gloopsAI/paperclip/pull/300",
        }
        args = SimpleNamespace(
            repo="gloopsAI/paperclip", base="gloops/stable", base_sha="b" * 40, pr=300, head=head,
            review_issue_id=issue_id, review_run_id=run_id,
        )
        issue = {"id": issue_id, "assigneeAgentId": reviewer, "executionWorkspaceSettings": {"reviewProvenance": provenance}}
        run = {"companyId": publisher.COMPANY_ID, "agentId": reviewer, "status": "succeeded", "contextSnapshot": {"issueId": issue_id}, "resultJson": {"providerInvocationAttempted": True}}
        comments = [{"createdByRunId": run_id, "authorAgentId": reviewer, "authorUserId": None, "body": f"APPROVE exact head {head}"}]
        with patch.object(publisher, "paperclip_issue", return_value=issue), patch.object(
            publisher, "paperclip", return_value=run
        ), patch.object(publisher, "paperclip_comments", return_value=comments):
            self.assertEqual(publisher.verify_review_receipt(args, 1299155335), provenance)

        forged = [{**comments[0], "createdByRunId": "66666666-6666-4666-8666-666666666666"}]
        with patch.object(publisher, "paperclip_issue", return_value=issue), patch.object(
            publisher, "paperclip", return_value=run
        ), patch.object(publisher, "paperclip_comments", return_value=forged):
            with self.assertRaises(SystemExit):
                publisher.verify_review_receipt(args, 1299155335)

    def test_main_revokes_app_token_after_publication(self):
        argv = [
            "publisher", "--repo", "gloopsAI/paperclip", "--base", "gloops/stable",
            "--base-sha", "b" * 40, "--pr", "300", "--head", "a" * 40,
            "--review-issue-id", "33333333-3333-4333-8333-333333333333",
            "--review-run-id", "22222222-2222-4222-8222-222222222222",
        ]
        with patch.object(publisher.sys, "argv", argv), patch.object(
            publisher, "verify_review_receipt", return_value={"sourceRunId": "source"}
        ), patch.object(publisher, "app_b_token", return_value="opaque"), patch.object(
            publisher, "publish_with_auth"
        ), patch.object(publisher, "gh", return_value={}) as github:
            publisher.main()
        github.assert_called_once_with("DELETE", "/installation/token", "token opaque")


if __name__ == "__main__":
    unittest.main()
