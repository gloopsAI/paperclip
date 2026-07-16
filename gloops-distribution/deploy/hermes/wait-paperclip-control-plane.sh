#!/usr/bin/env bash
set -euo pipefail

readonly CONTAINER="${PAPERCLIP_CONTAINER:-paperclip-gloops}"
readonly MAX_HEALTH_POLLS='105'
readonly HANDSHAKE_NETWORK='paperclip-handshake'
readonly HANDSHAKE_EXPECTED_IP='172.30.241.4'

verify_handshake_topology() {
  local network_internal container_ip
  network_internal="$(docker network inspect --format '{{.Internal}}' "${HANDSHAKE_NETWORK}" 2>/dev/null || true)"
  container_ip="$(docker inspect --format '{{with index .NetworkSettings.Networks "paperclip-handshake"}}{{.IPAddress}}{{end}}' "${CONTAINER}" 2>/dev/null || true)"
  [[ "${network_internal}" == 'true' && "${container_ip}" == "${HANDSHAKE_EXPECTED_IP}" ]] || {
    echo "Paperclip handshake topology drifted (network_internal=${network_internal:-missing}, container_ip=${container_ip:-missing})" >&2
    return 1
  }

  # Docker deliberately suppresses published host ports for containers whose
  # only attachment is an --internal bridge. The host is a member of the bridge
  # and can still reach the fixed container address directly.
  curl --fail --silent --show-error --max-time 5 --header 'Host: 127.0.0.1' \
    "http://${HANDSHAKE_EXPECTED_IP}:3100/api/health" >/dev/null || {
    echo 'Paperclip handshake health endpoint is not reachable from the host boundary' >&2
    return 1
  }
}

verify_execution_topology() {
  local execution_network host_ip host_port
  execution_network="$(docker inspect --format '{{with index .NetworkSettings.Networks "paperclip-execution"}}{{.NetworkID}}{{end}}' "${CONTAINER}" 2>/dev/null || true)"
  host_ip="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "3100/tcp") 0).HostIp}}' "${CONTAINER}" 2>/dev/null || true)"
  host_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "3100/tcp") 0).HostPort}}' "${CONTAINER}" 2>/dev/null || true)"
  [[ -n "${execution_network}" && "${host_ip}" == '127.0.0.1' && "${host_port}" == '3100' ]] || {
    echo "Paperclip execution topology drifted (network=${execution_network:-missing}, host_ip=${host_ip:-missing}, host_port=${host_port:-missing})" >&2
    return 1
  }
  curl --fail --silent --show-error --max-time 5 \
    'http://127.0.0.1:3100/api/health' >/dev/null || {
    echo 'Paperclip execution health endpoint is not reachable on the loopback boundary' >&2
    return 1
  }
}

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }

health='missing'
for _ in $(seq 1 "${MAX_HEALTH_POLLS}"); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${CONTAINER}" 2>/dev/null || true)"
  [[ "${health}" == 'healthy' ]] && break
  sleep 1
done
[[ "${health}" == 'healthy' ]] || {
  echo "Paperclip control plane did not become healthy within ${MAX_HEALTH_POLLS} seconds (last status: ${health})" >&2
  exit 1
}

if [[ "${CONTAINER}" == 'paperclip-gloops-handshake' ]]; then
  verify_handshake_topology
elif [[ "${CONTAINER}" == 'paperclip-gloops' ]]; then
  verify_execution_topology
else
  echo "unsupported Paperclip control-plane container: ${CONTAINER}" >&2
  exit 1
fi

echo 'verified Paperclip control-plane startup readiness'
