#!/usr/bin/env bash
set -euo pipefail

readonly REASON="${1:-campaign_epoch_expired}"
readonly CONFIG_DIR="${PAPERCLIP_CAMPAIGN_CONFIG_DIR:-/etc/paperclip-gloops}"
readonly STATE_DIR="${PAPERCLIP_CAMPAIGN_STATE_DIR:-/var/lib/paperclip-gloops/campaign-deadman}"
readonly RECEIPT="${STATE_DIR}/last-stop.json"
readonly RESTORE_PENDING="${STATE_DIR}/product-restore-pending.json"
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

# Persist the product-restoration obligation before deleting the campaign
# authority marker. The stop actuator may be retried after any partial failure;
# only a verified healthy general product plane is allowed to clear this state.
if [[ -e "${CONFIG_DIR}/CONTROLLED_SWARM_RUNTIME_APPROVED" && ! -e "${RESTORE_PENDING}" ]]; then
  pending_tmp="$(mktemp "${STATE_DIR}/product-restore-pending.XXXXXX")"
  trap 'rm -f "${pending_tmp}"' EXIT
  python3 - "${pending_tmp}" "${REASON}" <<'PY'
import datetime as dt
import json
import pathlib
import sys
import uuid

path = pathlib.Path(sys.argv[1])
pending = {
    "schemaVersion": "gloops.product-restore-pending.v1",
    "obligationId": str(uuid.uuid4()),
    "reason": sys.argv[2],
    "requestedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
}
path.write_text(json.dumps(pending, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  chmod 0600 "${pending_tmp}"
  if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" != 'network-free' ]]; then
    chown root:root "${pending_tmp}"
  fi
  mv -f "${pending_tmp}" "${RESTORE_PENDING}"
  trap - EXIT
fi
restore_general=0
[[ -e "${RESTORE_PENDING}" ]] && restore_general=1

rm -f \
  "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED" \
  "${CONFIG_DIR}/CONTROLLED_SWARM_RUNTIME_APPROVED"

# A campaign expiry ends only the campaign-bound handshake/recovery plane.
# General Paperclip execution and the registered brokers are product services:
# their lifecycle is intentionally independent of a gym campaign timer.
"${SYSTEMCTL}" stop --no-block \
  paperclip-controlled-swarm.service \
  paperclip-gloops-handshake.service \
  paperclip-hermes-handshake.service \
  paperclip-hermes-handshake-egress.service \
  paperclip-controlled-swarm-commissioning-recovery.service 2>/dev/null || true

deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  active=0
  for unit in \
    paperclip-controlled-swarm.service \
    paperclip-gloops-handshake.service \
    paperclip-hermes-handshake.service \
    paperclip-hermes-handshake-egress.service \
    paperclip-controlled-swarm-commissioning-recovery.service; do
    "${SYSTEMCTL}" is-active --quiet "${unit}" && active=1
  done
  ((active == 0)) && break
  sleep 1
done

# The campaign and general units share the paperclip-gloops name. The campaign
# unit's own ExecStopPost removes it while the unit is still fenced above; a
# direct removal here can race a restored general unit on an actuator retry.
for container in \
  paperclip-gloops-handshake \
  paperclip-hermes-handshake; do
  "${DOCKER}" rm -f "${container}" >/dev/null 2>&1 || true
done

for unit in \
  paperclip-controlled-swarm.service \
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

outcome='campaign_stopped'
restore_failed=0
preserve_receipt=0
if ((restore_general == 1)); then
  # The campaign and general control planes deliberately share one port and
  # container name. Fence and mask the campaign unit first, then restore the
  # pre-authorized campaign-free service with bounded retries. Hermes and the
  # registered brokers remain active throughout the handoff.
  "${SYSTEMCTL}" mask paperclip-controlled-swarm.service
  if [[ ! -e "${CONFIG_DIR}/ACTIVATION_APPROVED" ]]; then
    echo 'campaign expiry cannot restore general Paperclip without its activation marker' >&2
    outcome='product_restore_failed'
    restore_failed=1
  else
    "${SYSTEMCTL}" unmask paperclip-gloops.service
    "${SYSTEMCTL}" reset-failed paperclip-gloops.service 2>/dev/null || true
    restored=0
    for attempt in 1 2 3; do
      if "${SYSTEMCTL}" start paperclip-gloops.service \
        && "${SYSTEMCTL}" is-active --quiet paperclip-gloops.service; then
        restored=1
        break
      fi
      ((attempt < 3)) && sleep 1
    done
    if ((restored == 1)); then
      outcome='product_restored'
    else
      echo 'campaign expiry failed to restore general Paperclip after three attempts' >&2
      outcome='product_restore_failed'
      restore_failed=1
    fi
  fi
elif [[ -f "${RECEIPT}" ]]; then
  # A late broker retry after successful restoration must not downgrade the
  # durable product outcome to a generic campaign stop. Likewise, a missing
  # pending file cannot silently turn a recorded restoration failure green.
  prior_outcome="$(python3 - "${RECEIPT}" <<'PY' 2>/dev/null || true
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get("outcome")
if value in {"product_restored", "product_restore_failed"}:
    print(value)
PY
)"
  case "${prior_outcome}" in
    product_restored)
      outcome='product_restored'
      preserve_receipt=1
      ;;
    product_restore_failed)
      outcome='product_restore_failed'
      preserve_receipt=1
      restore_failed=1
      ;;
  esac
fi

if ((preserve_receipt == 0)); then
  tmp="$(mktemp "${STATE_DIR}/last-stop.XXXXXX")"
  trap 'rm -f "${tmp}"' EXIT
  python3 - "${tmp}" "${REASON}" "${outcome}" <<'PY'
import datetime as dt
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
receipt = {
    "schemaVersion": "gloops.campaign-deadman-stop.v1",
    "reason": sys.argv[2],
    "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "outcome": sys.argv[3],
}
path.write_text(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY
  chmod 0600 "${tmp}"
  if [[ "${PAPERCLIP_CAMPAIGN_TEST_MODE:-}" != 'network-free' ]]; then
    chown root:root "${tmp}"
  fi
  mv -f "${tmp}" "${RECEIPT}"
  trap - EXIT
fi

if ((restore_general == 1 && restore_failed == 0)); then
  rm -f "${RESTORE_PENDING}"
fi
((restore_failed == 0))
