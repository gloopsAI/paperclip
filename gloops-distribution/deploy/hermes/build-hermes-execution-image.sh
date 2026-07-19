#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly BASE_IMAGE='hermes-agent-gloops:bounded-runtime-v2@sha256:3fa158ecc7635512e6c0b33d68084de1eae33593ca009225cd2f7fbd7af2902d'
readonly TAG='hermes-agent-gloops:route-receipt-v3'
readonly SOURCE_DATE_EPOCH='1783473071'

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}

docker image inspect "${BASE_IMAGE}" >/dev/null
docker build \
  --no-cache \
  --network none \
  --provenance=false \
  --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
  --file "${SCRIPT_DIR}/Dockerfile.hermes-execution" \
  --tag "${TAG}" \
  "${SCRIPT_DIR}"
docker image inspect "${TAG}" --format '{{.Id}}'
