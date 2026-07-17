#!/usr/bin/env bash
set -euo pipefail

readonly REASON="${1:-campaign_epoch_expired}"
readonly TARGET='paperclip-campaign-deadman-rehearsal-target.service'
readonly STATE_DIR='/run/paperclip-campaign-rehearsal'
readonly RECEIPT="${STATE_DIR}/stop.json"

[[ "${EUID}" -eq 0 ]] || {
  echo "deadman rehearsal stop actuator must run as root" >&2
  exit 1
}

for unit in \
  paperclip-gloops.service \
  paperclip-gloops-handshake.service \
  paperclip-hermes-execution.service \
  paperclip-hermes-handshake.service \
  paperclip-hermes-handshake-egress.service; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing rehearsal actuator because production unit ${unit} is active" >&2
    exit 1
  fi
done

install -d -m 0700 -o root -g root "${STATE_DIR}"
systemctl stop "${TARGET}"

tmp="$(mktemp "${STATE_DIR}/stop.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT
python3 - "${tmp}" "${REASON}" <<'PY'
import datetime as dt
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
receipt = {
    "schemaVersion": "gloops.campaign-deadman-rehearsal-stop.v1",
    "reason": sys.argv[2],
    "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(
        timespec="milliseconds",
    ).replace("+00:00", "Z"),
    "target": "paperclip-campaign-deadman-rehearsal-target.service",
    "outcome": "stopped",
}
path.write_text(
    json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "${tmp}"
chown root:root "${tmp}"
mv -f "${tmp}" "${RECEIPT}"
trap - EXIT
