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
  'PAPERCLIP_CAMPAIGN_ID=controlled-swarm-20260717' \
  'PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET=/run/paperclip-campaign/deadman.sock' \
  'PAPERCLIP_CAMPAIGN_DURATION_SECONDS=86400' \
  'PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS=2000' \
  'PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false' \
  'PAPERCLIP_EXECUTION_ADMISSION_ENABLED=true' \
  'PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS=4' \
  'PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE=2026-07-17T04:55:56.000Z' \
  'PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK=3' \
  'PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=2'; do
  grep -Fxq "${expected_runtime_line}" "${runtime_env}" || {
    echo "Refusing source canaries because the governed runtime is missing ${expected_runtime_line}" >&2
    exit 1
  }
done
deadman_unit="${repo_root}/gloops-distribution/deploy/hermes/paperclip-campaign-deadman.service"
grep -Fq -- '--campaign-id controlled-swarm-20260717 --duration-seconds 86400' "${deadman_unit}"
grep -Fq 'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_LINUX_IMMUTABLE' "${deadman_unit}"
for bound_unit in \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-gloops.service" \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-gloops-handshake.service" \
  "${repo_root}/gloops-distribution/deploy/hermes/paperclip-hermes-execution.service"; do
  grep -Fq 'BindsTo=paperclip-campaign-deadman.service' "${bound_unit}"
done
paperclip_unit="${repo_root}/gloops-distribution/deploy/hermes/paperclip-gloops.service"
grep -Fq 'src=/opt/grok-build/bin/grok,dst=/opt/grok-build/bin/grok,readonly' "${paperclip_unit}"
grep -Fq 'src=/home/paperclip/.grok,dst=/home/paperclip/.grok' "${paperclip_unit}"
grep -Fq 'src=/opt/codex/0.142.5,dst=/opt/codex/0.142.5,readonly' "${paperclip_unit}"
grep -Fq 'src=/home/paperclip/.codex,dst=/home/paperclip/.codex' "${paperclip_unit}"
grep -Fq 'src=/usr/local/lib/paperclip-gloops/paperclip-codex-container,dst=/usr/local/bin/paperclip-codex,readonly' "${paperclip_unit}"
gloops-distribution/deploy/hermes/paperclip_subscription_clis_test.sh
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
  gloops-distribution/deploy/hermes/verify_campaign_deadman_test.py
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
    gloops-distribution/deploy/hermes/campaign-deadman-stop.sh \
    gloops-distribution/deploy/hermes/campaign-deadman-rehearsal-stop.sh \
    gloops-distribution/deploy/hermes/verify-campaign-deadman.py \
    gloops-distribution/deploy/hermes/rehearse-campaign-deadman.py \
    gloops-distribution/deploy/hermes/activate-controlled-swarm.sh \
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
    gloops-distribution/deploy/hermes/prepare-paperclip-subscription-clis.sh \
    gloops-distribution/deploy/hermes/paperclip-codex-container \
    gloops-distribution/deploy/hermes/paperclip_subscription_clis_test.sh \
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
    "campaignExpiryRejectsFurtherAdmission": "passed",
    "deadmanReadinessRaceIsBoundedAndFailClosed": "passed",
    "acceleratedHostDeadmanRehearsalIsInstalled": "passed",
    "activationRequiresExactRecentRehearsal": "passed",
    "manualStopRestoresVerifiedDarkState": "passed",
    "rollbackRefusesActiveCampaignDeadman": "passed",
    "rollbackCannotCertifySurvivingDeadmanSocket": "passed",
    "historicalIssueReplayIsRejected": "passed",
    "historicalRetryPromotionIsRejected": "passed",
    "boundedRecoveryDriverExcludesTimersAndRoutines": "passed",
    "boundedRecoveryDriverIsSingleFlight": "passed",
    "ambiguousGrokApiHistoryBlocks": "passed",
    "nestedAndAlternateGrokApiConfigurationRefused": "passed",
    "subscriptionCliProjectionIsApiKeyFree": "passed",
    "ownerHandoffOccursAtMostOnce": "passed",
    "terminalOutcomeIsDeterministic": "passed"
  }
}
JSON
