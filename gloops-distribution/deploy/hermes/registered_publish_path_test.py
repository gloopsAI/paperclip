#!/usr/bin/env python3
"""Regression floor: Induct publication has one registered broker path."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class RegisteredPublishPathTest(unittest.TestCase):
    def test_unregistered_publishers_are_absent(self) -> None:
        for relative in (
            "bin/induct-push-poller.py",
            "tools/induct-request-push.py",
            "tools/induct-git-push.py",
        ):
            with self.subTest(relative=relative):
                self.assertFalse((ROOT / relative).exists())

    def test_operator_and_agent_guidance_names_only_registered_broker(self) -> None:
        guidance = (ROOT / "plane-steward/INDUCT_PUSH_PATH.md").read_text()
        verifier = (ROOT / "bin/verify-induct-lease.sh").read_text()
        for content in (guidance, verifier):
            self.assertIn("github-push-tool.bundle.cjs", content)
            self.assertNotIn("induct-push-poller.py", content)
            self.assertNotIn("induct-request-push.py", content)
            self.assertNotIn("induct-git-push.py", content)
        self.assertIn("draft-only", guidance)
        self.assertIn("Missing, expired, replayed, or disagreeing", guidance)
        self.assertIn("authorization fails before token mint", guidance)

    def test_registered_broker_keeps_root_and_draft_only_boundaries(self) -> None:
        broker = (ROOT / "github-push-broker.py").read_text()
        service = (ROOT / "paperclip-github-push-broker.service").read_text()
        self.assertIn("draftPullRequest", broker)
        self.assertIn("rootAuthorizationDigest", broker)
        self.assertIn("NoNewPrivileges=yes", service)
        self.assertIn("ProtectSystem=strict", service)
        self.assertIn("ReadWritePaths=", service)


if __name__ == "__main__":
    unittest.main()
