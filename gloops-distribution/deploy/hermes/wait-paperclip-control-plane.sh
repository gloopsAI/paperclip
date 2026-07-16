#!/usr/bin/env bash
set -euo pipefail

readonly CONTAINER="${PAPERCLIP_CONTAINER:-paperclip-gloops}"
readonly MAX_HEALTH_POLLS='105'
readonly HEALTH_URL='http://127.0.0.1:3100/api/health'

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

curl --fail --silent --show-error --max-time 5 "${HEALTH_URL}" >/dev/null || {
  echo 'Paperclip control-plane health endpoint is not reachable from the host boundary' >&2
  exit 1
}

echo 'verified Paperclip control-plane startup readiness'
