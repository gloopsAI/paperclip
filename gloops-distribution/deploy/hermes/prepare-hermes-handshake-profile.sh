#!/usr/bin/env bash
set -euo pipefail

readonly SOURCE_AUTH='/opt/paperclip/hermes-execution-profile/auth.json'
readonly PROFILE_DIR='/opt/paperclip/hermes-handshake-profile'
readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly RUNTIME_ENV="${CONFIG_DIR}/hermes-execution.env"
readonly IMAGE='sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
for unit in paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing handshake profile preparation while ${unit} is active" >&2
    exit 1
  fi
done
[[ -f "${RUNTIME_ENV}" ]] || { echo "missing dedicated runtime environment: ${RUNTIME_ENV}" >&2; exit 1; }
[[ -f "${SOURCE_AUTH}" ]] || { echo "missing Ollama-only credential source: ${SOURCE_AUTH}" >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null

install -d -m 0700 -o root -g root "${PROFILE_DIR}"
find "${PROFILE_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

tmp_auth="$(mktemp "${CONFIG_DIR}/.hermes-handshake-auth.XXXXXX")"
trap 'rm -f "${tmp_auth}"' EXIT
jq '{
  version,
  providers: {},
  credential_pool: {
    "ollama-cloud": [.credential_pool["ollama-cloud"][] | {
      id, label, auth_type, priority, source, base_url, last_status,
      last_status_at, last_error_code, last_error_reason, last_error_message,
      last_error_reset_at, request_count, secret_fingerprint
    }]
  },
  updated_at,
  active_provider: "ollama-cloud",
  suppressed_sources: ["anthropic", "copilot", "openai-codex", "openrouter", "xai", "xai-oauth"]
}' "${SOURCE_AUTH}" >"${tmp_auth}"

install -m 0600 -o 10000 -g 10000 "${tmp_auth}" "${PROFILE_DIR}/auth.json"
install -m 0400 -o 10000 -g 10000 "${LIB_DIR}/hermes-handshake-config.yaml" "${PROFILE_DIR}/config.yaml"
install -m 0600 -o root -g root "${LIB_DIR}/hermes-handshake-policy.json" "${PROFILE_DIR}/policy.json"
rm -f "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED"

"${LIB_DIR}/verify-hermes-handshake-profile.sh" --source
echo 'prepared deterministic zero-tool Hermes provider-handshake profile'
