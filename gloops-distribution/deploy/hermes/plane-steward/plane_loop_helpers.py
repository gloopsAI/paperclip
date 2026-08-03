"""Pure helpers for Sentinel/Harbor plane loops (unit-tested; no host I/O)."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

TITLE_PREFIX = "[Sentinel/Plane]"
HARBOR_TITLE_MARKERS = ("[Harbor/Campaign]", "[Sentinel/Plane]")

CAMPAIGN_CODE_PREFIXES = ("campaign.",)
HARBOR_CODES = frozenset(
    {
        "pin.mismatch",
        "commissioned.false",
        "campaign.deadline_lt_6h",
        "campaign.deadline_lt_12h",
        "campaign.missing_epoch",
    }
)
LEASE_AUTO_APPLY_CODES = frozenset(
    {
        "lease.dirty_or_missing",
        "lease.dirty",
        "lease.stale",
        "induct_lease_stale",
        "workspace_admit.head_mismatch",
        "workspace_admit.dirty_tree",
    }
)

OPEN_STATUSES = frozenset(
    {"todo", "in_progress", "blocked", "backlog", "open", "ready", "queued"}
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ts() -> str:
    return utc_now().isoformat().replace("+00:00", "Z")


def parse_hours(value: Any) -> float | None:
    """Parse hours-remaining from preflight / env; None if missing/unparseable."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def fingerprint_codes(
    critical: list[str],
    warning: list[str] | None = None,
    *,
    hours_remaining: float | None = None,
    residual_hours_threshold: float = 12.0,
) -> str:
    """Stable fingerprint of residual-driving plane state."""
    codes: set[str] = {c for c in critical if c}
    for w in warning or []:
        if w and (w.startswith("campaign.") or w in HARBOR_CODES):
            codes.add(w)
    if hours_remaining is not None and hours_remaining < residual_hours_threshold:
        if hours_remaining <= 0:
            bucket = "expired"
        elif hours_remaining < 6:
            bucket = "lt6"
        else:
            bucket = "lt12"
        codes.add(f"campaign.hours_bucket:{bucket}")
    ordered = sorted(codes)
    raw = "|".join(ordered) if ordered else "green"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return f"{digest}:{raw}"


def needs_residual(
    critical: list[str],
    hours_remaining: float | None,
    *,
    residual_hours_threshold: float = 12.0,
) -> bool:
    if critical:
        return True
    if hours_remaining is not None and hours_remaining < residual_hours_threshold:
        return True
    return False


def assignee_for_codes(critical: list[str], warning: list[str] | None = None) -> str:
    """Return role key: 'harbor' or 'sentinel'."""
    codes = list(critical) + list(warning or [])
    for c in codes:
        if any(c.startswith(p) for p in CAMPAIGN_CODE_PREFIXES):
            return "harbor"
        if c in HARBOR_CODES:
            return "harbor"
    return "sentinel"


def should_auto_apply_lease(critical: list[str], warning: list[str] | None = None) -> bool:
    codes = set(critical) | set(warning or [])
    return bool(codes & LEASE_AUTO_APPLY_CODES)


def comment_rate_limited(
    last_comment_at: str | None,
    now: datetime | None = None,
    *,
    min_interval_sec: int = 1800,
) -> bool:
    """True if a comment was posted too recently (rate-limit active)."""
    if not last_comment_at:
        return False
    now = now or utc_now()
    try:
        prev = datetime.fromisoformat(last_comment_at.replace("Z", "+00:00"))
        if prev.tzinfo is None:
            prev = prev.replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    return (now - prev.astimezone(timezone.utc)).total_seconds() < min_interval_sec


def recommended_recipes_for(critical: list[str], warning: list[str] | None = None) -> list[str]:
    codes = set(critical) | set(warning or [])
    out: list[str] = []
    if codes & LEASE_AUTO_APPLY_CODES:
        out.append("induct-lease-refresh")
    if any(c.startswith("campaign.") for c in codes):
        out.append("harbor-campaign-reopen")
        out.append("campaign-deadline-alert")
    if "pin.mismatch" in codes or "commissioned.false" in codes:
        out.append("sdlc-preflight-check")
        if "pin.mismatch" in codes or any(c.startswith("campaign.") for c in codes):
            if "harbor-campaign-reopen" not in out:
                out.append("harbor-campaign-reopen")
    if any(
        c in codes
        for c in (
            "scheduler.true",
            "paperclip.unhealthy",
            "hermes.unhealthy",
            "induct_app.not_ok",
        )
    ):
        out.append("sdlc-preflight-check")
    if not out:
        out.append("sdlc-preflight-check")
    seen: set[str] = set()
    ordered: list[str] = []
    for r in out:
        if r not in seen:
            seen.add(r)
            ordered.append(r)
    return ordered


def build_residual_description(
    *,
    critical: list[str],
    warning: list[str],
    hours_remaining: float | None,
    preflight: dict[str, Any],
    recipes: list[str],
    fingerprint: str,
) -> str:
    codes_payload = {
        "criticalCodes": critical,
        "warningCodes": warning,
        "hoursRemaining": hours_remaining,
        "fingerprint": fingerprint,
        "campaign": preflight.get("campaign"),
        "commissioned": preflight.get("commissioned"),
        "schedulerEnabled": preflight.get("schedulerEnabled"),
    }
    return (
        "## Objective\n"
        "Restore Induct SDLC plane preflight to green without paging Zach.\n\n"
        "## Scope\n"
        "- Host plane probes (campaign epoch, lease, pin, commission, health)\n"
        "- Residual is owned by Harbor for campaign.* / pin / commission;\n"
        "  Sentinel for other critical plane codes\n"
        "- Sentinel may auto-apply **only** induct-lease-refresh when allowlisted\n"
        "- Harbor reopens campaigns via standing auth (never per-event Zach phrase)\n\n"
        "## Acceptance\n"
        "- `verify-induct-sdlc-preflight.sh` exits 0 with empty criticalCodes\n"
        "- Campaign hours remaining ≥ 12 (or residual cancelled as plane-green)\n"
        "- Receipt written under plane-steward state dir\n\n"
        "## Exact codes\n"
        "```json\n"
        f"{json.dumps(codes_payload, indent=2, sort_keys=True)}\n"
        "```\n\n"
        "## Recommended recipes\n"
        + "".join(f"- `{r}`\n" for r in recipes)
        + "\n"
        "## Hard bounds\n"
        "- Do **not** page Zach for happy-path plane babysitting\n"
        "- Do **not** enable HEARTBEAT_SCHEDULER\n"
        "- Do **not** multi-UUID READMIT\n"
        "- Do **not** open campaigns from Sentinel (Harbor only)\n"
    )


def build_residual_title(critical: list[str], hours_remaining: float | None) -> str:
    if any(c.startswith("campaign.") for c in critical) or (
        hours_remaining is not None and hours_remaining < 12
    ):
        detail = "campaign deadline / epoch"
    elif "lease.dirty_or_missing" in critical:
        detail = "induct lease dirty"
    elif "pin.mismatch" in critical:
        detail = "pin mismatch"
    elif "commissioned.false" in critical:
        detail = "not commissioned"
    elif critical:
        detail = critical[0]
    else:
        detail = "plane degraded"
    return f"{TITLE_PREFIX} {detail}"
