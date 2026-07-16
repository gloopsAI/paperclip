#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly BASE_IMAGE='hermes-agent@sha256:c58e0672b554d9a240bae881660a0294818f08f9523c9c512a1dadfdac6dae78'
readonly TAG='hermes-agent-gloops:tirith-fail-closed-v1'

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}

docker image inspect "${BASE_IMAGE}" >/dev/null
docker build \
  --network none \
  --provenance=false \
  --file "${SCRIPT_DIR}/Dockerfile.hermes-execution" \
  --tag "${TAG}" \
  "${SCRIPT_DIR}"
docker image inspect "${TAG}" --format '{{.Id}}'
