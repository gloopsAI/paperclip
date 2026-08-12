#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:c4fa52bdfbba974b4dee60c1ba5efaa8218221a106a8dd5fb50f201a82e896f3'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-c4fa52bdfbba974b4dee60c1ba5efaa8218221a106a8dd5fb50f201a82e896f3.tar.zst'
readonly ARCHIVE_SHA256='ab599099beaf87dbf39a8b2bfa58ac44bc3178617638bb4b0360b88a22b75e27'

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
