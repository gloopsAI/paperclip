#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${repo_root}"
runtime_env="${repo_root}/gloops-distribution/deploy/hermes/runtime.env"
for expected_runtime_line in \
  'PAPERCLIP_MTE_ENABLED=false' \
  'HEARTBEAT_SCHEDULER_ENABLED=false' \
  'PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false' \
  'PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false' \
  'PAPERCLIP_CAMPAIGN_ID=controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139' \
  'PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET=/run/paperclip-campaign/deadman.sock' \
  'PAPERCLIP_CAMPAIGN_DURATION_SECONDS=86400' \
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
grep -Fq -- '--campaign-id controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139 --duration-seconds 86400' "${deadman_unit}"
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
for bound_unit in \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-gloops.service" \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-gloops-handshake.service" \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-hermes-execution.service"; do
  grep -Fq 'BindsTo=paperclip-campaign-deadman.service' "${bound_unit}"
done
rollback_script="${repo_root}/gloops-distribution/deploy/hermes/rollback.sh"
backup_script="${repo_root}/gloops-distribution/deploy/hermes/backup-dark.sh"
grep -Fq 'paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service' "${rollback_script}"
grep -Fq 'systemctl disable --now paperclip.service paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service' "${rollback_script}"
grep -Fq 'systemctl mask paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service' "${rollback_script}"
grep -Fq 'paperclip-hermes-handshake-egress.service paperclip-campaign-deadman.service' "${backup_script}"
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
