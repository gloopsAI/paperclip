#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:0049638c8554593bfc4dfa767408e04ff2c0caa1b6b94208034a538842f45106'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-0049638c8554593bfc4dfa767408e04ff2c0caa1b6b94208034a538842f45106.tar.zst'
readonly ARCHIVE_SHA256='3e6f7c3ee31e087ef6b135dac756474eb967070b8722da0f36c894f4e42889f3'

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
