#!/usr/bin/env bash
set -euo pipefail

readonly MODE="${1:---source}"
readonly PROFILE_DIR='/opt/paperclip/hermes-execution-profile'
readonly STATE_DIR='/opt/paperclip/hermes-execution-state'
readonly RUNTIME_ENV='/etc/paperclip-gloops/hermes-execution.env'
readonly UNIT='/usr/local/lib/systemd/system/paperclip-hermes-execution.service'
readonly CONTAINER='paperclip-hermes-execution'
readonly NETWORK='paperclip-execution'
readonly API_PORT='8642'
readonly WORKSPACE="${STATE_DIR}/workspace"
readonly APPROVED_IMAGE_FILE='/etc/paperclip-gloops/approved-image'
failed=0

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; failed=1; }

[[ "${MODE}" == '--source' || "${MODE}" == '--live' ]] || {
  echo 'usage: verify-hermes-execution-profile.sh [--source|--live]' >&2
  exit 2
}

[[ -f "${RUNTIME_ENV}" ]] || fail 'dedicated credential environment is missing'
if [[ -f "${RUNTIME_ENV}" ]]; then
  mapfile -t env_keys < <(sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' "${RUNTIME_ENV}" | sort -u)
  if [[ "${env_keys[*]}" == 'API_SERVER_ENABLED API_SERVER_HOST API_SERVER_KEY API_SERVER_PORT OLLAMA_API_KEY' ]]; then
    pass 'dedicated environment contains only the API boundary and Ollama credential'
  else
    fail "unexpected dedicated environment keys: ${env_keys[*]:-none}"
  fi
  if grep -Fxq 'API_SERVER_ENABLED=true' "${RUNTIME_ENV}" \
    && grep -Fxq 'API_SERVER_HOST=0.0.0.0' "${RUNTIME_ENV}" \
    && grep -Fxq "API_SERVER_PORT=${API_PORT}" "${RUNTIME_ENV}" \
    && awk -F= '$1 == "API_SERVER_KEY" && length($2) >= 32 { found=1 } END { exit !found }' "${RUNTIME_ENV}"; then
    pass 'authenticated inter-container API boundary is explicit'
  else
    fail 'authenticated inter-container API boundary is missing or weak'
  fi
fi

if jq -e '
  (.credential_pool | keys) == ["ollama-cloud"] and
  (.credential_pool["ollama-cloud"] | length > 0) and
  all(.credential_pool["ollama-cloud"][];
    .auth_type == "api_key" and
    .source == "env:OLLAMA_API_KEY" and
    .base_url == "https://ollama.com/v1" and
    ((keys - ["auth_type", "base_url", "id", "label", "last_error_code", "last_error_message", "last_error_reason", "last_error_reset_at", "last_status", "last_status_at", "priority", "request_count", "secret_fingerprint", "source"]) | length == 0)) and
  (.providers == {}) and
  (.active_provider == "ollama-cloud")
' "${PROFILE_DIR}/auth.json" >/dev/null 2>&1; then
  pass 'credential pool is limited to Ollama Cloud with no fallback credential'
else
  fail 'credential pool is missing, malformed, or over-broad'
fi

if docker run --rm --network none --read-only -i \
  --entrypoint /opt/hermes/.venv/bin/python \
  --mount "type=bind,src=${PROFILE_DIR}/config.yaml,dst=/config.yaml,readonly" \
  'hermes-agent@sha256:c58e0672b554d9a240bae881660a0294818f08f9523c9c512a1dadfdac6dae78' \
  - /config.yaml <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
assert d["model"] == {"provider": "ollama-cloud", "default": "kimi-k2.7-code"}
assert "fallback_providers" not in d
assert d["agent"]["max_turns"] == 8 and d["agent"]["verify_on_stop"] is True
assert d["security"]["redact_secrets"] is True and d["security"]["tirith_fail_open"] is False
assert not any(key in d for key in ("plugins", "slack", "platforms", "moa"))
PY
then
  pass 'model, turn, verification, and channel policy is exact'
else
  fail 'Hermes execution configuration violates the allowlist'
fi

if jq -e '
  .schemaVersion == "gloops.hermes-execution-profile.v1" and
  .allowedProviders == ["ollama-cloud"] and
  .allowedRuntimeEnvironment == ["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY", "API_SERVER_PORT", "OLLAMA_API_KEY"] and
  .allowedCredentialEnvironment == ["API_SERVER_KEY", "OLLAMA_API_KEY"] and
  .allowedCredentialFiles == ["/opt/data/auth.json", "/opt/data/.config/gh/hosts.yml"] and
  .github == {
    "principal": "zach-hermes",
    "allowedRepositories": ["gloopsAI/paperclip"],
    "minimumPermission": "push",
    "credentialMount": "read-only"
  } and
  .grok.mode == "host-cli-only" and
  .grok.apiEnvironmentAllowed == false and
  .network.name == "paperclip-execution" and
  .network.apiAlias == "hermes-execution" and
  .network.apiPort == 8642 and
  .network.apiAuthentication == "bearer-key-required" and
  .network.publishedPorts == [] and
  .runtime.image == "hermes-agent@sha256:c58e0672b554d9a240bae881660a0294818f08f9523c9c512a1dadfdac6dae78" and
  .runtime.imageAcquisition == "preprovisioned-local-digest" and
  .runtime.broadHomeMounted == false and
  .runtime.broadEnvironmentSourcedAtRuntime == false and
  .runtime.providerInvocationBudget == {
    "required": true,
    "maxInputTokens": 30000,
    "maxOutputTokens": 8000,
    "maxTurns": 8,
    "maxToolCalls": 32,
    "maxWallMs": 3600000
  }
' "${PROFILE_DIR}/policy.json" >/dev/null 2>&1; then
  pass 'formal execution-only policy is installed'
else
  fail 'formal execution-only policy is missing or malformed'
fi

for forbidden in "${PROFILE_DIR}/.env" "${STATE_DIR}/.env"; do
  [[ ! -e "${forbidden}" ]] || fail "forbidden environment file exists: ${forbidden}"
done
mapfile -t profile_entries < <(find "${PROFILE_DIR}" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort)
if [[ "${profile_entries[*]}" == 'auth.json config.yaml gh gitconfig policy.json' ]] \
  && [[ "$(find "${PROFILE_DIR}/gh" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort | paste -sd ' ' -)" == 'config.yml hosts.yml' ]]; then
  pass 'execution profile contains only declared credential and policy artifacts'
else
  fail "execution profile contains undeclared artifacts: ${profile_entries[*]:-none}"
fi
for protected_file in "${RUNTIME_ENV}" "${PROFILE_DIR}/policy.json"; do
  if [[ "$(stat -c '%a:%U:%G' "${protected_file}" 2>/dev/null || true)" == '600:root:root' ]]; then
    pass "root-only file is protected: ${protected_file}"
  else
    fail "root-only file has unsafe ownership or mode: ${protected_file}"
  fi
done
if [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/auth.json" 2>/dev/null || true)" == '600:10000:10000' ]] \
  && [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/config.yaml" 2>/dev/null || true)" == '400:10000:10000' ]] \
  && [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/gh" 2>/dev/null || true)" == '500:10000:10000' ]] \
  && [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/gh/config.yml" 2>/dev/null || true)" == '400:10000:10000' ]] \
  && [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/gh/hosts.yml" 2>/dev/null || true)" == '400:10000:10000' ]] \
  && [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/gitconfig" 2>/dev/null || true)" == '400:10000:10000' ]]; then
  pass 'runtime profile is readable only by the fixed Hermes identity'
else
  fail 'runtime profile ownership or modes do not match the fixed Hermes identity'
fi
if [[ "$(GH_CONFIG_DIR="${PROFILE_DIR}/gh" gh api user --jq .login 2>/dev/null || true)" == 'zach-hermes' ]]; then
  pass 'dedicated GitHub credential resolves to the declared service identity'
else
  fail 'dedicated GitHub service identity is missing'
fi

if grep -Fq '/opt/paperclip/hermes-home' "${UNIT}" \
  || grep -Eq -- '--publish|-p[ =]' "${UNIT}"; then
  fail 'unit mounts the broad home or publishes a port'
else
  pass 'unit has no broad-home mount or published port'
fi
for required in \
  '--network paperclip-execution' \
  '--read-only' \
  '--tmpfs /run:rw,exec,nosuid,nodev,size=64m' \
  '--cap-drop ALL' \
  '--cap-add CHOWN' \
  '--cap-add DAC_OVERRIDE' \
  '--cap-add SETGID' \
  '--cap-add SETUID' \
  '--security-opt no-new-privileges:true' \
  '--memory 2048m' \
  '--cpus 2.0' \
  '--pids-limit 512' \
  '--env-file /etc/paperclip-gloops/hermes-execution.env'; do
  grep -Fq -- "${required}" "${UNIT}" || fail "unit is missing: ${required}"
done
for required_credential_mount in \
  '--mount type=bind,src=/opt/paperclip/hermes-execution-profile/gh,dst=/opt/data/.config/gh,readonly' \
  '--mount type=bind,src=/opt/paperclip/hermes-execution-profile/gitconfig,dst=/opt/data/.gitconfig,readonly'; do
  grep -Fq -- "${required_credential_mount}" "${UNIT}" || fail "unit is missing: ${required_credential_mount}"
done
if grep -Fq -- '--health-cmd' "${UNIT}" \
  && grep -Fq -- 'gateway run --replace' "${UNIT}"; then
  pass 'unit declares a gateway health check and single-instance replacement'
else
  fail 'unit is missing gateway lifecycle controls'
fi

if docker network inspect "${NETWORK}" >/dev/null 2>&1; then
  pass 'dedicated execution network exists'
else
  fail 'dedicated execution network is missing'
fi

if env -u XAI_API_KEY -u GROK_API_KEY timeout 10 /opt/grok-build/bin/grok --version >/dev/null 2>&1 \
  && ! grep -RIEq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)=' \
    "${RUNTIME_ENV}" "${PROFILE_DIR}" \
  && ! grep -Eiq '(api\.x\.ai|(^|[[:space:]])provider:[[:space:]]*(xai|grok)|(^|[[:space:]])base_url:.*x\.ai)' \
    "${PROFILE_DIR}/config.yaml"; then
  pass 'Grok is host-CLI-only with no API configuration'
else
  fail 'Grok CLI is unavailable or API configuration is present'
fi

if [[ "${MODE}" == '--live' ]]; then
  if ! docker inspect "${CONTAINER}" >/dev/null 2>&1; then
    fail 'live execution sidecar is missing'
  else
    live_env="$(mktemp)"
    live_mounts="$(mktemp)"
    trap 'rm -f "${live_env}" "${live_mounts}"' EXIT
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${CONTAINER}" >"${live_env}"
    docker inspect --format '{{range .Mounts}}{{println .Source " -> " .Destination " (" .RW ")"}}{{end}}' "${CONTAINER}" >"${live_mounts}"
    if docker exec --user 10000:10000 --env HOME=/opt/data "${CONTAINER}" \
      sh -lc '[ "$(gh api user --jq .login)" = "zach-hermes" ] && gh api repos/gloopsAI/paperclip --jq "select(.private == false and .permissions.push == true)" >/dev/null'; then
      pass 'live GitHub identity has write access to the declared public pilot boundary'
    else
      fail 'live GitHub identity or pilot repository write access is missing'
    fi
    if grep -Eq '^(ANTHROPIC|OPENROUTER|XAI|GROK|SLACK|AGENTMAIL|SMTP|DISCORD|TELEGRAM)_' "${live_env}"; then
      fail 'forbidden live environment key is present'
    else
      pass 'live environment excludes channels and forbidden providers'
    fi
    if grep -Fq '/opt/paperclip/hermes-home' "${live_mounts}"; then
      fail 'live container mounts the broad Hermes home'
    else
      pass 'live container mounts only the dedicated profile and state'
    fi
    if [[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "${CONTAINER}")" == "${NETWORK}" ]]; then
      pass 'live container uses the dedicated network'
    else
      fail 'live container uses the wrong network'
    fi
    port_bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "${CONTAINER}")"
    if [[ "${port_bindings}" == 'null' || "${port_bindings}" == '{}' ]]; then
      pass 'live container publishes no host ports'
    else
      fail 'live container publishes a host port'
    fi
    if docker exec "${CONTAINER}" test ! -e /opt/data/.env; then
      pass 'live home has no environment file'
    else
      fail 'live home contains an environment file'
    fi
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}")" == 'healthy' ]]; then
      pass 'live authenticated API boundary is healthy'
    else
      fail 'live authenticated API boundary is not healthy'
    fi
    observer_image="$(<"${APPROVED_IMAGE_FILE}")"
    if [[ "$(stat -c '%a:%u:%g' "${WORKSPACE}" 2>/dev/null || true)" == '750:10000:985' ]] \
      && docker run --rm --pull never --user 995:985 --network none --read-only \
        --cap-drop ALL --security-opt no-new-privileges:true \
        --mount "type=bind,src=${WORKSPACE},dst=/workspace,readonly" \
        --entrypoint /bin/sh "${observer_image}" -c \
        'test -r /workspace/paperclip/.git/HEAD'; then
      pass 'live Paperclip observer can read the exact pilot repository'
    else
      fail 'live execution workspace is not readable by the bounded Paperclip observer'
    fi
    if docker exec -i "${CONTAINER}" python - <<'PY'
import urllib.error
import urllib.request

try:
    urllib.request.urlopen("http://127.0.0.1:8642/v1/models", timeout=3)
except urllib.error.HTTPError as error:
    raise SystemExit(0 if error.code == 401 else 1)
raise SystemExit(1)
PY
    then
      pass 'live API rejects unauthenticated execution-plane access'
    else
      fail 'live API does not reject unauthenticated execution-plane access'
    fi
  fi
fi

exit "${failed}"
