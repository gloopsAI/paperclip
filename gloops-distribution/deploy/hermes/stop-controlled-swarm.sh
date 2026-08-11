#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly STATE_DIR='/var/lib/paperclip-gloops/controlled-swarm'
readonly LOCK='/run/lock/paperclip-controlled-swarm.lock'

[[ "${EUID}" -eq 0 ]] || {
  echo "controlled-swarm stop must run as root" >&2
  exit 1
}
exec 9>"${LOCK}"
flock -n 9 || {
  echo "another controlled-swarm operation holds the activation lock" >&2
  exit 1
}

rm -f \
  "${CONFIG_DIR}/CONTROLLED_SWARM_RUNTIME_APPROVED" \
  "${CONFIG_DIR}/github-push-authorization.json" \
  "${CONFIG_DIR}/github-push-authorization.sha256" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_ACTIVATION_APPROVED" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_COMMISSIONING_APPROVED"
"${LIB_DIR}/campaign-deadman-stop.sh" operator_requested_stop
systemctl stop paperclip-campaign-deadman.service
systemctl stop paperclip-controlled-swarm-commissioning-recovery.service
systemctl mask \
  paperclip-controlled-swarm.service \
  paperclip-campaign-deadman.service \
  paperclip-controlled-swarm-commissioning-recovery.service
for unit in \
  paperclip-controlled-swarm.service \
  paperclip-campaign-deadman.service \
  paperclip-controlled-swarm-commissioning-recovery.service
do
  systemctl reset-failed "${unit}" 2>/dev/null || true
done
"${LIB_DIR}/set-controlled-swarm-commissioning.py" false
systemctl is-active --quiet paperclip-gloops.service
for surviving_unit in \
  paperclip-hermes-execution.service \
  paperclip-github-push-broker.service \
  paperclip-github-read-broker.service \
  paperclip-platform-ops-broker.service; do
  systemctl is-active --quiet "${surviving_unit}"
done
for stopped_unit in \
  paperclip-controlled-swarm.service \
  paperclip-campaign-deadman.service \
  paperclip-controlled-swarm-commissioning-recovery.service; do
  ! systemctl is-active --quiet "${stopped_unit}"
done

install -d -m 0700 -o root -g root "${STATE_DIR}"
tmp="$(mktemp "${STATE_DIR}/manual-stop.XXXXXX")"
python3 - "${tmp}" <<'PY'
import datetime as dt
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(
    json.dumps(
        {
            "schemaVersion": "gloops.controlled-swarm-stop.v1",
            "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(
                timespec="milliseconds",
            ).replace("+00:00", "Z"),
            "reason": "operator_requested_stop",
            "outcome": "product_continues",
        },
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "${tmp}"
chown root:root "${tmp}"
mv -f "${tmp}" "${STATE_DIR}/last-manual-stop.json"
echo "PASS controlled swarm stopped and campaign-free product execution resumed"
