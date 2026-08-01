import { createHash } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupIdempotency,
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
  repositoryMutationReceipts,
} from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { conflict, HttpError, notFound } from "../errors.js";
import {
  EXECUTION_ADMISSION_CONTEXT_KEY,
  EXECUTION_ADMISSION_RESET_CONTEXT_KEY,
  readExecutionAdmissionEnvelope,
} from "./execution-admission.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const RECEIPT_SCHEMA_VERSION = "gloops.issue-admission-reset-receipt.v1" as const;
const RECEIPT_CONTEXT_KEY = "gloopsIssueAdmissionResetReceipt" as const;

type GuardedAdmissionResetReceipt = {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  issueId: string;
  agentId: string;
  projectId: string;
  projectWorkspaceId: string;
  resetId: string;
  idempotencyKey: string;
  priorBudgetId: string;
  priorEpoch: "default";
  priorReason: "retry_limit_exhausted";
  runId: string;
  createdAt: string;
};

type ResetInput = {
  issueId: string;
  companyId: string;
  agentId: string;
  resetId: string;
  requestedByUserId: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readReceipt(value: unknown): GuardedAdmissionResetReceipt | null {
  const candidate = record(value);
  if (
    candidate.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof candidate.issueId !== "string" ||
    typeof candidate.agentId !== "string" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.projectWorkspaceId !== "string" ||
    typeof candidate.resetId !== "string" ||
    typeof candidate.idempotencyKey !== "string" ||
    typeof candidate.priorBudgetId !== "string" ||
    candidate.priorEpoch !== "default" ||
    candidate.priorReason !== "retry_limit_exhausted" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  return candidate as GuardedAdmissionResetReceipt;
}

function requestFingerprint(input: ResetInput, projectWorkspaceId: string) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      projectWorkspaceId,
      resetId: input.resetId,
      requestedByUserId: input.requestedByUserId,
    }))
    .digest("hex")}`;
}

function resetIdempotencyKey(issueId: string, resetId: string) {
  return `issue-admission-reset:${issueId}:${resetId}`;
}

export function guardedAdmissionResetService(db: Db) {
  return {
    resetExhaustedAdmissionAndCheckout: async (input: ResetInput) => {
      if (!input.requestedByUserId.trim()) {
        throw new HttpError(403, "A concrete board user is required");
      }

      return db.transaction(async (tx) => {
        await tx.execute(sql`
          select id from issues
          where id = ${input.issueId} and company_id = ${input.companyId}
          for update
        `);

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            identifier: issues.identifier,
            status: issues.status,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            assigneeAgentId: issues.assigneeAgentId,
            responsibleUserId: issues.responsibleUserId,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
            startedAt: issues.startedAt,
          })
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");
        if (!issue.projectId || !issue.projectWorkspaceId) {
          throw new HttpError(422, "Issue must be bound to an exact project workspace", {
            code: "issue_workspace_binding_required",
            issueId: issue.id,
          });
        }
        if (!issue.responsibleUserId) {
          throw new HttpError(422, "Issue must have a responsible user before admission reset", {
            code: "responsible_user_required",
            issueId: issue.id,
          });
        }

        const idempotencyKey = resetIdempotencyKey(issue.id, input.resetId);
        const fingerprint = requestFingerprint(input, issue.projectWorkspaceId);
        const existingIdempotency = await tx
          .select()
          .from(agentWakeupIdempotency)
          .where(and(
            eq(agentWakeupIdempotency.companyId, issue.companyId),
            eq(agentWakeupIdempotency.agentId, input.agentId),
            eq(agentWakeupIdempotency.idempotencyKey, idempotencyKey),
          ))
          .then((rows) => rows[0] ?? null);
        if (existingIdempotency) {
          if (existingIdempotency.requestFingerprint !== fingerprint) {
            throw conflict("Admission reset id was already used with different request facts", {
              code: "admission_reset_idempotency_conflict",
              issueId: issue.id,
              resetId: input.resetId,
            });
          }
          const replayRun = existingIdempotency.runId
            ? await tx
              .select()
              .from(heartbeatRuns)
              .where(and(
                eq(heartbeatRuns.id, existingIdempotency.runId),
                eq(heartbeatRuns.companyId, issue.companyId),
              ))
              .then((rows) => rows[0] ?? null)
            : null;
          const replayReceipt = readReceipt(record(replayRun?.contextSnapshot)[RECEIPT_CONTEXT_KEY]);
          if (
            !replayRun ||
            !replayReceipt ||
            replayReceipt.runId !== replayRun.id ||
            replayReceipt.issueId !== issue.id ||
            replayReceipt.agentId !== input.agentId ||
            replayReceipt.projectWorkspaceId !== issue.projectWorkspaceId ||
            replayReceipt.resetId !== input.resetId ||
            replayReceipt.idempotencyKey !== idempotencyKey
          ) {
            throw conflict("Admission reset replay references a missing durable run receipt", {
              code: "admission_reset_replay_missing",
              issueId: issue.id,
              resetId: input.resetId,
            });
          }
          return { created: false as const, run: replayRun, receipt: replayReceipt };
        }

        if (issue.status === "done" || issue.status === "cancelled") {
          throw conflict("Terminal issues cannot receive an execution-admission reset", {
            code: "admission_reset_terminal_issue",
            issueId: issue.id,
            status: issue.status,
          });
        }
        if (issue.assigneeAgentId !== input.agentId) {
          throw conflict("Admission reset must retain the issue's current assignee", {
            code: "admission_reset_assignee_mismatch",
            issueId: issue.id,
            currentAssigneeAgentId: issue.assigneeAgentId,
          });
        }

        const agent = await tx
          .select({ id: agents.id, status: agents.status })
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.companyId, issue.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!agent) throw notFound("Agent not found");
        if (!isAgentStatusInvokable(agent.status)) {
          throw conflict("Issue assignee is not invokable", {
            code: "admission_reset_agent_not_invokable",
            agentId: agent.id,
            status: agent.status,
          });
        }

        const activeLockRunIds = [issue.checkoutRunId, issue.executionRunId]
          .filter((value): value is string => Boolean(value));
        const issueContextCondition = sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`;
        const activeBindingCondition = activeLockRunIds.length > 0
          ? or(issueContextCondition, inArray(heartbeatRuns.id, activeLockRunIds))
          : issueContextCondition;
        const activeRun = await tx
          .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, issue.companyId),
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            activeBindingCondition,
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (activeRun) {
          throw conflict("Issue already has an active execution binding", {
            code: "admission_reset_live_binding",
            issueId: issue.id,
            runId: activeRun.id,
            runStatus: activeRun.status,
          });
        }

        const [succeededRun, durableSuccessReceipt] = await Promise.all([
          tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, issue.companyId),
              eq(heartbeatRuns.status, "succeeded"),
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          tx
            .select({ id: repositoryMutationReceipts.id })
            .from(repositoryMutationReceipts)
            .where(and(
              eq(repositoryMutationReceipts.companyId, issue.companyId),
              eq(repositoryMutationReceipts.issueId, issue.id),
              eq(repositoryMutationReceipts.state, "reconciled_success"),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null),
        ]);
        if (succeededRun || durableSuccessReceipt) {
          throw conflict("Successful terminal evidence forbids an execution-admission reset", {
            code: "admission_reset_success_evidence",
            issueId: issue.id,
            succeededRunId: succeededRun?.id ?? null,
            repositoryMutationReceiptId: durableSuccessReceipt?.id ?? null,
          });
        }

        const expectedBudgetId = `issue:${issue.id}:default`;
        // Select the latest explicit retry-exhaustion denial first, then parse
        // and verify its envelope. Filtering by envelope fields in SQL would
        // skip a newer malformed denial and could incorrectly accept an older
        // valid row.
        const latestDefaultEpochRow = await tx
          .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, issue.companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            eq(heartbeatRuns.errorCode, "execution_admission.retry_limit_exhausted"),
          ))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const exhaustedEnvelope = readExecutionAdmissionEnvelope(
          record(latestDefaultEpochRow?.contextSnapshot)[EXECUTION_ADMISSION_CONTEXT_KEY],
        );
        if (
          !exhaustedEnvelope ||
          exhaustedEnvelope.budgetId !== expectedBudgetId ||
          exhaustedEnvelope.epoch !== "default" ||
          exhaustedEnvelope.decision !== "denied" ||
          exhaustedEnvelope.reason !== "retry_limit_exhausted"
        ) {
          throw conflict("Default execution-admission epoch is not provably retry-exhausted", {
            code: "admission_reset_epoch_not_exhausted",
            issueId: issue.id,
          });
        }

        const priorResetRun = await tx
          .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, issue.companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            sql`${heartbeatRuns.contextSnapshot} ->> ${EXECUTION_ADMISSION_RESET_CONTEXT_KEY} is not null`,
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (priorResetRun) {
          throw conflict("Default admission epoch already has a historical reset run", {
            code: "admission_reset_epoch_already_reset",
            issueId: issue.id,
            resetId: input.resetId,
            runId: priorResetRun.id,
            priorResetId: record(priorResetRun.contextSnapshot)[EXECUTION_ADMISSION_RESET_CONTEXT_KEY] ?? null,
          });
        }

        const now = new Date();
        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: issue.companyId,
            agentId: input.agentId,
            source: "on_demand",
            triggerDetail: "manual",
            reason: "issue_execution_admission_reset",
            payload: {
              issueId: issue.id,
              projectId: issue.projectId,
              projectWorkspaceId: issue.projectWorkspaceId,
              resetId: input.resetId,
            },
            status: "queued",
            requestedByActorType: "user",
            requestedByActorId: input.requestedByUserId,
            idempotencyKey,
          })
          .returning()
          .then((rows) => rows[0]!);

        const initialContext = {
          issueId: issue.id,
          taskId: issue.id,
          taskKey: issue.identifier ?? issue.id,
          projectId: issue.projectId,
          projectWorkspaceId: issue.projectWorkspaceId,
          source: "issue.execution_admission_reset",
          wakeReason: "issue_execution_admission_reset",
          [EXECUTION_ADMISSION_RESET_CONTEXT_KEY]: input.resetId,
        };
        const insertedRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: issue.companyId,
            agentId: input.agentId,
            invocationSource: "on_demand",
            triggerDetail: "manual",
            status: "queued",
            responsibleUserId: issue.responsibleUserId,
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: initialContext,
          })
          .returning()
          .then((rows) => rows[0]!);

        const receipt: GuardedAdmissionResetReceipt = {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          issueId: issue.id,
          agentId: input.agentId,
          projectId: issue.projectId,
          projectWorkspaceId: issue.projectWorkspaceId,
          resetId: input.resetId,
          idempotencyKey,
          priorBudgetId: exhaustedEnvelope.budgetId,
          priorEpoch: "default",
          priorReason: "retry_limit_exhausted",
          runId: insertedRun.id,
          createdAt: now.toISOString(),
        };
        const run = await tx
          .update(heartbeatRuns)
          .set({
            contextSnapshot: { ...initialContext, [RECEIPT_CONTEXT_KEY]: receipt },
            updatedAt: now,
          })
          .where(eq(heartbeatRuns.id, insertedRun.id))
          .returning()
          .then((rows) => rows[0]!);

        await tx
          .update(agentWakeupRequests)
          .set({ runId: run.id, updatedAt: now })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));
        await tx
          .update(issues)
          .set({
            status: "in_progress",
            assigneeAgentId: input.agentId,
            checkoutRunId: run.id,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            startedAt: issue.startedAt ?? now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
        await tx.insert(agentWakeupIdempotency).values({
          companyId: issue.companyId,
          agentId: input.agentId,
          idempotencyKey,
          requestFingerprint: fingerprint,
          outcomeKind: "queued",
          runId: run.id,
        });
        await tx.insert(activityLog).values({
          companyId: issue.companyId,
          actorType: "user",
          actorId: input.requestedByUserId,
          agentId: input.agentId,
          runId: run.id,
          action: "issue.execution_admission_reset_checkout",
          entityType: "issue",
          entityId: issue.id,
          details: receipt,
        });

        return { created: true as const, run, receipt };
      });
    },
  };
}
