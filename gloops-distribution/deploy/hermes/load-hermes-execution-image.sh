#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:210427ae7dc5b61f37aad0c0df5083018bb9c1de04cf9affde645a74988d64ab'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-210427ae7dc5b61f37aad0c0df5083018bb9c1de04cf9affde645a74988d64ab.tar.zst'
readonly ARCHIVE_SHA256='9447db763a51d6f69613b985d749a1bcdd4b04624344813027c2fc925510c83d'

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
