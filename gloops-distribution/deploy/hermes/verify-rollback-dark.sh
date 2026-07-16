#!/usr/bin/env bash
set -euo pipefail

failed=0
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
for unit in paperclip.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service; do
  if systemctl is-active --quiet "${unit}" || systemctl is-failed --quiet "${unit}"; then
    echo "FAIL rollback left active or failed unit: ${unit}" >&2
    failed=1
  fi
done
paperclip_enablement="$(systemctl is-enabled paperclip.service 2>/dev/null || true)"
if [[ "${paperclip_enablement}" != 'disabled' && "${paperclip_enablement}" != 'masked' ]]; then
  echo "FAIL rollback left paperclip.service boot-eligible: ${paperclip_enablement:-unknown}" >&2
  failed=1
fi
for unit in paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service; do
  if [[ "$(systemctl is-enabled "${unit}" 2>/dev/null || true)" != 'masked' ]]; then
    echo "FAIL rollback left governed unit unmasked: ${unit}" >&2
    failed=1
  fi
done
for marker in \
  /etc/paperclip-gloops/ACTIVATION_APPROVED \
  /etc/paperclip-gloops/HERMES_EXECUTION_APPROVED \
  /etc/paperclip-gloops/HERMES_HANDSHAKE_APPROVED \
  /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE \
  /run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE \
  /run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE; do
  [[ ! -e "${marker}" ]] || { echo "FAIL rollback marker remains: ${marker}" >&2; failed=1; }
done
if docker ps -a --format '{{.Names}}' | grep -Eq '^paperclip-(gloops|gloops-handshake|hermes-execution|hermes-handshake)$'; then
  echo 'FAIL rollback left a Paperclip or Hermes container' >&2
  failed=1
fi
for network in paperclip-execution paperclip-handshake; do
  if docker network inspect "${network}" >/dev/null 2>&1; then
    echo "FAIL rollback left governed network: ${network}" >&2
    failed=1
  fi
done
if iptables -nL PCLIP-HS-IN >/dev/null 2>&1 \
  || iptables -nL PCLIP-HS-FWD >/dev/null 2>&1 \
  || iptables -S INPUT 2>/dev/null | grep -Fq -- '-j PCLIP-HS-IN' \
  || iptables -S DOCKER-USER 2>/dev/null | grep -Fq -- '-j PCLIP-HS-FWD'; then
  echo 'FAIL rollback left handshake firewall topology' >&2
  failed=1
fi
if ss -lntH | awk '{print $4}' | grep -Eq '(^|:)(3100|8642|18080)$'; then
  echo 'FAIL rollback left a governed listener' >&2
  failed=1
fi
[[ "${failed}" -eq 0 ]] || exit 1
echo 'PASS rollback terminal state is inactive, marker-free, container-free, network-free, firewall-free, and listener-free'
