#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:---source}"
readonly PROFILE_DIR='/opt/paperclip/hermes-handshake-profile'
readonly RUNTIME_ENV='/etc/paperclip-gloops/hermes-execution.env'
readonly UNIT='/usr/local/lib/systemd/system/paperclip-hermes-handshake.service'
readonly GUARD='/usr/local/lib/paperclip-gloops/hermes-handshake-guard/sitecustomize.py'
readonly CONTAINER='paperclip-hermes-handshake'
readonly IMAGE='sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac'
failed=0

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; failed=1; }

[[ "${MODE}" == '--source' || "${MODE}" == '--live' ]] || {
  echo 'usage: verify-hermes-handshake-profile.sh [--source|--live]' >&2
  exit 2
}

if systemctl is-active --quiet paperclip-hermes-execution.service \
  || docker ps --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-execution'; then
  fail 'general Hermes execution is active; handshake admission is mutually exclusive'
fi
if [[ "${MODE}" == '--source' ]] \
  && { systemctl is-active --quiet paperclip-gloops.service \
    || docker ps --format '{{.Names}}' | grep -Eq '^paperclip-gloops(-handshake)?$'; }; then
  echo 'FAIL every Paperclip control plane must be inactive before the handshake sidecar starts' >&2
  exit 1
fi

mapfile -t env_keys < <(sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' "${RUNTIME_ENV}" 2>/dev/null | sort -u)
if [[ "${env_keys[*]}" == 'API_SERVER_ENABLED API_SERVER_HOST API_SERVER_KEY API_SERVER_PORT OLLAMA_API_KEY' ]]; then
  pass 'handshake environment contains only the API boundary and Ollama credential'
else
  fail "unexpected handshake environment keys: ${env_keys[*]:-none}"
fi

if jq -e '
  (.credential_pool | keys) == ["ollama-cloud"] and
  (.credential_pool["ollama-cloud"] | length > 0) and
  all(.credential_pool["ollama-cloud"][];
    .auth_type == "api_key" and
    .source == "env:OLLAMA_API_KEY" and
    .base_url == "https://ollama.com/v1") and
  (.providers == {}) and
  (.active_provider == "ollama-cloud")
' "${PROFILE_DIR}/auth.json" >/dev/null 2>&1; then
  pass 'handshake credential pool is Ollama-only'
else
  fail 'handshake credential pool is missing, malformed, or over-broad'
fi

if docker run --rm --pull never --network none --read-only -i \
  --entrypoint /opt/hermes/.venv/bin/python \
  --env PYTHONPATH=/opt/paperclip-handshake-guard \
  --mount "type=bind,src=${PROFILE_DIR}/config.yaml,dst=/config.yaml,readonly" \
  --mount "type=bind,src=${GUARD},dst=/opt/paperclip-handshake-guard/sitecustomize.py,readonly" \
  "${IMAGE}" - /config.yaml <<'PY'
import sys, yaml
from hermes_cli.tools_config import _get_platform_tools
from agent import agent_runtime_helpers
import model_tools

config = yaml.safe_load(open(sys.argv[1]))
assert config == {
    "model": {"provider": "ollama-cloud", "default": "kimi-k2.7-code"},
    "platform_toolsets": {"api_server": []},
    "known_plugin_toolsets": {"api_server": ["spotify"]},
    "mcp_servers": {},
    "cron": {"provider": "disabled"},
    "kanban": {"dispatch_in_gateway": False},
    "agent": {"max_turns": 1, "api_max_retries": 1, "verify_on_stop": False},
    "security": {"redact_secrets": True},
    "_config_version": 35,
}
toolsets = sorted(_get_platform_tools(config, "api_server"))
tools = model_tools.get_tool_definitions(enabled_toolsets=toolsets, quiet_mode=True)
assert toolsets == [], toolsets
assert tools == [], tools
guard = agent_runtime_helpers.try_recover_primary_transport
assert getattr(guard, "_paperclip_handshake_guard", False)
assert guard(None, ConnectionError("synthetic transport failure"), retry_count=1, max_retries=1) is False
PY
then
  pass 'exact image resolves zero tools and denies post-ceiling primary transport recovery'
else
  fail 'handshake configuration or total-attempt guard is not enforced by the exact image'
fi

if jq -e '
  .schemaVersion == "gloops.hermes-provider-handshake.v1" and
  .allowedProviders == ["ollama-cloud"] and
  .allowedCredentialFiles == ["/opt/handshake-profile/auth.json", "/opt/data/auth.json"] and
  .forbiddenCapabilities == ["tools", "mcp", "kanban", "cron", "sessions", "repository", "workspace", "github"] and
  .network.publishedPorts == [] and
  .runtime.image == "sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac" and
  .runtime.persistentPaths == [] and
  .runtime.repositoryMounts == [] and
  .runtime.githubCredentials == false and
  .runtime.sessionKeyStrategy == "none" and
  .runtime.providerInvocationBudget == {"maxTurns": 1, "maxProviderAttempts": 1, "maxApplicationAttempts": 1, "maxPrimaryRecoveryAttempts": 0, "maxSdkRetries": 0, "maxToolCalls": 0, "maxWallMs": 900000}
' "${PROFILE_DIR}/policy.json" >/dev/null 2>&1; then
  pass 'formal provider-handshake policy is exact'
else
  fail 'formal provider-handshake policy is missing or malformed'
fi

for required in \
  '--read-only' '--cap-drop ALL' '--security-opt no-new-privileges:true' \
  '--network paperclip-execution' '--network-alias hermes-execution' \
  '--memory 1024m' '--memory-swap 1024m' '--cpus 1.0' '--pids-limit 256' \
  'RuntimeMaxSec=900'; do
  grep -Fq -- "${required}" "${UNIT}" || fail "handshake unit is missing: ${required}"
done
for forbidden in \
  'github-app-credentials.py' '/opt/data/.config/gh' '/opt/data/workspace' \
  '/opt/data/sessions' 'HERMES_KANBAN_TASK' '--publish' '-p '; do
  if grep -Fq -- "${forbidden}" "${UNIT}"; then
    fail "handshake unit contains forbidden authority: ${forbidden}"
  fi
done

if [[ "${MODE}" == '--live' ]]; then
  deadline=$((SECONDS + 60))
  health=''
  while ((SECONDS < deadline)); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${CONTAINER}" 2>/dev/null || true)"
    [[ "${health}" == 'healthy' || "${health}" == 'unhealthy' ]] && break
    sleep 2
  done
  [[ "${health}" == 'healthy' ]] || fail 'handshake container did not become healthy'

  inspect="$(mktemp)"
  trap 'rm -f "${inspect}"' EXIT
  docker inspect "${CONTAINER}" >"${inspect}"
  if jq -e '
    .[0].Config.Image == "sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac" and
    (.[0].HostConfig.PortBindings == {} or .[0].HostConfig.PortBindings == null) and
    (.[0].Config.Env | index("PYTHONPATH=/opt/paperclip-handshake-guard")) != null and
    (.[0].Mounts | map(.Destination) | sort) == ["/opt/handshake-profile/auth.json", "/opt/handshake-profile/config.yaml", "/opt/paperclip-handshake-guard/sitecustomize.py"] and
    (.[0].Mounts | all(.RW == false)) and
    (.[0].Mounts | all(.Destination != "/opt/data/workspace" and .Destination != "/opt/data/sessions" and .Destination != "/opt/data/.config/gh")) and
    .[0].HostConfig.ReadonlyRootfs == true and
    .[0].HostConfig.Memory == 1073741824 and
    .[0].HostConfig.MemorySwap == 1073741824 and
    .[0].HostConfig.PidsLimit == 256 and
    (.[0].NetworkSettings.Networks["paperclip-execution"].Aliases | index("hermes-execution")) != null
  ' "${inspect}" >/dev/null; then
    pass 'live handshake container has read-only source credentials, zero repository/session/GitHub mounts, and no published port'
  else
    fail 'live handshake container drifted from the zero-authority boundary'
  fi
fi

[[ "${failed}" -eq 0 ]]
