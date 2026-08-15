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


class ArgusPublishPollerTests(unittest.TestCase):
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

    def test_exact_approved_head_publishes_and_arms_merge(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            with patch.object(poller, "STATE_PATH", state), patch.object(
                poller, "collect_approved_heads", return_value={HEAD: "GLO-3000"}
            ), patch.object(
                poller,
                "open_surface_prs",
                return_value=[{"number": 300, "title": "surface", "head": {"sha": HEAD}}],
            ), patch.object(poller, "independent_review_ok", return_value=False), patch.object(
                poller, "publish"
            ) as publish, patch.object(
                poller,
                "mark_ready_and_automerge",
                return_value={"ok": True, "headSha": HEAD, "baseRef": "gloops/stable", "autoMergeArmed": True},
            ) as merge_path, patch.object(
                poller.sys, "argv", ["poller", "--once"]
            ):
                self.assertEqual(poller.main(), 0)
                self.assertIn("300:" + HEAD, poller.load_state()["publishedForPr"])
            publish.assert_called_once_with(300, "accepted")
            merge_path.assert_called_once_with(300, HEAD)

    def test_nonmatching_head_does_not_publish(self):
        other = "b" * 40
        with patch.object(poller, "collect_approved_heads", return_value={HEAD: "GLO-3000"}), patch.object(
            poller,
            "open_surface_prs",
            return_value=[{"number": 300, "title": "surface", "head": {"sha": other}}],
        ), patch.object(poller, "publish") as publish, patch.object(
            poller.sys, "argv", ["poller", "--dry-run"]
        ):
            self.assertEqual(poller.main(), 0)
        publish.assert_not_called()

    def test_merge_helper_failure_is_receipted_and_never_false_green(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            with patch.object(poller, "STATE_PATH", state), patch.object(
                poller, "collect_approved_heads", return_value={HEAD: "GLO-3000"}
            ), patch.object(
                poller,
                "open_surface_prs",
                return_value=[{"number": 300, "title": "surface", "head": {"sha": HEAD}}],
            ), patch.object(poller, "independent_review_ok", return_value=False), patch.object(
                poller, "publish"
            ) as publish, patch.object(
                poller, "mark_ready_and_automerge", side_effect=RuntimeError("injected")
            ), patch.object(poller.sys, "argv", ["poller", "--once"]):
                self.assertEqual(poller.main(), 1)
                receipt = poller.load_state()["publishedForPr"]["300:" + HEAD]
            publish.assert_called_once_with(300, "accepted")
            self.assertEqual(receipt["result"], "review_published_merge_pending")
            self.assertEqual(receipt["mergePathErrorClass"], "RuntimeError")

    def test_state_receipt_is_private_and_durable_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            with patch.object(poller, "STATE_PATH", state):
                poller.save_state({"publishedForPr": {}, "lastRunAt": "now", "lastActions": []})
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
