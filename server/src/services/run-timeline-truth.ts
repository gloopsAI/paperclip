import { PAPERCLIP_EXECUTION_RECEIPT_KEY } from "@paperclipai/adapter-utils/execution-envelope";

export type RunTimelineStage =
  | "queued"
  | "executing"
  | "retry_wait"
  | "recovery"
  | "review"
  | "publication"
  | "deployed"
  | "rolled_back"
  | "settled"
  | "failed";

export interface RunTimelineEvidenceEvent {
  action: string;
  status: string | null;
  at: Date | string;
}

export interface RunTimelineTruthInput {
  run: {
    runId: string;
    status: string;
    agentId: string;
    responsibleUserId?: string | null;
    retryOfRunId?: string | null;
    scheduledRetryAttempt?: number | null;
    processLossRetryCount?: number | null;
    contextSnapshot?: Record<string, unknown> | null;
  };
  recoveryAction?: {
    ownerAgentId: string | null;
    ownerUserId: string | null;
    status: string;
    attemptCount: number;
    nextAction: string;
  } | null;
  mutationReceipt?: {
    id: string;
    state: string;
    expectedOldOid: string;
    expectedNewOid: string;
    remoteOldOid: string | null;
    remoteNewOid: string | null;
    brokerReceiptDigest: string | null;
    terminalAt: Date | string | null;
  } | null;
  settlement?: {
    id: string;
    schemaVersion: string;
    terminalStatus: string;
    mutationDisposition: string;
    brokerReceiptDigest: string | null;
    remoteOldOid: string | null;
    remoteNewOid: string | null;
    settledAt: Date | string;
  } | null;
  deployment?: RunTimelineEvidenceEvent | null;
  rollback?: RunTimelineEvidenceEvent | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOwner(context: Record<string, unknown> | null, ...keys: string[]) {
  for (const key of keys) {
    const value = readString(context?.[key]);
    if (value) return value;
  }
  return null;
}

function reviewTruth(context: Record<string, unknown> | null) {
  const receipt = asRecord(context?.[PAPERCLIP_EXECUTION_RECEIPT_KEY]);
  const verification = asRecord(receipt?.verification);
  const review = asRecord(verification?.review);
  const status = readString(review?.status);
  const headSha = readString(review?.headSha);
  if (!status && !headSha) return null;
  return { status, headSha };
}

function stageFor(input: RunTimelineTruthInput, review: ReturnType<typeof reviewTruth>): RunTimelineStage {
  if (input.rollback) return "rolled_back";
  if (input.deployment) return "deployed";
  if (input.settlement) return "settled";
  if (input.mutationReceipt) return "publication";
  if (review) return "review";
  if (input.recoveryAction) return "recovery";
  if (input.run.status === "scheduled_retry") return "retry_wait";
  if (input.run.status === "queued") return "queued";
  if (input.run.status === "running") return "executing";
  return input.run.status === "succeeded" ? "settled" : "failed";
}

/**
 * Builds the deliberately small, non-secret projection shown in the issue run
 * ledger. Raw context, provider credentials, environment maps and paths never
 * cross the API boundary.
 */
export function buildRunTimelineTruth(input: RunTimelineTruthInput) {
  const context = input.run.contextSnapshot ?? null;
  const review = reviewTruth(context);
  const retryEpoch = Math.max(
    input.run.retryOfRunId ? 1 : 0,
    input.run.scheduledRetryAttempt ?? 0,
    input.run.processLossRetryCount ?? 0,
  );

  return {
    stage: stageFor(input, review),
    intendedOwner: {
      agentId: readOwner(context, "intendedAgentId", "assigneeAgentId", "requestedAgentId") ?? input.run.agentId,
      userId: readOwner(context, "intendedUserId", "responsibleUserId") ?? input.run.responsibleUserId ?? null,
    },
    currentOwner: {
      agentId: input.run.agentId,
      userId: input.run.responsibleUserId ?? null,
    },
    recoveryOwner: input.recoveryAction
      ? {
          agentId: input.recoveryAction.ownerAgentId,
          userId: input.recoveryAction.ownerUserId,
          status: input.recoveryAction.status,
          attempt: input.recoveryAction.attemptCount,
          nextAction: input.recoveryAction.nextAction,
        }
      : null,
    retryEpoch,
    retryOfRunId: input.run.retryOfRunId ?? null,
    workspaceId: readOwner(context, "executionWorkspaceId", "projectWorkspaceId"),
    review,
    exactOids: input.mutationReceipt
      ? {
          expectedOld: input.mutationReceipt.expectedOldOid,
          expectedNew: input.mutationReceipt.expectedNewOid,
          remoteOld: input.mutationReceipt.remoteOldOid,
          remoteNew: input.mutationReceipt.remoteNewOid,
        }
      : input.settlement?.remoteNewOid || input.settlement?.remoteOldOid
        ? {
            expectedOld: null,
            expectedNew: null,
            remoteOld: input.settlement.remoteOldOid,
            remoteNew: input.settlement.remoteNewOid,
          }
        : null,
    publication: input.mutationReceipt
      ? {
          receiptId: input.mutationReceipt.id,
          state: input.mutationReceipt.state,
          brokerReceiptDigest: input.mutationReceipt.brokerReceiptDigest,
          terminalAt: input.mutationReceipt.terminalAt,
        }
      : null,
    deployment: input.deployment ?? null,
    rollback: input.rollback ?? null,
    terminalReceipt: input.settlement
      ? {
          id: input.settlement.id,
          schemaVersion: input.settlement.schemaVersion,
          terminalStatus: input.settlement.terminalStatus,
          mutationDisposition: input.settlement.mutationDisposition,
          brokerReceiptDigest: input.settlement.brokerReceiptDigest,
          settledAt: input.settlement.settledAt,
        }
      : null,
  };
}
