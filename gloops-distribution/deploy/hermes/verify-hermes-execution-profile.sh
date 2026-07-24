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
readonly SESSIONS="${STATE_DIR}/sessions"
readonly APPROVED_IMAGE_FILE='/etc/paperclip-gloops/approved-image'
readonly APP_CONFIG='/etc/paperclip-gloops/github-app.json'
readonly APP_KEY='/etc/paperclip-gloops/github-app/private-key.pem'
readonly HERMES_TOKEN='/var/lib/paperclip-gloops/credential-runtime/hermes-github-token'
readonly GITHUB_BROKER_SOCKET='/run/paperclip-github-broker/broker.sock'
readonly GITHUB_BROKER_TOOL='/usr/local/lib/paperclip-gloops/tools/github-push-tool.bundle.cjs'
readonly GITHUB_READ_BROKER_SOCKET='/run/paperclip-github-read-broker/broker.sock'
readonly GITHUB_READ_BROKER_TOOL='/usr/local/lib/paperclip-gloops/tools/github-read-tool.mjs'
readonly PAPERCLIP_TASK_TOOL='/usr/local/lib/paperclip-gloops/tools/paperclip-task.mjs'
readonly APPLY_PATCH_TOOL='/usr/local/lib/paperclip-gloops/tools/apply_patch'
readonly FOCUSED_TEST_TOOL='/usr/local/lib/paperclip-gloops/tools/focused_test'
readonly FOCUSED_TEST_PREFLIGHT='/usr/local/lib/paperclip-gloops/verify-focused-test-runtime.sh'
readonly CRON_PROVIDER="${PROFILE_DIR}/cron-disabled/__init__.py"
readonly TIRITH='/usr/local/lib/paperclip-gloops/tools/tirith'
readonly TIRITH_VERSION='0.3.3'
readonly TIRITH_SHA256='55a15bbcc726a9021c41be0e823878597560c23fec458ced3b804d1cbce19afe'
readonly HERMES_IMAGE='sha256:153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca'
readonly COMMAND_SECURITY_VERIFIER='/usr/local/lib/paperclip-gloops/verify-hermes-command-security-image.sh'
failed=0

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; failed=1; }

[[ "${MODE}" == '--source' || "${MODE}" == '--live' ]] || {
  echo 'usage: verify-hermes-execution-profile.sh [--source|--live]' >&2
  exit 2
}

if systemctl is-active --quiet paperclip-hermes-handshake.service \
  || docker ps --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-handshake'; then
  fail 'Hermes handshake is active; general execution admission is mutually exclusive'
fi

if "${COMMAND_SECURITY_VERIFIER}" "${HERMES_IMAGE}"; then
  pass 'Hermes command scanner remains fail-closed after its circuit breaker opens'
else
  fail 'Hermes command scanner can fail open after its circuit breaker opens'
fi

[[ -f "${RUNTIME_ENV}" ]] || fail 'dedicated credential environment is missing'
if [[ -f "${RUNTIME_ENV}" ]]; then
  mapfile -t env_keys < <(sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' "${RUNTIME_ENV}" | sort -u)
  if [[ "${env_keys[*]}" == 'API_SERVER_ENABLED API_SERVER_HOST API_SERVER_KEY API_SERVER_PORT OLLAMA_API_KEY PAPERCLIP_AGENT_ID PAPERCLIP_API_URL PAPERCLIP_BRIDGE_API_KEY PAPERCLIP_COMPANY_ID' ]]; then
    pass 'dedicated environment contains only the API boundary, Ollama credential, and scoped Paperclip task bridge'
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

if docker run --rm --pull never --network none --read-only -i \
  --entrypoint /opt/hermes/.venv/bin/python \
  --mount "type=bind,src=${PROFILE_DIR}/config.yaml,dst=/config.yaml,readonly" \
  'sha256:153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca' \
  - /config.yaml <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
assert d["model"] == {"provider": "ollama-cloud", "default": "kimi-k2.7-code"}
assert "fallback_providers" not in d
assert d["cron"] == {"provider": "disabled"}
assert d["kanban"] == {"dispatch_in_gateway": False}
assert d["platform_toolsets"] == {"api_server": ["terminal", "skills"]}
assert d["platforms"] == {
    "api_server": {
        "enabled": True,
        "extra": {
            "model_routes": {
                "kimi-k2.7-code:cloud": {
                    "model": "kimi-k2.7-code",
                    "provider": "ollama-cloud",
                },
                "minimax-m3:cloud": {
                    "model": "minimax-m3",
                    "provider": "ollama-cloud",
                },
                "glm-5.2:cloud": {
                    "model": "glm-5.2",
                    "provider": "ollama-cloud",
                },
                "deepseek-v4-flash:cloud": {
                    "model": "deepseek-v4-flash",
                    "provider": "ollama-cloud",
                },
                "qwen3.5:cloud": {
                    "model": "qwen3.5",
                    "provider": "ollama-cloud",
                },
            }
        },
    }
}
assert d["agent"]["max_turns"] == 32 and d["agent"]["verify_on_stop"] is True
assert d["security"] == {
    "redact_secrets": True,
    "tirith_enabled": True,
    "tirith_path": "/opt/data/bin/tirith",
    "tirith_fail_open": False,
}
assert not any(key in d for key in ("plugins", "slack", "moa"))
PY
then
  pass 'model routes, tools, turns, verification, and channel policy are exact'
else
  fail 'Hermes execution configuration violates the allowlist'
fi

if jq -e '
  .schemaVersion == "gloops.hermes-execution-profile.v2" and
  .allowedProviders == ["ollama-cloud"] and
  .allowedRuntimeEnvironment == ["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY", "API_SERVER_PORT", "OLLAMA_API_KEY"] and
  .allowedCredentialEnvironment == ["API_SERVER_KEY", "OLLAMA_API_KEY"] and
  .allowedCredentialFiles == ["/opt/data/auth.json"] and
  .github == {
    "principal": "root-owned-github-app-broker",
    "credentialType": "root-owned-unix-socket-broker",
    "appId": 4307157,
    "installationId": 146796843,
    "repositoryId": 1297008772,
    "allowedRepositories": ["gloopsAI/gloops-paperclip-plugin"],
    "permissions": {"contents":"write","metadata":"read"},
    "credentialMount": "none",
    "maximumLifetimeSeconds": 3600,
    "clientSocket": "/run/paperclip-github-broker/broker.sock",
    "clientTool": "/opt/data/bin/github-push-tool.bundle.cjs",
    "mutationClass": "create_one_branch_ref",
    "maxLeases": 1,
    "maxMutations": 1,
    "branchPattern": "refs/heads/paperclip/<paperclip-run-id>/calibration",
    "darkState": "broker-masked-socket-and-authorization-absent"
  } and
  .grok.mode == "host-cli-only" and
  .grok.apiEnvironmentAllowed == false and
  .network.name == "paperclip-execution" and
  .network.apiAlias == "hermes-execution" and
  .network.apiPort == 8642 and
  .network.apiAuthentication == "bearer-key-required" and
  .network.publishedPorts == [] and
  .runtime.image == "sha256:153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca" and
  .runtime.imageAcquisition == "root-only-content-addressed-archive" and
  .runtime.imageArchive == {
    "path": "/opt/paperclip/release-artifacts/hermes-execution-153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca.tar.zst",
    "sha256": "3cc435332944f18ef2e4ad043c152dfb86eaac560b9be4886876450b2e21d4d2"
  } and
  .runtime.broadHomeMounted == false and
  .runtime.broadEnvironmentSourcedAtRuntime == false and
  .runtime.commandSecurity == {
    "scanner": "tirith",
    "version": "0.3.3",
    "path": "/opt/data/bin/tirith",
    "sha256": "55a15bbcc726a9021c41be0e823878597560c23fec458ced3b804d1cbce19afe",
    "mount": "read-only",
    "autoInstall": false,
    "failureMode": "closed"
  } and
  .runtime.imageCorrection == {
    "baseImage": "hermes-agent-gloops:bounded-runtime-v2@sha256:3fa158ecc7635512e6c0b33d68084de1eae33593ca009225cd2f7fbd7af2902d",
    "scope": "authoritative-route-and-usage-receipts",
    "buildNetwork": "none",
    "sourceLock": "/usr/local/lib/paperclip-gloops/route-receipt/hermes-source-lock.json",
    "behavioralVerification": "63-contract-tests-plus-exact-runtime-projection"
  } and
  .runtime.backgroundExecution == {
    "cronProvider": "disabled",
    "kanbanDispatcher": false,
    "paperclipPluginScheduler": "empty-tables-locked-and-receipted",
    "resumePendingSessions": "empty-directory-precondition",
    "zeroWorkEgress": "deny-before-start-with-zero-attempt-counter"
  } and
  .runtime.providerInvocationBudget == {
    "required": true,
    "maxInputTokens": 30000,
    "maxOutputTokens": 8000,
    "maxTurns": 8,
    "maxToolCalls": 32,
    "maxWallMs": 3600000
  } and
  .runtime.agentHostTurnCeiling == {
    "maxTurns": 32,
    "authority": "outer-safety-ceiling-only",
    "taskBudgetAuthority": "paperclip-execution-admission",
    "explicitTaskEnvelopeMustNotExceed": 32
  } and
  .runtime.gitSafeDirectories == {
    "source": "pinned-image-plus-environment-no-credential-config",
    "paths": [
      "/opt/data/workspace/repos/induct",
      "/opt/data/workspace/controlled-swarm-plugin",
      "/opt/data/workspace/gloops-paperclip-plugin"
    ]
  }
' "${PROFILE_DIR}/policy.json" >/dev/null 2>&1; then
  pass 'formal execution-only policy is installed'
else
  fail 'formal execution-only policy is missing or malformed'
fi

if [[ -d "${SESSIONS}" ]] \
  && ! find "${SESSIONS}" -mindepth 1 -print -quit | grep -q .; then
  pass 'persistent Hermes sessions are empty, so startup continuation is impossible'
else
  fail 'persistent Hermes sessions are absent or could auto-resume on startup'
fi

state_identity_failed=0
for path in cache logs memories sessions; do
  if [[ "$(stat -c '%a:%u:%g' "${STATE_DIR}/${path}" 2>/dev/null || true)" != '700:10000:10000' ]]; then
    fail "persistent Hermes state has unsafe ownership or mode: ${STATE_DIR}/${path}"
    state_identity_failed=1
  fi
done
if [[ "${state_identity_failed}" -eq 0 ]]; then
  pass 'persistent Hermes state is writable only by the fixed Hermes identity'
fi

if [[ "$(stat -c '%a:%U:%G' "${TIRITH}" 2>/dev/null || true)" == '555:root:root' ]] \
  && [[ "$(sha256sum "${TIRITH}" 2>/dev/null | cut -d' ' -f1)" == "${TIRITH_SHA256}" ]] \
  && "${TIRITH}" --version | grep -Fq "${TIRITH_VERSION}"; then
  pass 'pinned Tirith command scanner is immutable and verified before activation'
else
  fail 'pinned Tirith command scanner is absent, mutable, or inexact'
fi

for forbidden in "${PROFILE_DIR}/.env" "${STATE_DIR}/.env"; do
  [[ ! -e "${forbidden}" ]] || fail "forbidden environment file exists: ${forbidden}"
done
mapfile -t profile_entries < <(find "${PROFILE_DIR}" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort)
if [[ "${profile_entries[*]}" == 'auth.json config.yaml cron-disabled policy.json' ]]; then
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
  && [[ "$(stat -c '%a:%u:%g' "${PROFILE_DIR}/cron-disabled" 2>/dev/null || true)" == '500:10000:10000' ]] \
  && [[ "$(stat -c '%a:%u:%g' "${CRON_PROVIDER}" 2>/dev/null || true)" == '400:10000:10000' ]]; then
  pass 'runtime profile is readable only by the fixed Hermes identity and contains no Git credential home'
else
  fail 'runtime profile ownership or modes do not match the fixed Hermes identity'
fi
if jq -e '
  .appId == 4307157 and
  .installationId == 146796843 and
  .repositoryId == 1297008772 and
  .repository == "gloopsAI/gloops-paperclip-plugin" and
  .privateKeyPath == "/etc/paperclip-gloops/github-app/private-key.pem"
' "${APP_CONFIG}" >/dev/null 2>&1 \
  && [[ "$(stat -c '%a:%U:%G' "${APP_CONFIG}" 2>/dev/null || true)" == '600:root:root' ]] \
  && [[ "$(stat -c '%a:%U:%G' "${APP_KEY}" 2>/dev/null || true)" =~ ^(400|600):root:root$ ]]; then
  pass 'root-owned GitHub App identity is restricted to the declared installation and repository'
else
  fail 'GitHub App configuration or private-key protection is invalid'
fi
if [[ ! -e "${HERMES_TOKEN}" && ! -e "${PROFILE_DIR}/gh" && ! -e "${PROFILE_DIR}/gitconfig" ]] \
  && [[ "$(stat -c '%a:%U:%G' "${GITHUB_BROKER_TOOL}" 2>/dev/null || true)" == '555:root:root' ]]; then
  pass 'Hermes receives an immutable broker client and no GitHub installation token or credential config'
else
  fail 'legacy GitHub write authority remains in the Hermes profile'
fi
if [[ "$(stat -c '%a:%U:%G' "${GITHUB_READ_BROKER_TOOL}" 2>/dev/null || true)" == '555:root:root' ]]; then
  pass 'Hermes receives an immutable read-only GitHub evidence client'
else
  fail 'read-only GitHub evidence client is absent or mutable'
fi
if [[ "$(stat -c '%a:%U:%G' "${PAPERCLIP_TASK_TOOL}" 2>/dev/null || true)" == '555:root:root' ]]; then
  pass 'Hermes receives an immutable Paperclip task helper'
else
  fail 'Paperclip task helper is absent or mutable'
fi
if [[ "$(stat -c '%a:%U:%G' "${APPLY_PATCH_TOOL}" 2>/dev/null || true)" == '555:root:root' ]] \
  && "${APPLY_PATCH_TOOL}" --help | grep -Fq 'usage: apply_patch [--diff -]'; then
  pass 'Hermes receives one immutable non-interactive workspace edit primitive'
else
  fail 'Hermes workspace edit primitive is absent, mutable, or unusable'
fi
if [[ "$(stat -c '%a:%U:%G' "${FOCUSED_TEST_TOOL}" 2>/dev/null || true)" == '555:root:root' ]] \
  && "${FOCUSED_TEST_TOOL}" --help | grep -Fq 'usage: focused_test --check' \
  && [[ "$(stat -c '%a:%U:%G' "${FOCUSED_TEST_PREFLIGHT}" 2>/dev/null || true)" == '755:root:root' ]] \
  && grep -Fq 'ExecStartPre=/usr/local/lib/paperclip-gloops/verify-focused-test-runtime.sh' "${UNIT}"; then
  pass 'Hermes receives one immutable non-installing focused-test primitive with activation preflight'
else
  fail 'Hermes focused-test primitive or activation preflight is absent, mutable, or unusable'
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
  '--group-add 985 ' \
  '--tmpfs /run:rw,exec,nosuid,nodev,size=64m' \
  '--tmpfs /opt/data:rw,nosuid,nodev,size=256m,uid=10000,gid=10000,mode=0700' \
  '--cap-drop ALL' \
  '--cap-add CHOWN' \
  '--cap-add DAC_OVERRIDE' \
  '--cap-add SETGID' \
  '--cap-add SETUID' \
  '--security-opt no-new-privileges:true' \
  '--env GIT_CONFIG_COUNT=1 ' \
  '--env GIT_CONFIG_KEY_0=safe.directory ' \
  '--env GIT_CONFIG_VALUE_0=/opt/data/workspace/* ' \
  '--memory 2048m' \
  '--cpus 2.0' \
  '--pids-limit 512' \
  '--env-file /etc/paperclip-gloops/hermes-execution.env'; do
  grep -Fq -- "${required}" "${UNIT}" || fail "unit is missing: ${required}"
done
for required_credential_mount in \
  '--mount type=bind,src=/opt/paperclip/hermes-execution-profile/cron-disabled,dst=/opt/data/plugins/disabled,readonly' \
  '--mount type=bind,src=/run/paperclip-github-broker,dst=/run/paperclip-github-broker' \
  '--mount type=bind,src=/run/paperclip-github-read-broker,dst=/run/paperclip-github-read-broker'; do
  grep -Fq -- "${required_credential_mount}" "${UNIT}" || fail "unit is missing: ${required_credential_mount}"
done
grep -Fq -- '--mount type=bind,src=/usr/local/lib/paperclip-gloops/tools,dst=/opt/data/bin,readonly' "${UNIT}" \
  || fail 'unit is missing the read-only pinned Tirith mount'
if grep -Fq -- 'dst=/opt/data/.config/gh' "${UNIT}" \
  || grep -Fq -- 'dst=/opt/data/.gitconfig' "${UNIT}" \
  || grep -Fq -- 'github-app-credentials.py refresh-hermes' "${UNIT}" \
  || grep -Fq -- 'github-app-credentials.py revoke-hermes' "${UNIT}"; then
  fail 'unit still projects legacy GitHub authority into Hermes'
else
  pass 'unit contains no legacy GitHub credential projection'
fi
for path in cache logs memories sessions; do
  # The trailing space makes this an exact writable mount token and rejects
  # both destination suffix drift and an appended `,readonly` option.
  required_state_mount="--mount type=bind,src=${STATE_DIR}/${path},dst=/opt/data/${path} "
  grep -Fq -- "${required_state_mount}" "${UNIT}" || fail "unit is missing: ${required_state_mount}"
done
if grep -Fq -- '--health-cmd' "${UNIT}" \
  && grep -Fq -- 'gateway run --replace' "${UNIT}"; then
  pass 'unit declares a gateway health check and single-instance replacement'
else
  fail 'unit is missing gateway lifecycle controls'
fi

if grep -Fq 'class DisabledCronScheduler(CronScheduler)' "${CRON_PROVIDER}" \
  && grep -Fq 'stop_event.wait()' "${CRON_PROVIDER}" \
  && ! grep -Eq 'fire_due|on_jobs_changed|reconcile|cron_tick|setInterval|while ' "${CRON_PROVIDER}"; then
  pass 'Hermes cron execution is contained by an inert shutdown-only provider'
else
  fail 'Hermes cron provider is absent or can execute/poll work'
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
    paperclip_owned_probe="${WORKSPACE}/.gloops-paperclip-owned-write-probe"
    trap 'rm -f "${live_env}" "${live_mounts}" "${paperclip_owned_probe}"' EXIT
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${CONTAINER}" >"${live_env}"
    docker inspect --format '{{json .Mounts}}' "${CONTAINER}" >"${live_mounts}"
    if docker exec --user 10000:10000 "${CONTAINER}" git config --get-all safe.directory \
        | awk '
          $0 == "/opt/data/workspace/*" { dynamic=1; next }
          index($0, "/opt/data/workspace/") == 1 { next }
          { invalid=1 }
          END { exit !(dynamic && !invalid) }
        ' \
      && docker exec --user 10000:10000 "${CONTAINER}" \
        git -C /opt/data/workspace/controlled-swarm-plugin status --short >/dev/null; then
      pass 'live Git trust covers dynamically realized repositories under the dedicated workspace root'
    else
      fail 'live Git trust is missing, outside the dedicated workspace root, or unusable for the shared repository'
    fi
    if [[ "$(docker inspect --format '{{json .HostConfig.GroupAdd}}' "${CONTAINER}")" == '["985"]' ]] \
      && docker exec --user 10000:10000 "${CONTAINER}" /usr/bin/id -G \
        | tr ' ' '\n' | grep -Fxq '985'; then
      pass 'live Hermes identity holds only the declared Paperclip workspace supplemental group'
    else
      fail 'live Hermes identity is missing or drifted from supplemental workspace gid 985'
    fi
    install -o 995 -g 985 -m 0664 /dev/null "${paperclip_owned_probe}"
    if docker exec --user 10000:10000 "${CONTAINER}" \
      /opt/hermes/.venv/bin/python -c \
      'from pathlib import Path; p=Path("/opt/data/workspace/.gloops-paperclip-owned-write-probe"); p.write_text("hermes-ok"); raise SystemExit(0 if p.read_text() == "hermes-ok" else 1)' \
      && [[ "$(stat -c '%u:%g:%a' "${paperclip_owned_probe}")" == '995:985:664' ]]; then
      pass 'live Hermes identity can update a Paperclip-owned group-writable workspace file'
    else
      fail 'live Hermes identity cannot update the Paperclip-owned shared workspace path'
    fi
    rm -f "${paperclip_owned_probe}"
    if systemctl is-active --quiet paperclip-github-push-broker.service \
      && [[ "$(stat -c '%a:%u:%g' "${GITHUB_BROKER_SOCKET}" 2>/dev/null || true)" == '660:0:10000' ]] \
      && docker exec --user 10000:10000 "${CONTAINER}" /usr/local/bin/node -e \
        "const fs=require('fs'); process.exit(fs.statSync('${GITHUB_BROKER_SOCKET}').isSocket()?0:1)" \
      && ! grep -Eq '^(GITHUB_TOKEN|GH_TOKEN)=' "${live_env}"; then
      pass 'live Hermes can reach only the authenticated broker socket and observes no GitHub token'
    else
      fail 'live GitHub broker socket boundary is missing, inaccessible, or credential-leaking'
    fi
    if systemctl is-active --quiet paperclip-github-read-broker.service \
      && [[ "$(stat -c '%a:%u:%g' "${GITHUB_READ_BROKER_SOCKET}" 2>/dev/null || true)" == '660:0:10000' ]] \
      && docker exec --user 10000:10000 "${CONTAINER}" /usr/local/bin/node -e \
        "const fs=require('fs'); process.exit(fs.statSync('${GITHUB_READ_BROKER_SOCKET}').isSocket()?0:1)"; then
      pass 'live Hermes can reach the read-only GitHub evidence broker socket'
    else
      fail 'live read-only GitHub evidence broker socket boundary is missing or inaccessible'
    fi
    if grep -Eq '^(ANTHROPIC|OPENROUTER|XAI|GROK|SLACK|AGENTMAIL|SMTP|DISCORD|TELEGRAM)_' "${live_env}"; then
      fail 'forbidden live environment key is present'
    else
      pass 'live environment excludes channels and forbidden providers'
    fi
    if jq -e --arg broad_home '/opt/paperclip/hermes-home' '
      type == "array"
      and all(.[];
        type == "object"
        and (.Type | type) == "string"
        and (.Source | type) == "string"
        and (.Destination | type) == "string"
        and (.RW | type) == "boolean"
      )
      and all(.[];
        .Source != $broad_home
        and ((.Source | startswith($broad_home + "/")) | not)
      )
    ' "${live_mounts}" >/dev/null; then
      pass 'live container mounts only the dedicated profile and state'
    else
      fail 'live mount metadata is invalid or includes the broad Hermes home'
    fi
    if jq -e \
      --arg source '/usr/local/lib/paperclip-gloops/tools' \
      --arg destination '/opt/data/bin' '
        type == "array"
        and ([.[] | select(.Destination == $destination)] | length) == 1
        and any(.[];
          .Type == "bind"
          and .Source == $source
          and .Destination == $destination
          and .RW == false
        )
      ' "${live_mounts}" >/dev/null \
      && docker exec --user 10000:10000 "${CONTAINER}" /opt/data/bin/tirith --version \
        | grep -Fq "${TIRITH_VERSION}" \
      && docker exec --user 10000:10000 "${CONTAINER}" /opt/data/bin/apply_patch --help \
        | grep -Fq 'usage: apply_patch [--diff -]'; then
      pass 'live Tirith scanner is the exact read-only pre-provisioned binary'
      pass 'live workspace edit primitive is exact and read-only'
    else
      fail 'live Tirith scanner or workspace edit primitive is missing, writable, inexact, or unusable'
    fi
    if docker exec --user 10000:10000 "${CONTAINER}" /opt/data/bin/focused_test --help \
      | grep -Fq 'usage: focused_test --check'; then
      pass 'live focused-test primitive is exact and read-only'
    else
      fail 'live focused-test primitive is missing, writable, inexact, or unusable'
    fi
    live_state_mounts_valid=1
    for path in cache logs memories sessions; do
      expected_state_source="${STATE_DIR}/${path}"
      expected_state_destination="/opt/data/${path}"
      if ! jq -e \
        --arg source "${expected_state_source}" \
        --arg destination "${expected_state_destination}" '
          type == "array"
          and ([.[] | select(.Destination == $destination)] | length) == 1
          and any(.[];
            .Type == "bind"
            and .Source == $source
            and .Destination == $destination
            and .RW == true
          )
        ' "${live_mounts}" >/dev/null; then
        fail "live persistent Hermes state mount is missing, duplicated, inexact, or read-only: ${expected_state_source} -> ${expected_state_destination}"
        live_state_mounts_valid=0
      fi
    done
    if [[ "${live_state_mounts_valid}" -eq 1 ]] \
      && docker exec -i --user 10000:10000 "${CONTAINER}" /opt/hermes/.venv/bin/python - <<'PY'
from pathlib import Path

for name in ("cache", "logs", "memories", "sessions"):
    probe = Path("/opt/data") / name / ".gloops-persistent-state-write-probe"
    probe.write_text("ok")
    probe.unlink()
PY
    then
      pass 'live persistent Hermes state mounts are exact and writable only by the fixed Hermes identity'
    else
      fail 'live persistent Hermes state mounts are absent, read-only, or not writable by Hermes'
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
    if [[ "$(docker inspect --format '{{index .HostConfig.Tmpfs "/opt/data"}}' "${CONTAINER}")" == *'uid=10000'* ]] \
      && [[ "$(docker inspect --format '{{index .HostConfig.Tmpfs "/opt/data"}}' "${CONTAINER}")" == *'gid=10000'* ]] \
      && [[ "$(docker inspect --format '{{index .HostConfig.Tmpfs "/opt/data"}}' "${CONTAINER}")" == *'mode=0700'* ]] \
      && docker exec -i --user 10000:10000 "${CONTAINER}" /opt/hermes/.venv/bin/python - <<'PY'
import os
import stat
from pathlib import Path

root = Path("/opt/data")
metadata = root.stat()
assert stat.S_IMODE(metadata.st_mode) == 0o700
assert (metadata.st_uid, metadata.st_gid) == (10000, 10000)
mount_lines = Path("/proc/self/mountinfo").read_text().splitlines()
assert any(
    line.split()[4] == "/opt/data"
    and line.split(" - ", 1)[1].split()[0] == "tmpfs"
    for line in mount_lines
)
probe = root / ".gloops-lifecycle-write-probe"
probe.write_text("ok")
probe.unlink()
PY
    then
      pass 'live Hermes identity exclusively owns the ephemeral lifecycle root'
    else
      fail 'live lifecycle root cannot persist planned-stop state as the Hermes identity'
    fi
    if docker exec --user 10000:10000 --env HOME=/opt/data --env HERMES_HOME=/opt/data \
      "${CONTAINER}" /opt/hermes/.venv/bin/python -c \
      'from cron.scheduler_provider import resolve_cron_scheduler; raise SystemExit(0 if resolve_cron_scheduler().name == "disabled" else 1)' \
      && docker exec --user 10000:10000 "${CONTAINER}" \
        /opt/hermes/.venv/bin/python -c \
        'import pathlib,yaml; d=yaml.safe_load(pathlib.Path("/opt/data/config.yaml").read_text()); raise SystemExit(0 if d.get("kanban") == {"dispatch_in_gateway": False} else 1)'; then
      pass 'live cron and kanban background execution are disabled'
    else
      fail 'live cron or kanban background execution remains enabled'
    fi
    if [[ "$(docker inspect --format '{{.State.Health.Status}}' "${CONTAINER}")" == 'healthy' ]]; then
      pass 'live authenticated API boundary is healthy'
    else
      fail 'live authenticated API boundary is not healthy'
    fi
    observer_image="$(<"${APPROVED_IMAGE_FILE}")"
    if [[ "$(stat -c '%a:%u:%g' "${WORKSPACE}" 2>/dev/null || true)" == '2770:10000:985' ]] \
      && docker run --rm --pull never --user 995:985 --network none --read-only \
        --cap-drop ALL --security-opt no-new-privileges:true \
        --mount "type=bind,src=${WORKSPACE},dst=/workspace" \
        --entrypoint /bin/sh "${observer_image}" -c \
        'set -eu; probe=/workspace/.paperclip-restore-preflight; trap '\''rm -rf "$probe"'\'' EXIT; mkdir "$probe"; printf ok >"$probe/owner"; test "$(cat "$probe/owner")" = ok; rm -rf "$probe"; test -r /workspace/gloops-paperclip-plugin/.git/HEAD'; then
      pass 'live Paperclip identity can use the shared workspace transaction boundary'
    else
      fail 'live execution workspace is not writable by the bounded Paperclip transaction identity'
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
