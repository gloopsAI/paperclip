#!/usr/bin/env bash
# Export PAPERCLIP_CAMPAIGN_DEADLINE_AT from campaign epoch into runtime.env.
#
# Server-side SDLC gates (S1) only see env; host epoch lives under
# /var/lib/paperclip-gloops/campaign-deadman/<id>/epoch.json. After arming an
# epoch (operator-owned open-campaign / deadman first admit), operators may run:
#
#   sudo export-campaign-deadline-to-runtime.sh
#
# This never opens or renews a campaign. Agents must not invoke hostctl bulk.
set -euo pipefail

RUNTIME_ENV="${PAPERCLIP_RUNTIME_ENV:-/etc/paperclip-gloops/runtime.env}"
CAMPAIGN_DIR="${PAPERCLIP_CAMPAIGN_DEADMAN_DIR:-/var/lib/paperclip-gloops/campaign-deadman}"

if [[ ! -f "$RUNTIME_ENV" ]]; then
  echo "missing $RUNTIME_ENV" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
# shellcheck source=/dev/null
source "$RUNTIME_ENV" 2>/dev/null || true
set +a

campaign_id="${PAPERCLIP_CAMPAIGN_ID:-}"
epoch=""
if [[ -n "$campaign_id" && -f "${CAMPAIGN_DIR}/${campaign_id}/epoch.json" ]]; then
  epoch="${CAMPAIGN_DIR}/${campaign_id}/epoch.json"
else
  for cand in "${CAMPAIGN_DIR}"/controlled-swarm-repair-cell-*/epoch.json; do
    if [[ -f "$cand" ]]; then
      epoch="$cand"
      break
    fi
  done
fi

if [[ -z "$epoch" || ! -f "$epoch" ]]; then
  echo "no epoch.json found under $CAMPAIGN_DIR" >&2
  exit 1
fi

deadline="$(python3 - <<PY
import json
e=json.load(open("$epoch"))
print(e.get("deadlineAt") or "")
PY
)"

if [[ -z "$deadline" ]]; then
  echo "epoch missing deadlineAt: $epoch" >&2
  exit 1
fi

tmp="$(mktemp)"
if grep -q '^PAPERCLIP_CAMPAIGN_DEADLINE_AT=' "$RUNTIME_ENV"; then
  sed "s|^PAPERCLIP_CAMPAIGN_DEADLINE_AT=.*|PAPERCLIP_CAMPAIGN_DEADLINE_AT=${deadline}|" "$RUNTIME_ENV" >"$tmp"
else
  cat "$RUNTIME_ENV" >"$tmp"
  printf '\nPAPERCLIP_CAMPAIGN_DEADLINE_AT=%s\n' "$deadline" >>"$tmp"
fi
# Prefer install when root for ownership; else rewrite in place for tests.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  install -o root -g root -m 0644 "$tmp" "$RUNTIME_ENV"
else
  cp "$tmp" "$RUNTIME_ENV"
fi
rm -f "$tmp"
echo "set PAPERCLIP_CAMPAIGN_DEADLINE_AT=$deadline from $epoch"
