#!/usr/bin/env bash
set -euo pipefail

readonly STATE_DIR='/home/paperclip/.paperclip'
readonly DATABASE_DIR="${STATE_DIR}/instances/default/db"
readonly BACKUP_ROOT='/opt/paperclip/backups'
readonly SERVICE_FILE='/etc/systemd/system/paperclip.service'

[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}

for unit in paperclip.service paperclip-gloops.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing cold backup while ${unit} is active" >&2
    exit 1
  fi
done

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
(
  cd "${stage}"
  sha256sum paperclip-db-physical.tar.zst paperclip-state.tar.zst paperclip.service.before >SHA256SUMS
)
chmod 0600 "${stage}/SHA256SUMS" "${stage}"/*.zst
mv "${stage}" "${destination}"
trap - EXIT

"$(dirname "$0")/rollback.sh" --check "${destination}"
echo "cold rollback backup captured: ${destination}"
