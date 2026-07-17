#!/usr/bin/env bash
set -euo pipefail

failed=0
readonly CAMPAIGN_DEADMAN_SOCKET="${PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET_PATH:-/run/paperclip-campaign/deadman.sock}"
for command in docker iptables ss systemctl; do
  if ! command -v "${command}" >/dev/null; then
    echo "FAIL rollback verifier dependency is unavailable: ${command}" >&2
    failed=1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo 'FAIL rollback verifier cannot inspect Docker topology' >&2
  failed=1
fi
if ! iptables -nL INPUT >/dev/null 2>&1 || ! iptables -nL DOCKER-USER >/dev/null 2>&1; then
  echo 'FAIL rollback verifier cannot inspect firewall topology' >&2
  failed=1
fi
for unit in paperclip.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service; do
  if ! active_state="$(systemctl show --property=ActiveState --value "${unit}" 2>/dev/null)"; then
    echo "FAIL rollback verifier cannot inspect unit state: ${unit}" >&2
    failed=1
  elif [[ "${active_state}" != 'inactive' ]]; then
    echo "FAIL rollback left non-inactive unit: ${unit} (${active_state})" >&2
    failed=1
  fi
done
paperclip_enablement="$(systemctl is-enabled paperclip.service 2>/dev/null || true)"
if [[ "${paperclip_enablement}" != 'disabled' && "${paperclip_enablement}" != 'masked' ]]; then
  echo "FAIL rollback left paperclip.service boot-eligible: ${paperclip_enablement:-unknown}" >&2
  failed=1
fi
for unit in paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service; do
  if [[ "$(systemctl is-enabled "${unit}" 2>/dev/null || true)" != 'masked' ]]; then
    echo "FAIL rollback left governed unit unmasked: ${unit}" >&2
    failed=1
  fi
done
if [[ -e "${CAMPAIGN_DEADMAN_SOCKET}" || -S "${CAMPAIGN_DEADMAN_SOCKET}" ]]; then
  echo "FAIL rollback left the campaign deadman socket: ${CAMPAIGN_DEADMAN_SOCKET}" >&2
  failed=1
fi
for marker in \
  /etc/paperclip-gloops/ACTIVATION_APPROVED \
  /etc/paperclip-gloops/HERMES_EXECUTION_APPROVED \
  /etc/paperclip-gloops/HERMES_HANDSHAKE_APPROVED \
  /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE \
  /run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE \
  /run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE; do
  [[ ! -e "${marker}" ]] || { echo "FAIL rollback marker remains: ${marker}" >&2; failed=1; }
done
if ! docker_containers="$(docker ps -a --format '{{.Names}}')"; then
  echo 'FAIL rollback verifier cannot inspect Docker containers' >&2
  failed=1
  docker_containers=''
fi
if grep -Eq '^paperclip-(gloops|gloops-handshake|hermes-execution|hermes-handshake)$' <<<"${docker_containers}"; then
  echo 'FAIL rollback left a Paperclip or Hermes container' >&2
  failed=1
fi
if ! docker_networks="$(docker network ls --format '{{.Name}}')"; then
  echo 'FAIL rollback verifier cannot inspect Docker networks' >&2
  failed=1
  docker_networks=''
fi
for network in paperclip-execution paperclip-handshake; do
  if grep -Fxq "${network}" <<<"${docker_networks}"; then
    echo "FAIL rollback left governed network: ${network}" >&2
    failed=1
  fi
done
if ! firewall_rules="$(iptables -S)"; then
  echo 'FAIL rollback verifier cannot capture firewall topology' >&2
  failed=1
  firewall_rules=''
fi
if grep -Eq '^-N PCLIP-HS-IN$|^-N PCLIP-HS-FWD$|^-A INPUT.* -j PCLIP-HS-IN( |$)|^-A DOCKER-USER.* -j PCLIP-HS-FWD( |$)' <<<"${firewall_rules}"; then
  echo 'FAIL rollback left handshake firewall topology' >&2
  failed=1
fi
if ! listeners="$(ss -lntH)"; then
  echo 'FAIL rollback verifier cannot inspect listeners' >&2
  failed=1
  listeners=''
fi
if awk '{print $4}' <<<"${listeners}" | grep -Eq '(^|:)(3100|8642|18080)$'; then
  echo 'FAIL rollback left a governed listener' >&2
  failed=1
fi
[[ "${failed}" -eq 0 ]] || exit 1
echo 'PASS rollback terminal state is inactive, deadman-free, marker-free, container-free, network-free, firewall-free, and listener-free'
