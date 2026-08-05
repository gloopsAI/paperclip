#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:e816faba30dfb38f06371ae3db9d1f30d5c9bf38bae41ff6230d746665fdfa18'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-e816faba30dfb38f06371ae3db9d1f30d5c9bf38bae41ff6230d746665fdfa18.tar.zst'
readonly ARCHIVE_SHA256='e055de2a9ee253867d8b89196dab3ef1ce2b40de27fbe7bae3ea90174dc50d3b'

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
