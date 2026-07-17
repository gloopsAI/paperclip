#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${repo_root}"

[[ "${PAPERCLIP_MTE_ENABLED:-false}" == "false" ]] || {
  echo "Refusing canaries while MTE is enabled" >&2
  exit 1
}
[[ "${HEARTBEAT_SCHEDULER_ENABLED:-false}" == "false" ]] || {
  echo "Refusing canaries while heartbeat scheduling is enabled" >&2
  exit 1
}
if env | grep -Eq '(^|_)(XAI|GROK)_(API_KEY|BASE_URL)='; then
  echo "Refusing canaries with Grok/xAI API configuration present" >&2
  exit 1
fi

pnpm exec vitest run \
  server/src/services/controlled-swarm-admission.test.ts \
  packages/adapter-utils/src/execution-envelope.test.ts \
  server/src/services/execution-admission.test.ts
pnpm --filter @paperclipai/hermes-paperclip-adapter exec vitest run \
  src/gateway/server/execute.test.ts
pnpm exec vitest run \
  server/src/__tests__/heartbeat-controlled-swarm-admission.test.ts \
  server/src/__tests__/heartbeat-retry-scheduling.test.ts \
  server/src/__tests__/heartbeat-execution-admission.test.ts
pnpm exec vitest run \
  server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts \
  -t 'rejects an agent-self-attested execution-truth receipt|blocks a recovery-owner side door to done without trusted execution truth'
pnpm exec vitest run \
  server/src/__tests__/plugin-orchestration-apis.test.ts \
  -t 'accepts terminal truth only from a capability-scoped plugin projection bound to the run'

head_sha="$(git rev-parse HEAD)"
evidence_sha="$(
  shasum -a 256 \
    packages/adapter-utils/src/execution-envelope.test.ts \
    packages/adapters/hermes/src/gateway/server/execute.test.ts \
    server/src/services/controlled-swarm-admission.test.ts \
    server/src/services/execution-admission.test.ts \
    server/src/__tests__/heartbeat-controlled-swarm-admission.test.ts \
    server/src/__tests__/heartbeat-execution-admission.test.ts \
    server/src/__tests__/heartbeat-retry-scheduling.test.ts \
    server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts \
    server/src/__tests__/plugin-orchestration-apis.test.ts \
    gloops-distribution/deploy/hermes/runtime.env \
    gloops-distribution/deploy/hermes/preflight.sh \
    gloops-distribution/deploy/hermes/rehearse-zero-work.sh \
    gloops-distribution/deploy/hermes/verify-dark.sh \
  | shasum -a 256 | awk '{print $1}'
)"

cat <<JSON
{
  "schemaVersion": "gloops.execution-envelope-canary-receipt.v1",
  "repositoryHead": "${head_sha}",
  "evidenceDigest": "sha256:${evidence_sha}",
  "providersInvoked": false,
  "paperclipActivated": false,
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
    "historicalIssueReplayIsRejected": "passed",
    "historicalRetryPromotionIsRejected": "passed",
    "boundedRetryDriverIsEnabled": "passed",
    "ambiguousGrokApiHistoryBlocks": "passed",
    "nestedAndAlternateGrokApiConfigurationRefused": "passed",
    "ownerHandoffOccursAtMostOnce": "passed",
    "terminalOutcomeIsDeterministic": "passed"
  }
}
JSON
