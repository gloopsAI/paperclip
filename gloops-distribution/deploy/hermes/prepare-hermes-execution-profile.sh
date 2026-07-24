#!/usr/bin/env bash
set -euo pipefail

readonly SOURCE_ENV='/opt/paperclip/hermes-home/.env'
readonly SOURCE_AUTH='/opt/paperclip/hermes-home/auth.json'
readonly PROFILE_DIR='/opt/paperclip/hermes-execution-profile'
readonly STATE_DIR='/opt/paperclip/hermes-execution-state'
readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly RUNTIME_ENV="${CONFIG_DIR}/hermes-execution.env"
readonly IMAGE='sha256:210427ae7dc5b61f37aad0c0df5083018bb9c1de04cf9affde645a74988d64ab'
readonly NETWORK='paperclip-execution'
readonly HERMES_UID='10000'
readonly HERMES_GID='10000'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
for unit in paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing profile preparation while ${unit} is active" >&2
    exit 1
  fi
done
[[ -f "${SOURCE_ENV}" ]] || { echo "missing credential source: ${SOURCE_ENV}" >&2; exit 1; }
[[ -f "${SOURCE_AUTH}" ]] || { echo "missing credential source: ${SOURCE_AUTH}" >&2; exit 1; }
docker image inspect "${IMAGE}" >/dev/null

install -d -m 0700 -o root -g root "${PROFILE_DIR}" "${STATE_DIR}" "${CONFIG_DIR}"
for path in cache logs memories sessions; do
  # These directories are mounted inside the Hermes-owned /opt/data tmpfs.
  # Prepare their host-side bind roots for the same fixed identity rather than
  # depending on image startup hooks to repair ownership as a side effect.
  install -d -m 0700 -o "${HERMES_UID}" -g "${HERMES_GID}" "${STATE_DIR}/${path}"
done
# Paperclip observes this tree read-only as uid:gid 995:985. Hermes owns the
# writable side as uid 10000. The shared group can traverse the bind-mount root
# without exposing any credential-bearing state directory.
install -d -m 0750 -o 10000 -g 985 "${STATE_DIR}/workspace"

tmp_env="$(mktemp "${CONFIG_DIR}/.hermes-execution.env.XXXXXX")"
tmp_auth="$(mktemp "${CONFIG_DIR}/.hermes-execution-auth.XXXXXX")"
trap 'rm -f "${tmp_env}" "${tmp_auth}"' EXIT

python3 - "${SOURCE_ENV}" "${RUNTIME_ENV}" "${tmp_env}" <<'PY'
from pathlib import Path
import secrets
import sys

source, prior, destination = map(Path, sys.argv[1:])
values = {}
for number, raw in enumerate(source.read_text().splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if "=" not in line:
        raise SystemExit(f"invalid environment line {number}")
    key, value = line.split("=", 1)
    key = key.strip()
    if key == "OLLAMA_API_KEY":
        if not value or "\n" in value or "\r" in value:
            raise SystemExit("OLLAMA_API_KEY is empty or malformed")
        values[key] = value
if set(values) != {"OLLAMA_API_KEY"}:
    raise SystemExit("exactly OLLAMA_API_KEY must be available")

api_key = None
if prior.is_file():
    for raw in prior.read_text().splitlines():
        if raw.startswith("API_SERVER_KEY="):
            candidate = raw.split("=", 1)[1]
            if len(candidate) >= 32 and all(char.isalnum() or char in "-_" for char in candidate):
                api_key = candidate
            break
if api_key is None:
    api_key = secrets.token_hex(32)

destination.write_text(
    "API_SERVER_ENABLED=true\n"
    "API_SERVER_HOST=0.0.0.0\n"
    "API_SERVER_PORT=8642\n"
    f"API_SERVER_KEY={api_key}\n"
    f"OLLAMA_API_KEY={values['OLLAMA_API_KEY']}\n"
)
PY

jq -e '
  (.credential_pool["ollama-cloud"] | type == "array" and length > 0) and
  all(.credential_pool["ollama-cloud"][];
    .auth_type == "api_key" and
    .source == "env:OLLAMA_API_KEY" and
    .base_url == "https://ollama.com/v1")
' "${SOURCE_AUTH}" >/dev/null
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

install -m 0600 -o root -g root "${tmp_env}" "${RUNTIME_ENV}"
install -m 0600 -o 10000 -g 10000 "${tmp_auth}" "${PROFILE_DIR}/auth.json"
install -m 0400 -o 10000 -g 10000 "${LIB_DIR}/hermes-execution-config.yaml" "${PROFILE_DIR}/config.yaml"
rm -rf "${PROFILE_DIR}/cron-disabled"
install -d -m 0500 -o 10000 -g 10000 "${PROFILE_DIR}/cron-disabled"
install -m 0400 -o 10000 -g 10000 "${LIB_DIR}/hermes-cron-disabled/__init__.py" "${PROFILE_DIR}/cron-disabled/__init__.py"
rm -rf "${PROFILE_DIR}/gh"
rm -f "${PROFILE_DIR}/gitconfig"
install -m 0600 -o root -g root "${LIB_DIR}/hermes-execution-policy.json" "${PROFILE_DIR}/policy.json"
rm -f "${PROFILE_DIR}/.env" "${STATE_DIR}/.env" "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"

if ! docker network inspect "${NETWORK}" >/dev/null 2>&1; then
  docker network create --driver bridge --attachable \
    --label ai.gloops.scope=paperclip-execution "${NETWORK}" >/dev/null
fi

"${LIB_DIR}/verify-hermes-execution-profile.sh" --source
echo 'prepared fail-closed Hermes execution-only profile'
