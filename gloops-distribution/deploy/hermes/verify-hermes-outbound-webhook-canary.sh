#!/usr/bin/env bash
# Prove lifecycle sink accepts HMAC-signed Hermes-shaped POSTs and writes a receipt.
set -euo pipefail

SECRET="${HERMES_OUTBOUND_WEBHOOK_SECRET:-}"
BASE_URL="${HERMES_LIFECYCLE_SINK_URL:-http://127.0.0.1:8765}"
# Prefer docker network alias when running on host with published port; for in-network use hermes-lifecycle-sink
RECEIPT_DIR="${HERMES_LIFECYCLE_RECEIPT_DIR:-/var/lib/paperclip-gloops/hermes-lifecycle-receipts}"

if [[ -z "${SECRET}" ]]; then
  # try host env file without printing value
  if [[ -r /etc/paperclip-gloops/hermes-execution.env ]]; then
    # shellcheck disable=SC1091
    set -a
    # only export the one key if present
    SECRET="$(grep -E '^HERMES_OUTBOUND_WEBHOOK_SECRET=' /etc/paperclip-gloops/hermes-execution.env | head -1 | cut -d= -f2- | tr -d '"' || true)"
    set +a
  fi
fi
[[ -n "${SECRET}" ]] || { echo "FAIL: HERMES_OUTBOUND_WEBHOOK_SECRET not set" >&2; exit 1; }

# If sink only on docker network, use docker run curl from same network
BODY='{"hook_event_name":"on_session_end","session_id":"canary_sess","delivery_id":"canary-deliv-1","extra":{"canary":true}}'
SIG="sha256=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${SECRET}" | awk '{print $2}')"
before=$(find "${RECEIPT_DIR}" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

if docker network inspect paperclip-execution >/dev/null 2>&1; then
  code=$(docker run --rm --network paperclip-execution curlimages/curl:8.5.0 \
    -sS -o /tmp/sink-resp.json -w '%{http_code}' \
    -X POST "http://hermes-lifecycle-sink:8765/hermes-events" \
    -H "Content-Type: application/json" \
    -H "X-Hermes-Signature-256: ${SIG}" \
    -H "X-Hermes-Event: on_session_end" \
    -H "X-Hermes-Delivery: canary-deliv-1" \
    -d "${BODY}" || true)
else
  code=$(curl -sS -o /tmp/sink-resp.json -w '%{http_code}' \
    -X POST "${BASE_URL}/hermes-events" \
    -H "Content-Type: application/json" \
    -H "X-Hermes-Signature-256: ${SIG}" \
    -H "X-Hermes-Event: on_session_end" \
    -H "X-Hermes-Delivery: canary-deliv-1" \
    -d "${BODY}" || true)
fi

echo "post_status=${code}"
[[ "${code}" == "200" ]] || { echo "FAIL: expected 200, body=$(cat /tmp/sink-resp.json 2>/dev/null || true)" >&2; exit 1; }
after=$(find "${RECEIPT_DIR}" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
[[ "${after}" -gt "${before}" ]] || { echo "FAIL: no new receipt in ${RECEIPT_DIR}" >&2; exit 1; }
# bad signature rejected
bad=$(docker run --rm --network paperclip-execution curlimages/curl:8.5.0 \
  -sS -o /dev/null -w '%{http_code}' \
  -X POST "http://hermes-lifecycle-sink:8765/hermes-events" \
  -H "Content-Type: application/json" \
  -H "X-Hermes-Signature-256: sha256=deadbeef" \
  -d "${BODY}" 2>/dev/null || echo 000)
[[ "${bad}" == "401" ]] || echo "WARN: bad-sig status=${bad} (expected 401 if sink up)"
echo "PASS: outbound webhook canary (receipts before=${before} after=${after})"
