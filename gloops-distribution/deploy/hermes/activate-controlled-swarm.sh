#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly STATE_DIR='/var/lib/paperclip-gloops/controlled-swarm'
readonly APPROVAL="${CONFIG_DIR}/CONTROLLED_SWARM_ACTIVATION_APPROVED"
readonly EPOCH='/var/lib/paperclip-gloops/campaign-deadman/controlled-swarm-20260717/epoch.json'
readonly LOCK='/run/lock/paperclip-controlled-swarm.lock'
readonly DEADMAN='paperclip-campaign-deadman.service'
readonly HERMES='paperclip-hermes-execution.service'
readonly PAPERCLIP='paperclip-gloops.service'

[[ "${EUID}" -eq 0 ]] || {
  echo "controlled-swarm activation must run as root" >&2
  exit 1
}
exec 9>"${LOCK}"
flock -n 9 || {
  echo "another controlled-swarm operation holds the activation lock" >&2
  exit 1
}
[[ -f "${APPROVAL}" && "$(stat -c '%a:%U:%G' "${APPROVAL}")" == '600:root:root' ]] || {
  echo "one-use root-owned controlled-swarm approval is missing" >&2
  exit 1
}
approval_in_progress="${CONFIG_DIR}/.CONTROLLED_SWARM_ACTIVATION_APPROVED.${BASHPID}"
mv -T "${APPROVAL}" "${approval_in_progress}"
trap 'rm -f "${approval_in_progress}"' EXIT
grep -Fxq 'PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false' "${CONFIG_DIR}/runtime.env" || {
  echo "accepted source has not been bound to an immutable release" >&2
  exit 1
}
grep -Fxq 'PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false' "${CONFIG_DIR}/runtime.env" || {
  echo "inert activation requires startup execution recovery to remain disabled" >&2
  exit 1
}
grep -Fxq 'PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false' "${CONFIG_DIR}/runtime.env" || {
  echo "inert activation requires the execution-commissioning barrier" >&2
  exit 1
}
[[ ! -e "${EPOCH}" ]] || {
  echo "inert activation refuses an existing production campaign epoch" >&2
  exit 1
}

"${LIB_DIR}/verify-dark.sh"
rehearsal_receipt="$(
  python3 - "${LIB_DIR}/campaign-deadman.py" "${LIB_DIR}/campaign-deadman-rehearsal-stop.sh" \
    "${CONFIG_DIR}/approved-image" /var/lib/paperclip-gloops/rehearsals <<'PY'
import datetime as dt
import hashlib
import json
import pathlib
import stat
import sys

broker, actuator, image_path, receipts = map(pathlib.Path, sys.argv[1:])
expected_broker = f"sha256:{hashlib.sha256(broker.read_bytes()).hexdigest()}"
expected_actuator = f"sha256:{hashlib.sha256(actuator.read_bytes()).hexdigest()}"
expected_image = image_path.read_text(encoding="utf-8").strip()
candidates = sorted(receipts.glob("campaign-deadman-*.json"), reverse=True)
for path in candidates:
    file_stat = path.stat()
    if (
        file_stat.st_uid != 0
        or file_stat.st_gid != 0
        or stat.S_IMODE(file_stat.st_mode) != 0o600
    ):
        continue
    value = json.loads(path.read_text(encoding="utf-8"))
    completed = dt.datetime.fromisoformat(value["completedAt"].replace("Z", "+00:00"))
    age = dt.datetime.now(dt.timezone.utc) - completed
    if (
        dt.timedelta(0) <= age <= dt.timedelta(hours=24)
        and value.get("schemaVersion") == "gloops.campaign-deadman-rehearsal.v1"
        and value.get("outcome") == "passed"
        and value.get("logicalDurationSeconds") == 86_400
        and value.get("installedBrokerSha256") == expected_broker
        and value.get("installedStopActuatorSha256") == expected_actuator
        and value.get("approvedImage") == expected_image
        and value.get("epochRootOwned") is True
        and value.get("epochMode") == "0600"
        and value.get("epochImmutable") is True
        and value.get("restartPreservedEpoch") is True
        and value.get("postExpiryAdmissionDenied") is True
        and value.get("postExpiryRestartRemainedExpired") is True
        and value.get("cleanupVerifiedDark") is True
        and value.get("providersInvoked") is False
        and value.get("paperclipActivated") is False
        and value.get("productionEpochCreated") is False
    ):
        print(path)
        break
else:
    raise SystemExit("no recent exact-artifact deadman rehearsal receipt exists")
PY
)"
python3 - "${approval_in_progress}" "${rehearsal_receipt}" "${CONFIG_DIR}/approved-image" <<'PY'
import datetime as dt
import hashlib
import json
import pathlib
import sys

approval_path, rehearsal_path, image_path = map(pathlib.Path, sys.argv[1:])
approval = json.loads(approval_path.read_text(encoding="utf-8"))
rehearsal_digest = f"sha256:{hashlib.sha256(rehearsal_path.read_bytes()).hexdigest()}"
approved_image = image_path.read_text(encoding="utf-8").strip()
now = dt.datetime.now(dt.timezone.utc)
authorized = dt.datetime.fromisoformat(approval["authorizedAt"].replace("Z", "+00:00"))
expires = dt.datetime.fromisoformat(approval["expiresAt"].replace("Z", "+00:00"))
if (
    set(approval) != {
        "schemaVersion",
        "authorization",
        "campaignId",
        "approvedImage",
        "rehearsalReceipt",
        "rehearsalReceiptSha256",
        "authorizedAt",
        "expiresAt",
    }
    or approval["schemaVersion"] != "gloops.controlled-swarm-activation-approval.v1"
    or approval["authorization"] != "activate_inert_control_plane"
    or approval["campaignId"] != "controlled-swarm-20260717"
    or approval["approvedImage"] != approved_image
    or approval["rehearsalReceipt"] != str(rehearsal_path)
    or approval["rehearsalReceiptSha256"] != rehearsal_digest
    or not authorized <= now < expires
    or expires - authorized > dt.timedelta(hours=4)
):
    raise SystemExit("controlled-swarm approval is stale, malformed, or artifact-mismatched")
PY

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  rm -f \
    "${CONFIG_DIR}/ACTIVATION_APPROVED" \
    "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED" \
    "${APPROVAL}" \
    "${approval_in_progress}"
  systemctl stop "${PAPERCLIP}" "${HERMES}" "${DEADMAN}"
  systemctl mask "${PAPERCLIP}" "${HERMES}" "${DEADMAN}"
  systemctl reset-failed "${PAPERCLIP}" "${HERMES}" "${DEADMAN}"
  "${LIB_DIR}/verify-dark.sh"
  exit "${status}"
}
trap cleanup EXIT

systemctl unmask "${DEADMAN}" "${HERMES}" "${PAPERCLIP}"
systemctl daemon-reload
systemctl start "${DEADMAN}"
"${LIB_DIR}/verify-campaign-deadman.py" \
  --wait-seconds 15 \
  --require-status unarmed
install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"
systemctl start "${HERMES}"
install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/ACTIVATION_APPROVED"
systemctl start "${PAPERCLIP}"
systemctl is-active --quiet "${DEADMAN}"
systemctl is-active --quiet "${HERMES}"
systemctl is-active --quiet "${PAPERCLIP}"
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3100/api/health >/dev/null
"${LIB_DIR}/verify-hermes-execution-profile.sh" --live
[[ ! -e "${EPOCH}" ]] || {
  echo "inert activation unexpectedly armed the campaign epoch" >&2
  exit 1
}

install -d -m 0700 -o root -g root "${STATE_DIR}"
receipt_tmp="$(mktemp "${STATE_DIR}/activation.XXXXXX")"
approval_sha256="sha256:$(sha256sum "${approval_in_progress}" | awk '{print $1}')"
python3 - "${receipt_tmp}" "${rehearsal_receipt}" \
  "$("${LIB_DIR}/verify-campaign-deadman.py" \
    --wait-seconds 5 \
    --require-status unarmed)" \
  "${approval_sha256}" <<'PY'
import datetime as dt
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
receipt = {
    "schemaVersion": "gloops.controlled-swarm-activation.v1",
    "activatedAt": dt.datetime.now(dt.timezone.utc).isoformat(
        timespec="milliseconds",
    ).replace("+00:00", "Z"),
    "rehearsalReceipt": sys.argv[2],
    "deadmanVerification": sys.argv[3],
    "consumedApprovalSha256": sys.argv[4],
    "services": {
        "paperclip": "active",
        "hermes": "active",
        "campaignDeadman": "active",
    },
    "campaignEpochState": "unarmed",
    "executionRecoveryDriverEnabled": False,
    "executionCommissioned": False,
    "startupWorkAdmissionObserved": False,
    "providerInvocationPossibleWithoutAdmission": False,
}
path.write_text(
    json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "${receipt_tmp}"
chown root:root "${receipt_tmp}"
mv -f "${receipt_tmp}" "${STATE_DIR}/last-activation.json"
rm -f "${approval_in_progress}"
trap - EXIT
echo "PASS controlled swarm is active and inert; the campaign epoch remains unarmed"
