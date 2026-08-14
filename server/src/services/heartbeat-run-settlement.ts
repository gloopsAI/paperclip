import { isDeepStrictEqual } from "node:util";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AdapterProviderIoTerminalEvidence } from "@paperclipai/adapter-utils";
import type { Db } from "@paperclipai/db";
import {
  agentRuntimeState,
  agents,
  companies,
  costEvents,
  heartbeatRuns,
  heartbeatRunSettlements,
} from "@paperclipai/db";
import {
  providerIoTerminalEvidenceService,
} from "./provider-io-terminal-evidence.js";
import type { PreparedProviderRequestIdentity } from "./provider-request-evidence.js";
import { budgetService } from "./budgets.js";
import { repositoryMutationReceiptService } from "./repository-mutation-receipts.js";
import {
  heartbeatRunIssueProjectionService,
  type HeartbeatRunIssueProjectionInput,
} from "./heartbeat-run-issue-projections.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OID_PATTERN = /^[0-9a-f]{40,64}$/;

export type HeartbeatRunMutationSettlement =
  | {
      disposition: "not_authorized";
    }
  | {
      disposition: "reconciled_success" | "bounded_failure" | "conflict";
      brokerReceiptDigest: string;
      remoteOldOid: string;
      remoteNewOid: string;
    };

type NormalizedUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AtomicHeartbeatRunSettlementInput = {
  identity: PreparedProviderRequestIdentity;
  terminalStatus: "succeeded" | "failed" | "timed_out" | "cancelled";
  runPatch: Partial<typeof heartbeatRuns.$inferInsert>;
  providerEvidence: AdapterProviderIoTerminalEvidence;
  accounting: {
    adapterType: string;
    sessionId: string | null;
    lastError: string | null;
    provider: string;
    biller: string;
    billingType: string;
    model: string;
    costCents: number;
    projectId?: string | null;
  };
  mutation: HeartbeatRunMutationSettlement;
  issueProjection?: HeartbeatRunIssueProjectionInput | null;
  settledAt?: Date;
};

export type HeartbeatRunSettlementStep =
  | "provider_evidence"
  | "run"
  | "issue_projection"
  | "cost"
  | "budget"
  | "accounting"
  | "settlement";

export type HeartbeatRunSettlementHooks = {
  afterStep?: (step: HeartbeatRunSettlementStep) => void | Promise<void>;
};

export class HeartbeatRunSettlementConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeartbeatRunSettlementConflictError";
  }
}

function terminalUsage(evidence: AdapterProviderIoTerminalEvidence): NormalizedUsage {
  const terminal = evidence.terminalEvidence;
  for (const [name, entry] of [
    ["input", terminal.inputUsage],
    ["cached", terminal.cachedUsage],
    ["output", terminal.outputUsage],
  ] as const) {
    if (!entry.present || !Number.isSafeInteger(entry.value) || entry.value < 0) {
      throw new HeartbeatRunSettlementConflictError(
        `Authoritative ${name} terminal usage is required for atomic settlement`,
      );
    }
  }
  return {
    inputTokens: terminal.inputUsage.value,
    cachedInputTokens: terminal.cachedUsage.value,
    outputTokens: terminal.outputUsage.value,
  };
}

function validateMutation(mutation: HeartbeatRunMutationSettlement): void {
  if (mutation.disposition === "not_authorized") return;
  if (
    !SHA256_PATTERN.test(mutation.brokerReceiptDigest)
    || !OID_PATTERN.test(mutation.remoteOldOid)
    || !OID_PATTERN.test(mutation.remoteNewOid)
  ) {
    throw new HeartbeatRunSettlementConflictError(
      "A reconciled repository mutation requires a valid broker receipt digest and exact remote object IDs",
    );
  }
}

function monthWindow(now: Date) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function assertReplayMatches(
  settlement: typeof heartbeatRunSettlements.$inferSelect,
  providerEvidenceId: string,
  input: AtomicHeartbeatRunSettlementInput,
  usage: NormalizedUsage,
): void {
  const mutationMatches =
    settlement.mutationDisposition === input.mutation.disposition
    && (
      input.mutation.disposition === "not_authorized"
        ? settlement.brokerReceiptDigest === null
          && settlement.remoteOldOid === null
          && settlement.remoteNewOid === null
        : settlement.brokerReceiptDigest === input.mutation.brokerReceiptDigest
          && settlement.remoteOldOid === input.mutation.remoteOldOid
          && settlement.remoteNewOid === input.mutation.remoteNewOid
    );
  if (
    settlement.schemaVersion !== "gloops.heartbeat-run-settlement.v1"
    || settlement.companyId !== input.identity.companyId
    || settlement.agentId !== input.identity.agentId
    || settlement.providerIoTerminalEvidenceId !== providerEvidenceId
    || settlement.terminalStatus !== input.terminalStatus
    || !isDeepStrictEqual(settlement.normalizedUsage, usage)
    || !mutationMatches
  ) {
    throw new HeartbeatRunSettlementConflictError(
      `Atomic settlement replay conflicts with the committed receipt for run ${input.identity.heartbeatRunId}`,
    );
  }
}

export function heartbeatRunSettlementService(
  db: Db,
  hooks: HeartbeatRunSettlementHooks = {},
) {
  return {
    settle: async (input: AtomicHeartbeatRunSettlementInput) => {
      if (!TERMINAL_STATUSES.has(input.terminalStatus)) {
        throw new HeartbeatRunSettlementConflictError("Atomic settlement requires a terminal run status");
      }
      if (
        input.terminalStatus === "succeeded"
        && input.mutation.disposition !== "not_authorized"
        && input.mutation.disposition !== "reconciled_success"
      ) {
        throw new HeartbeatRunSettlementConflictError(
          "A successful run cannot settle with a failed or conflicting repository mutation",
        );
      }
      if (!Number.isSafeInteger(input.accounting.costCents) || input.accounting.costCents < 0) {
        throw new HeartbeatRunSettlementConflictError("Atomic settlement cost must be non-negative integer cents");
      }
      validateMutation(input.mutation);
      const usage = terminalUsage(input.providerEvidence);
      const settledAt = input.settledAt ?? new Date();

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from heartbeat_runs where id = ${input.identity.heartbeatRunId} for update`,
        );
        const run = await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, input.identity.heartbeatRunId))
          .then((rows) => rows[0] ?? null);
        if (
          !run
          || run.companyId !== input.identity.companyId
          || run.agentId !== input.identity.agentId
        ) {
          throw new HeartbeatRunSettlementConflictError(
            `Heartbeat run identity does not match atomic settlement ${input.identity.heartbeatRunId}`,
          );
        }
        const mutation = await repositoryMutationReceiptService(tx as unknown as Db)
          .getForSettlement(input.identity.heartbeatRunId);
        if (!isDeepStrictEqual(mutation, input.mutation)) {
          throw new HeartbeatRunSettlementConflictError(
            `Repository mutation authority changed before atomic settlement for run ${run.id}`,
          );
        }

        const providerReceipt = await providerIoTerminalEvidenceService(tx as unknown as Db)
          .persistReconciledEvidence(input.identity, input.providerEvidence);
        await hooks.afterStep?.("provider_evidence");

        const existing = await tx
          .select()
          .from(heartbeatRunSettlements)
          .where(eq(heartbeatRunSettlements.heartbeatRunId, input.identity.heartbeatRunId))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          assertReplayMatches(existing, providerReceipt.id, input, usage);
          await heartbeatRunIssueProjectionService(tx as unknown as Db).assertExisting(
            input.issueProjection ?? null,
            input.identity.heartbeatRunId,
          );
          const [committedRun, costEvent] = await Promise.all([
            tx.select().from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, input.identity.heartbeatRunId))
              .then((rows) => rows[0]),
            tx.select().from(costEvents)
              .where(eq(costEvents.id, existing.costEventId))
              .then((rows) => rows[0]),
          ]);
          return {
            replayed: true as const,
            run: committedRun,
            providerReceipt,
            costEvent,
            settlement: existing,
          };
        }
        if (run.status !== "running") {
          throw new HeartbeatRunSettlementConflictError(
            `Run ${run.id} is ${run.status} without an atomic settlement receipt`,
          );
        }

        const committedRun = await tx
          .update(heartbeatRuns)
          .set({
            ...input.runPatch,
            status: input.terminalStatus,
            usageJson: {
              ...(input.runPatch.usageJson ?? {}),
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              outputTokens: usage.outputTokens,
              usageSource: "provider_terminal_evidence",
            },
            updatedAt: settledAt,
          })
          .where(and(
            eq(heartbeatRuns.id, input.identity.heartbeatRunId),
            eq(heartbeatRuns.status, "running"),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!committedRun) {
          throw new HeartbeatRunSettlementConflictError(
            `Run ${run.id} left running state before atomic settlement`,
          );
        }
        await hooks.afterStep?.("run");

        if (input.issueProjection) {
          if (
            input.issueProjection.companyId !== input.identity.companyId
            || input.issueProjection.agentId !== input.identity.agentId
            || input.issueProjection.heartbeatRunId !== input.identity.heartbeatRunId
            || input.issueProjection.issueId !== input.identity.issueId
          ) {
            throw new HeartbeatRunSettlementConflictError(
              `Issue projection identity does not match atomic settlement ${run.id}`,
            );
          }
          await heartbeatRunIssueProjectionService(tx as unknown as Db).enqueue(
            input.issueProjection,
          );
        }
        await hooks.afterStep?.("issue_projection");

        const costEvent = await tx
          .insert(costEvents)
          .values({
            companyId: input.identity.companyId,
            agentId: input.identity.agentId,
            issueId: input.identity.issueId,
            projectId: input.accounting.projectId ?? null,
            heartbeatRunId: input.identity.heartbeatRunId,
            provider: input.accounting.provider,
            biller: input.accounting.biller,
            billingType: input.accounting.billingType,
            model: input.accounting.model,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            costCents: input.accounting.costCents,
            occurredAt: settledAt,
          })
          .returning()
          .then((rows) => rows[0]);
        await hooks.afterStep?.("cost");

        // Budget hard-stop state is part of the durable settlement boundary.
        // Process cancellation is retried by the outer heartbeat service after
        // commit, but a cost event can never commit without the corresponding
        // database pause/incident decision also succeeding.
        await budgetService(tx as unknown as Db).evaluateCostEvent(costEvent);
        await hooks.afterStep?.("budget");

        await tx
          .insert(agentRuntimeState)
          .values({
            agentId: input.identity.agentId,
            companyId: input.identity.companyId,
            adapterType: input.accounting.adapterType,
            stateJson: {},
          })
          .onConflictDoNothing({ target: agentRuntimeState.agentId });
        const runtimeState = await tx
          .update(agentRuntimeState)
          .set({
            adapterType: input.accounting.adapterType,
            sessionId: input.accounting.sessionId,
            lastRunId: input.identity.heartbeatRunId,
            lastRunStatus: input.terminalStatus,
            lastError: input.accounting.lastError,
            totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${usage.inputTokens}`,
            totalCachedInputTokens:
              sql`${agentRuntimeState.totalCachedInputTokens} + ${usage.cachedInputTokens}`,
            totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${usage.outputTokens}`,
            totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${input.accounting.costCents}`,
            updatedAt: settledAt,
          })
          .where(and(
            eq(agentRuntimeState.agentId, input.identity.agentId),
            eq(agentRuntimeState.companyId, input.identity.companyId),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!runtimeState) {
          throw new HeartbeatRunSettlementConflictError(
            `Agent runtime state could not be continued for run ${run.id}`,
          );
        }

        const { start, end } = monthWindow(settledAt);
        const [agentSpend, companySpend] = await Promise.all([
          tx.select({
            total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          })
            .from(costEvents)
            .where(and(
              eq(costEvents.companyId, input.identity.companyId),
              eq(costEvents.agentId, input.identity.agentId),
              gte(costEvents.occurredAt, start),
              lt(costEvents.occurredAt, end),
            ))
            .then((rows) => Number(rows[0]?.total ?? 0)),
          tx.select({
            total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          })
            .from(costEvents)
            .where(and(
              eq(costEvents.companyId, input.identity.companyId),
              gte(costEvents.occurredAt, start),
              lt(costEvents.occurredAt, end),
            ))
            .then((rows) => Number(rows[0]?.total ?? 0)),
        ]);
        await Promise.all([
          tx.update(agents)
            .set({ spentMonthlyCents: agentSpend, updatedAt: settledAt })
            .where(and(
              eq(agents.id, input.identity.agentId),
              eq(agents.companyId, input.identity.companyId),
            )),
          tx.update(companies)
            .set({ spentMonthlyCents: companySpend, updatedAt: settledAt })
            .where(eq(companies.id, input.identity.companyId)),
        ]);
        await hooks.afterStep?.("accounting");

        const accountingContinuation = {
          schemaVersion: "gloops.accounting-continuation.v1",
          heartbeatRunId: input.identity.heartbeatRunId,
          agentId: input.identity.agentId,
          sessionId: runtimeState.sessionId,
          terminalStatus: runtimeState.lastRunStatus,
          totalInputTokens: runtimeState.totalInputTokens,
          totalCachedInputTokens: runtimeState.totalCachedInputTokens,
          totalOutputTokens: runtimeState.totalOutputTokens,
          totalCostCents: runtimeState.totalCostCents,
        };
        const settlement = await tx
          .insert(heartbeatRunSettlements)
          .values({
            schemaVersion: "gloops.heartbeat-run-settlement.v1",
            companyId: input.identity.companyId,
            agentId: input.identity.agentId,
            heartbeatRunId: input.identity.heartbeatRunId,
            providerIoTerminalEvidenceId: providerReceipt.id,
            costEventId: costEvent.id,
            terminalStatus: input.terminalStatus,
            normalizedUsage: usage,
            accountingContinuation,
            mutationDisposition: input.mutation.disposition,
            brokerReceiptDigest:
              input.mutation.disposition !== "not_authorized"
                ? input.mutation.brokerReceiptDigest
                : null,
            remoteOldOid:
              input.mutation.disposition !== "not_authorized"
                ? input.mutation.remoteOldOid
                : null,
            remoteNewOid:
              input.mutation.disposition !== "not_authorized"
                ? input.mutation.remoteNewOid
                : null,
            settledAt,
          })
          .returning()
          .then((rows) => rows[0]);
        await hooks.afterStep?.("settlement");

        return {
          replayed: false as const,
          run: committedRun,
          providerReceipt,
          costEvent,
          settlement,
        };
      });
    },
  };
}
