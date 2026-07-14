#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:4963ed91ce769ce37cae0e44b26289337058f09e5a347597f6b49fa6be22024e'
readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'

[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}

for unit in paperclip.service gloops-runner.service hermes-agent.service paperclip-gloops.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing installation while ${unit} is active" >&2
    exit 1
  fi
done

install -d -m 0700 -o root -g root "${CONFIG_DIR}"
install -d -m 0755 -o root -g root "${LIB_DIR}"
install -d -m 0755 -o root -g root /usr/local/lib/systemd/system
install -m 0600 -o root -g root "${SCRIPT_DIR}/runtime.env" "${CONFIG_DIR}/runtime.env"
install -m 0755 -o root -g root "${SCRIPT_DIR}/backup-dark.sh" "${LIB_DIR}/backup-dark.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/preflight.sh" "${LIB_DIR}/preflight.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/failure-alert.mjs" "${LIB_DIR}/failure-alert.mjs"
install -m 0755 -o root -g root "${SCRIPT_DIR}/configure-tailnet-https.sh" "${LIB_DIR}/configure-tailnet-https.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-dark.sh" "${LIB_DIR}/verify-dark.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/rollback.sh" "${LIB_DIR}/rollback.sh"
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-gloops.service" /usr/local/lib/systemd/system/paperclip-gloops.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-gloops-alert@.service" /usr/local/lib/systemd/system/paperclip-gloops-alert@.service
rm -f "${CONFIG_DIR}/ACTIVATION_APPROVED"

docker pull "${IMAGE}"
docker image inspect "${IMAGE}" >/dev/null
printf '%s\n' "${IMAGE}" >"${CONFIG_DIR}/approved-image"
chmod 0600 "${CONFIG_DIR}/approved-image"

systemctl daemon-reload
systemctl disable --now paperclip.service gloops-runner.service hermes-agent.service 2>/dev/null || true
systemctl disable --now paperclip-gloops.service 2>/dev/null || true
systemctl mask paperclip-gloops.service

"${LIB_DIR}/configure-tailnet-https.sh"
"${LIB_DIR}/verify-dark.sh"
