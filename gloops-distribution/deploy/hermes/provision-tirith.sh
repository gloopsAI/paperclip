#!/usr/bin/env bash
set -euo pipefail

readonly VERSION='0.3.3'
readonly ARCHIVE='tirith-x86_64-unknown-linux-gnu.tar.gz'
readonly ARCHIVE_SHA256='6cdbe35e8f9ccf42e70ad95b501c93cd218ac18201c3df958d54f6ba0d995ce2'
readonly BINARY_SHA256='55a15bbcc726a9021c41be0e823878597560c23fec458ced3b804d1cbce19afe'
readonly RELEASE_URL="https://github.com/sheeki03/tirith/releases/download/v${VERSION}/${ARCHIVE}"
readonly TOOL_DIR='/usr/local/lib/paperclip-gloops/tools'
readonly DESTINATION="${TOOL_DIR}/tirith"

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}

if [[ -f "${DESTINATION}" ]] \
  && [[ "$(sha256sum "${DESTINATION}" | cut -d' ' -f1)" == "${BINARY_SHA256}" ]] \
  && [[ "$(stat -c '%a:%U:%G' "${DESTINATION}")" == '555:root:root' ]]; then
  echo "pinned Tirith ${VERSION} is already provisioned"
  exit 0
fi

for command in curl sha256sum tar; do
  command -v "${command}" >/dev/null || {
    echo "required provisioning command is missing: ${command}" >&2
    exit 1
  }
done

stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${stage}/${ARCHIVE}" "${RELEASE_URL}"
printf '%s  %s\n' "${ARCHIVE_SHA256}" "${stage}/${ARCHIVE}" | sha256sum -c -
tar -tzf "${stage}/${ARCHIVE}" >"${stage}/archive-members.txt"
grep -Fxq 'tirith' "${stage}/archive-members.txt"
tar -xOf "${stage}/${ARCHIVE}" tirith >"${stage}/tirith"
printf '%s  %s\n' "${BINARY_SHA256}" "${stage}/tirith" | sha256sum -c -

install -d -m 0755 -o root -g root "${TOOL_DIR}"
install -m 0555 -o root -g root "${stage}/tirith" "${TOOL_DIR}/.tirith.new"
mv -f "${TOOL_DIR}/.tirith.new" "${DESTINATION}"
"${DESTINATION}" --version | grep -Fq "${VERSION}"
echo "provisioned pinned Tirith ${VERSION} at ${DESTINATION}"
