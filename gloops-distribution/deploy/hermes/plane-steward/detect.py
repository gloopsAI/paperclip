#!/usr/bin/env python3
"""Detect plane-steward signals from board/API/log evidence (C5).

Heuristic, fail-closed detector. Does not mutate state. Emits a JSON report of
matched signals and recommended recipe ids from recipes.json.

Inputs (any combination):
  --events-file PATH   JSON array or JSONL of event objects
  --log-file PATH      free-text log / journal lines
  --stdin              read JSON events from stdin
  --issue-json PATH    single issue snapshot (board GET)
  --run-json PATH      heartbeat-run snapshot

Environment (optional):
  PAPERCLIP_API_BASE   if set with --from-api, attempt GET /issues and /heartbeat-runs
  PAPERCLIP_API_TOKEN  bearer for API (never logged)

Exit codes:
  0  report printed (may be empty matches)
  2  usage / parse error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
RECIPES_PATH = HERE / "recipes.json"

UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.I,
)
SHA40_RE = re.compile(r"\b[0-9a-f]{40}\b")
CANCEL_LT_5S_RE = re.compile(
    r"(cancel(?:led|ation)?|durationMs|runtimeMs|elapsed).{0,40}\b([0-4](?:\.\d+)?)\s*s\b|"
    r"\bcancel(?:led)?\b.{0,20}\b([0-4]\d{0,3})\s*ms\b|"
    r"\"durationMs\"\s*:\s*([0-4]\d{0,3})\b",
    re.I,
)

# Map signal code -> recipe id (ordered preference).
SIGNAL_TO_RECIPE: list[tuple[str, str, re.Pattern[str] | None]] = [
    (
        "dirty_tree",
        "dirty-tree-clean",
        re.compile(
            r"workspace_admit\.dirty_tree|dirty[_ ]tree|workspace_validation_failed.{0,40}dirty|"
            r"uncommitted|untracked files|porcelain not clean",
            re.I,
        ),
    ),
    (
        "head_mismatch",
        "wrong-head-rebase",
        re.compile(
            r"workspace_admit\.head_mismatch|exact_head_mismatch|head[_ ]mismatch|"
            r"expected_head_not_full_sha|expected.{0,20}40.char|received.?main\b|"
            r"repoRef.{0,20}\bmain\b",
            re.I,
        ),
    ),
    (
        "acl_denied",
        "acl-fix",
        re.compile(
            r"workspace_admit\.cwd_not_readable|EACCES|permission denied|"
            r"acl[_ ]denied|uid.?995|not readable by (node|runner)",
            re.I,
        ),
    ),
    (
        "workspace_admit",
        "wrong-head-rebase",
        re.compile(r"workspace_admit\.(cwd_missing|cwd_not_git|workspace_not_found)", re.I),
    ),
    (
        "readmit_budget_required",
        "readmit-budget-bound-wake",
        re.compile(
            r"readmit_budget_required|resourceBudget|resource_budget|"
            r"backlog_bankruptcy|company_frozen",
            re.I,
        ),
    ),
    (
        "cancel_lt_5s",
        "readmit-budget-bound-wake",
        None,  # special-cased
    ),
    (
        "null_issueId",
        "null-issueId-wake-reject",
        re.compile(
            r"issueId[\"'=\s:]*null|payload\.issueId.{0,20}(missing|null|undefined)|"
            r"execution_admission\.issue_unbound|wakeup_missing_issueId|"
            r"naked.?wake|issue.unbound",
            re.I,
        ),
    ),
    (
        "heartbeat_scheduler_enabled",
        "never-enable-global-heartbeat-scheduler",
        re.compile(
            r"HEARTBEAT_SCHEDULER_ENABLED\s*=\s*true|heartbeat.?scheduler.?enabled.?true|"
            r"preflight_death_spiral",
            re.I,
        ),
    ),
    (
        "company_frozen_null_issue",
        "null-issueId-wake-reject",
        re.compile(
            r"company_frozen.{0,80}issueId.{0,20}null|issueId.{0,20}null.{0,80}company_frozen",
            re.I | re.S,
        ),
    ),
    (
        "campaign_deadline_imminent",
        "campaign-deadline-alert",
        re.compile(
            r"campaign\.deadline(?:_lt_\d+h)?|deadline_lt_\d+h|campaign_deadline_imminent|"
            r"hours_remaining.{0,20}[0-5](?:\.\d+)?|campaign epoch.{0,40}expir",
            re.I,
        ),
    ),
    (
        "harbor_campaign_reopen",
        "harbor-campaign-reopen",
        re.compile(
            r"harbor.?campaign.?reopen|campaign\.deadline_lt_6h|campaign\.missing_epoch|"
            r"standing.?harbor.?reopen|OPEN CAMPAIGN 24H",
            re.I,
        ),
    ),
    (
        "campaign_deadline_block",
        "sdlc-preflight-block",
        re.compile(
            r"campaign\.missing_epoch|sdlc\.plane_not_ok|sdlc-preflight-block|"
            r"induct_sdlc_preflight|PREFLIGHT_JSON.{\"ok\":false",
            re.I,
        ),
    ),
    (
        "induct_lease_stale",
        "induct-lease-refresh",
        re.compile(
            r"induct_lease_stale|lease\.dirty_or_missing|lease\.dirty|lease\.stale|"
            r"sdlc\.lease_dirty|sdlc\.lease_stale|verify-induct-lease|"
            r"DIRTY_TREE|VERIFY_INDUCT_LEASE",
            re.I,
        ),
    ),
    (
        "sdlc_preflight",
        "sdlc-preflight-check",
        re.compile(
            r"sdlc-preflight|verify-induct-sdlc-preflight|plane-status|"
            r"scheduler\.true|commissioned\.false|pin\.mismatch|induct_app\.not_ok",
            re.I,
        ),
    ),
]


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_recipes(path: Path = RECIPES_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _as_text(obj: Any) -> str:
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, sort_keys=True)
    except TypeError:
        return str(obj)


def _duration_ms(obj: dict[str, Any]) -> int | None:
    for key in ("durationMs", "runtimeMs", "elapsedMs", "cancelAfterMs"):
        value = obj.get(key)
        if isinstance(value, (int, float)) and value >= 0:
            return int(value)
    # startedAt / cancelledAt pair
    start = obj.get("startedAt") or obj.get("createdAt")
    end = obj.get("cancelledAt") or obj.get("endedAt") or obj.get("finishedAt")
    if isinstance(start, str) and isinstance(end, str):
        try:
            s = datetime.fromisoformat(start.replace("Z", "+00:00"))
            e = datetime.fromisoformat(end.replace("Z", "+00:00"))
            return max(0, int((e - s).total_seconds() * 1000))
        except ValueError:
            return None
    return None


def detect_cancel_lt_5s(text: str, obj: dict[str, Any] | None = None) -> bool:
    if obj is not None:
        ms = _duration_ms(obj)
        if ms is not None and ms < 5000:
            status = str(obj.get("status") or obj.get("outcome") or "").lower()
            if "cancel" in status or obj.get("cancelled") is True or "cancel" in text.lower():
                return True
            # short-lived failed recovery thrash also matches backlog signal
            if ms < 5000 and any(
                token in text.lower()
                for token in ("cancel", "recovery", "missing_disposition", "workspace_admit")
            ):
                return True
    if CANCEL_LT_5S_RE.search(text):
        return True
    # explicit "cancel in 1s" narrative
    if re.search(r"cancel(?:led)?\s+(?:in\s+)?[0-4](?:\.\d+)?\s*s\b", text, re.I):
        return True
    return False


def extract_issue_id(obj: dict[str, Any] | None, text: str) -> str | None:
    if obj:
        for key in ("issueId", "issue_id", "id", "workItemId"):
            value = obj.get(key)
            if isinstance(value, str) and UUID_RE.fullmatch(value):
                # Prefer explicit issueId keys over generic id when present
                if key in ("issueId", "issue_id", "workItemId"):
                    return value.lower()
        payload = obj.get("payload")
        if isinstance(payload, dict):
            value = payload.get("issueId") or payload.get("issue_id")
            if isinstance(value, str) and UUID_RE.fullmatch(value):
                return value.lower()
            if value is None and "issueId" in payload:
                return None  # explicit null
        # fall back to top-level id if uuid-shaped
        top = obj.get("id")
        if isinstance(top, str) and UUID_RE.fullmatch(top):
            return top.lower()
    match = UUID_RE.search(text)
    return match.group(0).lower() if match else None


def issue_id_is_null(obj: dict[str, Any] | None, text: str) -> bool:
    if obj:
        payload = obj.get("payload")
        if isinstance(payload, dict) and "issueId" in payload and payload.get("issueId") in (
            None,
            "",
        ):
            return True
        if obj.get("issueId") in (None, "") and (
            obj.get("kind") in ("wakeup", "invoke", "heartbeat")
            or "wakeup" in _as_text(obj).lower()
        ):
            return True
    if re.search(r"issueId[\"'=\s:]*null", text, re.I):
        return True
    if re.search(r"payload\.issueId.{0,20}(missing|null|undefined)", text, re.I):
        return True
    return False


def detect_in_text(text: str, obj: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(signal: str, recipe_id: str, detail: str, confidence: str = "heuristic") -> None:
        key = f"{signal}:{recipe_id}"
        if key in seen:
            return
        seen.add(key)
        matches.append(
            {
                "signal": signal,
                "recipeId": recipe_id,
                "detail": detail[:500],
                "confidence": confidence,
                "issueId": extract_issue_id(obj, text),
            }
        )

    # Special: cancel < 5s
    if detect_cancel_lt_5s(text, obj):
        add("cancel_lt_5s", "readmit-budget-bound-wake", "cancel or run duration < 5s")

    # Special: null issueId (prefer over generic company_frozen thrash)
    if issue_id_is_null(obj, text):
        add(
            "null_issueId",
            "null-issueId-wake-reject",
            "wake/invoke missing payload.issueId — do not thrash company unfreeze",
            confidence="high",
        )
        # If company_frozen also present, annotate dual signal but keep null recipe primary
        if re.search(r"company_frozen|backlog_bankruptcy", text, re.I):
            add(
                "company_frozen_null_issue",
                "null-issueId-wake-reject",
                "company_frozen with null issueId is often a false surface; re-issue bound wake",
                confidence="high",
            )

    for signal, recipe_id, pattern in SIGNAL_TO_RECIPE:
        if signal in ("cancel_lt_5s", "null_issueId", "company_frozen_null_issue"):
            continue
        if pattern is None:
            continue
        m = pattern.search(text)
        if m:
            add(signal, recipe_id, m.group(0))

    # Structured errorCode on run objects
    if obj:
        error_code = obj.get("errorCode") or obj.get("reasonCode") or obj.get("code")
        if isinstance(error_code, str):
            code = error_code.lower()
            if "dirty_tree" in code or code.endswith("dirty_tree"):
                add("dirty_tree", "dirty-tree-clean", error_code, "high")
            if "head_mismatch" in code or "expected_head" in code:
                add("head_mismatch", "wrong-head-rebase", error_code, "high")
            if "cwd_not_readable" in code or "acl" in code:
                add("acl_denied", "acl-fix", error_code, "high")
            if "readmit_budget" in code or "resource_budget" in code:
                add("readmit_budget_required", "readmit-budget-bound-wake", error_code, "high")
            if "issue_unbound" in code:
                add("null_issueId", "null-issueId-wake-reject", error_code, "high")
            if code.startswith("workspace_admit."):
                add("workspace_admit", "wrong-head-rebase", error_code, "high")
            if "lease" in code or "dirty_or_missing" in code:
                add("induct_lease_stale", "induct-lease-refresh", error_code, "high")
            if "deadline" in code or code.startswith("campaign."):
                add("campaign_deadline_imminent", "campaign-deadline-alert", error_code, "high")
            if code.startswith("sdlc.") or code in (
                "scheduler.true",
                "commissioned.false",
                "pin.mismatch",
                "induct_app.not_ok",
            ):
                add("sdlc_preflight", "sdlc-preflight-check", error_code, "high")

    return matches


def detect_events(events: list[Any]) -> list[dict[str, Any]]:
    all_matches: list[dict[str, Any]] = []
    for event in events:
        if isinstance(event, dict):
            text = _as_text(event)
            all_matches.extend(detect_in_text(text, event))
        elif isinstance(event, str):
            all_matches.extend(detect_in_text(event, None))
    return _dedupe(all_matches)


def _dedupe(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for m in matches:
        key = f"{m['signal']}:{m['recipeId']}:{m.get('issueId')}"
        if key in seen:
            continue
        seen.add(key)
        out.append(m)
    return out


def load_json_or_jsonl(path: Path) -> list[Any]:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return []
    if path.suffix == ".jsonl" or "\n" in raw and not raw.lstrip().startswith("["):
        events: list[Any] = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                events.append(line)
        return events
    data = json.loads(raw)
    if isinstance(data, list):
        return data
    return [data]


def fetch_api_events(base: str, token: str | None) -> list[Any]:
    """Best-effort pull of recent issues/runs. Failures become empty with error notes."""
    events: list[Any] = []
    headers = {"Accept": "application/json", "User-Agent": "plane-steward-detect/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for path in ("/api/issues?limit=50", "/api/heartbeat-runs?limit=50", "/issues?limit=50"):
        url = base.rstrip("/") + path
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            if isinstance(payload, list):
                events.extend(payload)
            elif isinstance(payload, dict):
                for key in ("items", "data", "issues", "runs", "results"):
                    if isinstance(payload.get(key), list):
                        events.extend(payload[key])
                        break
                else:
                    events.append(payload)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError):
            continue
    return events


def build_report(matches: list[dict[str, Any]], sources: list[str]) -> dict[str, Any]:
    recipe_ids = sorted({m["recipeId"] for m in matches})
    return {
        "ok": True,
        "ts": timestamp(),
        "schemaVersion": "gloops.plane-steward.detect.v1",
        "sources": sources,
        "matchCount": len(matches),
        "matches": matches,
        "recommendedRecipes": recipe_ids,
        "notes": [
            "Detector is heuristic; operator/Sentinel must confirm before --apply.",
            "Prefer heartbeat-run errorCode over UI company_frozen text (W8).",
            "null issueId → null-issueId-wake-reject, not whole-company unfreeze.",
            "HEARTBEAT_SCHEDULER must stay false under controlled-swarm.",
        ],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--events-file", type=Path, help="JSON array or JSONL events")
    p.add_argument("--log-file", type=Path, help="Free-text log file")
    p.add_argument("--issue-json", type=Path, help="Single issue JSON snapshot")
    p.add_argument("--run-json", type=Path, help="Heartbeat-run JSON snapshot")
    p.add_argument("--stdin", action="store_true", help="Read JSON events from stdin")
    p.add_argument(
        "--from-api",
        action="store_true",
        help="Pull recent issues/runs from PAPERCLIP_API_BASE",
    )
    p.add_argument(
        "--recipes",
        type=Path,
        default=RECIPES_PATH,
        help="Path to recipes.json (validated for recommended ids)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    sources: list[str] = []
    events: list[Any] = []

    try:
        recipes = load_recipes(args.recipes)
        known = {r["id"] for r in recipes.get("recipes", [])}
    except (OSError, json.JSONDecodeError, KeyError) as error:
        print(json.dumps({"ok": False, "error": f"recipes load failed: {error}"}), file=sys.stderr)
        return 2

    if args.events_file:
        events.extend(load_json_or_jsonl(args.events_file))
        sources.append(str(args.events_file))
    if args.issue_json:
        events.append(json.loads(args.issue_json.read_text(encoding="utf-8")))
        sources.append(str(args.issue_json))
    if args.run_json:
        events.append(json.loads(args.run_json.read_text(encoding="utf-8")))
        sources.append(str(args.run_json))
    if args.log_file:
        events.append(args.log_file.read_text(encoding="utf-8", errors="replace"))
        sources.append(str(args.log_file))
    if args.stdin:
        raw = sys.stdin.read()
        if raw.strip():
            try:
                data = json.loads(raw)
                events.extend(data if isinstance(data, list) else [data])
            except json.JSONDecodeError:
                events.append(raw)
        sources.append("stdin")
    if args.from_api:
        base = os.environ.get("PAPERCLIP_API_BASE", "").strip()
        token = os.environ.get("PAPERCLIP_API_TOKEN")
        if not base:
            print(
                json.dumps({"ok": False, "error": "PAPERCLIP_API_BASE required for --from-api"}),
                file=sys.stderr,
            )
            return 2
        events.extend(fetch_api_events(base, token))
        sources.append(f"api:{base}")

    if not sources:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "provide --events-file, --log-file, --issue-json, --run-json, --stdin, or --from-api",
                }
            ),
            file=sys.stderr,
        )
        return 2

    matches = detect_events(events)
    # Drop recommendations for unknown recipe ids (fail closed on catalog drift)
    for m in matches:
        if m["recipeId"] not in known:
            m["recipeId"] = "UNKNOWN"
            m["detail"] = f"recipe not in catalog: {m['detail']}"

    report = build_report(matches, sources)
    print(json.dumps(report, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
