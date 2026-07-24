#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:fd1f8f68f600f8da0c42a38361d7333a8487015ed04ec5e6bcbed8b4bb9cb00b'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-fd1f8f68f600f8da0c42a38361d7333a8487015ed04ec5e6bcbed8b4bb9cb00b.tar.zst'
readonly ARCHIVE_SHA256='94015a0ba990fe69c027355facddb34450807ba026b2b81d79275887a16d1637'

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
