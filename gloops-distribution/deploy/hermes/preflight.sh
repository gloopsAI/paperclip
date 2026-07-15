#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:f93ce4dc007e2c16c2acb9e806e8097332ca8636b039c9ad44f5c875145f610d'
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
readonly -A EXPECTED_EXECUTION_ENVELOPE=(
  [PAPERCLIP_EXECUTION_ADMISSION_ENABLED]='true'
  [PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK]='1'
  [PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK]='0'
  [PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK]='50000'
  [PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK]='16000'
  [PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK]='3600000'
  [PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION]='30000'
  [PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION]='8000'
  [PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION]='8'
  [PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION]='32'
)
for execution_setting in "${!EXPECTED_EXECUTION_ENVELOPE[@]}"; do
  [[ "${!execution_setting:-}" == "${EXPECTED_EXECUTION_ENVELOPE[${execution_setting}]}" ]] || {
    echo "${execution_setting} has drifted from the accepted bounded-pilot envelope" >&2
    exit 1
  }
done
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
readonly FORBIDDEN_PROVIDER_ENDPOINT_PATTERN='api\.x\.ai|(^|[[:space:]])base_url:[[:space:]]*[^#]*x\.ai'
if ((${#existing_provider_config[@]} > 0)) \
  && grep -RIEq "${FORBIDDEN_PROVIDER_ENDPOINT_PATTERN}" "${existing_provider_config[@]}"; then
  echo "Grok/xAI API endpoint configuration is forbidden" >&2
  exit 1
fi
# Host-level Hermes profiles are outside this pilot and may govern the separate
# Grok CLI/OAuth surface. They are never mounted into the execution sidecar.
# API credentials and literal endpoints remain forbidden globally above; the exact
# mounted Ollama-only route is enforced by the live profile verifier below.
[[ -x /opt/grok-build/bin/grok ]] || {
  echo "the governed Grok CLI is unavailable" >&2
  exit 1
}

/usr/local/lib/paperclip-gloops/verify-hermes-execution-profile.sh --live
systemctl is-active --quiet paperclip-hermes-execution.service || {
  echo "the Hermes execution-only sidecar must be active before Paperclip" >&2
  exit 1
}
docker exec --user 10000:10000 --env HOME=/opt/data paperclip-hermes-execution \
  sh -lc '[ "$(gh api user --jq .login)" = "zach-hermes" ] && gh api repos/gloopsAI/gloops-paperclip-plugin --jq "select(.private == false and .permissions.push == true)" >/dev/null' || {
  echo "the live Hermes identity lacks bounded write access to the public pilot repository" >&2
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
