#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[hermes-reference-matrix] $*"
}

fail() {
  echo "[hermes-reference-matrix] ERROR: $*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Hermes gateway deterministic reference matrix

Runs the strict Paperclip/Hermes Docker E2E repeatedly against an already
running disposable Paperclip instance and local OpenAI-compatible reference
mock. Each iteration starts a fresh Hermes container and a fresh Paperclip
agent/issue lifecycle. Successful iterations clean up their transient state.

Required:
  PAPERCLIP_API_URL=http://127.0.0.1:3189
  PAPERCLIP_API_URL_FOR_HERMES=http://host.docker.internal:3189
  PAPERCLIP_AUTH_HEADER='Bearer <board-token>'
  COMPANY_ID=<disposable-company-uuid>

Common controls:
  REFERENCE_RUNS=20
  REFERENCE_DELAY_SECONDS=11
  REFERENCE_LABEL=fork
  REFERENCE_RECEIPT=/tmp/hermes-reference-fork.json
  REFERENCE_MOCK_PROBE_URL=http://127.0.0.1:8787/health
  HERMES_REFERENCE_MOCK_BASE_URL=http://host.docker.internal:8787/v1
  HERMES_BUILD=0

The script never starts the Paperclip server or reference mock and never
enables worktree execution. Those are explicit operator-controlled gates.
EOF
  exit 0
fi

for command in curl jq pnpm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: ${command}"
done

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"
: "${PAPERCLIP_API_URL_FOR_HERMES:?PAPERCLIP_API_URL_FOR_HERMES is required}"
: "${PAPERCLIP_AUTH_HEADER:?PAPERCLIP_AUTH_HEADER is required}"
: "${COMPANY_ID:?COMPANY_ID is required}"

REFERENCE_RUNS="${REFERENCE_RUNS:-20}"
REFERENCE_DELAY_SECONDS="${REFERENCE_DELAY_SECONDS:-11}"
REFERENCE_LABEL="${REFERENCE_LABEL:-reference}"
REFERENCE_MOCK_PROBE_URL="${REFERENCE_MOCK_PROBE_URL:-http://127.0.0.1:8787/health}"
HERMES_REFERENCE_MOCK_BASE_URL="${HERMES_REFERENCE_MOCK_BASE_URL:-http://host.docker.internal:8787/v1}"
REFERENCE_RECEIPT="${REFERENCE_RECEIPT:-${TMPDIR:-/tmp}/hermes-reference-${REFERENCE_LABEL}.json}"
REFERENCE_LOG_DIR="${REFERENCE_LOG_DIR:-${TMPDIR:-/tmp}/hermes-reference-${REFERENCE_LABEL}-logs}"
HERMES_BUILD="${HERMES_BUILD:-0}"

[[ "$REFERENCE_RUNS" =~ ^[1-9][0-9]*$ ]] || fail "REFERENCE_RUNS must be a positive integer"
[[ "$REFERENCE_DELAY_SECONDS" =~ ^[0-9]+$ ]] || fail "REFERENCE_DELAY_SECONDS must be a non-negative integer"
curl -fsS "$REFERENCE_MOCK_PROBE_URL" >/dev/null || fail "reference mock is not healthy at ${REFERENCE_MOCK_PROBE_URL}"
curl -fsS -H "Authorization: ${PAPERCLIP_AUTH_HEADER}" "${PAPERCLIP_API_URL%/}/api/health" >/dev/null \
  || fail "Paperclip is not healthy at ${PAPERCLIP_API_URL}"

mkdir -p "$REFERENCE_LOG_DIR" "$(dirname "$REFERENCE_RECEIPT")"
results_file="$(mktemp "${TMPDIR:-/tmp}/hermes-reference-results.XXXXXX")"
trap 'rm -f "$results_file"' EXIT

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for index in $(seq 1 "$REFERENCE_RUNS"); do
  suffix="${REFERENCE_LABEL}-$(printf '%02d' "$index")"
  output_file="${REFERENCE_LOG_DIR}/${suffix}.log"
  iteration_started="$(date +%s)"
  log "cold start ${index}/${REFERENCE_RUNS}: ${suffix}"
  if HERMES_BUILD="$HERMES_BUILD" \
    HERMES_SMOKE_RUN_SUFFIX="$suffix" \
    HERMES_SMOKE_KEEP=0 \
    STRICT_CASES=1 \
    HERMES_STOP_ASSERT=0 \
    HERMES_SMOKE_MODEL_PROVIDER=custom \
    HERMES_SMOKE_MODEL_DEFAULT=reference-mock \
    HERMES_SMOKE_MODEL_BASE_URL="$HERMES_REFERENCE_MOCK_BASE_URL" \
    OPENAI_API_KEY=reference-only-no-secret \
    PAPERCLIP_API_URL="$PAPERCLIP_API_URL" \
    PAPERCLIP_API_URL_FOR_HERMES="$PAPERCLIP_API_URL_FOR_HERMES" \
    PAPERCLIP_AUTH_HEADER="$PAPERCLIP_AUTH_HEADER" \
    COMPANY_ID="$COMPANY_ID" \
    pnpm smoke:hermes-gateway-e2e >"$output_file" 2>&1; then
    result="passed"
  else
    result="failed"
  fi
  duration_seconds="$(( $(date +%s) - iteration_started ))"
  jq -nc \
    --arg label "$suffix" \
    --arg result "$result" \
    --argjson durationSeconds "$duration_seconds" \
    '{label:$label,result:$result,durationSeconds:$durationSeconds}' >> "$results_file"
  if [[ "$result" != "passed" ]]; then
    jq -s \
      --arg label "$REFERENCE_LABEL" \
      --arg startedAt "$started_at" \
      --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg status "failed" \
      '{label:$label,status:$status,startedAt:$startedAt,completedAt:$completedAt,runs:.}' \
      "$results_file" > "$REFERENCE_RECEIPT"
    tail -80 "$output_file" >&2
    fail "cold start ${suffix} failed; receipt=${REFERENCE_RECEIPT} log=${output_file}"
  fi
  if (( index < REFERENCE_RUNS && REFERENCE_DELAY_SECONDS > 0 )); then
    log "pacing onboarding for ${REFERENCE_DELAY_SECONDS}s"
    sleep "$REFERENCE_DELAY_SECONDS"
  fi
done

jq -s \
  --arg label "$REFERENCE_LABEL" \
  --arg startedAt "$started_at" \
  --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg status "passed" \
  '{label:$label,status:$status,startedAt:$startedAt,completedAt:$completedAt,totalRuns:length,passedRuns:map(select(.result == "passed"))|length,runs:.}' \
  "$results_file" > "$REFERENCE_RECEIPT"
log "success: ${REFERENCE_RUNS}/${REFERENCE_RUNS} cold starts passed; receipt=${REFERENCE_RECEIPT}"
