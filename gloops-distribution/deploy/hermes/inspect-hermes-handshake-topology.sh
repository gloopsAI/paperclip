#!/usr/bin/env bash
set -euo pipefail

readonly NETWORK='paperclip-handshake'

command -v docker >/dev/null || {
  echo 'Docker client is unavailable' >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo 'Docker daemon/topology is unavailable' >&2
  exit 1
}

mapfile -t network_ids < <(docker network ls --filter "name=^${NETWORK}$" --format '{{.ID}}')
if ((${#network_ids[@]} == 0)); then
  echo 'absent'
  exit 0
fi
if ((${#network_ids[@]} != 1)); then
  echo 'handshake network identity is ambiguous' >&2
  exit 1
fi

network_json="$(docker network inspect "${NETWORK}")" || {
  echo 'handshake network topology cannot be inspected' >&2
  exit 1
}
container_count="$(python3 -c 'import json,sys; print(len(json.load(sys.stdin)[0]["Containers"]))' <<<"${network_json}")"
if [[ "${container_count}" != '0' ]]; then
  echo 'attached'
  exit 0
fi
echo 'empty'
