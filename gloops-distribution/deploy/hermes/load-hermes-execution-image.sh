#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE='sha256:153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca'
readonly ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca.tar.zst'
readonly ARCHIVE_SHA256='3cc435332944f18ef2e4ad043c152dfb86eaac560b9be4886876450b2e21d4d2'

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
