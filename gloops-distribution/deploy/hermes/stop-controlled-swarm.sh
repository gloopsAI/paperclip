#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR="${PAPERCLIP_CONTROLLED_SWARM_CONFIG_DIR:-/etc/paperclip-gloops}"
readonly LIB_DIR="${PAPERCLIP_CONTROLLED_SWARM_LIB_DIR:-/usr/local/lib/paperclip-gloops}"
readonly STATE_DIR="${PAPERCLIP_CONTROLLED_SWARM_STATE_DIR:-/var/lib/paperclip-gloops/controlled-swarm}"
readonly LOCK="${PAPERCLIP_CONTROLLED_SWARM_LOCK:-/run/lock/paperclip-controlled-swarm.lock}"
readonly STOP_ACTUATOR="${PAPERCLIP_CONTROLLED_SWARM_STOP_ACTUATOR:-${LIB_DIR}/campaign-deadman-stop.sh}"
readonly SET_COMMISSIONING="${PAPERCLIP_CONTROLLED_SWARM_SET_COMMISSIONING:-${LIB_DIR}/set-controlled-swarm-commissioning.py}"

[[ "${EUID}" -eq 0 || "${PAPERCLIP_CONTROLLED_SWARM_TEST_MODE:-}" == 'network-free' ]] || {
  echo "controlled-swarm stop must run as root" >&2
  exit 1
}
if [[ "${PAPERCLIP_CONTROLLED_SWARM_TEST_MODE:-}" == 'network-free' ]]; then
  python3 - \
    "${CONFIG_DIR}" \
    "${LIB_DIR}" \
    "${STATE_DIR}" \
    "${LOCK}" \
    "${STOP_ACTUATOR}" \
    "${SET_COMMISSIONING}" <<'PY'
import pathlib
import sys

root = pathlib.Path("/tmp").resolve()
for raw in sys.argv[1:]:
    resolved = pathlib.Path(raw).resolve(strict=False)
    if resolved == root or root not in resolved.parents:
        raise SystemExit(
            f"network-free test mode requires every injected path under /tmp: {raw}"
        )
PY
fi
exec 9>"${LOCK}"
flock -n 9 || {
  echo "another controlled-swarm operation holds the activation lock" >&2
  exit 1
}

rm -f \
  "${CONFIG_DIR}/github-push-authorization.json" \
  "${CONFIG_DIR}/github-push-authorization.sha256" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_ACTIVATION_APPROVED" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_COMMISSIONING_APPROVED"
# The deadman actuator owns CONTROLLED_SWARM_RUNTIME_APPROVED: it must first
# convert that campaign marker into a durable product-restoration obligation,
# then remove the marker itself. The wrapper must never consume it early.
"${STOP_ACTUATOR}" operator_requested_stop
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
"${SET_COMMISSIONING}" false
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

if [[ "${PAPERCLIP_CONTROLLED_SWARM_TEST_MODE:-}" == 'network-free' ]]; then
  mkdir -p "${STATE_DIR}"
  chmod 0700 "${STATE_DIR}"
else
  install -d -m 0700 -o root -g root "${STATE_DIR}"
fi
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
if [[ "${PAPERCLIP_CONTROLLED_SWARM_TEST_MODE:-}" != 'network-free' ]]; then
  chown root:root "${tmp}"
fi
mv -f "${tmp}" "${STATE_DIR}/last-manual-stop.json"
echo "PASS controlled swarm stopped and campaign-free product execution resumed"
