#!/usr/bin/env bash
set -euo pipefail

# General product execution is deliberately independent of the trainer's
# campaign epoch.  The one-shot provider handshake remains campaign-bound, so
# callers must opt into that stricter mode instead of inheriting it silently.
MODE="${1:---general}"
[[ "$#" -le 1 ]] || {
  echo "usage: $0 [--general|--campaign-bound]" >&2
  exit 2
}
case "${MODE}" in
  --general|--campaign-bound) ;;
  *)
    echo "usage: $0 [--general|--campaign-bound]" >&2
    exit 2
    ;;
esac

readonly APPROVED_IMAGE_FILE='/etc/paperclip-gloops/approved-image'
readonly ACTIVATION_MARKER='/etc/paperclip-gloops/ACTIVATION_APPROVED'
readonly EXECUTION_MARKER='/etc/paperclip-gloops/HERMES_EXECUTION_APPROVED'
readonly HANDSHAKE_ACTIVE='/run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE'
readonly PAPERCLIP_HANDSHAKE_ACTIVE='/run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE'
readonly CAMPAIGN_DEADMAN_SOCKET='/run/paperclip-campaign/deadman.sock'
readonly CAMPAIGN_DEADMAN_BROKER='/usr/local/lib/paperclip-gloops/campaign-deadman.py'
readonly STATE_DIR='/home/paperclip/.paperclip'
readonly PLUGIN_DIR='/opt/paperclip/plugins'
readonly MTE_PLUGIN_DIR='/home/paperclip/mte-shadow-package'
readonly MAX_STATE_BYTES=$((10 * 1024 * 1024 * 1024))
readonly MIN_FREE_BYTES=$((10 * 1024 * 1024 * 1024))

[[ -f "${ACTIVATION_MARKER}" || -f "${PAPERCLIP_HANDSHAKE_ACTIVE}" ]] || {
  echo "operator activation marker is absent" >&2
  exit 1
}

[[ -r "${APPROVED_IMAGE_FILE}" ]] || {
  echo "approved immutable image receipt is missing" >&2
  exit 1
}
readonly EXPECTED_IMAGE="$(tr -d '\r\n' < "${APPROVED_IMAGE_FILE}")"
[[ "${EXPECTED_IMAGE}" == ghcr.io/gloopsai/paperclip-gloops@sha256:* ]] || {
  echo "approved image receipt is not a GLoops Paperclip digest" >&2
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
[[ "${PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED:-true}" == 'false' ]] || {
  echo "the controlled-swarm runtime has not been bound to an accepted immutable image" >&2
  exit 1
}
declare -A EXPECTED_EXECUTION_ENVELOPE=(
  [HEARTBEAT_SCHEDULER_ENABLED]='false'
  [PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED]='false'
  [PAPERCLIP_EXECUTION_ADMISSION_ENABLED]='true'
  [PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS]='codex_local,grok_local'
  [PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS]='89ed0964-d918-4fcc-b830-5be49d2d4089'
  [PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS]='4'
  [PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE]='2026-07-18T23:12:22.000Z'
  [PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK]='3'
  [PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK]='2'
  [PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK]='8000000'
  [PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK]='256000'
  [PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK]='7200000'
  [PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION]='4000000'
  [PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION]='128000'
  [PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION]='64'
  [PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION]='240'
)
if [[ "${MODE}" == '--campaign-bound' ]]; then
  EXPECTED_EXECUTION_ENVELOPE[PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE]='campaign-bound'
  EXPECTED_EXECUTION_ENVELOPE[PAPERCLIP_CAMPAIGN_ID]='controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139'
  EXPECTED_EXECUTION_ENVELOPE[PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET]='/run/paperclip-campaign/deadman.sock'
  EXPECTED_EXECUTION_ENVELOPE[PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS]='2000'
else
  EXPECTED_EXECUTION_ENVELOPE[PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE]='general'
  for forbidden_campaign_setting in \
    PAPERCLIP_CAMPAIGN_ID \
    PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET \
    PAPERCLIP_CAMPAIGN_DURATION_SECONDS \
    PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS; do
    [[ -z "${!forbidden_campaign_setting:-}" ]] || {
      echo "general execution inherited ${forbidden_campaign_setting}" >&2
      exit 1
    }
  done
fi
for execution_setting in "${!EXPECTED_EXECUTION_ENVELOPE[@]}"; do
  [[ "${!execution_setting:-}" == "${EXPECTED_EXECUTION_ENVELOPE[${execution_setting}]}" ]] || {
    echo "${execution_setting} has drifted from the accepted controlled-swarm envelope" >&2
    exit 1
  }
done
# The campaign epoch length is the one envelope entry that is an operator choice
# within a sanctioned range rather than a fixed accepted literal, so it is
# range-checked instead of exact-matched. The range is read from the installed
# broker, which is the only place it is declared and the thing that enforces it.
campaign_duration_bound() {
  local name="$1" line expression
  line="$(grep -m1 -E "^${name} = [0-9]+([ ]+\*[ ]+[0-9]+)*([ ]+#.*)?$" \
    "${CAMPAIGN_DEADMAN_BROKER}")" || {
    echo "installed campaign deadman does not declare ${name}" >&2
    return 1
  }
  expression="${line#* = }"
  expression="${expression%%#*}"
  printf '%s\n' "$((expression))"
}
if [[ "${MODE}" == '--campaign-bound' ]]; then
  campaign_duration_minimum="$(campaign_duration_bound MIN_CAMPAIGN_DURATION_SECONDS)"
  campaign_duration_maximum="$(campaign_duration_bound MAX_CAMPAIGN_DURATION_SECONDS)"
  if ! [[ "${PAPERCLIP_CAMPAIGN_DURATION_SECONDS:-}" =~ ^[0-9]+$ ]] \
    || ((10#${PAPERCLIP_CAMPAIGN_DURATION_SECONDS} < campaign_duration_minimum \
      || 10#${PAPERCLIP_CAMPAIGN_DURATION_SECONDS} > campaign_duration_maximum)); then
    echo "PAPERCLIP_CAMPAIGN_DURATION_SECONDS is outside the sanctioned ${campaign_duration_minimum}..${campaign_duration_maximum} second campaign range" >&2
    exit 1
  fi
fi
"/usr/local/lib/paperclip-gloops/verify-backlog-readmit-window.py"
if [[ "${MODE}" == '--campaign-bound' ]]; then
  "/usr/local/lib/paperclip-gloops/verify-predecessor-campaign-epoch.py"
fi
case "${PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED:-}" in
  false) ;;
  true)
    commissioning_receipt='/var/lib/paperclip-gloops/controlled-swarm/commissioning.json'
    [[ -f "${commissioning_receipt}" \
      && "$(stat -c '%a:%U:%G' "${commissioning_receipt}")" == '600:root:root' ]] || {
      echo "commissioned execution requires the root-owned commissioning receipt" >&2
      exit 1
    }
    /usr/local/lib/paperclip-gloops/controlled-swarm-commissioner.py \
      --verify-receipt
    ;;
  *)
    echo "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED is not an exact boolean" >&2
    exit 1
    ;;
esac
if [[ "${MODE}" == '--campaign-bound' ]]; then
  systemctl is-active --quiet paperclip-campaign-deadman.service || {
    echo "the root-owned campaign deadman must be active before campaign-bound execution" >&2
    exit 1
  }
  /usr/local/lib/paperclip-gloops/verify-campaign-deadman.py \
    --socket "${CAMPAIGN_DEADMAN_SOCKET}" \
    --campaign-id "${PAPERCLIP_CAMPAIGN_ID}" \
    --wait-seconds 15
fi
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

if [[ -f "${HANDSHAKE_ACTIVE}" ]]; then
  [[ ! -e "${EXECUTION_MARKER}" ]] || {
    echo "execution and handshake activation markers are mutually exclusive" >&2
    exit 1
  }
  systemctl is-active --quiet paperclip-hermes-handshake.service || {
    echo "the zero-tool Hermes handshake sidecar must be active before Paperclip" >&2
    exit 1
  }
  ! systemctl is-active --quiet paperclip-hermes-execution.service || {
    echo "the general Hermes execution sidecar must be inactive during a handshake" >&2
    exit 1
  }
  for forbidden_credential in \
    /var/lib/paperclip-gloops/credential-runtime/hermes-github-token \
    /var/lib/paperclip-gloops/credential-runtime/projector-github-token \
    /opt/paperclip/hermes-execution-profile/gh/hosts.yml; do
    [[ ! -e "${forbidden_credential}" ]] || {
      echo "GitHub credential is forbidden during provider handshake: ${forbidden_credential}" >&2
      exit 1
    }
  done
  /usr/local/lib/paperclip-gloops/verify-hermes-handshake-profile.sh --live
else
  [[ -f "${EXECUTION_MARKER}" ]] || {
    echo "the Hermes execution activation marker is absent" >&2
    exit 1
  }
  ! systemctl is-active --quiet paperclip-hermes-handshake.service || {
    echo "the Hermes handshake sidecar must be inactive during general execution" >&2
    exit 1
  }
  systemctl is-active --quiet paperclip-github-push-broker.service || {
    echo "the root-owned GitHub push broker must be active before Hermes execution" >&2
    exit 1
  }
  systemctl is-active --quiet paperclip-platform-ops-broker.service || {
    echo "the root-owned platform operations broker must be active before Hermes execution" >&2
    exit 1
  }
  [[ -S /run/paperclip-platform-ops-broker/broker.sock ]] || {
    echo "the root-owned platform operations broker socket is unavailable" >&2
    exit 1
  }
  [[ -S /run/paperclip-github-broker/broker.sock ]] || {
    echo "the root-owned GitHub push broker socket is unavailable" >&2
    exit 1
  }
  for forbidden_legacy_projection in \
    /var/lib/paperclip-gloops/credential-runtime/hermes-github-token \
    /opt/paperclip/hermes-execution-profile/gh/hosts.yml; do
    [[ ! -e "${forbidden_legacy_projection}" ]] || {
      echo "legacy Hermes GitHub write authority remains projected: ${forbidden_legacy_projection}" >&2
      exit 1
    }
  done
  /usr/local/lib/paperclip-gloops/verify-hermes-execution-profile.sh --live
  systemctl is-active --quiet paperclip-hermes-execution.service || {
    echo "the Hermes execution-only sidecar must be active before Paperclip" >&2
    exit 1
  }
fi

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
if /usr/bin/docker ps -a --format '{{.Names}}' | grep -Eq '^paperclip-gloops(-handshake)?$'; then
  echo "a Paperclip container already exists; refusing concurrent execution" >&2
  exit 1
fi
