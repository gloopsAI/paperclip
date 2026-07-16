#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:---source}"
readonly PROFILE_DIR='/opt/paperclip/hermes-handshake-profile'
readonly RUNTIME_ENV='/etc/paperclip-gloops/hermes-execution.env'
readonly UNIT='/usr/local/lib/systemd/system/paperclip-hermes-handshake.service'
readonly EGRESS_UNIT='/usr/local/lib/systemd/system/paperclip-hermes-handshake-egress.service'
readonly TOPOLOGY_INSPECTOR='/usr/local/lib/paperclip-gloops/inspect-hermes-handshake-topology.sh'
readonly GUARD='/usr/local/lib/paperclip-gloops/hermes-handshake-guard/sitecustomize.py'
readonly CRON_PROVIDER="${PROFILE_DIR}/cron-disabled/__init__.py"
readonly CONTAINER='paperclip-hermes-handshake'
readonly IMAGE='sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac'
readonly EGRESS_STATE='/run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE'
readonly INPUT_CHAIN='PCLIP-HS-IN'
readonly FORWARD_CHAIN='PCLIP-HS-FWD'
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

if [[ "$(stat -c '%a:%u:%g' "${CRON_PROVIDER}" 2>/dev/null || true)" == '400:10000:10000' ]] \
  && grep -Fq 'class DisabledCronScheduler(CronScheduler):' "${CRON_PROVIDER}" \
  && grep -Fq 'stop_event.wait()' "${CRON_PROVIDER}"; then
  pass 'handshake cron provider is an exact inert shutdown-only implementation'
else
  fail 'handshake cron provider is absent, mutable, or not inert'
fi

if docker run --rm --pull never --network none --read-only -i \
  --entrypoint /opt/hermes/.venv/bin/python \
  --env PYTHONPATH=/opt/paperclip-handshake-guard \
  --mount "type=bind,src=${PROFILE_DIR}/config.yaml,dst=/config.yaml,readonly" \
  --mount "type=bind,src=${PROFILE_DIR}/cron-disabled,dst=/opt/data/plugins/disabled,readonly" \
  --mount "type=bind,src=${GUARD},dst=/opt/paperclip-handshake-guard/sitecustomize.py,readonly" \
  "${IMAGE}" - /config.yaml <<'PY'
import importlib.util, sys, threading, unittest, yaml
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
spec = importlib.util.spec_from_file_location("disabled", "/opt/data/plugins/disabled/__init__.py")
disabled = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disabled)
scheduler = disabled.DisabledCronScheduler()
assert scheduler.name == "disabled"
stop_event = threading.Event()
stop_event.set()
scheduler.start(stop_event)
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
  .allowedRuntimeEnvironment == ["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY", "API_SERVER_PORT", "OLLAMA_API_KEY", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"] and
  .allowedCredentialFiles == ["/opt/handshake-profile/auth.json", "/opt/data/auth.json"] and
  .forbiddenCapabilities == ["tools", "mcp", "kanban", "cron", "sessions", "repository", "workspace", "github"] and
  .network == {
    "name":"paperclip-handshake", "internal":true, "ipv6":false, "containerDns":"loopback-static-resolv-conf",
    "apiAlias":"hermes-execution", "apiPort":8642, "apiAuthentication":"bearer-key-required",
    "publishedPorts":[], "internetEgress":"single-connect-exact-authority-and-tls-sni-proxy",
    "proxyAuthority":"ollama.com:443", "proxyTlsSni":"ollama.com", "proxyTunnelBudget":1,
    "proxyMaxConnections":4
  } and
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
  '--network paperclip-handshake' '--ip 172.30.241.3' '--network-alias hermes-execution' \
  '--dns 127.0.0.1' 'HTTPS_PROXY=http://172.30.241.1:18080' \
  'src=/usr/local/lib/paperclip-gloops/hermes-handshake-resolv.conf,dst=/etc/resolv.conf,readonly' \
  'src=/opt/paperclip/hermes-handshake-profile/cron-disabled,dst=/opt/data/plugins/disabled,readonly' \
  'BindsTo=paperclip-hermes-handshake-egress.service' \
  '--memory 1024m' '--memory-swap 1024m' '--cpus 1.0' '--pids-limit 256' \
  'h.try_recover_primary_transport._paperclip_handshake_guard' \
  'httpx.Client._send_single_request._paperclip_handshake_guard' \
  'httpx.AsyncClient._send_single_request._paperclip_handshake_guard' \
  'RuntimeMaxSec=900'; do
  grep -Fq -- "${required}" "${UNIT}" || fail "handshake unit is missing: ${required}"
done
for required in \
  'install-hermes-handshake-egress.sh' 'remove-hermes-handshake-egress.sh' \
  'hermes-handshake-egress-proxy.py' \
  '--listen 172.30.241.1 --port 18080' '--max-connections 4' \
  'DynamicUser=yes' 'NoNewPrivileges=yes' 'StopWhenUnneeded=yes' \
  'MemoryMax=128M' 'CPUQuota=50%' 'LimitNOFILE=64' \
  'RuntimeMaxSec=900'; do
  grep -Fq -- "${required}" "${EGRESS_UNIT}" || fail "handshake egress unit is missing: ${required}"
done
if [[ "$(grep -Fxc 'TasksMax=64' "${EGRESS_UNIT}" || true)" -eq 1 ]]; then
  pass 'handshake egress unit declares exactly one 64-task ceiling'
else
  fail 'handshake egress unit task ceiling is missing, duplicated, or not exactly 64'
fi
if [[ -x "${TOPOLOGY_INSPECTOR}" ]]; then
  pass 'handshake topology inspector is installed separately and executable'
else
  fail 'handshake topology inspector is absent or not executable'
fi
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
    if [[ "$(cat "${EGRESS_STATE}")" != $'schema=gloops.hermes-handshake-egress.v2\nnetwork=paperclip-handshake\nsubnet=172.30.241.0/29\ngateway=172.30.241.1\nhermes_ip=172.30.241.3\npaperclip_ip=172.30.241.4\nproxy_port=18080\ninput_chain=PCLIP-HS-IN\nforward_chain=PCLIP-HS-FWD' ]]; then
      fail 'live handshake egress state is malformed'
    elif ! iptables -C INPUT -s 172.30.241.0/29 -m comment --comment paperclip-handshake-input -j "${INPUT_CHAIN}" \
      || ! iptables -C "${INPUT_CHAIN}" -s 172.30.241.3 -d 172.30.241.1 -p tcp --dport 18080 -m comment --comment paperclip-handshake-proxy -j ACCEPT \
      || ! iptables -C "${INPUT_CHAIN}" -m comment --comment paperclip-handshake-host-deny -j REJECT --reject-with icmp-port-unreachable \
      || ! iptables -C DOCKER-USER -s 172.30.241.0/29 -m comment --comment paperclip-handshake-forward -j "${FORWARD_CHAIN}" \
      || ! iptables -C "${FORWARD_CHAIN}" -m conntrack --ctstate ESTABLISHED,RELATED -m comment --comment paperclip-handshake-established -j RETURN \
      || ! iptables -C "${FORWARD_CHAIN}" -s 172.30.241.4 -d 172.30.241.3 -p tcp --dport 8642 -m comment --comment paperclip-handshake-api -j ACCEPT \
      || ! iptables -C "${FORWARD_CHAIN}" -m comment --comment paperclip-handshake-forward-deny -j REJECT --reject-with icmp-port-unreachable; then
      fail 'live handshake egress firewall boundary is incomplete'
    elif [[ "$(iptables -S INPUT | grep -Fc -- "-j ${INPUT_CHAIN}")" -ne 1 ]] \
      || [[ "$(iptables -S DOCKER-USER | grep -Fc -- "-j ${FORWARD_CHAIN}")" -ne 1 ]] \
      || [[ "$(iptables -S "${INPUT_CHAIN}" | grep -c '^-A ')" -ne 2 ]] \
      || [[ "$(iptables -S "${FORWARD_CHAIN}" | grep -c '^-A ')" -ne 3 ]]; then
      fail 'live handshake egress firewall contains unexpected rules'
    elif [[ "$(iptables -S INPUT | grep '^-A ' | head -n 1)" != *"-j ${INPUT_CHAIN}" ]] \
      || [[ "$(iptables -S DOCKER-USER | grep '^-A ' | head -n 1)" != *"-j ${FORWARD_CHAIN}" ]]; then
      fail 'live handshake egress firewall is not first in both host and Docker forwarding policy'
    else
      pass 'live container forwarding is internal-only and host access is limited to the fixed Hermes source and proxy port'
    fi
  fi
  systemctl is-active --quiet paperclip-hermes-handshake-egress.service \
    || fail 'handshake egress proxy service is not active'
  if [[ "$(systemctl show --property=TasksMax --value paperclip-hermes-handshake-egress.service 2>/dev/null || true)" == '64' ]]; then
    pass 'live handshake egress service effective task ceiling is exactly 64'
  else
    fail 'live handshake egress service effective task ceiling is not exactly 64'
  fi
  ss -lntH sport = :18080 | grep -Fq '172.30.241.1:18080' \
    || fail 'handshake egress proxy is not listening only on the isolated bridge gateway'
  if docker network inspect paperclip-handshake | jq -e '
    .[0].Internal == true and .[0].EnableIPv6 == false and
    .[0].IPAM.Config == [{"Subnet":"172.30.241.0/29","Gateway":"172.30.241.1"}] and
    .[0].Options["com.docker.network.bridge.name"] == "pc-hshake0"
  ' >/dev/null; then
    pass 'live handshake network is isolated, IPv4-only, and exact'
  else
    fail 'live handshake network is not the exact internal network'
  fi
  /usr/local/lib/paperclip-gloops/verify-hermes-handshake-egress-boundary.sh \
    || fail 'live executable negative egress proof failed'

  deadline=$((SECONDS + 60))
  health=''
  while ((SECONDS < deadline)); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${CONTAINER}" 2>/dev/null || true)"
    [[ "${health}" == 'healthy' || "${health}" == 'unhealthy' ]] && break
    sleep 2
  done
  [[ "${health}" == 'healthy' ]] || fail 'handshake container did not become healthy'

  cron_logs="$(mktemp)"
  if ! docker logs "${CONTAINER}" >"${cron_logs}" 2>&1; then
    fail 'handshake runtime logs are unavailable for cron-provider verification'
  elif grep -Fq "using built-in ticker" "${cron_logs}"; then
    fail 'handshake runtime fell back to the built-in cron ticker'
  else
    pass 'handshake runtime did not start the built-in cron ticker'
  fi
  rm -f "${cron_logs}"

  inspect="$(mktemp)"
  trap 'rm -f "${inspect}"' EXIT
  docker inspect "${CONTAINER}" >"${inspect}"
  if jq -e '
    .[0].Config.Image == "sha256:d5394064690c323d2ec7e62defc0dd8986be080dcc18489998b2d6edd96b4fac" and
    (.[0].HostConfig.PortBindings == {} or .[0].HostConfig.PortBindings == null) and
    (.[0].Config.Env | index("PYTHONPATH=/opt/paperclip-handshake-guard")) != null and
    (.[0].Config.Env | index("HTTPS_PROXY=http://172.30.241.1:18080")) != null and
    .[0].HostConfig.Dns == ["127.0.0.1"] and
    (.[0].Mounts | map(.Destination) | sort) == ["/etc/resolv.conf", "/opt/data/plugins/disabled", "/opt/handshake-profile/auth.json", "/opt/handshake-profile/config.yaml", "/opt/paperclip-handshake-guard/sitecustomize.py"] and
    (.[0].Mounts | all(.RW == false)) and
    (.[0].Mounts | all(.Destination != "/opt/data/workspace" and .Destination != "/opt/data/sessions" and .Destination != "/opt/data/.config/gh")) and
    .[0].HostConfig.ReadonlyRootfs == true and
    .[0].HostConfig.Memory == 1073741824 and
    .[0].HostConfig.MemorySwap == 1073741824 and
    .[0].HostConfig.PidsLimit == 256 and
    .[0].NetworkSettings.Networks["paperclip-handshake"].IPAddress == "172.30.241.3" and
    (.[0].NetworkSettings.Networks["paperclip-handshake"].Aliases | index("hermes-execution")) != null
  ' "${inspect}" >/dev/null; then
    pass 'live handshake container has read-only source credentials, zero repository/session/GitHub mounts, and no published port'
  else
    fail 'live handshake container drifted from the zero-authority boundary'
  fi
fi

[[ "${failed}" -eq 0 ]]
