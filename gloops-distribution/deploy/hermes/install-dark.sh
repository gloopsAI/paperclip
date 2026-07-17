#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:07eb68e29e97059e66481c7e4dc008253f4240ec7f00b9a03e0f13ca32c494fe'
readonly HERMES_IMAGE='sha256:3fa158ecc7635512e6c0b33d68084de1eae33593ca009225cd2f7fbd7af2902d'
readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly APP_KEY="${CONFIG_DIR}/github-app/private-key.pem"

[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}
for command in python3 chattr lsattr systemctl docker; do
  command -v "${command}" >/dev/null || {
    echo "required campaign-deadman command is unavailable: ${command}" >&2
    exit 1
  }
done
[[ "$(id -u paperclip 2>/dev/null || true)" == '995' ]] \
  && [[ "$(id -g paperclip 2>/dev/null || true)" == '985' ]] || {
  echo "the campaign deadman requires the accepted paperclip identity 995:985" >&2
  exit 1
}

for unit in paperclip.service gloops-runner.service hermes-agent.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing installation while ${unit} is active" >&2
    exit 1
  fi
done
if docker ps -a --format '{{.Names}}' \
  | grep -Eq '^paperclip-(gloops|gloops-handshake|hermes-execution|hermes-handshake)$'; then
  echo "refusing installation while a Paperclip or Hermes container exists" >&2
  exit 1
fi
"${SCRIPT_DIR}/load-hermes-execution-image.sh"
"${SCRIPT_DIR}/verify-hermes-command-security-image.sh" "${HERMES_IMAGE}"
[[ -f "${APP_KEY}" && "$(stat -c '%a:%U:%G' "${APP_KEY}")" =~ ^(400|600):root:root$ ]] || {
  echo "the repository-scoped GitHub App private key is missing or not root-protected: ${APP_KEY}" >&2
  exit 1
}

install -d -m 0700 -o root -g root "${CONFIG_DIR}"
install -d -m 0755 -o root -g root "${LIB_DIR}"
install -d -m 0700 -o root -g root /var/lib/paperclip-gloops
install -d -m 0755 -o root -g root /usr/local/lib/systemd/system
rm -f \
  "${CONFIG_DIR}/ACTIVATION_APPROVED" \
  "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED" \
  "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_ACTIVATION_APPROVED" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_COMMISSIONING_APPROVED" \
  /var/lib/paperclip-gloops/controlled-swarm/commissioning.json
rm -f \
  "${CONFIG_DIR}"/.CONTROLLED_SWARM_ACTIVATION_APPROVED.* \
  "${CONFIG_DIR}"/.CONTROLLED_SWARM_COMMISSIONING_APPROVED.*
"${SCRIPT_DIR}/remove-hermes-handshake-egress.sh"
rm -f /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE /run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE
rm -f /run/paperclip-campaign/deadman.sock
install -m 0600 -o root -g root "${SCRIPT_DIR}/runtime.env" "${CONFIG_DIR}/runtime.env"
install -m 0755 -o root -g root "${SCRIPT_DIR}/backup-dark.sh" "${LIB_DIR}/backup-dark.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/preflight.sh" "${LIB_DIR}/preflight.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/wait-paperclip-control-plane.sh" "${LIB_DIR}/wait-paperclip-control-plane.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-runtime-deadman.sh" "${LIB_DIR}/verify-runtime-deadman.sh"
install -m 0555 -o root -g root "${SCRIPT_DIR}/campaign-deadman.py" "${LIB_DIR}/campaign-deadman.py"
install -m 0555 -o root -g root "${SCRIPT_DIR}/verify-campaign-deadman.py" "${LIB_DIR}/verify-campaign-deadman.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/campaign-deadman-stop.sh" "${LIB_DIR}/campaign-deadman-stop.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/campaign-deadman-rehearsal-stop.sh" "${LIB_DIR}/campaign-deadman-rehearsal-stop.sh"
install -m 0555 -o root -g root "${SCRIPT_DIR}/rehearse-campaign-deadman.py" "${LIB_DIR}/rehearse-campaign-deadman.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/activate-controlled-swarm.sh" "${LIB_DIR}/activate-controlled-swarm.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/commission-controlled-swarm.sh" "${LIB_DIR}/commission-controlled-swarm.sh"
install -m 0555 -o root -g root "${SCRIPT_DIR}/controlled-swarm-commissioner.py" "${LIB_DIR}/controlled-swarm-commissioner.py"
install -m 0555 -o root -g root "${SCRIPT_DIR}/set-controlled-swarm-commissioning.py" "${LIB_DIR}/set-controlled-swarm-commissioning.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/stop-controlled-swarm.sh" "${LIB_DIR}/stop-controlled-swarm.sh"
install -m 0555 -o root -g root "${SCRIPT_DIR}/observe-controlled-swarm.py" "${LIB_DIR}/observe-controlled-swarm.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/failure-alert.mjs" "${LIB_DIR}/failure-alert.mjs"
install -m 0755 -o root -g root "${SCRIPT_DIR}/configure-tailnet-https.sh" "${LIB_DIR}/configure-tailnet-https.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-dark.sh" "${LIB_DIR}/verify-dark.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/rehearse-zero-work.sh" "${LIB_DIR}/rehearse-zero-work.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/rollback.sh" "${LIB_DIR}/rollback.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-rollback-dark.sh" "${LIB_DIR}/verify-rollback-dark.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/prepare-hermes-execution-profile.sh" "${LIB_DIR}/prepare-hermes-execution-profile.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/prepare-hermes-handshake-profile.sh" "${LIB_DIR}/prepare-hermes-handshake-profile.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-hermes-execution-profile.sh" "${LIB_DIR}/verify-hermes-execution-profile.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-hermes-handshake-profile.sh" "${LIB_DIR}/verify-hermes-handshake-profile.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/install-hermes-handshake-egress.sh" "${LIB_DIR}/install-hermes-handshake-egress.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/remove-hermes-handshake-egress.sh" "${LIB_DIR}/remove-hermes-handshake-egress.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/inspect-hermes-handshake-topology.sh" "${LIB_DIR}/inspect-hermes-handshake-topology.sh"
install -m 0555 -o root -g root "${SCRIPT_DIR}/hermes-handshake-egress-proxy.py" "${LIB_DIR}/hermes-handshake-egress-proxy.py"
install -m 0555 -o root -g root "${SCRIPT_DIR}/verify-hermes-handshake-live-readiness.py" "${LIB_DIR}/verify-hermes-handshake-live-readiness.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-hermes-handshake-egress-boundary.sh" "${LIB_DIR}/verify-hermes-handshake-egress-boundary.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/rehearse-hermes-handshake-egress-failure.sh" "${LIB_DIR}/rehearse-hermes-handshake-egress-failure.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/rehearse-handshake-control-plane-firewall.sh" "${LIB_DIR}/rehearse-handshake-control-plane-firewall.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-hermes-command-security-image.sh" "${LIB_DIR}/verify-hermes-command-security-image.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/load-hermes-execution-image.sh" "${LIB_DIR}/load-hermes-execution-image.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/provision-tirith.sh" "${LIB_DIR}/provision-tirith.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/restore-hermes-workspace-observer.sh" "${LIB_DIR}/restore-hermes-workspace-observer.sh"
install -m 0755 -o root -g root "${SCRIPT_DIR}/github-app-credentials.py" "${LIB_DIR}/github-app-credentials.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/stop-hermes-execution.py" "${LIB_DIR}/stop-hermes-execution.py"
install -m 0755 -o root -g root "${SCRIPT_DIR}/verify-lifecycle-history.py" "${LIB_DIR}/verify-lifecycle-history.py"
rm -rf "${LIB_DIR}/hermes-cron-disabled"
install -d -m 0755 -o root -g root "${LIB_DIR}/hermes-cron-disabled"
install -m 0444 -o root -g root "${SCRIPT_DIR}/hermes-cron-disabled/__init__.py" "${LIB_DIR}/hermes-cron-disabled/__init__.py"
rm -rf "${LIB_DIR}/hermes-handshake-guard"
install -d -m 0555 -o root -g root "${LIB_DIR}/hermes-handshake-guard"
install -m 0444 -o root -g root "${SCRIPT_DIR}/hermes-handshake-guard/sitecustomize.py" "${LIB_DIR}/hermes-handshake-guard/sitecustomize.py"
install -m 0600 -o root -g root "${SCRIPT_DIR}/github-app.json" "${CONFIG_DIR}/github-app.json"
install -m 0600 -o root -g root "${SCRIPT_DIR}/hermes-execution-config.yaml" "${LIB_DIR}/hermes-execution-config.yaml"
install -m 0600 -o root -g root "${SCRIPT_DIR}/hermes-execution-policy.json" "${LIB_DIR}/hermes-execution-policy.json"
install -m 0600 -o root -g root "${SCRIPT_DIR}/hermes-handshake-config.yaml" "${LIB_DIR}/hermes-handshake-config.yaml"
install -m 0600 -o root -g root "${SCRIPT_DIR}/hermes-handshake-policy.json" "${LIB_DIR}/hermes-handshake-policy.json"
install -m 0444 -o root -g root "${SCRIPT_DIR}/hermes-handshake-resolv.conf" "${LIB_DIR}/hermes-handshake-resolv.conf"
install -m 0600 -o root -g root "${SCRIPT_DIR}/hermes-execution-gitconfig" "${LIB_DIR}/hermes-execution-gitconfig"
install -m 0600 -o root -g root "${SCRIPT_DIR}/hermes-execution-gh-config.yml" "${LIB_DIR}/hermes-execution-gh-config.yml"
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-gloops.service" /usr/local/lib/systemd/system/paperclip-gloops.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-gloops-handshake.service" /usr/local/lib/systemd/system/paperclip-gloops-handshake.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-hermes-execution.service" /usr/local/lib/systemd/system/paperclip-hermes-execution.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-hermes-handshake.service" /usr/local/lib/systemd/system/paperclip-hermes-handshake.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-hermes-handshake-egress.service" /usr/local/lib/systemd/system/paperclip-hermes-handshake-egress.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-gloops-alert@.service" /usr/local/lib/systemd/system/paperclip-gloops-alert@.service
install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-campaign-deadman.service" /usr/local/lib/systemd/system/paperclip-campaign-deadman.service

"${LIB_DIR}/provision-tirith.sh"

docker pull "${IMAGE}"
docker image inspect "${IMAGE}" >/dev/null
printf '%s\n' "${IMAGE}" >"${CONFIG_DIR}/approved-image"
chmod 0600 "${CONFIG_DIR}/approved-image"

systemctl daemon-reload
systemctl disable --now paperclip.service gloops-runner.service hermes-agent.service 2>/dev/null || true
systemctl disable --now paperclip-gloops.service 2>/dev/null || true
systemctl disable --now paperclip-gloops-handshake.service 2>/dev/null || true
systemctl disable --now paperclip-hermes-execution.service 2>/dev/null || true
systemctl disable --now paperclip-hermes-handshake.service 2>/dev/null || true
systemctl disable --now paperclip-hermes-handshake-egress.service 2>/dev/null || true
systemctl disable --now paperclip-campaign-deadman.service 2>/dev/null || true
systemctl mask paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service
systemctl reset-failed paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service 2>/dev/null || true

# Reconcile any complete receipt left by the previously installed broker before
# the first new lifecycle establishes its history baseline. No token is minted.
"${LIB_DIR}/github-app-credentials.py" migrate-persistent-state
"${LIB_DIR}/github-app-credentials.py" reconcile-expired-mint-intents
"${LIB_DIR}/github-app-credentials.py" revoke-hermes
"${LIB_DIR}/github-app-credentials.py" revoke-projector

"${LIB_DIR}/prepare-hermes-execution-profile.sh"
"${LIB_DIR}/prepare-hermes-handshake-profile.sh"

"${LIB_DIR}/configure-tailnet-https.sh"
"${LIB_DIR}/verify-dark.sh"
