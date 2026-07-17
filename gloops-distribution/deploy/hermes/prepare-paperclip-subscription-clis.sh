#!/usr/bin/env bash
set -euo pipefail

readonly PAPERCLIP_USER="${PAPERCLIP_CLI_USER:-paperclip}"
readonly PAPERCLIP_GROUP="${PAPERCLIP_CLI_GROUP:-paperclip}"
readonly GROK_BINARY="${PAPERCLIP_GROK_BINARY:-/opt/grok-build/bin/grok}"
readonly GROK_HOME="${PAPERCLIP_GROK_HOME:-/home/paperclip/.grok}"
readonly CODEX_INSTALL="${PAPERCLIP_CODEX_INSTALL:-/opt/codex/0.142.5}"
readonly CODEX_SOURCE_HOME="${PAPERCLIP_CODEX_SOURCE_HOME:-/var/lib/codex-runner/.codex}"
readonly CODEX_PROJECTED_HOME="${PAPERCLIP_CODEX_PROJECTED_HOME:-/home/paperclip/.codex}"
readonly TEST_MODE="${PAPERCLIP_CLI_PREPARE_TEST_MODE:-0}"

if [[ "${TEST_MODE}" != '1' && "${EUID}" -ne 0 ]]; then
  echo "run with sudo" >&2
  exit 1
fi
if env | grep -Eq '^(XAI_API_KEY|GROK_API_KEY|GROK_CLI_CHAT_PROXY_BASE_URL|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)='; then
  echo "provider API credentials and proxy overrides are forbidden during subscription CLI projection" >&2
  exit 1
fi

[[ -x "${GROK_BINARY}" ]] || {
  echo "governed Grok CLI is unavailable: ${GROK_BINARY}" >&2
  exit 1
}
[[ -r "${GROK_HOME}/auth.json" ]] || {
  echo "Grok CLI OAuth state is unavailable: ${GROK_HOME}/auth.json" >&2
  exit 1
}
[[ -x "${CODEX_INSTALL}/bin/codex" ]] || {
  echo "governed Codex CLI is unavailable: ${CODEX_INSTALL}/bin/codex" >&2
  exit 1
}
[[ -r "${CODEX_SOURCE_HOME}/auth.json" ]] || {
  echo "Codex ChatGPT subscription state is unavailable: ${CODEX_SOURCE_HOME}/auth.json" >&2
  exit 1
}

install -d -m 0700 -o "${PAPERCLIP_USER}" -g "${PAPERCLIP_GROUP}" "${CODEX_PROJECTED_HOME}"
staged_auth="$(mktemp "${CODEX_PROJECTED_HOME}/.auth.json.XXXXXX")"
trap 'rm -f "${staged_auth}"' EXIT
install -m 0600 -o "${PAPERCLIP_USER}" -g "${PAPERCLIP_GROUP}" \
  "${CODEX_SOURCE_HOME}/auth.json" "${staged_auth}"
mv -f "${staged_auth}" "${CODEX_PROJECTED_HOME}/auth.json"
trap - EXIT

[[ "$(stat -c '%a:%U:%G' "${CODEX_PROJECTED_HOME}/auth.json")" == \
  "600:${PAPERCLIP_USER}:${PAPERCLIP_GROUP}" ]] || {
  echo "projected Codex auth state has unsafe ownership or mode" >&2
  exit 1
}

printf '%s\n' 'PASS Paperclip subscription CLI state is present and API-key routes are absent'
