#!/usr/bin/env python3
"""Unit tests for sentinel-plane-loop pure helpers (no network / no host)."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

import plane_loop_helpers as spl


class FingerprintTest(unittest.TestCase):
    def test_empty_is_green(self) -> None:
        fp = spl.fingerprint_codes([])
        self.assertTrue(fp.endswith(":green") or fp.split(":", 1)[1] == "green")

    def test_stable_order_independent(self) -> None:
        a = spl.fingerprint_codes(["b.code", "a.code"])
        b = spl.fingerprint_codes(["a.code", "b.code"])
        self.assertEqual(a, b)

    def test_hours_bucket_lt12(self) -> None:
        fp = spl.fingerprint_codes([], hours_remaining=10.0)
        self.assertIn("campaign.hours_bucket:lt12", fp)

    def test_hours_bucket_lt6(self) -> None:
        fp = spl.fingerprint_codes(["campaign.deadline_lt_6h"], hours_remaining=3.0)
        self.assertIn("campaign.hours_bucket:lt6", fp)

    def test_hours_bucket_expired(self) -> None:
        fp = spl.fingerprint_codes([], hours_remaining=-1.0)
        self.assertIn("campaign.hours_bucket:expired", fp)

    def test_critical_changes_fingerprint(self) -> None:
        a = spl.fingerprint_codes(["lease.dirty_or_missing"])
        b = spl.fingerprint_codes(["pin.mismatch"])
        self.assertNotEqual(a, b)


class ParseHoursTest(unittest.TestCase):
    def test_none(self) -> None:
        self.assertIsNone(spl.parse_hours(None))
        self.assertIsNone(spl.parse_hours(""))

    def test_float(self) -> None:
        self.assertEqual(spl.parse_hours(3.5), 3.5)
        self.assertEqual(spl.parse_hours("12.25"), 12.25)

    def test_bad(self) -> None:
        self.assertIsNone(spl.parse_hours("nope"))


class NeedsResidualTest(unittest.TestCase):
    def test_critical(self) -> None:
        self.assertTrue(spl.needs_residual(["lease.dirty_or_missing"], 24.0))

    def test_hours_under_12(self) -> None:
        self.assertTrue(spl.needs_residual([], 11.9))

    def test_green(self) -> None:
        self.assertFalse(spl.needs_residual([], 20.0))
        self.assertFalse(spl.needs_residual([], None))


class AssigneeTest(unittest.TestCase):
    def test_campaign_to_harbor(self) -> None:
        self.assertEqual(spl.assignee_for_codes(["campaign.deadline_lt_6h"]), "harbor")

    def test_pin_to_harbor(self) -> None:
        self.assertEqual(spl.assignee_for_codes(["pin.mismatch"]), "harbor")

    def test_lease_to_sentinel(self) -> None:
        self.assertEqual(spl.assignee_for_codes(["lease.dirty_or_missing"]), "sentinel")

    def test_commissioned_to_harbor(self) -> None:
        self.assertEqual(spl.assignee_for_codes(["commissioned.false"]), "harbor")


class LeaseAutoApplyTest(unittest.TestCase):
    def test_lease_code(self) -> None:
        self.assertTrue(spl.should_auto_apply_lease(["lease.dirty_or_missing"]))

    def test_campaign_only(self) -> None:
        self.assertFalse(spl.should_auto_apply_lease(["campaign.deadline_lt_6h"]))


class CommentRateLimitTest(unittest.TestCase):
    def test_none_not_limited(self) -> None:
        self.assertFalse(spl.comment_rate_limited(None))

    def test_recent_limited(self) -> None:
        now = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
        last = (now - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
        self.assertTrue(spl.comment_rate_limited(last, now, min_interval_sec=1800))

    def test_old_not_limited(self) -> None:
        now = datetime(2026, 8, 3, 12, 0, tzinfo=timezone.utc)
        last = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
        self.assertFalse(spl.comment_rate_limited(last, now, min_interval_sec=1800))


class RecipesAndDescriptionTest(unittest.TestCase):
    def test_recipes_include_harbor_reopen(self) -> None:
        recipes = spl.recommended_recipes_for(["campaign.deadline_lt_6h"])
        self.assertIn("harbor-campaign-reopen", recipes)

    def test_title_prefix(self) -> None:
        title = spl.build_residual_title(["campaign.deadline_lt_6h"], 2.0)
        self.assertTrue(title.startswith(spl.TITLE_PREFIX))

    def test_description_ops_format_not_implement_packet(self) -> None:
        desc = spl.build_residual_description(
            critical=["lease.dirty_or_missing"],
            warning=[],
            hours_remaining=20.0,
            preflight={"commissioned": True},
            recipes=["induct-lease-refresh"],
            fingerprint="abc",
        )
        self.assertIn("## Plane residual (ops — not product code work)", desc)
        self.assertIn("## Codes", desc)
        self.assertIn("## Recommended recipes", desc)
        self.assertIn("## Bounds", desc)
        self.assertIn("## Decision/Outcome", desc)
        self.assertIn("Do **not** page Zach", desc)
        self.assertIn("HEARTBEAT_SCHEDULER", desc)
        self.assertIn("induct-lease-refresh", desc)
        self.assertIn('"fingerprint": "abc"', desc)
        # Packet DoR implement sections must not appear as headings.
        self.assertNotRegex(desc, r"(?m)^##\s*Objective\s*$")
        self.assertNotRegex(desc, r"(?m)^##\s*Scope\s*$")
        self.assertNotRegex(desc, r"(?m)^##\s*Acceptance\s*$")
        # Avoid bare "implement" so looksImplementPacket stays false.
        self.assertNotRegex(desc, r"(?i)\bimplement\b")


if __name__ == "__main__":
    unittest.main()
