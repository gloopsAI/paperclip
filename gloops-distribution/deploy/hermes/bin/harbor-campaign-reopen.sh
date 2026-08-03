#!/usr/bin/env bash
# Harbor campaign reopen — residual-driven wrapper around open-campaign-24h.
#
# Usage:
#   harbor-campaign-reopen.sh --status
#   harbor-campaign-reopen.sh --dry-run
#   harbor-campaign-reopen.sh --execute --confirm-execute [--issue-id UUID]
#
# Requires standing Harbor authorization (not per-event Zach phrase typing):
#   /var/lib/paperclip-gloops/campaign-deadman/standing/harbor-reopen-authorized.json
#
# Authority bounds:
#   - Harbor duty only (not Sentinel)
#   - phrase comes from standing auth file
#   - maxAutoReopensPerDay from standing auth (default 2)
#   - never enable HEARTBEAT_SCHEDULER / multi-UUID READMIT
set -euo pipefail

MODE=""
CONFIRM=0
ISSUE_ID=""
FORCE=0

RUNTIME_ENV="${PAPERCLIP_RUNTIME_ENV:-/etc/paperclip-gloops/runtime.env}"
CAMPAIGN_DIR="${PAPERCLIP_CAMPAIGN_DEADMAN_DIR:-/var/lib/paperclip-gloops/campaign-deadman}"
STANDING_AUTH="${HARBOR_REOPEN_STANDING_AUTH:-${CAMPAIGN_DIR}/standing/harbor-reopen-authorized.json}"
OPEN_CAMPAIGN_BIN="${OPEN_CAMPAIGN_24H_BIN:-/usr/local/lib/paperclip-gloops/tools/open-campaign-24h.sh}"
EXPORT_DEADLINE_BIN="${EXPORT_CAMPAIGN_DEADLINE_BIN:-/usr/local/lib/paperclip-gloops/bin/export-campaign-deadline-to-runtime.sh}"
APPROVED_IMAGE_FILE="${PAPERCLIP_HOSTCTL_APPROVED_IMAGE:-/etc/paperclip-gloops/approved-image}"
SUPERVISOR_CLOSURE="${SUPERVISOR_OPERATIONAL_CLOSURE:-/var/lib/paperclip-gloops/supervisor-operational-closure.json}"
RECEIPT_DIR="${HARBOR_REOPEN_RECEIPT_DIR:-${CAMPAIGN_DIR}/receipts}"
COUNTER_FILE="${HARBOR_REOPEN_COUNTER:-${CAMPAIGN_DIR}/standing/harbor-reopen-counter.json}"
API="${PAPERCLIP_API:-http://127.0.0.1:3100}"
if [[ "$API" == */api ]]; then
  API_BASE="$API"
else
  API_BASE="${API}/api"
fi
TOKEN_FILE="${PAPERCLIP_BOARD_TOKEN_FILE:-/etc/paperclip-gloops/operator-board-token}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-89ed0964-d918-4fcc-b830-5be49d2d4089}"
NOT_NEEDED_HOURS="${HARBOR_REOPEN_NOT_NEEDED_HOURS:-6}"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) MODE=status; shift ;;
    --dry-run) MODE=dry-run; shift ;;
    --execute) MODE=execute; shift ;;
    --confirm-execute) CONFIRM=1; shift ;;
    --issue-id) ISSUE_ID="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

if [[ -z "$MODE" ]]; then
  usage
fi

if [[ -f "$RUNTIME_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source "$RUNTIME_ENV" 2>/dev/null || true
  set +a
fi

ts() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

board_token() {
  if [[ -n "${PAPERCLIP_TOKEN:-}${PAPERCLIP_BOARD_TOKEN:-}" ]]; then
    printf '%s' "${PAPERCLIP_TOKEN:-${PAPERCLIP_BOARD_TOKEN:-}}"
    return 0
  fi
  if [[ -f "$TOKEN_FILE" ]]; then
    tr -d '[:space:]' <"$TOKEN_FILE"
    return 0
  fi
  echo "no board token at $TOKEN_FILE" >&2
  return 1
}

api() {
  local method="$1" path="$2" body="${3:-}"
  local url
  if [[ "$path" == http* ]]; then
    url="$path"
  else
    url="${API_BASE}${path}"
  fi
  local tok
  tok="$(board_token)"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$url" \
      -H "Authorization: Bearer ${tok}" \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -fsS -X "$method" "$url" \
      -H "Authorization: Bearer ${tok}" \
      -H "Accept: application/json"
  fi
}

find_epoch() {
  local campaign_id="${PAPERCLIP_CAMPAIGN_ID:-}"
  if [[ -n "$campaign_id" && -f "${CAMPAIGN_DIR}/${campaign_id}/epoch.json" ]]; then
    echo "${CAMPAIGN_DIR}/${campaign_id}/epoch.json"
    return 0
  fi
  local cand
  for cand in "${CAMPAIGN_DIR}"/controlled-swarm-repair-cell-*/epoch.json; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done
  for cand in "${CAMPAIGN_DIR}"/*/epoch.json; do
    if [[ -f "$cand" ]]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

hours_remaining() {
  local deadline=""
  local epoch_path=""
  if epoch_path="$(find_epoch 2>/dev/null)"; then
    deadline="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("deadlineAt") or "")' "$epoch_path" 2>/dev/null || true)"
  fi
  if [[ -z "$deadline" && -n "${PAPERCLIP_CAMPAIGN_DEADLINE_AT:-}" ]]; then
    deadline="${PAPERCLIP_CAMPAIGN_DEADLINE_AT}"
  fi
  if [[ -z "$deadline" ]]; then
    echo ""
    return 1
  fi
  python3 -c '
import sys
from datetime import datetime, timezone
raw = sys.argv[1].strip()
dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
print(f"{(dt - now).total_seconds() / 3600.0:.6f}")
' "$deadline"
}

read_standing_auth() {
  if [[ ! -f "$STANDING_AUTH" ]]; then
    echo "REFUSE: missing standing Harbor authorization at:" >&2
    echo "  $STANDING_AUTH" >&2
    echo "Install via: install-harbor-standing-reopen-auth.sh --confirm-standing-delegation" >&2
    echo "Example template: deploy/hermes/standing/harbor-reopen-authorized.example.json" >&2
    return 1
  fi
  python3 - "$STANDING_AUTH" <<'PY'
import json, sys
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception as e:
    print(f"REFUSE: unreadable standing auth: {e}", file=sys.stderr)
    sys.exit(1)
if data.get("authorized") is not True:
    print("REFUSE: standing auth authorized != true", file=sys.stderr)
    sys.exit(1)
phrase = str(data.get("phrase") or "")
if "OPEN CAMPAIGN" not in phrase.upper():
    print("REFUSE: standing auth phrase must include OPEN CAMPAIGN", file=sys.stderr)
    sys.exit(1)
by = data.get("authorizedBy") or ""
if not by:
    print("REFUSE: standing auth missing authorizedBy", file=sys.stderr)
    sys.exit(1)
max_day = int(data.get("maxAutoReopensPerDay") or 2)
print(json.dumps({
    "phrase": phrase,
    "authorizedBy": by,
    "maxAutoReopensPerDay": max_day,
    "authorizedAt": data.get("authorizedAt"),
    "schemaVersion": data.get("schemaVersion"),
}))
PY
}

check_daily_cap() {
  local max_day="$1"
  python3 - "$COUNTER_FILE" "$max_day" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path
path = Path(sys.argv[1])
max_day = int(sys.argv[2])
today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
count = 0
if path.is_file():
    try:
        data = json.loads(path.read_text())
        if data.get("day") == today:
            count = int(data.get("count") or 0)
    except Exception:
        count = 0
if count >= max_day:
    print(f"REFUSE: maxAutoReopensPerDay={max_day} reached for {today} (count={count})", file=sys.stderr)
    sys.exit(1)
print(json.dumps({"day": today, "count": count, "max": max_day}))
PY
}

bump_daily_cap() {
  python3 - "$COUNTER_FILE" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path
path = Path(sys.argv[1])
today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
count = 0
if path.is_file():
    try:
        data = json.loads(path.read_text())
        if data.get("day") == today:
            count = int(data.get("count") or 0)
    except Exception:
        count = 0
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({"day": today, "count": count + 1, "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00","Z")}, indent=2) + "\n")
print(count + 1)
PY
}

ensure_supervisor_approved_image() {
  # Mint/update approvedImage field only if campaign id + image present; keep other fields.
  if [[ ! -f "$APPROVED_IMAGE_FILE" ]]; then
    echo "supervisor-closure: approved-image missing; skip"
    return 0
  fi
  local image
  image="$(tr -d '[:space:]' <"$APPROVED_IMAGE_FILE" || true)"
  local campaign_id="${PAPERCLIP_CAMPAIGN_ID:-}"
  if [[ -z "$image" ]]; then
    echo "supervisor-closure: empty approved-image; skip"
    return 0
  fi
  if [[ -z "$campaign_id" ]]; then
    # try from epoch
    local epoch_path=""
    if epoch_path="$(find_epoch 2>/dev/null)"; then
      campaign_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("campaignId") or "")' "$epoch_path" 2>/dev/null || true)"
    fi
  fi
  if [[ -z "$campaign_id" ]]; then
    echo "supervisor-closure: no campaign id; skip approvedImage mint"
    return 0
  fi
  python3 - "$SUPERVISOR_CLOSURE" "$image" "$campaign_id" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path
path = Path(sys.argv[1])
image = sys.argv[2]
campaign_id = sys.argv[3]
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
data = {}
if path.is_file():
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
# Only touch approvedImage (+ ensure campaignId if absent). Keep all other fields.
if data.get("approvedImage") == image and data.get("campaignId") in (campaign_id, None, ""):
    if data.get("campaignId") in (None, ""):
        data["campaignId"] = campaign_id
    else:
        print("supervisor-closure: approvedImage already matches")
        sys.exit(0)
data["approvedImage"] = image
if not data.get("campaignId"):
    data["campaignId"] = campaign_id
data.setdefault("schemaVersion", data.get("schemaVersion") or "gloops.supervisor-operational-closure.v1")
data["approvedImageUpdatedAt"] = now
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
print(f"supervisor-closure: set approvedImage for campaignId={campaign_id}")
PY
}

comment_and_complete_issue() {
  local issue_id="$1"
  local body="$2"
  local status="${3:-done}"
  if [[ -z "$issue_id" ]]; then
    return 0
  fi
  api POST "/issues/${issue_id}/comments" "$(python3 -c 'import json,sys; print(json.dumps({"body":sys.argv[1]}))' "$body")" >/dev/null || true
  api PATCH "/issues/${issue_id}" "$(python3 -c 'import json,sys; print(json.dumps({"status":sys.argv[1],"comment":sys.argv[2]}))' "$status" "$body")" >/dev/null || \
    api PATCH "/issues/${issue_id}" "$(python3 -c 'import json,sys; print(json.dumps({"status":"cancelled","comment":sys.argv[1]}))' "$body")" >/dev/null || true
}

verify_issue_open() {
  local issue_id="$1"
  local raw
  raw="$(api GET "/issues/${issue_id}" || true)"
  if [[ -z "$raw" ]]; then
    echo "issue ${issue_id} not found" >&2
    return 1
  fi
  python3 -c '
import json,sys
i=json.loads(sys.argv[1])
st=str(i.get("status") or "").lower()
open_st={"todo","in_progress","blocked","backlog","open","ready","queued"}
if st not in open_st:
    raise SystemExit(f"issue not open: status={st}")
print(i.get("title") or "")
' "$raw"
}

find_residual_issue() {
  # Prefer explicit id; else search title markers with campaign codes.
  if [[ -n "$ISSUE_ID" ]]; then
    echo "$ISSUE_ID"
    return 0
  fi
  python3 - "$API_BASE" "$TOKEN_FILE" "$COMPANY_ID" <<'PY' 2>/dev/null || true
import json, os, sys, urllib.request
from pathlib import Path
api = sys.argv[1].rstrip("/")
token_file = Path(sys.argv[2])
company = sys.argv[3]
token = os.environ.get("PAPERCLIP_TOKEN") or os.environ.get("PAPERCLIP_BOARD_TOKEN") or ""
if not token and token_file.is_file():
    token = token_file.read_text().strip()
if not token:
    sys.exit(0)
headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}

def get(path):
    req = urllib.request.Request(api + path, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

markers = ("[Harbor/Campaign]", "[Sentinel/Plane]")
open_st = {"todo", "in_progress", "blocked", "backlog", "open", "ready"}
for q in ("Harbor%2FCampaign", "Sentinel%2FPlane"):
    try:
        data = get(f"/companies/{company}/issues?status=todo,in_progress,blocked&q={q}")
    except Exception:
        continue
    items = data if isinstance(data, list) else (data.get("issues") or data.get("items") or [])
    for issue in items or []:
        title = str(issue.get("title") or "")
        if not any(m in title for m in markers):
            continue
        if str(issue.get("status") or "").lower() not in open_st:
            continue
        desc = str(issue.get("description") or "")
        if "campaign." in desc or "Campaign" in title or "deadline" in title.lower():
            print(issue.get("id") or "")
            sys.exit(0)
sys.exit(0)
PY
}

# --- status mode ---
HRS=""
HRS="$(hours_remaining 2>/dev/null || true)"
AUTH_JSON=""
AUTH_OK=0
if AUTH_JSON="$(read_standing_auth 2>/dev/null)"; then
  AUTH_OK=1
fi

if [[ "$MODE" == "status" ]]; then
  python3 - "$HRS" "$AUTH_OK" "$STANDING_AUTH" "$OPEN_CAMPAIGN_BIN" "$ISSUE_ID" <<'PY'
import json, sys
from pathlib import Path
hrs_s, auth_ok_s, standing, open_bin, issue_id = sys.argv[1:6]
hrs = float(hrs_s) if hrs_s not in ("", None) else None
print(json.dumps({
  "schemaVersion": "gloops.harbor-campaign-reopen-status.v1",
  "ts": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00","Z"),
  "hoursRemaining": hrs,
  "standingAuthOk": auth_ok_s == "1",
  "standingAuthPath": standing,
  "openCampaignBin": open_bin,
  "openCampaignPresent": Path(open_bin).is_file(),
  "issueId": issue_id or None,
  "mode": "status",
}, indent=2, sort_keys=True))
PY
  exit 0
fi

# --- dry-run / execute shared gates ---
if [[ "$AUTH_OK" -ne 1 ]]; then
  read_standing_auth || exit 1
fi
AUTH_JSON="$(read_standing_auth)"
PHRASE="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["phrase"])' <<<"$AUTH_JSON")"
MAX_DAY="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["maxAutoReopensPerDay"])' <<<"$AUTH_JSON")"
AUTH_BY="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["authorizedBy"])' <<<"$AUTH_JSON")"

if [[ -n "$HRS" ]] && python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > float(sys.argv[2]) else 1)" "$HRS" "$NOT_NEEDED_HOURS"; then
  if [[ "$FORCE" -ne 1 && -z "$ISSUE_ID" ]]; then
    echo "not needed: hours_remaining=$HRS > ${NOT_NEEDED_HOURS}h (and no forced residual). exit 0"
    exit 0
  fi
fi

# daily cap (even for dry-run we report; enforce on execute)
CAP_JSON="$(check_daily_cap "$MAX_DAY")"

RESOLVED_ISSUE="$(find_residual_issue || true)"
if [[ -n "$RESOLVED_ISSUE" ]]; then
  ISSUE_ID="$RESOLVED_ISSUE"
fi
if [[ -n "$ISSUE_ID" ]]; then
  echo "residual issue: $ISSUE_ID"
  verify_issue_open "$ISSUE_ID" || {
    echo "REFUSE: residual issue not open: $ISSUE_ID" >&2
    exit 1
  }
fi

if [[ "$MODE" == "dry-run" ]]; then
  python3 - "$HRS" "$PHRASE" "$AUTH_BY" "$MAX_DAY" "$CAP_JSON" "$ISSUE_ID" "$OPEN_CAMPAIGN_BIN" <<'PY'
import json, sys
from pathlib import Path
hrs_s, phrase, auth_by, max_day, cap_json, issue_id, open_bin = sys.argv[1:8]
hrs = float(hrs_s) if hrs_s not in ("", None) else None
try:
    cap = json.loads(cap_json)
except Exception:
    cap = {"raw": cap_json}
print(json.dumps({
  "schemaVersion": "gloops.harbor-campaign-reopen.v1",
  "mode": "dry-run",
  "ts": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00","Z"),
  "hoursRemaining": hrs,
  "phrase": phrase,
  "authorizedBy": auth_by,
  "maxAutoReopensPerDay": int(max_day),
  "dailyCap": cap,
  "issueId": issue_id or None,
  "wouldExecute": [
    "open-campaign-24h.sh --phrase … --execute --confirm-execute",
    "export-campaign-deadline-to-runtime.sh",
    "ensure supervisor-operational-closure approvedImage",
    "systemctl restart only if open-campaign did not",
  ],
  "openCampaignBin": open_bin,
  "openCampaignPresent": Path(open_bin).is_file(),
}, indent=2, sort_keys=True))
PY
  exit 0
fi

# --- execute ---
if [[ "$MODE" != "execute" ]]; then
  echo "internal error: mode=$MODE" >&2
  exit 2
fi
if [[ "$CONFIRM" -ne 1 ]]; then
  echo "REFUSE: --execute requires --confirm-execute" >&2
  exit 1
fi
if [[ ! -f "$OPEN_CAMPAIGN_BIN" ]]; then
  echo "REFUSE: open-campaign missing at $OPEN_CAMPAIGN_BIN" >&2
  echo "Host tool may not be in git; install/wrap by path." >&2
  exit 1
fi

check_daily_cap "$MAX_DAY" >/dev/null

REASON="Harbor standing reopen residual=${ISSUE_ID:-none} by=${AUTH_BY}"
echo "executing open-campaign-24h with standing phrase (authorizedBy=$AUTH_BY)"
set +e
OPEN_OUT="$("$OPEN_CAMPAIGN_BIN" --phrase "$PHRASE" --execute --confirm-execute --reason "$REASON" 2>&1)"
OPEN_RC=$?
set -e
echo "$OPEN_OUT"

OPEN_DID_RESTART=0
if grep -Eiq 'restart(ed|ing)? (paperclip-campaign-deadman|paperclip-gloops)|systemctl restart' <<<"$OPEN_OUT"; then
  OPEN_DID_RESTART=1
fi

if [[ "$OPEN_RC" -ne 0 ]]; then
  echo "open-campaign failed rc=$OPEN_RC" >&2
  if [[ -n "$ISSUE_ID" ]]; then
    comment_and_complete_issue "$ISSUE_ID" "Harbor reopen FAILED rc=$OPEN_RC. See host receipt. Do not page Zach for retry if standing auth still valid — re-run harbor-campaign-reopen." "blocked" || true
  fi
  exit "$OPEN_RC"
fi

if [[ -x "$EXPORT_DEADLINE_BIN" || -f "$EXPORT_DEADLINE_BIN" ]]; then
  bash "$EXPORT_DEADLINE_BIN" || echo "WARN export-campaign-deadline failed" >&2
else
  echo "WARN missing $EXPORT_DEADLINE_BIN" >&2
fi

ensure_supervisor_approved_image || true

if [[ "$OPEN_DID_RESTART" -eq 0 ]]; then
  if command -v systemctl >/dev/null 2>&1; then
    echo "open-campaign did not clearly restart units; restarting paperclip-campaign-deadman paperclip-gloops"
    systemctl restart paperclip-campaign-deadman paperclip-gloops || {
      echo "WARN systemctl restart failed" >&2
    }
  fi
else
  echo "skip double restart (open-campaign already restarted services)"
fi

bump_daily_cap >/dev/null || true

TS_FILE="$(date -u +"%Y%m%dT%H%M%SZ")"
RECEIPT_PATH="${RECEIPT_DIR}/harbor-reopen-${TS_FILE}.json"
mkdir -p "$RECEIPT_DIR" 2>/dev/null || true
python3 - <<PY
import json
receipt = {
  "schemaVersion": "gloops.harbor-campaign-reopen.v1",
  "mode": "execute",
  "ts": "$(ts)",
  "ok": True,
  "hoursRemainingBefore": $( [[ -n "$HRS" ]] && echo "$HRS" || echo "null" ),
  "authorizedBy": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$AUTH_BY"),
  "phrase": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$PHRASE"),
  "issueId": $( [[ -n "$ISSUE_ID" ]] && python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ISSUE_ID" || echo null ),
  "reason": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$REASON"),
  "openCampaignRc": $OPEN_RC,
  "openDidRestart": bool($OPEN_DID_RESTART),
  "openCampaignStdoutTail": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1][-3000:]))' "$OPEN_OUT"),
}
open("$RECEIPT_PATH","w").write(json.dumps(receipt, indent=2, sort_keys=True)+"\n")
print("receipt:", "$RECEIPT_PATH")
print(json.dumps(receipt, indent=2, sort_keys=True))
PY

if [[ -n "$ISSUE_ID" ]]; then
  comment_and_complete_issue "$ISSUE_ID" \
    "Harbor standing reopen **succeeded**. Receipt: \`${RECEIPT_PATH}\`. Export deadline + supervisor approvedImage updated. Do not page Zach." \
    "done" || true
fi

exit 0
