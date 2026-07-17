#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

user="$(id -un)"
group="$(id -gn)"
mkdir -p \
  "${tmp}/grok-home" \
  "${tmp}/codex-install/bin" \
  "${tmp}/codex-source" \
  "${tmp}/codex-projected"
printf '#!/bin/sh\nexit 0\n' >"${tmp}/grok"
printf '#!/bin/sh\nexit 0\n' >"${tmp}/codex-install/bin/codex"
chmod 0755 "${tmp}/grok" "${tmp}/codex-install/bin/codex"
printf '{"auth_mode":"oidc"}\n' >"${tmp}/grok-home/auth.json"
printf '{"auth_mode":"chatgpt"}\n' >"${tmp}/codex-source/auth.json"

PAPERCLIP_CLI_PREPARE_TEST_MODE=1 \
PAPERCLIP_CLI_USER="${user}" \
PAPERCLIP_CLI_GROUP="${group}" \
PAPERCLIP_GROK_BINARY="${tmp}/grok" \
PAPERCLIP_GROK_HOME="${tmp}/grok-home" \
PAPERCLIP_CODEX_INSTALL="${tmp}/codex-install" \
PAPERCLIP_CODEX_SOURCE_HOME="${tmp}/codex-source" \
PAPERCLIP_CODEX_PROJECTED_HOME="${tmp}/codex-projected" \
  "${script_dir}/prepare-paperclip-subscription-clis.sh" >/dev/null

cmp "${tmp}/codex-source/auth.json" "${tmp}/codex-projected/auth.json"
[[ "$(stat -c '%a' "${tmp}/codex-projected/auth.json")" == '600' ]]

if XAI_API_KEY=forbidden \
  PAPERCLIP_CLI_PREPARE_TEST_MODE=1 \
  PAPERCLIP_CLI_USER="${user}" \
  PAPERCLIP_CLI_GROUP="${group}" \
  PAPERCLIP_GROK_BINARY="${tmp}/grok" \
  PAPERCLIP_GROK_HOME="${tmp}/grok-home" \
  PAPERCLIP_CODEX_INSTALL="${tmp}/codex-install" \
  PAPERCLIP_CODEX_SOURCE_HOME="${tmp}/codex-source" \
  PAPERCLIP_CODEX_PROJECTED_HOME="${tmp}/codex-projected" \
    "${script_dir}/prepare-paperclip-subscription-clis.sh" >/dev/null 2>&1; then
  echo "subscription CLI projection accepted a forbidden xAI API credential" >&2
  exit 1
fi

rm -f "${tmp}/codex-source/auth.json"
if PAPERCLIP_CLI_PREPARE_TEST_MODE=1 \
  PAPERCLIP_CLI_USER="${user}" \
  PAPERCLIP_CLI_GROUP="${group}" \
  PAPERCLIP_GROK_BINARY="${tmp}/grok" \
  PAPERCLIP_GROK_HOME="${tmp}/grok-home" \
  PAPERCLIP_CODEX_INSTALL="${tmp}/codex-install" \
  PAPERCLIP_CODEX_SOURCE_HOME="${tmp}/codex-source" \
  PAPERCLIP_CODEX_PROJECTED_HOME="${tmp}/codex-projected" \
    "${script_dir}/prepare-paperclip-subscription-clis.sh" >/dev/null 2>&1; then
  echo "subscription CLI projection accepted missing Codex subscription state" >&2
  exit 1
fi

grep -Fq 'unset OPENAI_API_KEY' "${script_dir}/paperclip-codex-container"
grep -Fq 'unset CODEX_API_KEY' "${script_dir}/paperclip-codex-container"
grep -Fq 'unset CODEX_ACCESS_TOKEN' "${script_dir}/paperclip-codex-container"
grep -Fq 'exec /opt/codex/0.142.5/bin/codex "$@"' "${script_dir}/paperclip-codex-container"

printf '%s\n' 'PASS Paperclip subscription CLI projection tests'
