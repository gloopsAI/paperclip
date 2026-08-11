#!/usr/bin/env bash
set -euo pipefail

readonly REASON="${1:-campaign_epoch_expired}"
readonly CONFIG_DIR="${PAPERCLIP_CAMPAIGN_CONFIG_DIR:-/etc/paperclip-gloops}"
readonly STATE_DIR="${PAPERCLIP_CAMPAIGN_STATE_DIR:-/var/lib/paperclip-gloops/campaign-deadman}"
readonly RECEIPT="${STATE_DIR}/last-stop.json"
readonly SYSTEMCTL="${PAPERCLIP_CAMPAIGN_SYSTEMCTL:-systemctl}"
readonly DOCKER="${PAPERCLIP_CAMPAIGN_DOCKER:-docker}"
readonly COMMISSIONING_MARKER="${PAPERCLIP_CAMPAIGN_COMMISSIONING_MARKER:-/etc/paperclip-gloops/CONTROLLED_SWARM_COMMISSIONING_APPROVED}"
readonly COMMISSIONING_RECEIPT="${PAPERCLIP_CAMPAIGN_COMMISSIONING_RECEIPT:-/var/lib/paperclip-gloops/controlled-swarm/commissioning.json}"
readonly SET_COMMISSIONING="${PAPERCLIP_CAMPAIGN_SET_COMMISSIONING:-/usr/local/lib/paperclip-gloops/set-controlled-swarm-commissioning.py}"

[[ "${EUID}" -eq 0 || "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]] || {
  echo "campaign stop actuator must run as root" >&2
  exit 1
}
if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]]; then
  python3 - \
    "${CONFIG_DIR}" \
    "${STATE_DIR}" \
    "${COMMISSIONING_MARKER}" \
    "${COMMISSIONING_RECEIPT}" \
    "${SYSTEMCTL}" \
    "${DOCKER}" \
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

if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" == 'network-free' ]]; then
  mkdir -p "${STATE_DIR}"
  chmod 0700 "${STATE_DIR}"
else
  install -d -m 0700 -o root -g root "${STATE_DIR}"
fi
rm -f \
  "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED"

# A campaign expiry ends only the campaign-bound handshake/recovery plane.
# General Paperclip execution and the registered brokers are product services:
# their lifecycle is intentionally independent of a gym campaign timer.
"${SYSTEMCTL}" stop --no-block \
  paperclip-gloops-handshake.service \
  paperclip-hermes-handshake.service \
  paperclip-hermes-handshake-egress.service \
  paperclip-controlled-swarm-commissioning-recovery.service 2>/dev/null || true

deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  active=0
  for unit in \
    paperclip-gloops-handshake.service \
    paperclip-hermes-handshake.service \
    paperclip-hermes-handshake-egress.service \
    paperclip-controlled-swarm-commissioning-recovery.service; do
    "${SYSTEMCTL}" is-active --quiet "${unit}" && active=1
  done
  ((active == 0)) && break
  sleep 1
done

for container in \
  paperclip-gloops-handshake \
  paperclip-hermes-handshake; do
  "${DOCKER}" rm -f "${container}" >/dev/null 2>&1 || true
done

for unit in \
  paperclip-gloops-handshake.service \
  paperclip-hermes-handshake.service \
  paperclip-hermes-handshake-egress.service \
  paperclip-controlled-swarm-commissioning-recovery.service; do
  if "${SYSTEMCTL}" is-active --quiet "${unit}"; then
    echo "failed to stop ${unit}" >&2
    exit 1
  fi
done

rm -f \
  "${COMMISSIONING_MARKER}" \
  "${COMMISSIONING_RECEIPT}"
"${SET_COMMISSIONING}" false

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
if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" != 'network-free' ]]; then
  chown root:root "${tmp}"
fi
mv -f "${tmp}" "${RECEIPT}"
trap - EXIT
