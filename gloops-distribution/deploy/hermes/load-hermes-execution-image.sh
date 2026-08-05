#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:cd65e466dcd2878e9618ccb98e217c451a4460d787cf502f07d90ea3b37bc9ec'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-cd65e466dcd2878e9618ccb98e217c451a4460d787cf502f07d90ea3b37bc9ec.tar.zst'
readonly ARCHIVE_SHA256='24bd9079c4594463703fb5a90c0b6b19caec07f8ebd73326fe1828231fec19ef'

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
