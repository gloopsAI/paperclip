#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:395e63aa1d6fc7883d61fa55a9e59345f2416aa9511ad3cf56153f6c5b0f49aa'
readonly ACTIVATION_MARKER='/etc/paperclip-gloops/ACTIVATION_APPROVED'
readonly STATE_DIR='/home/paperclip/.paperclip'
readonly PLUGIN_DIR='/opt/paperclip/plugins'
readonly MTE_PLUGIN_DIR='/home/paperclip/mte-shadow-package'
readonly MAX_STATE_BYTES=$((10 * 1024 * 1024 * 1024))
readonly MIN_FREE_BYTES=$((10 * 1024 * 1024 * 1024))

[[ -f "${ACTIVATION_MARKER}" ]] || {
  echo "operator activation marker is absent" >&2
  exit 1
}

[[ "${PAPERCLIP_IMAGE:-}" == "${EXPECTED_IMAGE}" ]] || {
  echo "service image does not match the approved immutable digest" >&2
  exit 1
}

[[ "${PAPERCLIP_MTE_ENABLED:-}" == 'false' ]] || {
  echo "Maximum Token Efficiency must remain explicitly disabled" >&2
  exit 1
}
[[ "${PAPERCLIP_EXECUTION_ADMISSION_ENABLED:-}" == 'true' ]] || {
  echo "task execution admission must remain explicitly enabled" >&2
  exit 1
}
for required_execution_ceiling in \
  PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK \
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK \
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK \
  PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK; do
  [[ "${!required_execution_ceiling:-}" =~ ^[1-9][0-9]*$ ]] || {
    echo "${required_execution_ceiling} must be a positive integer" >&2
    exit 1
  }
done
[[ "${PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK:-}" =~ ^(0|[1-9][0-9]*)$ ]] || {
  echo "PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK must be a non-negative integer" >&2
  exit 1
}
((PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK < PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK)) || {
  echo "task retries must be lower than total task runs" >&2
  exit 1
}
if env | grep -Eq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)='; then
  echo "Grok/xAI API configuration is forbidden" >&2
  exit 1
fi
provider_config=(
  /etc/paperclip-gloops
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
  echo "Grok/xAI API configuration is forbidden" >&2
  exit 1
fi
[[ -x /opt/grok-build/bin/grok ]] || {
  echo "the governed Grok CLI is unavailable" >&2
  exit 1
}

[[ -d "${STATE_DIR}" ]] || {
  echo "Paperclip state directory is missing" >&2
  exit 1
}
[[ -d "${PLUGIN_DIR}" && -d "${MTE_PLUGIN_DIR}" ]] || {
  echo "one or more installed plugin directories are missing" >&2
  exit 1
}

state_bytes="$(du -sb "${STATE_DIR}" | awk '{print $1}')"
free_bytes="$(df -PB1 "${STATE_DIR}" | awk 'NR == 2 {print $4}')"
[[ "${state_bytes}" -le "${MAX_STATE_BYTES}" ]] || {
  echo "Paperclip state exceeds the 10 GiB admission ceiling" >&2
  exit 1
}
[[ "${free_bytes}" -ge "${MIN_FREE_BYTES}" ]] || {
  echo "host has less than the required 10 GiB free-space reserve" >&2
  exit 1
}

/usr/bin/docker image inspect "${EXPECTED_IMAGE}" >/dev/null
if /usr/bin/docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-gloops'; then
  echo "a Paperclip container already exists; refusing concurrent execution" >&2
  exit 1
fi
