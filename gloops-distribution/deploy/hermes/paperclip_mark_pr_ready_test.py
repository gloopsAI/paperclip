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
    def test_exact_head_and_base_are_required(self):
        head = "a" * 40
        pr = {
            "state": "open",
            "merged": False,
            "head": {"sha": head},
            "base": {"ref": "gloops/stable"},
        }
        MODULE.assert_exact_pr(pr, head, "gloops/stable")
        with self.assertRaisesRegex(RuntimeError, "head drifted"):
            MODULE.assert_exact_pr(pr, "b" * 40, "gloops/stable")
        with self.assertRaisesRegex(RuntimeError, "base drifted"):
            MODULE.assert_exact_pr(pr, head, "main")

    def test_closed_unmerged_pr_is_never_success(self):
        head = "a" * 40
        with self.assertRaisesRegex(RuntimeError, "closed without merge"):
            MODULE.assert_exact_pr({
                "state": "closed",
                "merged": False,
                "head": {"sha": head},
                "base": {"ref": "gloops/stable"},
            }, head, "gloops/stable")


if __name__ == "__main__":
    unittest.main()
