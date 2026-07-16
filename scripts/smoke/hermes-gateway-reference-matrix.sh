#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[hermes-reference-matrix] $*"
}

fail() {
  echo "[hermes-reference-matrix] ERROR: $*" >&2
  exit 1
}

print_usage() {
  cat <<'EOF'
Hermes gateway deterministic reference matrix

Runs the strict Paperclip/Hermes Docker E2E repeatedly against an already
running disposable local-trusted Paperclip instance and a local
OpenAI-compatible reference mock. Each iteration creates a disposable company,
starts a fresh Hermes container, executes a fresh Paperclip lifecycle, deletes
the company and all transitive state, and positively verifies local cleanup.

Required:
  PAPERCLIP_API_URL=http://127.0.0.1:3189
  PAPERCLIP_API_URL_FOR_HERMES=http://host.docker.internal:3189
  PAPERCLIP_AUTH_HEADER='Bearer <board-token>'
  PAPERCLIP_SOURCE_COMMIT=<40-hex-clean-runtime-commit>
  PAPERCLIP_SOURCE_TREE_CLEAN=true
  REFERENCE_DISPOSABLE_ACK=delete-disposable-companies

Common controls:
  REFERENCE_RUNS=20
  REFERENCE_DELAY_SECONDS=11
  REFERENCE_LABEL=fork
  REFERENCE_RECEIPT=/tmp/hermes-reference-fork.json
  REFERENCE_MOCK_PROBE_URL=http://127.0.0.1:8787/health
  HERMES_REFERENCE_MOCK_BASE_URL=http://host.docker.internal:8787/v1
  HERMES_BUILD=0

The Paperclip URL must use loopback, must not use production port 3100, and
must report local_trusted deployment mode. The Hermes-facing URL and reference
mock URL are derived-tie checked to the same local ports. Real provider
credentials and endpoint overrides must be unset. The script never starts the
Paperclip server or reference mock and never enables worktree execution. Those
are explicit operator-controlled gates.
EOF
}

case "${1:-}" in
  -h|--help)
    print_usage
    exit 0
    ;;
esac

for command in curl docker jq node pnpm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: ${command}"
done

: "${PAPERCLIP_API_URL:?PAPERCLIP_API_URL is required}"
: "${PAPERCLIP_API_URL_FOR_HERMES:?PAPERCLIP_API_URL_FOR_HERMES is required}"
: "${PAPERCLIP_AUTH_HEADER:?PAPERCLIP_AUTH_HEADER is required}"
: "${PAPERCLIP_SOURCE_COMMIT:?PAPERCLIP_SOURCE_COMMIT is required}"
: "${PAPERCLIP_SOURCE_TREE_CLEAN:?PAPERCLIP_SOURCE_TREE_CLEAN is required}"
: "${REFERENCE_DISPOSABLE_ACK:?REFERENCE_DISPOSABLE_ACK is required}"

REFERENCE_RUNS="${REFERENCE_RUNS:-20}"
REFERENCE_DELAY_SECONDS="${REFERENCE_DELAY_SECONDS:-11}"
REFERENCE_LABEL="${REFERENCE_LABEL:-reference}"
REFERENCE_MOCK_PROBE_URL="${REFERENCE_MOCK_PROBE_URL:-http://127.0.0.1:8787/health}"
HERMES_REFERENCE_MOCK_BASE_URL="${HERMES_REFERENCE_MOCK_BASE_URL:-http://host.docker.internal:8787/v1}"
REFERENCE_RECEIPT="${REFERENCE_RECEIPT:-${TMPDIR:-/tmp}/hermes-reference-${REFERENCE_LABEL}.json}"
REFERENCE_LOG_DIR="${REFERENCE_LOG_DIR:-${TMPDIR:-/tmp}/hermes-reference-${REFERENCE_LABEL}-logs}"
REFERENCE_STATE_ROOT="${REFERENCE_STATE_ROOT:-${TMPDIR:-/tmp}/hermes-reference-${REFERENCE_LABEL}-state}"
HERMES_BUILD="${HERMES_BUILD:-0}"

readonly DISPOSABLE_ACK='delete-disposable-companies'
readonly DISALLOWED_PROVIDER_VARS=(
  OPENROUTER_API_KEY
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  GEMINI_API_KEY
  GOOGLE_API_KEY
  MISTRAL_API_KEY
  XAI_API_KEY
  GROK_API_KEY
  AZURE_OPENAI_API_KEY
  OPENAI_BASE_URL
  OPENAI_API_BASE
  ANTHROPIC_BASE_URL
  XAI_BASE_URL
  GROK_BASE_URL
)

validate_reference_boundary() {
  [[ "$REFERENCE_DISPOSABLE_ACK" == "$DISPOSABLE_ACK" ]] \
    || fail "REFERENCE_DISPOSABLE_ACK must equal ${DISPOSABLE_ACK}"
  [[ "$PAPERCLIP_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || fail "PAPERCLIP_SOURCE_COMMIT must be an exact lowercase 40-hex commit"
  [[ "$PAPERCLIP_SOURCE_TREE_CLEAN" == "true" ]] \
    || fail "PAPERCLIP_SOURCE_TREE_CLEAN must equal true; dirty runtime sources cannot be certified"
  [[ -z "${COMPANY_ID:-}" && -z "${PAPERCLIP_COMPANY_ID:-}" ]] \
    || fail "COMPANY_ID/PAPERCLIP_COMPANY_ID must be unset; the matrix creates and deletes a fresh company per run"

  local paperclip_port mock_port variable
  if [[ "$PAPERCLIP_API_URL" =~ ^http://127\.0\.0\.1:([0-9]{4,5})$ ]]; then
    paperclip_port="${BASH_REMATCH[1]}"
  else
    fail "PAPERCLIP_API_URL must be exact loopback HTTP with an explicit non-default port"
  fi
  (( paperclip_port >= 1024 && paperclip_port <= 65535 && paperclip_port != 3100 )) \
    || fail "Paperclip reference port must be 1024-65535 and must not be production port 3100"
  [[ "$PAPERCLIP_API_URL_FOR_HERMES" == "http://host.docker.internal:${paperclip_port}" ]] \
    || fail "PAPERCLIP_API_URL_FOR_HERMES must tie exactly to the loopback Paperclip port"

  if [[ "$REFERENCE_MOCK_PROBE_URL" =~ ^http://127\.0\.0\.1:([0-9]{4,5})/health$ ]]; then
    mock_port="${BASH_REMATCH[1]}"
  else
    fail "REFERENCE_MOCK_PROBE_URL must be an exact loopback /health URL"
  fi
  (( mock_port >= 1024 && mock_port <= 65535 && mock_port != paperclip_port && mock_port != 3100 )) \
    || fail "reference mock port must be non-default and distinct from Paperclip"
  [[ "$HERMES_REFERENCE_MOCK_BASE_URL" == "http://host.docker.internal:${mock_port}/v1" ]] \
    || fail "HERMES_REFERENCE_MOCK_BASE_URL must tie exactly to the local reference mock port"

  for variable in "${DISALLOWED_PROVIDER_VARS[@]}"; do
    [[ -z "${!variable-}" ]] || fail "${variable} must be unset for deterministic zero-provider certification"
  done
}

[[ "$REFERENCE_RUNS" =~ ^[1-9][0-9]*$ ]] || fail "REFERENCE_RUNS must be a positive integer"
[[ "$REFERENCE_DELAY_SECONDS" =~ ^[0-9]+$ ]] || fail "REFERENCE_DELAY_SECONDS must be a non-negative integer"
validate_reference_boundary

if [[ "${1:-}" == "--validate-config" ]]; then
  log "reference boundary configuration is valid"
  exit 0
fi

health_payload="$(curl -fsS -H "Authorization: ${PAPERCLIP_AUTH_HEADER}" "${PAPERCLIP_API_URL%/}/api/health")" \
  || fail "Paperclip is not healthy at ${PAPERCLIP_API_URL}"
[[ "$(jq -r '.deploymentMode // empty' <<<"$health_payload")" == "local_trusted" ]] \
  || fail "Paperclip reference instance must report deploymentMode=local_trusted"
curl -fsS "$REFERENCE_MOCK_PROBE_URL" >/dev/null \
  || fail "reference mock is not healthy at ${REFERENCE_MOCK_PROBE_URL}"

api_request() {
  local method="$1"
  local path="$2"
  local data="${3-}"
  local output_file="$4"
  local code
  if [[ -n "$data" ]]; then
    code="$(curl -sS -o "$output_file" -w '%{http_code}' -X "$method" \
      -H "Authorization: ${PAPERCLIP_AUTH_HEADER}" -H 'Content-Type: application/json' \
      "${PAPERCLIP_API_URL%/}/api${path}" --data "$data")"
  else
    code="$(curl -sS -o "$output_file" -w '%{http_code}' -X "$method" \
      -H "Authorization: ${PAPERCLIP_AUTH_HEADER}" \
      "${PAPERCLIP_API_URL%/}/api${path}")"
  fi
  printf '%s' "$code"
}

create_disposable_company() {
  local label="$1"
  local response_file code company_id
  response_file="$(mktemp)"
  code="$(api_request POST /companies "$(jq -nc --arg name "Hermes reference ${label}" '{name:$name,description:"Disposable hermes_gateway certification company",budgetMonthlyCents:0,requireBoardApprovalForNewAgents:false}')" "$response_file")"
  if [[ "$code" != "201" ]]; then
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi
  company_id="$(jq -r '.id // empty' "$response_file")"
  rm -f "$response_file"
  [[ "$company_id" =~ ^[0-9a-f-]{36}$ ]] || return 1
  printf '%s' "$company_id"
}

create_disposable_ceo() {
  local company_id="$1"
  local response_file code agent_id
  response_file="$(mktemp)"
  code="$(api_request POST "/companies/${company_id}/agents" \
    '{"name":"Reference CEO","role":"ceo","title":"Disposable certification CEO","adapterType":"process","adapterConfig":{},"budgetMonthlyCents":0}' \
    "$response_file")"
  if [[ "$code" != "201" ]]; then
    cat "$response_file" >&2
    rm -f "$response_file"
    return 1
  fi
  agent_id="$(jq -r '.id // .agent.id // empty' "$response_file")"
  rm -f "$response_file"
  [[ "$agent_id" =~ ^[0-9a-f-]{36}$ ]]
}

company_is_absent() {
  local company_id="$1"
  local response_file code absent=0
  response_file="$(mktemp)"
  code="$(api_request GET "/companies/${company_id}" "" "$response_file")"
  [[ "$code" == "404" ]] || absent=1
  code="$(api_request GET /companies "" "$response_file")"
  if [[ "$code" != "200" ]] || jq -e --arg id "$company_id" '.[] | select(.id == $id)' "$response_file" >/dev/null; then
    absent=1
  fi
  rm -f "$response_file"
  return "$absent"
}

force_cleanup() {
  local company_id="$1"
  local container_name="$2"
  local state_dir="$3"
  local join_output="$4"
  local response_file
  response_file="$(mktemp)"
  api_request DELETE "/companies/${company_id}" "" "$response_file" >/dev/null 2>&1 || true
  rm -f "$response_file"
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -rf "$state_dir"
  rm -f "$join_output"
}

mkdir -p "$REFERENCE_LOG_DIR" "$REFERENCE_STATE_ROOT" "$(dirname "$REFERENCE_RECEIPT")"
results_file="$(mktemp "${TMPDIR:-/tmp}/hermes-reference-results.XXXXXX")"
trap 'rm -f "$results_file"' EXIT

write_receipt() {
  local status="$1"
  jq -s \
    --arg label "$REFERENCE_LABEL" \
    --arg startedAt "$started_at" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$status" \
    --arg paperclipUrl "$PAPERCLIP_API_URL" \
    --arg paperclipForHermes "$PAPERCLIP_API_URL_FOR_HERMES" \
    --arg sourceCommit "$PAPERCLIP_SOURCE_COMMIT" \
    --arg sourceTreeClean "$PAPERCLIP_SOURCE_TREE_CLEAN" \
    --arg mockProbeUrl "$REFERENCE_MOCK_PROBE_URL" \
    --arg mockBaseUrl "$HERMES_REFERENCE_MOCK_BASE_URL" \
    --argjson onboardingPacingSeconds "$REFERENCE_DELAY_SECONDS" \
    '{schemaVersion:"gloops.hermes-reference-matrix.v1",label:$label,status:$status,startedAt:$startedAt,completedAt:$completedAt,runtimeSource:{commit:$sourceCommit,treeClean:($sourceTreeClean == "true")},boundary:{paperclipUrl:$paperclipUrl,paperclipForHermes:$paperclipForHermes,mockProbeUrl:$mockProbeUrl,mockBaseUrl:$mockBaseUrl,disposableCompanyPerRun:true,localTrustedRequired:true,productionPortRejected:true,realProviderCredentialsRejected:true,onboardingPacingSeconds:$onboardingPacingSeconds},totalRuns:length,passedRuns:(map(select(.result == "passed"))|length),runs:.}' \
    "$results_file" > "$REFERENCE_RECEIPT"
}

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for index in $(seq 1 "$REFERENCE_RUNS"); do
  suffix="${REFERENCE_LABEL}-$(printf '%02d' "$index")"
  output_file="${REFERENCE_LOG_DIR}/${suffix}.log"
  state_dir="${REFERENCE_STATE_ROOT}/${suffix}"
  diag_dir="${REFERENCE_LOG_DIR}/${suffix}-diag"
  join_output="${diag_dir}/join-output.json"
  container_name="paperclip-hermes-gateway-smoke-${suffix}"
  iteration_started="$(date +%s)"
  log "cold start ${index}/${REFERENCE_RUNS}: ${suffix}"

  company_id="$(create_disposable_company "$suffix")" \
    || { write_receipt failed; fail "could not create disposable company for ${suffix}"; }
  if ! create_disposable_ceo "$company_id"; then
    force_cleanup "$company_id" "$container_name" "$state_dir" "$join_output"
    write_receipt failed
    fail "could not create disposable CEO for ${suffix}"
  fi

  if HERMES_BUILD="$HERMES_BUILD" \
    HERMES_SMOKE_RUN_SUFFIX="$suffix" \
    HERMES_CONTAINER_NAME="$container_name" \
    HERMES_SMOKE_STATE_DIR="$state_dir" \
    HERMES_SMOKE_DIAG_DIR="$diag_dir" \
    HERMES_JOIN_OUTPUT_FILE="$join_output" \
    HERMES_SMOKE_KEEP=0 \
    HERMES_SMOKE_STRICT_CLEANUP=1 \
    HERMES_SMOKE_DELETE_COMPANY=1 \
    STRICT_CASES=1 \
    HERMES_STOP_ASSERT=0 \
    HERMES_SMOKE_MODEL_PROVIDER=custom \
    HERMES_SMOKE_MODEL_DEFAULT=reference-mock \
    HERMES_SMOKE_MODEL_BASE_URL="$HERMES_REFERENCE_MOCK_BASE_URL" \
    OPENROUTER_API_KEY='' \
    OPENAI_API_KEY=reference-only-no-secret \
    ANTHROPIC_API_KEY='' \
    GEMINI_API_KEY='' \
    GOOGLE_API_KEY='' \
    MISTRAL_API_KEY='' \
    XAI_API_KEY='' \
    GROK_API_KEY='' \
    PAPERCLIP_API_URL="$PAPERCLIP_API_URL" \
    PAPERCLIP_API_URL_FOR_HERMES="$PAPERCLIP_API_URL_FOR_HERMES" \
    PAPERCLIP_AUTH_HEADER="$PAPERCLIP_AUTH_HEADER" \
    COMPANY_ID="$company_id" \
    pnpm smoke:hermes-gateway-e2e >"$output_file" 2>&1; then
    e2e_passed=true
  else
    e2e_passed=false
  fi

  company_absent=false
  container_absent=false
  state_absent=false
  claimed_key_absent=false
  claimed_key_readable=false
  claimed_key_mode=''
  claimed_key_owner=''
  claimed_key_proof="${diag_dir}/claimed-key-proof.json"
  if [[ -f "$claimed_key_proof" ]]; then
    claimed_key_readable="$(jq -r '.readableByUid10001 == true' "$claimed_key_proof")"
    claimed_key_mode="$(jq -r '.mode // empty' "$claimed_key_proof")"
    claimed_key_owner="$(jq -r '.owner // empty' "$claimed_key_proof")"
  fi
  company_is_absent "$company_id" && company_absent=true
  ! docker inspect "$container_name" >/dev/null 2>&1 && container_absent=true
  [[ ! -e "$state_dir" ]] && state_absent=true
  [[ ! -e "$join_output" && ! -e "${state_dir}/workspace/paperclip-claimed-api-key.json" ]] && claimed_key_absent=true

  if [[ "$e2e_passed" == true && "$company_absent" == true && "$container_absent" == true && "$state_absent" == true && "$claimed_key_absent" == true && "$claimed_key_readable" == true && "$claimed_key_mode" == 600 && "$claimed_key_owner" == 10001:10001 ]]; then
    result="passed"
  else
    result="failed"
  fi
  duration_seconds="$(( $(date +%s) - iteration_started ))"
  jq -nc \
    --arg label "$suffix" \
    --arg result "$result" \
    --arg companyId "$company_id" \
    --argjson durationSeconds "$duration_seconds" \
    --argjson e2ePassed "$e2e_passed" \
    --argjson companyAbsent "$company_absent" \
    --argjson containerAbsent "$container_absent" \
    --argjson stateAbsent "$state_absent" \
    --argjson claimedKeyAbsent "$claimed_key_absent" \
    --argjson claimedKeyReadableByUid10001 "$claimed_key_readable" \
    --arg claimedKeyMode "$claimed_key_mode" \
    --arg claimedKeyOwner "$claimed_key_owner" \
    '{label:$label,result:$result,companyId:$companyId,durationSeconds:$durationSeconds,e2ePassed:$e2ePassed,claimedKeyProof:{readableByUid10001:$claimedKeyReadableByUid10001,mode:$claimedKeyMode,owner:$claimedKeyOwner},cleanup:{companyAbsent:$companyAbsent,containerAbsent:$containerAbsent,stateAbsent:$stateAbsent,claimedKeyAbsent:$claimedKeyAbsent}}' \
    >> "$results_file"

  if [[ "$result" != "passed" ]]; then
    force_cleanup "$company_id" "$container_name" "$state_dir" "$join_output"
    write_receipt failed
    tail -100 "$output_file" >&2
    fail "cold start ${suffix} failed or left residue; receipt=${REFERENCE_RECEIPT} log=${output_file}"
  fi
  if (( index < REFERENCE_RUNS && REFERENCE_DELAY_SECONDS > 0 )); then
    log "pacing onboarding for ${REFERENCE_DELAY_SECONDS}s"
    sleep "$REFERENCE_DELAY_SECONDS"
  fi
done

write_receipt passed
log "success: ${REFERENCE_RUNS}/${REFERENCE_RUNS} cold starts and strict cleanup passed; receipt=${REFERENCE_RECEIPT}"
