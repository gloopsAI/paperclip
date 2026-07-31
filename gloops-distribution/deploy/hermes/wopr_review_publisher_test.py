#!/usr/bin/env python3
"""Regression coverage for the App B Paperclip API origin."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
