#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:a3b605c0eeeb73ea1b4813e755f59571234e8640a215cb01523dd2ef7267909d'
failed=0

check_inactive() {
  local unit="$1"
  if systemctl is-active --quiet "${unit}"; then
    echo "FAIL active unit: ${unit}" >&2
    failed=1
  elif systemctl is-failed --quiet "${unit}"; then
    echo "FAIL failed unit requires reconciliation: ${unit}" >&2
    failed=1
  else
    echo "PASS inactive and non-failed unit: ${unit}"
  fi
}

for unit in paperclip.service gloops-runner.service hermes-agent.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service; do
  check_inactive "${unit}"
done

if [[ "$(systemctl is-enabled paperclip-gloops.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-gloops.service is masked"
else
  echo "FAIL paperclip-gloops.service is not masked" >&2
  failed=1
fi

if [[ "$(systemctl is-enabled paperclip-gloops-handshake.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-gloops-handshake.service is masked"
else
  echo "FAIL paperclip-gloops-handshake.service is not masked" >&2
  failed=1
fi

if [[ "$(systemctl is-enabled paperclip-hermes-execution.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-hermes-execution.service is masked"
else
  echo "FAIL paperclip-hermes-execution.service is not masked" >&2
  failed=1
fi

if [[ "$(systemctl is-enabled paperclip-hermes-handshake.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-hermes-handshake.service is masked"
else
  echo "FAIL paperclip-hermes-handshake.service is not masked" >&2
  failed=1
fi

if [[ "$(systemctl is-enabled paperclip-hermes-handshake-egress.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-hermes-handshake-egress.service is masked"
else
  echo "FAIL paperclip-hermes-handshake-egress.service is not masked" >&2
  failed=1
fi

if [[ ! -e /etc/paperclip-gloops/HERMES_EXECUTION_APPROVED ]]; then
  echo "PASS Hermes execution activation marker is absent"
else
  echo "FAIL Hermes execution activation marker exists" >&2
  failed=1
fi

if [[ ! -e /etc/paperclip-gloops/ACTIVATION_APPROVED ]]; then
  echo "PASS activation marker is absent"
else
  echo "FAIL activation marker exists" >&2
  failed=1
fi

if [[ ! -e /etc/paperclip-gloops/HERMES_HANDSHAKE_APPROVED ]]; then
  echo "PASS Hermes handshake activation marker is absent"
else
  echo "FAIL Hermes handshake activation marker exists" >&2
  failed=1
fi

for active_marker in \
  /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE \
  /run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE; do
  if [[ -e "${active_marker}" ]]; then
    echo "FAIL one-use handshake marker remains while dark: ${active_marker}" >&2
    failed=1
  else
    echo "PASS one-use handshake marker is absent: ${active_marker}"
  fi
done

if ! /usr/local/lib/paperclip-gloops/verify-hermes-handshake-live-readiness.py; then
  failed=1
fi

for ephemeral_credential in \
  /var/lib/paperclip-gloops/credential-runtime/hermes-github-token \
  /var/lib/paperclip-gloops/credential-runtime/projector-github-token \
  /var/lib/paperclip-gloops/credential-runtime/projector-token-rotated \
  /var/lib/paperclip-gloops/credential-runtime/mint-intents.json \
  /run/paperclip-gloops/hermes-github-token \
  /run/paperclip-gloops/projector-github-token \
  /run/paperclip-gloops/projector-token-rotated \
  /run/paperclip-gloops/credential-receipt.json \
  /opt/paperclip/hermes-execution-profile/gh/hosts.yml; do
  if [[ -e "${ephemeral_credential}" ]]; then
    echo "FAIL ephemeral GitHub credential remains while dark: ${ephemeral_credential}" >&2
    failed=1
  fi
done
if [[ "${failed}" -eq 0 ]]; then
  echo "PASS no GitHub App installation token remains while dark"
fi
credential_runtime='/var/lib/paperclip-gloops/credential-runtime'
credential_runtime_valid=1
if [[ "$(stat -c '%a:%U:%G' "${credential_runtime}" 2>/dev/null || true)" != '700:root:root' ]]; then
  credential_runtime_valid=0
fi
if find "${credential_runtime}" -mindepth 1 -maxdepth 1 ! -type f -print -quit 2>/dev/null | grep -q .; then
  credential_runtime_valid=0
fi
while IFS= read -r state_file; do
  case "$(basename "${state_file}")" in
    credential-lifecycle.lock|credential-receipt.json|migration-baseline.json) ;;
    *) credential_runtime_valid=0 ;;
  esac
  [[ "$(stat -c '%a:%U:%G' "${state_file}" 2>/dev/null || true)" == '600:root:root' ]] \
    || credential_runtime_valid=0
done < <(find "${credential_runtime}" -mindepth 1 -maxdepth 1 -type f -print 2>/dev/null)
baseline_file="${credential_runtime}/migration-baseline.json"
if [[ ! -f "${baseline_file}" ]] || ! node - "${baseline_file}" <<'NODE'
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (
  JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["basis", "completedAt", "createdAt", "safeAfter", "schemaVersion", "status"]) ||
  value.schemaVersion !== "gloops.github-app-migration-baseline.v1" ||
  value.status !== "complete" ||
  typeof value.createdAt !== "string" ||
  typeof value.safeAfter !== "string" ||
  typeof value.completedAt !== "string" ||
  value.basis !== "expiry-quarantine-completed" ||
  !Number.isFinite(Date.parse(value.createdAt)) ||
  !Number.isFinite(Date.parse(value.safeAfter)) ||
  !Number.isFinite(Date.parse(value.completedAt)) ||
  Date.parse(value.safeAfter) - Date.parse(value.createdAt) < 3900000 ||
  Date.parse(value.completedAt) < Date.parse(value.safeAfter)
) process.exit(1);
NODE
then
  credential_runtime_valid=0
fi
for evidence_file in \
  /var/lib/paperclip-gloops/credential-expiry-history.jsonl \
  /var/lib/paperclip-gloops/credential-expiry-history.lock; do
  if [[ -e "${evidence_file}" ]] \
    && [[ "$(stat -c '%a:%U:%G' "${evidence_file}" 2>/dev/null || true)" != '600:root:root' ]]; then
    credential_runtime_valid=0
  fi
done
if ((credential_runtime_valid == 1)); then
  echo "PASS durable credential cleanup state is root-only"
else
  echo "FAIL durable credential cleanup state is absent, unprotected, or undeclared" >&2
  failed=1
fi
if /usr/local/lib/paperclip-gloops/verify-lifecycle-history.py \
  /var/lib/paperclip-gloops/credential-history.jsonl \
  /var/lib/paperclip-gloops/hermes-stop-history.jsonl \
  /var/lib/paperclip-gloops/credential-expiry-history.jsonl \
  /var/lib/paperclip-gloops/credential-runtime/credential-receipt.json; then
  :
else
  echo "FAIL durable Hermes execution lifecycle evidence is invalid" >&2
  failed=1
fi

if ! firewall_rules="$(iptables -S DOCKER-USER 2>/dev/null)"; then
  echo "FAIL Docker egress-policy chain is unavailable" >&2
  failed=1
elif grep -Fq 'gloops-zero-work-' <<<"${firewall_rules}"; then
  echo "FAIL a zero-work egress proof rule remains installed while dark" >&2
  failed=1
else
  echo "PASS no zero-work egress proof rule remains installed"
fi
if [[ -e /run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE ]]; then
  echo "FAIL Hermes handshake egress state remains while dark" >&2
  failed=1
elif iptables -nL PCLIP-HS-IN >/dev/null 2>&1 \
  || iptables -nL PCLIP-HS-FWD >/dev/null 2>&1 \
  || grep -Fq -- '-j PCLIP-HS-FWD' <<<"${firewall_rules:-}" \
  || iptables -S INPUT 2>/dev/null | grep -Fq -- '-j PCLIP-HS-IN'; then
  echo "FAIL Hermes handshake egress firewall policy remains while dark" >&2
  failed=1
else
  echo "PASS no Hermes handshake egress policy remains while dark"
fi
if docker network inspect paperclip-handshake >/dev/null 2>&1; then
  echo "FAIL isolated handshake network remains while dark" >&2
  failed=1
else
  echo "PASS isolated handshake network is absent while dark"
fi

if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "PASS exact image digest is installed"
else
  echo "FAIL exact image digest is missing" >&2
  failed=1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-gloops'; then
  echo "FAIL paperclip-gloops container exists" >&2
  failed=1
else
  echo "PASS no paperclip-gloops container exists"
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-gloops-handshake'; then
  echo "FAIL paperclip-gloops-handshake container exists" >&2
  failed=1
else
  echo "PASS no paperclip-gloops-handshake container exists"
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-execution'; then
  echo "FAIL paperclip-hermes-execution container exists" >&2
  failed=1
else
  echo "PASS no paperclip-hermes-execution container exists"
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-handshake'; then
  echo "FAIL paperclip-hermes-handshake container exists" >&2
  failed=1
else
  echo "PASS no paperclip-hermes-handshake container exists"
fi

if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)(3100|8642|18080)$'; then
  echo "FAIL Paperclip or Hermes execution HTTP port is listening" >&2
  failed=1
else
  echo "PASS no Paperclip or Hermes execution HTTP listener exists"
fi

serve_status="$(mktemp)"
trap 'rm -f "${serve_status}"' EXIT
tailscale serve status --json >"${serve_status}"
if node - "${serve_status}" <<'NODE'
const { readFileSync } = require("node:fs");
const status = JSON.parse(readFileSync(process.argv[2], "utf8"));
const endpoint = "ubuntu-hermes-nyc1.taild219d6.ts.net:8443";
if (status.TCP?.["8443"]?.HTTPS !== true) process.exit(1);
if (status.Web?.[endpoint]?.Handlers?.["/"]?.Proxy !== "http://127.0.0.1:3100") process.exit(1);
if (status.AllowFunnel?.[endpoint] === true) process.exit(1);
NODE
then
  echo "PASS tailnet-only HTTPS 8443 is configured without Funnel"
else
  echo "FAIL tailnet-only HTTPS 8443 configuration is missing or public" >&2
  failed=1
fi

if systemctl list-timers --all --no-legend | grep -Ei 'paperclip|gloops-(runner|exec|watchdog)|hermes-agent'; then
  echo "FAIL a Paperclip-related timer is scheduled" >&2
  failed=1
else
  echo "PASS no Paperclip-related timer is scheduled"
fi

if systemctl list-unit-files --type=service --no-legend | grep -E 'paperclip|gloops-runner|hermes-agent' | grep -Ev '(disabled|masked|static)'; then
  echo "FAIL a Paperclip-related service is enabled" >&2
  failed=1
else
  echo "PASS Paperclip-related services are disabled, masked, or static"
fi

if grep -RIEq 'paperclip|gloops-(runner|exec|watchdog)|hermes-agent' /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly /var/spool/cron/crontabs 2>/dev/null; then
  echo "FAIL a Paperclip-related cron entry exists" >&2
  failed=1
else
  echo "PASS no Paperclip-related cron entry exists"
fi

if command -v atq >/dev/null && atq | grep -q .; then
  echo "FAIL queued at jobs exist and require operator classification" >&2
  failed=1
else
  echo "PASS no queued at jobs exist"
fi

if pgrep -u paperclip >/dev/null \
  || pgrep -x gloops-runner >/dev/null \
  || pgrep -x hermes-agent >/dev/null; then
  echo "FAIL a Paperclip-related process exists" >&2
  failed=1
else
  echo "PASS no Paperclip-related process exists"
fi

provider_config=(
  /etc/paperclip-gloops
  /usr/local/lib/systemd/system/paperclip-gloops.service
  /etc/gloops-runner.env
  /etc/hermes-agent.env
  /opt/paperclip/hermes-home/.env
  /opt/paperclip/hermes-home/config.yaml
  /opt/paperclip/grok-shared-runner/runner.env
  /root/.hermes/config.yaml
  /root/.hermes/.env
)
existing_provider_config=()
for path in "${provider_config[@]}"; do
  [[ -e "${path}" ]] && existing_provider_config+=("${path}")
done
if ((${#existing_provider_config[@]} > 0)) \
  && grep -RIEq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)=' "${existing_provider_config[@]}"; then
  echo "FAIL Grok/xAI API configuration is present" >&2
  failed=1
else
  echo "PASS no Grok/xAI API configuration is present"
fi

if [[ -x /opt/grok-build/bin/grok ]]; then
  echo "PASS governed Grok CLI is available outside the control-plane container"
else
  echo "FAIL governed Grok CLI is unavailable" >&2
  failed=1
fi

if grep -Fxq 'PAPERCLIP_MTE_ENABLED=false' /etc/paperclip-gloops/runtime.env \
  && ! find /opt/paperclip/plugins -mindepth 1 -maxdepth 2 -type d -iname '*mte*' -print -quit | grep -q .; then
  echo "PASS Maximum Token Efficiency remains default-off and uninstalled"
else
  echo "FAIL Maximum Token Efficiency is not provably default-off" >&2
  failed=1
fi

if grep -Fxq 'PAPERCLIP_EXECUTION_ADMISSION_ENABLED=true' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK=1' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=0' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK=50000' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK=16000' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK=3600000' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION=30000' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION=8000' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION=8' /etc/paperclip-gloops/runtime.env \
  && grep -Fxq 'PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION=32' /etc/paperclip-gloops/runtime.env; then
  echo "PASS exact bounded-pilot task and provider-invocation execution envelope is installed"
else
  echo "FAIL exact bounded-pilot execution envelope is missing or has drifted" >&2
  failed=1
fi

unit_file='/usr/local/lib/systemd/system/paperclip-gloops.service'
for required in \
  '--read-only' \
  '--cap-drop ALL' \
  '--security-opt no-new-privileges:true' \
  '--memory 1536m' \
  '--memory-swap 1536m' \
  '--cpus 2.0' \
  '--pids-limit 512' \
  '--log-opt max-size=10m' \
  '--log-opt max-file=3' \
  '--mount type=bind,src=/opt/paperclip/hermes-execution-state/workspace,dst=/opt/data/workspace,readonly'; do
  if ! grep -Fq -- "${required}" "${unit_file}"; then
    echo "FAIL missing resource/security bound: ${required}" >&2
    failed=1
  fi
done
if [[ "${failed}" -eq 0 ]]; then
  echo "PASS resource and container-security bounds are installed"
fi

if [[ "$(stat -c '%a:%u:%g' /opt/paperclip/hermes-execution-state/workspace 2>/dev/null || true)" == '750:10000:985' ]]; then
  echo "PASS host execution workspace is readable only by the Paperclip observer group"
else
  echo "FAIL host execution workspace observation permissions are not bounded" >&2
  failed=1
fi

if /usr/local/lib/paperclip-gloops/verify-hermes-execution-profile.sh --source; then
  echo "PASS Hermes execution-only profile is installed"
else
  echo "FAIL Hermes execution-only profile is invalid" >&2
  failed=1
fi

if /usr/local/lib/paperclip-gloops/verify-hermes-handshake-profile.sh --source; then
  echo "PASS Hermes provider-handshake profile is installed"
else
  echo "FAIL Hermes provider-handshake profile is invalid" >&2
  failed=1
fi

exit "${failed}"
