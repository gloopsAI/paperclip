#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: sudo $0 --check BACKUP_DIR | --restore BACKUP_DIR" >&2
  exit 2
}

[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}
[[ "$#" -eq 2 ]] || usage
mode="$1"
backup_dir="$(realpath "$2")"
[[ -d "${backup_dir}" ]] || usage

(cd "${backup_dir}" && sha256sum -c SHA256SUMS)
zstd -t "${backup_dir}/paperclip-state.tar.zst"
zstd -t "${backup_dir}/paperclip-db-physical.tar.zst"
tar --zstd -tf "${backup_dir}/paperclip-state.tar.zst" >/dev/null
tar --zstd -tf "${backup_dir}/paperclip-db-physical.tar.zst" >/dev/null

if [[ "${mode}" == '--check' ]]; then
  echo "rollback artifacts are valid"
  exit 0
fi
[[ "${mode}" == '--restore' ]] || usage

for unit in paperclip.service paperclip-gloops.service paperclip-hermes-execution.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing rollback while ${unit} is active" >&2
    exit 1
  fi
done
if [[ -x /usr/local/lib/paperclip-gloops/github-app-credentials.py ]]; then
  /usr/local/lib/paperclip-gloops/github-app-credentials.py revoke-projector
  /usr/local/lib/paperclip-gloops/github-app-credentials.py revoke-hermes
fi

restore_stage="$(mktemp -d /home/paperclip/.paperclip.restore.XXXXXX)"
trap 'rm -rf "${restore_stage}"' EXIT
tar --zstd -xf "${backup_dir}/paperclip-state.tar.zst" -C "${restore_stage}"
restored_state="$(find "${restore_stage}" -mindepth 1 -maxdepth 2 -type d -name .paperclip -print -quit)"
[[ -n "${restored_state}" ]] || {
  echo "state archive does not contain .paperclip" >&2
  exit 1
}

rm -rf /home/paperclip/.paperclip.rollback-previous
mv /home/paperclip/.paperclip /home/paperclip/.paperclip.rollback-previous
mv "${restored_state}" /home/paperclip/.paperclip
chown -R paperclip:paperclip /home/paperclip/.paperclip

install -m 0644 -o root -g root "${backup_dir}/paperclip.service.before" /etc/systemd/system/paperclip.service
rm -f /etc/paperclip-gloops/ACTIVATION_APPROVED /etc/paperclip-gloops/HERMES_EXECUTION_APPROVED
systemctl daemon-reload
systemctl disable --now paperclip.service paperclip-gloops.service paperclip-hermes-execution.service 2>/dev/null || true
systemctl mask paperclip-gloops.service paperclip-hermes-execution.service 2>/dev/null || true
docker rm -f paperclip-hermes-execution 2>/dev/null || true
rm -f /etc/paperclip-gloops/hermes-execution.env
rm -f /etc/paperclip-gloops/operator-board-token /etc/paperclip-gloops/projector-github-secret-id
rm -rf /run/paperclip-gloops
rm -rf /opt/paperclip/hermes-execution-profile /opt/paperclip/hermes-execution-state
docker network rm paperclip-execution >/dev/null 2>&1 || true
echo "rollback restored the prior state and service definition; all Paperclip services remain dark"
