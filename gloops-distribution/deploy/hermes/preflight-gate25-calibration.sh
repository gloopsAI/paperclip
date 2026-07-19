#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:c6cace2d01b45ee22275f4648155c75b72ec7cb0c7c361ddb1a9c48e9db7caa1'
readonly STATE_DIR='/home/paperclip/.paperclip'
readonly MARKER='/run/paperclip-gate25/PAPERCLIP_ACTIVE'
readonly APPROVAL_DIGEST='/run/paperclip-gate25/approval.sha256'

[[ -f "${MARKER}" && -s "${APPROVAL_DIGEST}" ]] || {
  echo 'Gate 2.5 one-use runtime boundary is absent' >&2
  exit 1
}
[[ "${PAPERCLIP_IMAGE:-}" == "${EXPECTED_IMAGE}" ]] || {
  echo 'Gate 2.5 image differs from the approved immutable release' >&2
  exit 1
}
for key in \
  HEARTBEAT_SCHEDULER_ENABLED \
  PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED \
  PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED \
  PAPERCLIP_EXECUTION_ADMISSION_ENABLED \
  PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS \
  PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK \
  PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK; do
  [[ "$(grep -Ec "^${key}=" /run/paperclip-gate25/runtime.env)" -eq 1 ]] || {
    echo "Gate 2.5 runtime envelope has a missing or duplicate ${key}" >&2
    exit 1
  }
done
for exact in \
  'HEARTBEAT_SCHEDULER_ENABLED=false' \
  'PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false' \
  'PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false' \
  'PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true' \
  'PAPERCLIP_EXECUTION_ADMISSION_ENABLED=true' \
  'PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS=1' \
  'PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK=2' \
  'PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=0'; do
  grep -Fxq "${exact}" /run/paperclip-gate25/runtime.env || {
    echo "Gate 2.5 runtime envelope is missing ${exact}" >&2
    exit 1
  }
done
if grep -Eq '^PAPERCLIP_CAMPAIGN_(ID|DEADMAN_SOCKET|DURATION_SECONDS|DEADMAN_TIMEOUT_MS)=' \
  /run/paperclip-gate25/runtime.env; then
  echo 'Gate 2.5 may not consume or create a campaign epoch' >&2
  exit 1
fi
for unit in \
  paperclip-gloops.service \
  paperclip-hermes-execution.service \
  paperclip-github-push-broker.service \
  paperclip-campaign-deadman.service \
  paperclip-gloops-handshake.service \
  paperclip-hermes-handshake.service; do
  ! systemctl is-active --quiet "${unit}" || {
    echo "production or handshake unit is active during Gate 2.5: ${unit}" >&2
    exit 1
  }
done
systemctl is-active --quiet paperclip-hermes-gate25-calibration.service
systemctl is-active --quiet paperclip-github-push-broker-gate25.service
[[ -S /run/paperclip-github-broker/broker.sock ]]
/usr/local/lib/paperclip-gloops/verify-hermes-execution-profile.sh --live
[[ -d "${STATE_DIR}" ]]
[[ "$(du -sb "${STATE_DIR}" | awk '{print $1}')" -le $((10 * 1024 * 1024 * 1024)) ]]
[[ "$(df -PB1 "${STATE_DIR}" | awk 'NR == 2 {print $4}')" -ge $((10 * 1024 * 1024 * 1024)) ]]
if env | grep -Eq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)='; then
  echo 'Grok/xAI API configuration is forbidden' >&2
  exit 1
fi
docker image inspect "${EXPECTED_IMAGE}" >/dev/null
if docker ps -a --format '{{.Names}}' | grep -Eq '^paperclip-gloops(-handshake)?$'; then
  echo 'a Paperclip container already exists' >&2
  exit 1
fi
