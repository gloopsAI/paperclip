#!/usr/bin/env bash
set -euo pipefail

readonly CONTAINER="${PAPERCLIP_CONTAINER:-paperclip-gloops}"
readonly MAX_HEALTH_POLLS='105'
readonly HANDSHAKE_NETWORK='paperclip-handshake'
readonly HANDSHAKE_EXPECTED_IP='172.30.241.4'

verify_handshake_topology() {
  local network_internal expected_network_id networks_json ports_json network_names container_network_id container_ip published_binding_count
  network_internal="$(docker network inspect --format '{{.Internal}}' "${HANDSHAKE_NETWORK}" 2>/dev/null || true)"
  expected_network_id="$(docker network inspect --format '{{.Id}}' "${HANDSHAKE_NETWORK}" 2>/dev/null || true)"
  networks_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "${CONTAINER}" 2>/dev/null || true)"
  ports_json="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${CONTAINER}" 2>/dev/null || true)"
  network_names="$(jq -r 'keys | sort | join(",")' <<<"${networks_json:-null}" 2>/dev/null || true)"
  container_network_id="$(jq -r '.["paperclip-handshake"].NetworkID // empty' <<<"${networks_json:-null}" 2>/dev/null || true)"
  container_ip="$(jq -r '.["paperclip-handshake"].IPAddress // empty' <<<"${networks_json:-null}" 2>/dev/null || true)"
  published_binding_count="$(jq -r '[to_entries[] | select(.value != null)] | length' <<<"${ports_json:-null}" 2>/dev/null || true)"
  [[ "${network_internal}" == 'true' \
    && -n "${expected_network_id}" \
    && "${network_names}" == "${HANDSHAKE_NETWORK}" \
    && "${container_network_id}" == "${expected_network_id}" \
    && "${container_ip}" == "${HANDSHAKE_EXPECTED_IP}" \
    && "${published_binding_count}" == '0' ]] || {
    echo "Paperclip handshake topology drifted (network_internal=${network_internal:-missing}, networks=${network_names:-missing}, network_id_match=$([[ -n "${expected_network_id}" && "${container_network_id}" == "${expected_network_id}" ]] && echo true || echo false), container_ip=${container_ip:-missing}, published_bindings=${published_binding_count:-missing})" >&2
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
  local expected_network_id networks_json ports_json network_names container_network_id port_keys exact_loopback_binding
  expected_network_id="$(docker network inspect --format '{{.Id}}' 'paperclip-execution' 2>/dev/null || true)"
  networks_json="$(docker inspect --format '{{json .NetworkSettings.Networks}}' "${CONTAINER}" 2>/dev/null || true)"
  ports_json="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${CONTAINER}" 2>/dev/null || true)"
  network_names="$(jq -r 'keys | sort | join(",")' <<<"${networks_json:-null}" 2>/dev/null || true)"
  container_network_id="$(jq -r '.["paperclip-execution"].NetworkID // empty' <<<"${networks_json:-null}" 2>/dev/null || true)"
  port_keys="$(jq -r 'keys | sort | join(",")' <<<"${ports_json:-null}" 2>/dev/null || true)"
  exact_loopback_binding="$(jq -r '.["3100/tcp"] as $binding | ($binding | type == "array") and ($binding | length == 1) and ($binding[0].HostIp == "127.0.0.1") and ($binding[0].HostPort == "3100")' <<<"${ports_json:-null}" 2>/dev/null || true)"
  [[ -n "${expected_network_id}" \
    && "${network_names}" == 'paperclip-execution' \
    && "${container_network_id}" == "${expected_network_id}" \
    && "${port_keys}" == '3100/tcp' \
    && "${exact_loopback_binding}" == 'true' ]] || {
    echo "Paperclip execution topology drifted (networks=${network_names:-missing}, network_id_match=$([[ -n "${expected_network_id}" && "${container_network_id}" == "${expected_network_id}" ]] && echo true || echo false), port_keys=${port_keys:-missing}, exact_loopback_binding=${exact_loopback_binding:-missing})" >&2
    return 1
  }
  curl --fail --silent --show-error --max-time 5 \
    'http://127.0.0.1:3100/api/health' >/dev/null || {
    echo 'Paperclip execution health endpoint is not reachable on the loopback boundary' >&2
    return 1
  }
}

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required for exact Paperclip topology verification' >&2; exit 1; }

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
