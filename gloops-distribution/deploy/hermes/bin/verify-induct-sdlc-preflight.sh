#!/usr/bin/env bash
# S0 — Induct SDLC host preflight (fail-closed for critical plane law).
#
# Exit 0 only when no critical codes fail. Warnings alone still exit 0.
# Last stdout line: PREFLIGHT_JSON={...}
# Best-effort write: /var/lib/paperclip-gloops/sdlc-preflight/last.json (root)
#
# Env:
#   SDLC_PREFLIGHT_MIN_CAMPAIGN_HOURS  default 6
#   SDLC_PREFLIGHT_LEASE_CWD           default induct-main path
#   PAPERCLIP_* from /etc/paperclip-gloops/runtime.env when present
set -uo pipefail

RUNTIME_ENV="${PAPERCLIP_RUNTIME_ENV:-/etc/paperclip-gloops/runtime.env}"
if [[ -f "$RUNTIME_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source "$RUNTIME_ENV" 2>/dev/null || true
  set +a
fi

MIN_HOURS="${SDLC_PREFLIGHT_MIN_CAMPAIGN_HOURS:-6}"
WARN_HOURS="${SDLC_PREFLIGHT_WARN_CAMPAIGN_HOURS:-12}"
LEASE_CWD="${SDLC_PREFLIGHT_LEASE_CWD:-/opt/paperclip/hermes-execution-state/workspace/induct-main}"
CAMPAIGN_DIR="${PAPERCLIP_CAMPAIGN_DEADMAN_DIR:-/var/lib/paperclip-gloops/campaign-deadman}"
APPROVED_IMAGE_FILE="${PAPERCLIP_HOSTCTL_APPROVED_IMAGE:-/etc/paperclip-gloops/approved-image}"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
INDUCT_APP_BIN="${INDUCT_GITHUB_APP_BIN:-/usr/local/lib/paperclip-gloops/bin/induct-github-app.py}"
VERIFY_LEASE_BIN="${VERIFY_INDUCT_LEASE_BIN:-/usr/local/lib/paperclip-gloops/bin/verify-induct-lease.sh}"
_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -x "$VERIFY_LEASE_BIN" && ! -f "$VERIFY_LEASE_BIN" ]]; then
  if [[ -f "${_self_dir}/verify-induct-lease.sh" ]]; then
    VERIFY_LEASE_BIN="${_self_dir}/verify-induct-lease.sh"
  fi
fi
if [[ ! -x "$INDUCT_APP_BIN" && ! -f "$INDUCT_APP_BIN" ]]; then
  if [[ -f "${_self_dir}/induct-github-app.py" ]]; then
    INDUCT_APP_BIN="${_self_dir}/induct-github-app.py"
  fi
fi
PREFLIGHT_STATE_DIR="${SDLC_PREFLIGHT_STATE_DIR:-/var/lib/paperclip-gloops/sdlc-preflight}"

critical_codes=()
warning_codes=()

note() {
  echo "$1"
}

add_critical() {
  critical_codes+=("$1")
  note "CRITICAL $1${2:+ — $2}"
}

add_warning() {
  warning_codes+=("$1")
  note "WARN $1${2:+ — $2}"
}

is_true() {
  local v
  v="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ "$v" == "true" || "$v" == "1" || "$v" == "yes" ]]
}

codes_json() {
  # Encode bash array as JSON string list; empty -> []
  if [[ "$#" -eq 0 ]]; then
    printf '[]'
    return
  fi
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"
}

read_deadline_from_epoch() {
  local path="$1"
  python3 -c 'import json,sys; e=json.load(open(sys.argv[1])); print(e.get("deadlineAt") or "")' "$path" 2>/dev/null || true
}

hours_until() {
  local iso="$1"
  python3 -c '
import sys
from datetime import datetime, timezone
raw = sys.argv[1].strip()
dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
print(f"{(dt - now).total_seconds() / 3600.0:.4f}")
' "$iso" 2>/dev/null || true
}

# --- campaign epoch / deadline ---
campaign_id="${PAPERCLIP_CAMPAIGN_ID:-}"
commissioned="${PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED:-false}"
deadline_iso=""
hours_remaining=""
epoch_path=""

find_epoch() {
  if [[ -n "$campaign_id" && -f "${CAMPAIGN_DIR}/${campaign_id}/epoch.json" ]]; then
    echo "${CAMPAIGN_DIR}/${campaign_id}/epoch.json"
    return 0
  fi
  local cand
  if [[ -n "$campaign_id" && -d "$CAMPAIGN_DIR" ]]; then
    for cand in "${CAMPAIGN_DIR}"/controlled-swarm-repair-cell-*/epoch.json; do
      [[ -f "$cand" ]] || continue
      if grep -Fq "\"campaignId\":\"${campaign_id}\"" "$cand" 2>/dev/null \
        || grep -Fq "\"campaignId\": \"${campaign_id}\"" "$cand" 2>/dev/null; then
        echo "$cand"
        return 0
      fi
    done
  fi
  for cand in "${CAMPAIGN_DIR}"/controlled-swarm-repair-cell-*/epoch.json; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

if epoch_path="$(find_epoch)"; then
  note "epoch_path=$epoch_path"
  deadline_iso="$(read_deadline_from_epoch "$epoch_path")"
elif [[ -n "${PAPERCLIP_CAMPAIGN_DEADLINE_AT:-}" ]]; then
  deadline_iso="${PAPERCLIP_CAMPAIGN_DEADLINE_AT}"
  note "deadline from PAPERCLIP_CAMPAIGN_DEADLINE_AT"
fi

if [[ -z "$deadline_iso" ]]; then
  if is_true "$commissioned"; then
    add_critical "campaign.missing_epoch" "commissioned=true but no epoch/deadline"
  else
    note "campaign.epoch=absent (commissioned=false - ok)"
  fi
else
  hours_remaining="$(hours_until "$deadline_iso")"
  if [[ -z "$hours_remaining" ]]; then
    add_critical "campaign.missing_epoch" "unparseable deadlineAt=$deadline_iso"
  else
    note "campaign.hours_remaining=$hours_remaining deadline=$deadline_iso"
    if python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$hours_remaining" "$MIN_HOURS"; then
      if python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= 0 else 1)" "$hours_remaining"; then
        add_critical "campaign.deadline_lt_6h" "hours_remaining=$hours_remaining (<=0 expired)"
      else
        add_critical "campaign.deadline_lt_6h" "hours_remaining=$hours_remaining < min=$MIN_HOURS"
      fi
    elif python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) < float(sys.argv[2]) else 1)" "$hours_remaining" "$WARN_HOURS"; then
      add_warning "campaign.deadline_lt_12h" "hours_remaining=$hours_remaining < warn=$WARN_HOURS"
    fi
  fi
fi

# --- scheduler must stay false under controlled swarm / Induct preflight law ---
scheduler_raw="${HEARTBEAT_SCHEDULER_ENABLED:-${PAPERCLIP_CONTROLLED_SWARM_SCHEDULER_ENABLED:-false}}"
if is_true "$scheduler_raw"; then
  add_critical "scheduler.true" "HEARTBEAT_SCHEDULER_ENABLED or swarm scheduler is true"
else
  note "scheduler.enabled=false (ok)"
fi

# --- commissioned when controlled swarm expected ---
expect_swarm=false
if is_true "${PAPERCLIP_CONTROLLED_SWARM_EXPECTED:-}"; then
  expect_swarm=true
fi
if [[ -n "$campaign_id" ]]; then
  expect_swarm=true
fi
if [[ "$expect_swarm" == "true" ]] && ! is_true "$commissioned"; then
  add_critical "commissioned.false" "controlled swarm expected but PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED!=true"
else
  note "commissioned=$commissioned expect_swarm=$expect_swarm"
fi

# --- paperclip/hermes health via loopback health ---
if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  note "health.probe=ok url=$HEALTH_URL"
else
  health_code=$?
  add_critical "paperclip.unhealthy" "curl $HEALTH_URL failed (rc=$health_code)"
  add_critical "hermes.unhealthy" "shared health endpoint unreachable (proxy for hermes/paperclip plane)"
fi

# --- induct github app status (if present) ---
if [[ -f "$INDUCT_APP_BIN" ]]; then
  if ! python3 "$INDUCT_APP_BIN" status >/dev/null 2>&1; then
    add_critical "induct_app.not_ok" "induct-github-app.py status failed"
  else
    note "induct_app.status=ok"
  fi
else
  note "induct_app.bin=absent (skip)"
fi

# --- lease ---
if [[ -f "$VERIFY_LEASE_BIN" ]]; then
  if ! bash "$VERIFY_LEASE_BIN" "$LEASE_CWD" >/dev/null 2>&1; then
    add_critical "lease.dirty_or_missing" "verify-induct-lease.sh failed cwd=$LEASE_CWD"
  else
    note "lease.ok cwd=$LEASE_CWD"
  fi
else
  if [[ ! -d "$LEASE_CWD/.git" ]]; then
    add_critical "lease.dirty_or_missing" "lease cwd missing or not git: $LEASE_CWD"
  else
    porcelain="$(git -C "$LEASE_CWD" status --porcelain 2>/dev/null || echo DIRTY)"
    if [[ -n "$porcelain" ]]; then
      add_critical "lease.dirty_or_missing" "dirty porcelain on $LEASE_CWD"
    else
      note "lease.ok (structural) cwd=$LEASE_CWD"
    fi
  fi
fi

# --- pin mismatch: approved-image vs PAPERCLIP_IMAGE ---
pin_image="${PAPERCLIP_IMAGE:-}"
approved_image=""
if [[ -f "$APPROVED_IMAGE_FILE" ]]; then
  approved_image="$(tr -d '[:space:]' < "$APPROVED_IMAGE_FILE" || true)"
fi
if [[ -n "$pin_image" && -n "$approved_image" && "$pin_image" != "$approved_image" ]]; then
  add_critical "pin.mismatch" "PAPERCLIP_IMAGE != approved-image"
else
  note "pin.image=${pin_image:-unset} approved=${approved_image:-unset}"
fi

ok=true
if ((${#critical_codes[@]} > 0)); then
  ok=false
fi

export _OK="$ok"
export _CRIT
export _WARN
_CRIT="$(codes_json "${critical_codes[@]+"${critical_codes[@]}"}")"
_WARN="$(codes_json "${warning_codes[@]+"${warning_codes[@]}"}")"
export _CRIT _WARN
export _CID="$campaign_id"
export _DDL="$deadline_iso"
export _HRS="$hours_remaining"
export _EP="$epoch_path"
export _COMM="$commissioned"
export _SCHED="$scheduler_raw"
export _PIN="$pin_image"
export _APP="$approved_image"
export _LEASE="$LEASE_CWD"
export _HURL="$HEALTH_URL"

PREFLIGHT_JSON="$(
  python3 -c '
import json, os
critical = json.loads(os.environ.get("_CRIT") or "[]")
warning = json.loads(os.environ.get("_WARN") or "[]")
# drop accidental empties
critical = [c for c in critical if c]
warning = [c for c in warning if c]
hrs = os.environ.get("_HRS") or ""
payload = {
    "schemaVersion": "gloops.sdlc-preflight.v1",
    "ok": os.environ.get("_OK", "false") == "true",
    "codes": critical + warning,
    "criticalCodes": critical,
    "warningCodes": warning,
    "campaign": {
        "id": os.environ.get("_CID") or None,
        "deadlineAt": os.environ.get("_DDL") or None,
        "hoursRemaining": float(hrs) if hrs not in ("", None) else None,
        "epochPath": os.environ.get("_EP") or None,
    },
    "commissioned": (os.environ.get("_COMM") or "false").strip().lower() in ("true", "1", "yes"),
    "schedulerEnabled": (os.environ.get("_SCHED") or "false").strip().lower() in ("true", "1", "yes"),
    "pinImage": os.environ.get("_PIN") or None,
    "approvedImage": os.environ.get("_APP") or None,
    "leaseCwd": os.environ.get("_LEASE") or None,
    "healthUrl": os.environ.get("_HURL") or None,
}
print(json.dumps(payload, separators=(",", ":")))
'
)"

echo "PREFLIGHT_JSON=${PREFLIGHT_JSON}"

# Best-effort persist when root
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  mkdir -p "$PREFLIGHT_STATE_DIR" 2>/dev/null || true
  if [[ -d "$PREFLIGHT_STATE_DIR" ]]; then
    printf '%s\n' "$PREFLIGHT_JSON" > "${PREFLIGHT_STATE_DIR}/last.json" 2>/dev/null || true
    chmod 0644 "${PREFLIGHT_STATE_DIR}/last.json" 2>/dev/null || true
  fi
fi

if [[ "$ok" == "true" ]]; then
  exit 0
fi
exit 1
