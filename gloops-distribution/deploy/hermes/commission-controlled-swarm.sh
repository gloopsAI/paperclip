#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly STATE_DIR='/var/lib/paperclip-gloops/controlled-swarm'
readonly APPROVAL="${CONFIG_DIR}/CONTROLLED_SWARM_COMMISSIONING_APPROVED"
readonly RECEIPT="${STATE_DIR}/commissioning.json"
readonly EPOCH='/var/lib/paperclip-gloops/campaign-deadman/controlled-swarm-20260717/epoch.json'
readonly LOCK='/run/lock/paperclip-controlled-swarm.lock'
readonly PAPERCLIP='paperclip-gloops.service'
readonly HERMES='paperclip-hermes-execution.service'
readonly DEADMAN='paperclip-campaign-deadman.service'

[[ "${EUID}" -eq 0 ]] || {
  echo "controlled-swarm commissioning must run as root" >&2
  exit 1
}
exec 9>"${LOCK}"
flock -n 9 || {
  echo "another controlled-swarm operation holds the activation lock" >&2
  exit 1
}
[[ -f "${APPROVAL}" && "$(stat -c '%a:%U:%G' "${APPROVAL}")" == '600:root:root' ]] || {
  echo "one-use root-owned controlled-swarm commissioning approval is missing" >&2
  exit 1
}
approval_in_progress="${CONFIG_DIR}/.CONTROLLED_SWARM_COMMISSIONING_APPROVED.${BASHPID}"
mv -T "${APPROVAL}" "${approval_in_progress}"
trap 'rm -f "${approval_in_progress}"' EXIT

for unit in "${DEADMAN}" "${HERMES}" "${PAPERCLIP}"; do
  systemctl is-active --quiet "${unit}" || {
    echo "commissioning requires an already healthy inert control plane: ${unit}" >&2
    exit 1
  }
done
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3100/api/health >/dev/null
grep -Fxq 'PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false' \
  "${CONFIG_DIR}/runtime.env" || {
    echo "commissioning requires the inert execution barrier" >&2
    exit 1
  }
[[ ! -e "${EPOCH}" ]] || {
  echo "commissioning refuses an existing campaign epoch" >&2
  exit 1
}

install -d -m 0700 -o root -g root "${STATE_DIR}"
receipt_tmp="$(mktemp "${STATE_DIR}/commissioning.XXXXXX")"
python3 - \
  "${approval_in_progress}" \
  "${CONFIG_DIR}/approved-image" \
  "${CONFIG_DIR}/operator-board-token" \
  "${receipt_tmp}" <<'PY'
import datetime as dt
import hashlib
import json
import pathlib
import stat
import sys
import urllib.request

approval_path, image_path, token_path, receipt_path = map(pathlib.Path, sys.argv[1:])
approval = json.loads(approval_path.read_text(encoding="utf-8"))
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
        "governanceMerge",
        "authorizedAt",
        "expiresAt",
    }
    or approval["schemaVersion"] != "gloops.controlled-swarm-commissioning-approval.v1"
    or approval["authorization"] != "commission_twelve_ollama_roles"
    or approval["campaignId"] != "controlled-swarm-20260717"
    or approval["approvedImage"] != approved_image
    or approval["governanceMerge"] != "3a5820722e8c6f55d6a1a730cada1cb4f1a1df77"
    or not authorized <= now < expires
    or expires - authorized > dt.timedelta(hours=4)
):
    raise SystemExit("commissioning approval is stale, malformed, or boundary-mismatched")

token_stat = token_path.stat()
if token_stat.st_uid != 0 or stat.S_IMODE(token_stat.st_mode) != 0o600:
    raise SystemExit("operator board token boundary is invalid")
token = token_path.read_text(encoding="utf-8").strip()
request = urllib.request.Request(
    "http://127.0.0.1:3100/api/companies/89ed0964-d918-4fcc-b830-5be49d2d4089/agent-configurations",
    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
)
with urllib.request.urlopen(request, timeout=10) as response:
    agents = json.loads(response.read())

admitted = {
    "Northstar": "2f68703f-c2bd-40e1-a91e-70bc4d702e5e",
    "Atlas": "5768cc30-f8b9-4b20-871e-badf7d574b9b",
    "Conductor": "15cdc815-2a68-437b-a93b-d1f1157aa8a3",
    "Dispatch": "fd571350-6da8-482e-a17e-7edb914fa612",
    "Mason": "76a090e6-1523-4086-be5f-2a7dd7a37238",
    "Wren": "3298054f-0fc5-4ff9-8c53-b1382b3046d3",
    "Scout": "a89f54cc-3f1b-4157-b25b-c6c7a4fdcc1a",
    "Radar": "532a3827-3133-45a6-834a-486415c53b87",
    "Context Steward": "81a870b3-a474-44be-95e7-1151a9532832",
    "Argus": "843c62bc-6f32-420e-9b62-7a2d6a34846f",
    "Harbor": "a3a1cb4c-390a-4d40-9a88-8609183ed012",
    "Reception": "f57fe56c-639d-4826-b462-ff2e8a0116c4",
}
paused = {agent["name"]: agent for agent in agents if agent.get("status") == "paused"}
if any(paused.get(name, {}).get("id") != agent_id for name, agent_id in admitted.items()):
    raise SystemExit("the twelve admitted identities are not exact and paused")
if any(
    paused[name].get("adapterType") != "hermes_gateway"
    or paused[name].get("runtimeConfig", {}).get("heartbeat", {}).get("enabled") is not False
    or paused[name].get("runtimeConfig", {}).get("heartbeat", {}).get("intervalSec") != 3600
    or paused[name].get("runtimeConfig", {}).get("heartbeat", {}).get("wakeOnDemand") is not True
    or paused[name].get("runtimeConfig", {}).get("heartbeat", {}).get("maxConcurrentRuns") != 1
    or paused[name].get("adapterConfig", {}).get("instructions", "").count(
        "<!-- GLOOPS_CONTROLLED_SWARM_PROTOCOL_START -->",
    ) != 1
    or paused[name].get("adapterConfig", {}).get("instructions", "").count(
        "<!-- GLOOPS_CONTROLLED_SWARM_PROTOCOL_END -->",
    ) != 1
    or "controlled-swarm-20260717"
    not in paused[name].get("adapterConfig", {}).get("instructions", "")
    for name in admitted
):
    raise SystemExit("an admitted identity has drifted from the exact execution protocol")
for name, agent_id in {
    "Grok Burst": "fb0a4d29-a670-464a-8956-b9dfdb4e4529",
    "Codex Burst": "a9ff2c34-0bd1-44e9-866a-3b03ce678cf4",
    "Fourth Pilot Engineer": "dc607ee2-5c10-4bbd-9d2a-c8e5e33be936",
}.items():
    if paused.get(name, {}).get("id") != agent_id:
        raise SystemExit(f"{name} is not exactly paused")
reflection = [agent for agent in agents if agent.get("name") == "Reflection Coach"]
if len(reflection) != 1 or reflection[0].get("status") != "pending_approval":
    raise SystemExit("Reflection Coach exclusion has drifted")

receipt = {
    "schemaVersion": "gloops.controlled-swarm-commissioning.v1",
    "campaignId": approval["campaignId"],
    "approvedImage": approved_image,
    "governanceMerge": approval["governanceMerge"],
    "authorization": approval["authorization"],
    "approvalSha256": f"sha256:{hashlib.sha256(approval_path.read_bytes()).hexdigest()}",
    "commissionedAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "admittedAgentIds": sorted(admitted.values()),
    "burstAgentIds": sorted(
        ["fb0a4d29-a670-464a-8956-b9dfdb4e4529", "a9ff2c34-0bd1-44e9-866a-3b03ce678cf4"],
    ),
    "executionProvider": "ollama-cloud-via-hermes-gateway",
    "timerHeartbeatsEnabled": False,
    "campaignEpochState": "unarmed",
    "outcome": "commissioned",
}
receipt_path.write_text(
    json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY
chmod 0600 "${receipt_tmp}"
chown root:root "${receipt_tmp}"
mv -f "${receipt_tmp}" "${RECEIPT}"

rollback() {
  local status=$?
  trap - EXIT
  set +e
  "${LIB_DIR}/set-controlled-swarm-commissioning.py" false
  rm -f "${RECEIPT}" "${approval_in_progress}"
  systemctl restart "${PAPERCLIP}"
  exit "${status}"
}
trap rollback EXIT

"${LIB_DIR}/set-controlled-swarm-commissioning.py" true
systemctl restart "${PAPERCLIP}"
systemctl is-active --quiet "${PAPERCLIP}"
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3100/api/health >/dev/null
docker inspect paperclip-gloops \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -Fxq 'PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true'
[[ ! -e "${EPOCH}" ]] || {
  echo "commissioning unexpectedly armed the campaign epoch" >&2
  exit 1
}
rm -f "${approval_in_progress}"
trap - EXIT
echo "PASS controlled swarm is commissioned; roles remain paused and epoch unarmed"
