#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly BASE_IMAGE='gloops/hermes-execution:moa-receipt-v2@sha256:fd1f8f68f600f8da0c42a38361d7333a8487015ed04ec5e6bcbed8b4bb9cb00b'
readonly TAG='hermes-agent-gloops:v020-route-receipt-v1'
readonly ARCHIVE="${SCRIPT_DIR}/hermes-agent-3c27eb6.tar.gz"
readonly ARCHIVE_SHA256='a68e96f385768ec6c466122bf21fcb697680a5f349c9a673badfbe27752b6928'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
[[ -f "${ARCHIVE}" ]] || {
  echo "missing ${ARCHIVE}; copy the verified upstream archive into the build context" >&2
  exit 1
}
printf '%s  %s\n' "${ARCHIVE_SHA256}" "${ARCHIVE}" | sha256sum -c -
docker image inspect "${BASE_IMAGE}" >/dev/null
docker build \
  --network none \
  --provenance=false \
  --file "${SCRIPT_DIR}/Dockerfile.hermes-execution" \
  --tag "${TAG}" \
  "${SCRIPT_DIR}"
docker image inspect "${TAG}" --format '{{.Id}}'
