#!/usr/bin/env bash
set -euo pipefail

readonly STATE_DIR='/home/paperclip/.paperclip'
readonly DATABASE_DIR="${STATE_DIR}/instances/default/db"
readonly BACKUP_ROOT='/opt/paperclip/backups'
readonly SERVICE_FILE='/etc/systemd/system/paperclip.service'
readonly HERMES_IMAGE_ARCHIVE='/opt/paperclip/release-artifacts/hermes-execution-fd1f8f68f600f8da0c42a38361d7333a8487015ed04ec5e6bcbed8b4bb9cb00b.tar.zst'
readonly COMMISSIONING_ROLLBACK_JOURNAL='/var/lib/paperclip-gloops/controlled-swarm/commissioning-rollback.json'

# WG-PLAT-018: sourceable pre-install snapshot/restore for BOTH read-lane files.
source "$(dirname "${BASH_SOURCE[0]}")/read-lane-snapshot.sh"

refuse_unresolved_commissioning() {
  local journal="${1:?commissioning rollback journal path is required}"
  if [[ -e "${journal}" || -L "${journal}" ]]; then
    echo "refusing cold backup while a controlled-swarm commissioning rollback journal survives: ${journal}" >&2
    return 1
  fi
}

main() {
[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}

refuse_unresolved_commissioning "${COMMISSIONING_ROLLBACK_JOURNAL}"

for unit in paperclip.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service paperclip-controlled-swarm-commissioning-recovery.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing cold backup while ${unit} is active" >&2
    exit 1
  fi
done
if docker ps -a --format '{{.Names}}' \
  | grep -Eq '^paperclip-(gloops|gloops-handshake|hermes-execution|hermes-handshake)$'; then
  echo "refusing cold backup while a Paperclip or Hermes container exists" >&2
  exit 1
fi

[[ -d "${STATE_DIR}" ]] || {
  echo "Paperclip state directory is missing: ${STATE_DIR}" >&2
  exit 1
}
[[ -d "${DATABASE_DIR}" ]] || {
  echo "Paperclip database directory is missing: ${DATABASE_DIR}" >&2
  exit 1
}
[[ -f "${SERVICE_FILE}" ]] || {
  echo "prior Paperclip service definition is missing: ${SERVICE_FILE}" >&2
  exit 1
}
[[ "$(stat -c '%a:%U:%G' "${HERMES_IMAGE_ARCHIVE}" 2>/dev/null || true)" == '600:root:root' ]] || {
  echo "Hermes execution image archive is missing or not root-protected: ${HERMES_IMAGE_ARCHIVE}" >&2
  exit 1
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${1:-${BACKUP_ROOT}/dark-install-${stamp}}"
[[ ! -e "${destination}" ]] || {
  echo "backup destination already exists: ${destination}" >&2
  exit 1
}

install -d -m 0700 -o root -g root "${BACKUP_ROOT}"
stage="$(mktemp -d "${BACKUP_ROOT}/.dark-install-${stamp}.XXXXXX")"
trap 'rm -rf "${stage}"' EXIT

tar --zstd -cf "${stage}/paperclip-state.tar.zst" -C /home/paperclip .paperclip
tar --zstd -cf "${stage}/paperclip-db-physical.tar.zst" -C "${STATE_DIR}/instances/default" db
install -m 0600 -o root -g root "${SERVICE_FILE}" "${stage}/paperclip.service.before"
# Capture the PRE-install state (content + old hash, or "absent") of BOTH halves
# of the read-only evidence lane so rollback can restore them symmetrically.
capture_read_lane_snapshot "${stage}"
# Fail before publishing the backup if the manifest cannot be used to restore
# the exact copied artifacts. This is semantic validation in addition to the
# aggregate SHA256SUMS written below.
check_read_lane_snapshot "${stage}"
ln "${HERMES_IMAGE_ARCHIVE}" "${stage}/$(basename "${HERMES_IMAGE_ARCHIVE}")"
(
  cd "${stage}"
  files=(hermes-execution-*.tar.zst paperclip-db-physical.tar.zst paperclip-state.tar.zst paperclip.service.before read-lane.manifest)
  for snapshot in read-lane.*.before; do
    [[ -e "${snapshot}" ]] && files+=("${snapshot}")
  done
  sha256sum "${files[@]}" >SHA256SUMS
)
chmod 0600 "${stage}/SHA256SUMS" "${stage}"/*.zst
mv "${stage}" "${destination}"
trap - EXIT

"$(dirname "$0")/rollback.sh" --check "${destination}"
echo "cold rollback backup captured: ${destination}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
