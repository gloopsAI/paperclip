#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${repo_root}"

# The sanctioned campaign-duration range is declared once, in campaign-deadman.py.
# Every gate re-derives it from there instead of carrying its own literal, because
# a copied literal is precisely how this envelope came to be pinned to 86400.
campaign_duration_bound() {
  local name="$1" source="$2" line expression
  line="$(grep -m1 -E "^${name} = [0-9]+([ ]+\*[ ]+[0-9]+)*([ ]+#.*)?$" "${source}")" || {
    echo "campaign deadman does not declare ${name} in ${source}" >&2
    return 1
  }
  expression="${line#* = }"
  expression="${expression%%#*}"
  printf '%s\n' "$((expression))"
}

# Print the single PAPERCLIP_CAMPAIGN_DURATION_SECONDS value declared by an env
# file, refusing an absent, duplicated, or non-numeric declaration. A later
# duplicate would silently win at runtime, so more than one is a refusal.
campaign_duration_from_env() {
  local source="$1" declarations value
  declarations="$(grep -cE '^PAPERCLIP_CAMPAIGN_DURATION_SECONDS=' "${source}" || true)"
  value="$(grep -m1 -E '^PAPERCLIP_CAMPAIGN_DURATION_SECONDS=[0-9]+$' "${source}" || true)"
  value="${value#*=}"
  [[ "${declarations}" == '1' && -n "${value}" ]] || {
    echo "expected exactly one numeric PAPERCLIP_CAMPAIGN_DURATION_SECONDS in ${source}" >&2
    return 1
  }
  printf '%s\n' "${value}"
}

campaign_duration_min="$(campaign_duration_bound \
  MIN_CAMPAIGN_DURATION_SECONDS \
  "${repo_root}/gloops-distribution/deploy/hermes/campaign-deadman.py")"
campaign_duration_max="$(campaign_duration_bound \
  MAX_CAMPAIGN_DURATION_SECONDS \
  "${repo_root}/gloops-distribution/deploy/hermes/campaign-deadman.py")"

runtime_env="${repo_root}/gloops-distribution/deploy/hermes/runtime.env"
for expected_runtime_line in \
  'PAPERCLIP_MTE_ENABLED=false' \
  'HEARTBEAT_SCHEDULER_ENABLED=false' \
  'PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false' \
  'PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false' \
  'PAPERCLIP_CAMPAIGN_ID=controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139' \
  'PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET=/run/paperclip-campaign/deadman.sock' \
  'PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS=2000' \
  'PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false' \
  'PAPERCLIP_EXECUTION_ADMISSION_ENABLED=true' \
  'PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS=4' \
  'PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE=2026-07-18T23:12:22.000Z' \
  'PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK=3' \
  'PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=2'; do
  grep -Fxq "${expected_runtime_line}" "${runtime_env}" || {
    echo "Refusing source canaries because the governed runtime is missing ${expected_runtime_line}" >&2
    exit 1
  }
done
deadman_unit="${repo_root}/gloops-distribution/deploy/hermes/paperclip-campaign-deadman.service"
successor_campaign_id='controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139'
predecessor_campaign_id='controlled-swarm-20260717'

# The campaign identity stays exactly pinned; only the epoch length is a bounded
# operator choice. Assert the identity literally and the duration by range, and
# require the broker's own argument to agree with the value the control plane
# reads from runtime.env -- a plane and a dead-man that disagree about the epoch
# length is the failure this range would otherwise make possible.
grep -Fq -- "--campaign-id ${successor_campaign_id} --duration-seconds " "${deadman_unit}"
unit_duration_seconds="$(
  grep -m1 -oE -- '--duration-seconds [0-9]+' "${deadman_unit}" | awk '{print $2}'
)"
runtime_duration_seconds="$(campaign_duration_from_env "${runtime_env}")"
for observed in "${unit_duration_seconds}" "${runtime_duration_seconds}"; do
  if ! [[ "${observed}" =~ ^[0-9]+$ ]] \
    || ((10#${observed} < campaign_duration_min || 10#${observed} > campaign_duration_max)); then
    echo "Refusing source canaries because the campaign duration ${observed:-unset} is outside the sanctioned ${campaign_duration_min}..${campaign_duration_max} second range" >&2
    exit 1
  fi
done
[[ "${unit_duration_seconds}" == "${runtime_duration_seconds}" ]] || {
  echo "Refusing source canaries because the deadman unit (${unit_duration_seconds}) and runtime env (${runtime_duration_seconds}) declare different campaign durations" >&2
  exit 1
}
grep -Fq 'ExecStartPre=/usr/local/lib/paperclip-gloops/verify-predecessor-campaign-epoch.py' "${deadman_unit}"
for successor_bound_file in \
  "${repo_root}/gloops-distribution/deploy/hermes/runtime.env" \
  "${repo_root}/gloops-distribution/deploy/hermes/preflight.sh" \
  "${repo_root}/gloops-distribution/deploy/hermes/rehearse-zero-work.sh" \
  "${repo_root}/gloops-distribution/deploy/hermes/rehearse-campaign-deadman.py" \
  "${repo_root}/gloops-distribution/deploy/hermes/activate-controlled-swarm.sh" \
  "${repo_root}/gloops-distribution/deploy/hermes/controlled-swarm-commissioner.py" \
  "${repo_root}/gloops-distribution/deploy/hermes/observe-controlled-swarm.py" \
  "${repo_root}/gloops-distribution/deploy/hermes/verify-dark.sh"; do
  grep -Fq "${successor_campaign_id}" "${successor_bound_file}"
done
zero_work_rehearsal="${repo_root}/gloops-distribution/deploy/hermes/rehearse-zero-work.sh"
for broker_topology_line in \
  "readonly GITHUB_BROKER_UNIT='paperclip-github-push-broker.service'" \
  '"${LIB_DIR}/github-push-broker.py" assert-quiescent' \
  'systemctl start "${GITHUB_BROKER_UNIT}"' \
  'systemctl is-active --quiet "${GITHUB_BROKER_UNIT}"'; do
  grep -Fq "${broker_topology_line}" "${zero_work_rehearsal}" || {
    echo "Refusing canaries because zero-work rehearsal omits broker topology: ${broker_topology_line}" >&2
    exit 1
  }
done
predecessor_verifier="${repo_root}/gloops-distribution/deploy/hermes/verify-predecessor-campaign-epoch.py"
grep -Fq "PREDECESSOR_CAMPAIGN_ID = \"${predecessor_campaign_id}\"" "${predecessor_verifier}"
grep -Fq 'af8260a4c30f92c79a1c138e2951cbb40041ed58da40b86273a27881b2d07b0b' "${predecessor_verifier}"
grep -Fq 'parser.add_argument("--campaign-id", required=True)' \
  "${repo_root}/gloops-distribution/deploy/hermes/verify-campaign-deadman.py"
grep -Fq 'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_LINUX_IMMUTABLE' "${deadman_unit}"
# Campaign expiry must still stop the isolated handshake path, but must not own
# the product control plane, execution sidecar, or registered brokers.
grep -Fq 'BindsTo=paperclip-campaign-deadman.service' \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-gloops-handshake.service"
python3 "${repo_root}/gloops-distribution/deploy/hermes/verify-product-service-lifecycle.py" \
  --repo-root "${repo_root}"
rollback_script="${repo_root}/gloops-distribution/deploy/hermes/rollback.sh"
backup_script="${repo_root}/gloops-distribution/deploy/hermes/backup-dark.sh"
rollback_units='paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service'
grep -Fq "${rollback_units}" "${rollback_script}"
grep -Fq 'systemctl disable --now paperclip.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service' "${rollback_script}"
grep -Fq 'systemctl mask paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service' "${rollback_script}"
grep -Fq "${rollback_units}" "${backup_script}"
if grep -Fq 'rm -rf /var/lib/paperclip-gloops/campaign-deadman' "${rollback_script}"; then
  echo "Refusing canaries because rollback deletes durable campaign epoch evidence" >&2
  exit 1
fi
if env | grep -Eq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)='; then
  echo "Refusing canaries with Grok/xAI API configuration present" >&2
  exit 1
fi

pnpm exec vitest run \
  server/src/services/campaign-deadman.test.ts \
  server/src/services/controlled-swarm-admission.test.ts \
  packages/adapter-utils/src/execution-envelope.test.ts \
  server/src/services/execution-admission.test.ts
pnpm --filter @paperclipai/hermes-paperclip-adapter exec vitest run \
  src/gateway/server/execute.test.ts
pnpm exec vitest run \
  server/src/services/company-queue-pump-lock.test.ts \
  server/src/__tests__/heartbeat-controlled-swarm-admission.test.ts \
  server/src/__tests__/heartbeat-retry-scheduling.test.ts \
  server/src/__tests__/heartbeat-execution-admission.test.ts
pnpm exec vitest run \
  server/src/__tests__/server-startup-feedback-export.test.ts \
  -t 'drives only bounded execution recovery when the global heartbeat scheduler is disabled|keeps periodic execution recovery single-flight when a cycle is slow'
pnpm exec vitest run \
  server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts \
  -t 'rejects an agent-self-attested execution-truth receipt|blocks a recovery-owner side door to done without trusted execution truth'
pnpm exec vitest run \
  server/src/__tests__/plugin-orchestration-apis.test.ts \
  -t 'accepts terminal truth only from a capability-scoped plugin projection bound to the run'
python3 -m unittest \
  gloops-distribution/deploy/hermes/campaign_deadman_test.py \
  gloops-distribution/deploy/hermes/verify_campaign_deadman_test.py \
  gloops-distribution/deploy/hermes/verify_predecessor_campaign_epoch_test.py \
  gloops-distribution/deploy/hermes/controlled_swarm_commissioner_test.py \
  gloops-distribution/deploy/hermes/set_controlled_swarm_commissioning_test.py \
  gloops-distribution/deploy/hermes/paperclip_hostctl_test.py
gloops-distribution/deploy/hermes/rollback_dark_query_failure_test.sh

head_sha="$(git rev-parse HEAD)"
evidence_sha="$(
  shasum -a 256 \
    packages/adapter-utils/src/execution-envelope.test.ts \
    packages/adapters/hermes/src/gateway/server/execute.test.ts \
    server/src/config.ts \
    server/src/index.ts \
    server/src/services/company-queue-pump-lock.ts \
    server/src/services/company-queue-pump-lock.test.ts \
    server/src/services/campaign-deadman.ts \
    server/src/services/campaign-deadman.test.ts \
    server/src/services/controlled-swarm-admission.ts \
    server/src/services/heartbeat.ts \
    server/src/services/controlled-swarm-admission.test.ts \
    server/src/services/execution-admission.test.ts \
    server/src/__tests__/heartbeat-controlled-swarm-admission.test.ts \
    server/src/__tests__/heartbeat-execution-admission.test.ts \
    server/src/__tests__/heartbeat-retry-scheduling.test.ts \
    server/src/__tests__/server-startup-feedback-export.test.ts \
    server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts \
    server/src/__tests__/plugin-orchestration-apis.test.ts \
    gloops-distribution/deploy/hermes/README.md \
    gloops-distribution/deploy/hermes/runtime.env \
    gloops-distribution/deploy/hermes/campaign-deadman.py \
    gloops-distribution/deploy/hermes/campaign_deadman_test.py \
    gloops-distribution/deploy/hermes/verify_campaign_deadman_test.py \
    gloops-distribution/deploy/hermes/verify-predecessor-campaign-epoch.py \
    gloops-distribution/deploy/hermes/verify_predecessor_campaign_epoch_test.py \
    gloops-distribution/deploy/hermes/campaign-deadman-stop.sh \
    gloops-distribution/deploy/hermes/campaign-deadman-rehearsal-stop.sh \
    gloops-distribution/deploy/hermes/verify-campaign-deadman.py \
    gloops-distribution/deploy/hermes/verify-product-service-lifecycle.py \
    gloops-distribution/deploy/hermes/rehearse-campaign-deadman.py \
    gloops-distribution/deploy/hermes/activate-controlled-swarm.sh \
    gloops-distribution/deploy/hermes/commission-controlled-swarm.sh \
    gloops-distribution/deploy/hermes/controlled-swarm-commissioner.py \
    gloops-distribution/deploy/hermes/controlled_swarm_commissioner_test.py \
    gloops-distribution/deploy/hermes/set-controlled-swarm-commissioning.py \
    gloops-distribution/deploy/hermes/set_controlled_swarm_commissioning_test.py \
    gloops-distribution/deploy/hermes/paperclip-hostctl.py \
    gloops-distribution/deploy/hermes/paperclip_hostctl_test.py \
    gloops-distribution/deploy/hermes/HOST_WRITER_LOCK.md \
    gloops-distribution/deploy/hermes/stop-controlled-swarm.sh \
    gloops-distribution/deploy/hermes/observe-controlled-swarm.py \
    gloops-distribution/deploy/hermes/paperclip-campaign-deadman.service \
    gloops-distribution/deploy/hermes/paperclip-gloops.service \
    gloops-distribution/deploy/hermes/paperclip-gloops-handshake.service \
    gloops-distribution/deploy/hermes/paperclip-hermes-execution.service \
    gloops-distribution/deploy/hermes/install-dark.sh \
    gloops-distribution/deploy/hermes/backup-dark.sh \
    gloops-distribution/deploy/hermes/rollback.sh \
    gloops-distribution/deploy/hermes/verify-rollback-dark.sh \
    gloops-distribution/deploy/hermes/rollback_dark_query_failure_test.sh \
    gloops-distribution/deploy/hermes/preflight.sh \
    gloops-distribution/deploy/hermes/rehearse-zero-work.sh \
    gloops-distribution/deploy/hermes/verify-dark.sh \
  | shasum -a 256 | awk '{print $1}'
)"

cat <<JSON
{
  "schemaVersion": "gloops.execution-envelope-canary-receipt.v1",
  "artifactScope": "source",
  "repositoryHead": "${head_sha}",
  "evidenceDigest": "sha256:${evidence_sha}",
  "providersInvoked": false,
  "paperclipActivated": false,
  "installedImageVerified": false,
  "activationInterlock": "immutable_release_pin_bound",
  "mteActivated": false,
  "scenarios": {
    "millionTokenPromptRefusedBeforeDispatch": "passed",
    "boundPacketIsActualRecoveryInput": "passed",
    "staleHeadCannotProveReadiness": "passed",
    "agentCannotSelfAttestExecutionTruth": "passed",
    "recoveryResolutionCannotBypassTruthGate": "passed",
    "trustedPluginProjectionIsRunBound": "passed",
    "unsupportedAdapterCannotDispatch": "passed",
    "missingUsageFailsClosed": "passed",
    "companyWipIsSerializedBeforeDispatch": "passed",
    "companyQueueClaimsAreRoundRobinFair": "passed",
    "companyQueuePumpRemainsSerializedWhenSlow": "passed",
    "claimCancellationDoesNotReenterCompanyPump": "passed",
    "firstClaimBindsHostOwnedCampaignEpoch": "passed",
    "deadmanDenialPreventsAdapterInvocation": "passed",
    "uncommissionedSwarmDeniesAdapterInvocation": "passed",
    "campaignEpochSurvivesRestartWithoutRenewal": "passed",
    "predecessorEpochRemainsImmutableAndDistinct": "passed",
    "successorCampaignIdentityIsFixedAndCollisionResistant": "passed",
    "campaignVerificationRequiresExplicitIdentity": "passed",
    "historicalIssueCutoffAdvancedForSuccessor": "passed",
    "campaignExpiryRejectsFurtherAdmission": "passed",
    "deadmanReadinessRaceIsBoundedAndFailClosed": "passed",
    "acceleratedHostDeadmanRehearsalIsInstalled": "passed",
    "activationRequiresExactRecentRehearsal": "passed",
    "commissioningRequiresExactSixteenIdentityRoster": "passed",
    "commissioningRevalidatesRosterAfterRestart": "passed",
    "commissioningFailureRestoresInertBarrier": "passed",
    "commissioningReceiptIsInvalidatedOnStop": "passed",
    "manualStopRestoresVerifiedDarkState": "passed",
    "rollbackRefusesActiveCampaignDeadman": "passed",
    "rollbackCannotCertifySurvivingDeadmanSocket": "passed",
    "historicalIssueReplayIsRejected": "passed",
    "historicalRetryPromotionIsRejected": "passed",
    "boundedRecoveryDriverExcludesTimersAndRoutines": "passed",
    "boundedRecoveryDriverIsSingleFlight": "passed",
    "ambiguousGrokApiHistoryBlocks": "passed",
    "nestedAndAlternateGrokApiConfigurationRefused": "passed",
    "ownerHandoffOccursAtMostOnce": "passed",
    "terminalOutcomeIsDeterministic": "passed"
  }
}
JSON
