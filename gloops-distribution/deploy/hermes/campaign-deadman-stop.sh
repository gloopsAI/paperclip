#!/usr/bin/env bash
set -euo pipefail

readonly REASON="${1:-campaign_epoch_expired}"
readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly STATE_DIR='/var/lib/paperclip-gloops/campaign-deadman'
readonly RECEIPT="${STATE_DIR}/last-stop.json"

[[ "${EUID}" -eq 0 ]] || {
  echo "campaign stop actuator must run as root" >&2
  exit 1
}

install -d -m 0700 -o root -g root "${STATE_DIR}"
rm -f \
  "${CONFIG_DIR}/ACTIVATION_APPROVED" \
  "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED" \
  "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED"

systemctl stop --no-block \
  paperclip-gloops.service \
  paperclip-gloops-handshake.service \
  paperclip-hermes-execution.service \
  paperclip-hermes-handshake.service \
  paperclip-hermes-handshake-egress.service 2>/dev/null || true

deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  active=0
  for unit in \
    paperclip-gloops.service \
    paperclip-gloops-handshake.service \
    paperclip-hermes-execution.service \
    paperclip-hermes-handshake.service \
    paperclip-hermes-handshake-egress.service; do
    systemctl is-active --quiet "${unit}" && active=1
  done
  ((active == 0)) && break
  sleep 1
done

for container in \
  paperclip-gloops \
  paperclip-gloops-handshake \
  paperclip-hermes-execution \
  paperclip-hermes-handshake; do
  docker rm -f "${container}" >/dev/null 2>&1 || true
done

for unit in \
  paperclip-gloops.service \
  paperclip-gloops-handshake.service \
  paperclip-hermes-execution.service \
  paperclip-hermes-handshake.service \
  paperclip-hermes-handshake-egress.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "failed to stop ${unit}" >&2
    exit 1
  fi
done

rm -f \
  /etc/paperclip-gloops/CONTROLLED_SWARM_COMMISSIONING_APPROVED \
  /var/lib/paperclip-gloops/controlled-swarm/commissioning.json
/usr/local/lib/paperclip-gloops/set-controlled-swarm-commissioning.py false

tmp="$(mktemp "${STATE_DIR}/last-stop.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
python3 - "${tmp}" "${REASON}" <<'PY'
import datetime as dt
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
receipt = {
    "schemaVersion": "gloops.campaign-deadman-stop.v1",
    "reason": sys.argv[2],
    "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "outcome": "dark",
}
path.write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
chmod 0600 "${tmp}"
chown root:root "${tmp}"
mv -f "${tmp}" "${RECEIPT}"
trap - EXIT
