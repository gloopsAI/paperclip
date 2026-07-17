#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:3fa158ecc7635512e6c0b33d68084de1eae33593ca009225cd2f7fbd7af2902d'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-3fa158ecc7635512e6c0b33d68084de1eae33593ca009225cd2f7fbd7af2902d.tar.zst'
readonly ARCHIVE_SHA256='58e7325459157c8085052cfd4be322c00825111881a14f978124a667b42518d3'

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}
[[ "$(stat -c '%a:%U:%G' "${ARCHIVE}" 2>/dev/null || true)" == '600:root:root' ]] || {
  echo "Hermes execution image archive is missing or not root-protected: ${ARCHIVE}" >&2
  exit 1
}
printf '%s  %s\n' "${ARCHIVE_SHA256}" "${ARCHIVE}" | sha256sum -c -
zstd -t "${ARCHIVE}"

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  zstd -dc "${ARCHIVE}" | docker load >/dev/null
fi
docker image inspect "${IMAGE}" >/dev/null
echo "loaded exact Hermes execution image ${IMAGE} from the verified release archive"
