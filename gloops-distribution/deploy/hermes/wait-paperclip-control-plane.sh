#!/usr/bin/env bash
set -euo pipefail

readonly CONTAINER="${PAPERCLIP_CONTAINER:-paperclip-gloops}"
readonly NETWORK='paperclip-handshake'
readonly EXPECTED_IP='172.30.241.4'
readonly MAX_HEALTH_POLLS='105'
readonly HEALTH_URL="http://${EXPECTED_IP}:3100/api/health"

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

network_internal="$(docker network inspect --format '{{.Internal}}' "${NETWORK}" 2>/dev/null || true)"
container_ip="$(docker inspect --format '{{with index .NetworkSettings.Networks "paperclip-handshake"}}{{.IPAddress}}{{end}}' "${CONTAINER}" 2>/dev/null || true)"
[[ "${network_internal}" == 'true' && "${container_ip}" == "${EXPECTED_IP}" ]] || {
  echo "Paperclip control-plane topology drifted (network_internal=${network_internal:-missing}, container_ip=${container_ip:-missing})" >&2
  exit 1
}

# Docker deliberately suppresses published host ports for containers whose only
# attachment is an --internal bridge. The host is a member of the bridge and
# can still reach the fixed container address directly without adding an
# Internet-capable network. Preserve the allowed loopback Host value while
# verifying the real host-to-container path.
curl --fail --silent --show-error --max-time 5 --header 'Host: 127.0.0.1' "${HEALTH_URL}" >/dev/null || {
  echo 'Paperclip control-plane health endpoint is not reachable from the host boundary' >&2
  exit 1
}

echo 'verified Paperclip control-plane startup readiness'
