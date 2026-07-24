#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:7e94fdbd276710806b772ba0fdc03a4a2682a870f7786e5e27cac9fa767a9488'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-7e94fdbd276710806b772ba0fdc03a4a2682a870f7786e5e27cac9fa767a9488.tar.zst'
readonly ARCHIVE_SHA256='9e3236b846e19642f14f7d708d07901a532ba24c4ea34a9ae6f28bfe67f183b0'

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
