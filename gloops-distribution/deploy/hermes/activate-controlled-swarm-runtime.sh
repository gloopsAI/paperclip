#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR="${PAPERCLIP_CAMPAIGN_CONFIG_DIR:-/etc/paperclip-gloops}"
readonly EPOCH="${PAPERCLIP_CAMPAIGN_EPOCH_PATH:-/var/lib/paperclip-gloops/campaign-deadman/controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139/epoch.json}"
readonly SYSTEMCTL="${PAPERCLIP_CAMPAIGN_SYSTEMCTL:-systemctl}"
readonly VERIFY_DEADMAN="${PAPERCLIP_CAMPAIGN_VERIFY_DEADMAN:-/usr/local/lib/paperclip-gloops/verify-campaign-deadman.py}"
readonly VERIFY_PROFILE="${PAPERCLIP_CAMPAIGN_VERIFY_PROFILE:-/usr/local/lib/paperclip-gloops/verify-hermes-execution-profile.sh}"
readonly CURL="${PAPERCLIP_CAMPAIGN_CURL:-curl}"
readonly DEADMAN='paperclip-campaign-deadman.service'
readonly HERMES='paperclip-hermes-execution.service'
readonly GITHUB_BROKER='paperclip-github-push-broker.service'
readonly GITHUB_READ_BROKER='paperclip-github-read-broker.service'
readonly PLATFORM_OPS_BROKER='paperclip-platform-ops-broker.service'
readonly CAMPAIGN_PAPERCLIP='paperclip-controlled-swarm.service'
readonly COMMISSIONING_RECOVERY='paperclip-controlled-swarm-commissioning-recovery.service'
readonly CAMPAIGN_MARKER="${CONFIG_DIR}/CONTROLLED_SWARM_RUNTIME_APPROVED"

[[ "${EUID}" -eq 0 || "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]] || {
  echo 'controlled-swarm runtime activation must run as root' >&2
  exit 1
}
if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]]; then
  python3 - \
    "${CONFIG_DIR}" "${EPOCH}" "${SYSTEMCTL}" "${VERIFY_DEADMAN}" \
    "${VERIFY_PROFILE}" "${CURL}" <<'PY'
import pathlib
import sys

root = pathlib.Path('/tmp').resolve()
for raw in sys.argv[1:]:
    resolved = pathlib.Path(raw).resolve(strict=False)
    if resolved == root or root not in resolved.parents:
        raise SystemExit(
            f'network-free test mode requires every injected path under /tmp: {raw}'
        )
PY
fi

"${SYSTEMCTL}" unmask \
  "${DEADMAN}" \
  "${GITHUB_BROKER}" \
  "${GITHUB_READ_BROKER}" \
  "${PLATFORM_OPS_BROKER}" \
  "${HERMES}" \
  "${CAMPAIGN_PAPERCLIP}" \
  "${COMMISSIONING_RECOVERY}"
"${SYSTEMCTL}" daemon-reload
"${SYSTEMCTL}" enable "${COMMISSIONING_RECOVERY}"
"${SYSTEMCTL}" start "${DEADMAN}"
"${VERIFY_DEADMAN}" \
  --campaign-id controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139 \
  --wait-seconds 15 \
  --require-status unarmed

if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]]; then
  : >"${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"
  chmod 0600 "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"
  : >"${CONFIG_DIR}/ACTIVATION_APPROVED"
  chmod 0600 "${CONFIG_DIR}/ACTIVATION_APPROVED"
else
  install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"
  # This marker authorizes the campaign-free product control plane to resume
  # after the mutually exclusive campaign control plane is fenced at expiry.
  install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/ACTIVATION_APPROVED"
fi
"${SYSTEMCTL}" start "${GITHUB_BROKER}"
"${SYSTEMCTL}" start "${GITHUB_READ_BROKER}"
"${SYSTEMCTL}" start "${PLATFORM_OPS_BROKER}"
"${SYSTEMCTL}" start "${HERMES}"
if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]]; then
  : >"${CAMPAIGN_MARKER}"
  chmod 0600 "${CAMPAIGN_MARKER}"
else
  install -m 0600 -o root -g root /dev/null "${CAMPAIGN_MARKER}"
fi
"${SYSTEMCTL}" start "${CAMPAIGN_PAPERCLIP}"

for unit in \
  "${DEADMAN}" \
  "${GITHUB_BROKER}" \
  "${GITHUB_READ_BROKER}" \
  "${PLATFORM_OPS_BROKER}" \
  "${HERMES}" \
  "${CAMPAIGN_PAPERCLIP}"; do
  "${SYSTEMCTL}" is-active --quiet "${unit}"
done
"${CURL}" --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3100/api/health >/dev/null
"${VERIFY_PROFILE}" --live
[[ ! -e "${EPOCH}" ]] || {
  echo 'inert activation unexpectedly armed the campaign epoch' >&2
  exit 1
}
