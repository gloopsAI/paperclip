#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:---source}"
readonly PROFILE_DIR='/opt/paperclip/hermes-handshake-profile'
readonly RUNTIME_ENV='/etc/paperclip-gloops/hermes-execution.env'
readonly UNIT='/usr/local/lib/systemd/system/paperclip-hermes-handshake.service'
readonly GUARD='/usr/local/lib/paperclip-gloops/hermes-handshake-guard/sitecustomize.py'
readonly CONTAINER='paperclip-hermes-handshake'
readonly IMAGE='sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac'
readonly EGRESS_STATE='/run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE'
readonly EGRESS_CHAIN='PCLIP-HSHAKE-EGRESS'
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
import sys, unittest, yaml
import httpx
from hermes_cli.tools_config import _get_platform_tools
from agent import agent_runtime_helpers
from agent.context_compressor import ContextCompressor
import model_tools

config = yaml.safe_load(open(sys.argv[1]))
assert config == {
    "model": {"provider": "ollama-cloud", "default": "kimi-k2.7-code", "context_length": 262144},
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
compressor = ContextCompressor(
    model=config["model"]["default"],
    base_url="https://ollama.com/v1",
    api_key="",
    config_context_length=config["model"]["context_length"],
    provider=config["model"]["provider"],
    quiet_mode=True,
)
assert compressor.context_length == 262144
guard = agent_runtime_helpers.try_recover_primary_transport
assert getattr(guard, "_paperclip_handshake_guard", False)
assert guard(None, ConnectionError("synthetic transport failure"), retry_count=1, max_retries=1) is False
assert getattr(httpx.Client._send_single_request, "_paperclip_handshake_guard", False)
assert getattr(httpx.AsyncClient._send_single_request, "_paperclip_handshake_guard", False)
guard_request = httpx.Client._send_single_request._paperclip_guard_provider_request
assert guard_request is httpx.AsyncClient._send_single_request._paperclip_guard_provider_request
guard_request(httpx.Request("GET", "http://127.0.0.1:8642/v1/models"))
unittest.TestCase().assertRaisesRegex(
    RuntimeError,
    "forbids remote provider transport",
    guard_request,
    httpx.Request("POST", "https://api.x.ai/v1/chat/completions"),
)
guard_request(httpx.Request("POST", "https://ollama.com/v1/chat/completions"))
unittest.TestCase().assertRaisesRegex(
    RuntimeError,
    "one total provider attempt",
    guard_request,
    httpx.Request("POST", "https://ollama.com/api/show"),
)
PY
then
  pass 'exact image resolves zero tools, rejects non-Ollama remote HTTP, and rejects every second provider transport attempt'
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
  'h.try_recover_primary_transport._paperclip_handshake_guard' \
  'httpx.Client._send_single_request._paperclip_handshake_guard' \
  'httpx.AsyncClient._send_single_request._paperclip_handshake_guard' \
  'install-hermes-handshake-egress.sh' \
  'remove-hermes-handshake-egress.sh' \
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
  if [[ "$(stat -c '%a:%U:%G' "${EGRESS_STATE}" 2>/dev/null || true)" != '600:root:root' ]]; then
    fail 'live handshake egress state is absent or not root-protected'
  else
    subnet="$(sed -n 's/^subnet=//p' "${EGRESS_STATE}")"
    ollama_csv="$(sed -n 's/^ollama_ipv4=//p' "${EGRESS_STATE}")"
    policy_sha256="$(sed -n 's/^policy_sha256=//p' "${EGRESS_STATE}")"
    IFS=, read -r -a ollama_ips <<<"${ollama_csv}"
    expected_policy_sha256="$({ printf '%s\n' "${subnet}"; printf '%s\n' "${ollama_ips[@]}"; } | sha256sum | awk '{print $1}')"
    if [[ "$(sed -n 's/^schema=//p' "${EGRESS_STATE}")" != 'gloops.hermes-handshake-egress.v1' ]] \
      || [[ "$(sed -n 's/^network=//p' "${EGRESS_STATE}")" != 'paperclip-execution' ]] \
      || [[ "$(sed -n 's/^chain=//p' "${EGRESS_STATE}")" != "${EGRESS_CHAIN}" ]] \
      || [[ "${policy_sha256}" != "${expected_policy_sha256}" ]] \
      || [[ "$(wc -l <"${EGRESS_STATE}")" -ne 6 ]] \
      || [[ -z "${subnet}" || ${#ollama_ips[@]} -eq 0 ]]; then
      fail 'live handshake egress state is malformed'
    elif ! iptables -C DOCKER-USER -s "${subnet}" -m comment --comment paperclip-hermes-handshake-egress -j "${EGRESS_CHAIN}" \
      || ! iptables -C "${EGRESS_CHAIN}" -d "${subnet}" -m comment --comment paperclip-hermes-handshake-egress -j RETURN \
      || ! iptables -C "${EGRESS_CHAIN}" -m comment --comment paperclip-hermes-handshake-deny -j REJECT --reject-with icmp-port-unreachable; then
      fail 'live handshake egress firewall boundary is incomplete'
    elif [[ "$(iptables -S DOCKER-USER | grep -Fc -- "-j ${EGRESS_CHAIN}")" -ne 1 ]] \
      || [[ "$(iptables -S "${EGRESS_CHAIN}" | grep -c '^-A ')" -ne $((${#ollama_ips[@]} + 2)) ]]; then
      fail 'live handshake egress firewall contains unexpected rules'
    else
      for ip in "${ollama_ips[@]}"; do
        iptables -C "${EGRESS_CHAIN}" -p tcp -d "${ip}" --dport 443 \
          -m comment --comment paperclip-hermes-handshake-ollama -j RETURN \
          || fail "live handshake egress firewall is missing Ollama destination ${ip}:443"
      done
      pass 'live whole-container egress is restricted to the Docker subnet and resolved ollama.com IPv4 destinations on TCP 443'
    fi
  fi

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
