#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly PAPERCLIP_UNIT='paperclip-gloops.service'
readonly HERMES_UNIT='paperclip-hermes-execution.service'
readonly OBSERVE_SECONDS="${PAPERCLIP_ZERO_WORK_OBSERVE_SECONDS:-60}"

[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}
[[ "${OBSERVE_SECONDS}" =~ ^[0-9]+$ ]] \
  && ((OBSERVE_SECONDS >= 30 && OBSERVE_SECONDS <= 300)) || {
  echo "PAPERCLIP_ZERO_WORK_OBSERVE_SECONDS must be between 30 and 300" >&2
  exit 2
}

for unit in "${PAPERCLIP_UNIT}" "${HERMES_UNIT}"; do
  if systemctl is-active --quiet "${unit}"; then
    echo "refusing rehearsal while ${unit} is active" >&2
    exit 1
  fi
  [[ "$(systemctl is-enabled "${unit}" 2>/dev/null || true)" == 'masked' ]] || {
    echo "refusing rehearsal because ${unit} is not masked" >&2
    exit 1
  }
done
[[ ! -e "${CONFIG_DIR}/ACTIVATION_APPROVED" ]] || {
  echo "Paperclip activation marker already exists" >&2
  exit 1
}
[[ ! -e "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED" ]] || {
  echo "Hermes activation marker already exists" >&2
  exit 1
}
grep -Fxq 'HEARTBEAT_SCHEDULER_ENABLED=false' "${CONFIG_DIR}/runtime.env"
grep -Fxq 'PAPERCLIP_MTE_ENABLED=false' "${CONFIG_DIR}/runtime.env"

evidence_output="$(mktemp)"
evidence_error="$(mktemp)"
evidence_pid=''
credential_history='/var/lib/paperclip-gloops/credential-history.jsonl'
stop_history='/var/lib/paperclip-gloops/hermes-stop-history.jsonl'
sessions_dir='/opt/paperclip/hermes-execution-state/sessions'
network='paperclip-execution'
egress_comment="gloops-zero-work-${BASHPID}"
egress_rule_installed=0
credential_history_before="$([[ -f "${credential_history}" ]] && wc -l <"${credential_history}" || echo 0)"
stop_history_before="$([[ -f "${stop_history}" ]] && wc -l <"${stop_history}" || echo 0)"
if find "${sessions_dir}" -mindepth 1 -print -quit | grep -q .; then
  echo "refusing rehearsal because a persistent Hermes session could auto-resume" >&2
  exit 1
fi

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "${evidence_pid}" ]] && kill -0 "${evidence_pid}" 2>/dev/null; then
    kill "${evidence_pid}" 2>/dev/null
    wait "${evidence_pid}" 2>/dev/null
  fi
  systemctl stop "${PAPERCLIP_UNIT}"
  systemctl stop "${HERMES_UNIT}"
  if ((egress_rule_installed == 1)); then
    subnet="$(docker network inspect "${network}" --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null)"
    iptables -D DOCKER-USER -s "${subnet}" ! -d "${subnet}" \
      -m comment --comment "${egress_comment}" -j REJECT
    egress_rule_installed=0
  fi
  rm -f "${CONFIG_DIR}/ACTIVATION_APPROVED" "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"
  systemctl mask "${PAPERCLIP_UNIT}" "${HERMES_UNIT}"
  systemctl reset-failed "${PAPERCLIP_UNIT}" "${HERMES_UNIT}"
  "${LIB_DIR}/verify-dark.sh"
  local dark_status=$?
  rm -f "${evidence_output}" "${evidence_error}"
  if ((status == 0 && dark_status != 0)); then
    status=${dark_status}
  fi
  exit "${status}"
}
trap cleanup EXIT

started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "zero-work rehearsal started at ${started_at}"

subnet="$(docker network inspect "${network}" --format '{{(index .IPAM.Config 0).Subnet}}')"
[[ "${subnet}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || {
  echo "paperclip-execution network has no valid IPv4 subnet" >&2
  exit 1
}
iptables -I DOCKER-USER 1 -s "${subnet}" ! -d "${subnet}" \
  -m comment --comment "${egress_comment}" -j REJECT
egress_rule_installed=1

systemctl unmask "${PAPERCLIP_UNIT}" "${HERMES_UNIT}"
install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"
systemctl start "${HERMES_UNIT}"
install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/ACTIVATION_APPROVED"
systemctl start "${PAPERCLIP_UNIT}"

systemctl is-active --quiet "${HERMES_UNIT}"
systemctl is-active --quiet "${PAPERCLIP_UNIT}"
curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:3100/api/health >/dev/null
"${LIB_DIR}/verify-hermes-execution-profile.sh" --live

sleep "${OBSERVE_SECONDS}"

# Clear and revoke the trusted projector credential while Paperclip can still
# service the secret rotation. The evidence locks below intentionally remain
# held through service shutdown; pre-clearing makes systemd's ExecStop cleanup
# idempotent instead of forcing that rotation to wait behind the closed interval.
"${LIB_DIR}/github-app-credentials.py" clear-projector

timeout --signal=TERM --kill-after=5s 180s docker exec \
  --env "ZERO_WORK_STARTED_AT=${started_at}" \
  paperclip-gloops \
  node --input-type=module -e '
    import { createDb } from "@paperclipai/db";
    import { readFileSync } from "node:fs";

    const config = JSON.parse(readFileSync(
      "/home/paperclip/.paperclip/instances/default/config.json",
      "utf8",
    ));
    const port = config.database?.embeddedPostgresPort ?? 54329;
    const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`);
    const sql = db.$client;
    const since = process.env.ZERO_WORK_STARTED_AT;
    await sql.begin(async (tx) => {
      await tx.unsafe(
        "LOCK TABLE agent_wakeup_requests, cost_events, heartbeat_runs, " +
        "issue_recovery_actions, issues, plugin_jobs, plugin_job_runs IN ACCESS EXCLUSIVE MODE",
      );
      const counts = {
        issues: (await tx`select count(*)::int as count from issues where created_at >= ${since}`)[0].count,
        runs: (await tx`select count(*)::int as count from heartbeat_runs where created_at >= ${since}`)[0].count,
        wakeups: (await tx`select count(*)::int as count from agent_wakeup_requests where created_at >= ${since}`)[0].count,
        recoveryActions: (await tx`select count(*)::int as count from issue_recovery_actions where created_at >= ${since}`)[0].count,
        costEvents: (await tx`select count(*)::int as count from cost_events where created_at >= ${since}`)[0].count,
        pluginJobs: (await tx`select count(*)::int as count from plugin_jobs`)[0].count,
        pluginJobRuns: (await tx`select count(*)::int as count from plugin_job_runs where created_at >= ${since}`)[0].count,
      };
      process.stdout.write(`${JSON.stringify({ since, counts })}\n`);
      await new Promise(() => setInterval(() => {}, 1000));
    });
  ' >"${evidence_output}" 2>"${evidence_error}" &
evidence_pid=$!

for _ in $(seq 1 300); do
  [[ -s "${evidence_output}" ]] && break
  if ! kill -0 "${evidence_pid}" 2>/dev/null; then
    wait "${evidence_pid}" || true
    cat "${evidence_error}" >&2
    echo "evidence lock holder exited before producing a receipt" >&2
    exit 1
  fi
  sleep 0.1
done
[[ -s "${evidence_output}" ]] || {
  cat "${evidence_error}" >&2
  echo "timed out waiting for the evidence-table locks" >&2
  exit 1
}
kill -0 "${evidence_pid}" 2>/dev/null || {
  echo "evidence lock holder exited before shutdown" >&2
  exit 1
}

# The table locks close the work interval. Stopping both services while those
# locks remain held makes the captured receipt final before it is evaluated.
# Paperclip's projector credential is already cleared, so ExecStop is a safe,
# non-blocking no-op for that credential lifecycle step.
systemctl stop "${PAPERCLIP_UNIT}"
systemctl stop "${HERMES_UNIT}"
systemctl is-active --quiet "${HERMES_UNIT}" && exit 1
systemctl is-active --quiet "${PAPERCLIP_UNIT}" && exit 1
[[ "$(systemctl show --property=Result --value "${HERMES_UNIT}")" == 'success' ]] || {
  echo "Hermes execution sidecar did not stop cleanly" >&2
  exit 1
}
[[ "$(systemctl show --property=Result --value "${PAPERCLIP_UNIT}")" == 'success' ]] || {
  echo "Paperclip control plane did not stop cleanly" >&2
  exit 1
}
if docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-execution'; then
  echo "Hermes execution sidecar container remains after stop" >&2
  exit 1
fi
wait "${evidence_pid}" 2>/dev/null || true
evidence_pid=''

node - "${evidence_output}" <<'NODE'
const { readFileSync } = require("node:fs");
const lines = readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean);
if (lines.length !== 1) throw new Error("expected exactly one zero-work evidence receipt");
const receipt = JSON.parse(lines[0]);
const expected = ["issues", "runs", "wakeups", "recoveryActions", "costEvents", "pluginJobs", "pluginJobRuns"];
if (Object.keys(receipt.counts).sort().join(",") !== expected.sort().join(",")) {
  throw new Error("zero-work evidence receipt has an unexpected shape");
}
for (const [name, count] of Object.entries(receipt.counts)) {
  if (!Number.isInteger(count) || count !== 0) {
    throw new Error(`zero-work rehearsal created ${count} ${name} row(s)`);
  }
}
console.log(JSON.stringify(receipt));
NODE

python3 - "${credential_history}" "${stop_history}" \
  "${credential_history_before}" "${stop_history_before}" <<'PY'
import json
from pathlib import Path
import sys

credential_path, stop_path = map(Path, sys.argv[1:3])
credential_before, stop_before = map(int, sys.argv[3:5])
credentials = [json.loads(line) for line in credential_path.read_text().splitlines() if line]
stops = [json.loads(line) for line in stop_path.read_text().splitlines() if line]
assert len(credentials) == credential_before + 1, "expected one durable credential lifecycle receipt"
assert len(stops) == stop_before + 1, "expected one durable Hermes stop receipt"
credential, stop = credentials[-1], stops[-1]
assert credential["lifecycleId"] == stop["lifecycleId"], "lifecycle receipts do not correlate"
assert credential.get("legacyReceipt") is not True, "new lifecycle was classified as legacy"
assert all(isinstance(credential[role]["revokedAt"], str) for role in ("hermes", "projector"))
assert stop["status"] == "succeeded"
assert stop["plannedStopAccepted"] is True
assert stop["gatewayState"] == "stopped"
assert stop["containerStopped"] is True
print(json.dumps({
    "lifecycleId": credential["lifecycleId"],
    "credentialReceiptDigest": credential["receiptDigest"],
    "stopReceiptDigest": stop["receiptDigest"],
}, sort_keys=True))
PY

blocked_packets="$(iptables -L DOCKER-USER -v -n -x | awk -v marker="${egress_comment}" '$0 ~ marker {print $1}')"
[[ "${blocked_packets}" == '0' ]] || {
  echo "zero-work rehearsal attempted ${blocked_packets:-unknown} external network packet(s)" >&2
  exit 1
}
if find "${sessions_dir}" -mindepth 1 -print -quit | grep -q .; then
  echo "zero-work rehearsal created persistent Hermes session state" >&2
  exit 1
fi

echo "PASS closed-interval rehearsal created no issue, run, wakeup, recovery, cost, plugin-job, or plugin-job-run row"
echo "PASS zero-work rehearsal admitted no Hermes continuation or external provider attempt"
