#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:4ad5881969635daec4194f7bb78df22a1768df4f74f574cc935647d24750a23d'
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

for unit in paperclip.service gloops-runner.service hermes-agent.service paperclip-gloops.service paperclip-hermes-execution.service; do
  check_inactive "${unit}"
done

if [[ "$(systemctl is-enabled paperclip-gloops.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-gloops.service is masked"
else
  echo "FAIL paperclip-gloops.service is not masked" >&2
  failed=1
fi

if [[ "$(systemctl is-enabled paperclip-hermes-execution.service 2>/dev/null || true)" == "masked" ]]; then
  echo "PASS paperclip-hermes-execution.service is masked"
else
  echo "FAIL paperclip-hermes-execution.service is not masked" >&2
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

for ephemeral_credential in \
  /run/paperclip-gloops/hermes-github-token \
  /run/paperclip-gloops/projector-github-token \
  /run/paperclip-gloops/projector-token-rotated \
  /opt/paperclip/hermes-execution-profile/gh/hosts.yml; do
  if [[ -e "${ephemeral_credential}" ]]; then
    echo "FAIL ephemeral GitHub credential remains while dark: ${ephemeral_credential}" >&2
    failed=1
  fi
done
if [[ "${failed}" -eq 0 ]]; then
  echo "PASS no GitHub App installation token remains while dark"
fi
if [[ -f /run/paperclip-gloops/credential-receipt.json ]]; then
  if jq -e '
    .schemaVersion == "gloops.github-app-credential-receipt.v1" and
    (.hermes.revokedAt | type == "string") and
    (.projector.revokedAt | type == "string") and
    (.hermes.tokenFingerprint | test("^[0-9a-f]{64}$")) and
    (.projector.tokenFingerprint | test("^[0-9a-f]{64}$")) and
    (.receiptDigest | test("^[0-9a-f]{64}$"))
  ' /run/paperclip-gloops/credential-receipt.json >/dev/null; then
    echo "PASS GitHub App credential receipt records both successful revocations"
  else
    echo "FAIL GitHub App credential receipt is incomplete while dark" >&2
    failed=1
  fi
fi
if [[ -s /var/lib/paperclip-gloops/credential-history.jsonl ]] \
  && jq -se '
    all(.[];
      .schemaVersion == "gloops.github-app-credential-receipt.v1" and
      (.lifecycleId | type == "string") and
      (.hermes.revokedAt | type == "string") and
      (.projector.revokedAt | type == "string") and
      (.receiptDigest | test("^[0-9a-f]{64}$")))
  ' /var/lib/paperclip-gloops/credential-history.jsonl >/dev/null \
  && python3 - /var/lib/paperclip-gloops/credential-history.jsonl <<'PY'
import hashlib, json, pathlib, sys
prior = None
seen = set()
for sequence, line in enumerate(pathlib.Path(sys.argv[1]).read_text().splitlines(), 1):
    record = json.loads(line)
    digest = record.pop("receiptDigest")
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256(canonical.encode()).hexdigest() == digest
    assert record["sequence"] == sequence
    assert record["previousReceiptDigest"] == prior
    assert record["lifecycleId"] not in seen
    seen.add(record["lifecycleId"])
    prior = digest
PY
then
  echo "PASS append-only GitHub credential lifecycle history is complete"
elif [[ -f /run/paperclip-gloops/credential-receipt.json ]]; then
  echo "FAIL GitHub credential lifecycle history is absent or malformed" >&2
  failed=1
fi
if [[ -s /var/lib/paperclip-gloops/hermes-stop-history.jsonl ]] \
  && jq -se '
    all(.[];
      .schemaVersion == "gloops.hermes-stop-receipt.v1" and
      (.status == "succeeded" or .status == "failed" or .status == "not-present") and
      (if .status == "succeeded" then
        .plannedStopAccepted == true and .gatewayState == "stopped" and .containerStopped == true
       elif .status == "failed" then
        .containerStopped == true and (.error | type == "string")
       else .containerPresent == false end) and
      (.receiptDigest | test("^[0-9a-f]{64}$")))
  ' /var/lib/paperclip-gloops/hermes-stop-history.jsonl >/dev/null \
  && python3 - /var/lib/paperclip-gloops/hermes-stop-history.jsonl <<'PY'
import hashlib, json, pathlib, sys
prior = None
seen = set()
for sequence, line in enumerate(pathlib.Path(sys.argv[1]).read_text().splitlines(), 1):
    record = json.loads(line)
    digest = record.pop("receiptDigest")
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"))
    assert hashlib.sha256(canonical.encode()).hexdigest() == digest
    assert record["sequence"] == sequence
    assert record["previousReceiptDigest"] == prior
    assert record["attemptId"] not in seen
    seen.add(record["attemptId"])
    prior = digest
PY
then
  echo "PASS append-only Hermes stop history is complete and digest-verified"
elif [[ -e /var/lib/paperclip-gloops/hermes-stop-history.jsonl ]]; then
  echo "FAIL Hermes graceful-stop history exists but is empty or malformed" >&2
  failed=1
else
  echo "PASS no Hermes execution lifecycle has been recorded by this installed release yet"
fi
if [[ -s /var/lib/paperclip-gloops/credential-history.jsonl ]] \
  && [[ -s /var/lib/paperclip-gloops/hermes-stop-history.jsonl ]]; then
  if python3 - \
    /var/lib/paperclip-gloops/credential-history.jsonl \
    /var/lib/paperclip-gloops/hermes-stop-history.jsonl \
    /run/paperclip-gloops/credential-receipt.json <<'PY'
import json, pathlib, sys
credentials = [json.loads(line) for line in pathlib.Path(sys.argv[1]).read_text().splitlines()]
stops = [json.loads(line) for line in pathlib.Path(sys.argv[2]).read_text().splitlines()]
current = json.loads(pathlib.Path(sys.argv[3]).read_text())
credential_ids = {entry["lifecycleId"] for entry in credentials}
for stop in stops:
    lifecycle = stop.get("lifecycleId")
    if lifecycle is not None:
        assert lifecycle in credential_ids
for credential in credentials:
    if credential.get("legacyReceipt") is not True:
        assert any(stop.get("lifecycleId") == credential["lifecycleId"] for stop in stops)
assert current["receiptDigest"] == credentials[-1]["receiptDigest"]
PY
  then
    echo "PASS credential and Hermes stop histories are fully cross-correlated"
  else
    echo "FAIL credential and Hermes stop histories are not fully cross-correlated" >&2
    failed=1
  fi
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

if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-execution'; then
  echo "FAIL paperclip-hermes-execution container exists" >&2
  failed=1
else
  echo "PASS no paperclip-hermes-execution container exists"
fi

if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)(3100|8642)$'; then
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

exit "${failed}"
