#!/usr/bin/env bash
set -euo pipefail

readonly COMMISSIONING_ROLLBACK_JOURNAL='/var/lib/paperclip-gloops/controlled-swarm/commissioning-rollback.json'

# WG-PLAT-018: sourceable pre-install snapshot/restore for BOTH read-lane files.
source "$(dirname "${BASH_SOURCE[0]}")/read-lane-snapshot.sh"

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
# Semantically reconcile the read-lane manifest: SHA256SUMS alone does not prove
# a usable restore artifact, so verify every present snapshot's bytes match its
# recorded hash and governed mode/owner before we ever trust it for a restore.
check_read_lane_snapshot "${backup_dir}"
zstd -t "${backup_dir}/paperclip-state.tar.zst"
zstd -t "${backup_dir}/paperclip-db-physical.tar.zst"
tar --zstd -tf "${backup_dir}/paperclip-state.tar.zst" >/dev/null
tar --zstd -tf "${backup_dir}/paperclip-db-physical.tar.zst" >/dev/null
shopt -s nullglob
hermes_image_archives=("${backup_dir}"/hermes-execution-*.tar.zst)
shopt -u nullglob
for hermes_image_archive in "${hermes_image_archives[@]}"; do
  zstd -t "${hermes_image_archive}"
  tar --zstd -tf "${hermes_image_archive}" >/dev/null
done

if [[ "${mode}" == '--check' ]]; then
  echo "rollback artifacts are valid"
  exit 0
fi
[[ "${mode}" == '--restore' ]] || usage
if [[ -e "${COMMISSIONING_ROLLBACK_JOURNAL}" || -L "${COMMISSIONING_ROLLBACK_JOURNAL}" ]]; then
  echo "refusing rollback restore with an unresolved commissioning rollback journal" >&2
  exit 1
fi

for unit in paperclip.service paperclip-gloops.service paperclip-controlled-swarm.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service paperclip-controlled-swarm-commissioning-recovery.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing rollback while ${unit} is active" >&2
    exit 1
  fi
done
if docker ps -a --format '{{.Names}}' \
  | grep -Eq '^paperclip-(gloops|gloops-handshake|hermes-execution|hermes-handshake)$'; then
  echo "refusing rollback while a Paperclip or Hermes container exists" >&2
  exit 1
fi
if [[ -x /usr/local/lib/paperclip-gloops/github-app-credentials.py ]]; then
  /usr/local/lib/paperclip-gloops/github-app-credentials.py revoke-projector
  /usr/local/lib/paperclip-gloops/github-app-credentials.py revoke-hermes
fi
if [[ -x /usr/local/lib/paperclip-gloops/remove-hermes-handshake-egress.sh ]]; then
  /usr/local/lib/paperclip-gloops/remove-hermes-handshake-egress.sh
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
rm -f /etc/paperclip-gloops/ACTIVATION_APPROVED /etc/paperclip-gloops/HERMES_EXECUTION_APPROVED /etc/paperclip-gloops/HERMES_HANDSHAKE_APPROVED /etc/paperclip-gloops/CONTROLLED_SWARM_RUNTIME_APPROVED
rm -f /etc/paperclip-gloops/github-push-authorization.json /etc/paperclip-gloops/github-push-authorization.sha256 /etc/paperclip-gloops/github-broker-receipt-token
rm -f /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE /run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE
systemctl daemon-reload
systemctl disable --now paperclip.service paperclip-gloops.service paperclip-controlled-swarm.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service paperclip-controlled-swarm-commissioning-recovery.service 2>/dev/null || true
systemctl mask paperclip-gloops.service paperclip-controlled-swarm.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service paperclip-controlled-swarm-commissioning-recovery.service 2>/dev/null || true
docker rm -f paperclip-gloops-handshake 2>/dev/null || true
docker rm -f paperclip-hermes-execution 2>/dev/null || true
docker rm -f paperclip-hermes-handshake 2>/dev/null || true
rm -f /etc/paperclip-gloops/hermes-execution.env
rm -f /etc/paperclip-gloops/operator-board-token /etc/paperclip-gloops/projector-github-secret-id
rm -rf /run/paperclip-gloops
rm -rf /run/paperclip-campaign
rm -rf /run/paperclip-github-broker /var/lib/paperclip-gloops/github-push-broker
rm -rf /run/paperclip-github-read-broker /var/lib/paperclip-gloops/github-read-broker
rm -rf /run/paperclip-platform-ops-broker /var/lib/paperclip-gloops/platform-ops-broker
rm -rf /opt/paperclip/hermes-execution-profile /opt/paperclip/hermes-execution-state /opt/paperclip/hermes-handshake-profile
rm -rf /usr/local/lib/paperclip-gloops/tools /usr/local/lib/paperclip-gloops/hermes-handshake-guard
# Symmetrically restore BOTH read-lane files to their captured pre-install
# state: the broker (which the tool-dir purge above does NOT cover) and the
# read-tool client (removed with tools/ above).  Present files are restored and
# hash-verified against the backup; absent-marked files are removed -- never one
# lane rolled back and the other left with the new code.
restore_read_lane_snapshot "${backup_dir}"
docker network rm paperclip-execution >/dev/null 2>&1 || true
# Hand the backup manifest to the terminal verifier so it checks the RESTORED
# pair against the recorded old hashes (present->hash-equal, absent->absent).
READ_LANE_BACKUP_DIR="${backup_dir}" "/usr/local/lib/paperclip-gloops/verify-rollback-dark.sh"
echo "rollback restored the prior state and service definition; Paperclip, Hermes, and the campaign deadman remain dark"
