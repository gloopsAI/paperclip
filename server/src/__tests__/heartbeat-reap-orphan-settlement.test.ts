import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, priorExecutionRun } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";
import {
  EXECUTION_ADMISSION_CONTEXT_KEY,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionAdmission,
  isBudgetExemptPreflightFailure,
  parseExecutionAdmissionPolicy,
} from "../services/execution-admission.js";

// Phase 1.3 (budget-accounting fix): reapOrphanedRuns settling an orphan
// whose adapter never populates processPid (e.g. `hermes_gateway`, a
// remote/webhook-driven adapter) and, once settled, correctly accounting for
// it so it does not hold its full task-budget reservation forever. Exercised
// against a real database (not the pure-function priorExecutionRun tests in
// heartbeat-prior-execution-run-budget.test.ts) because reapOrphanedRuns'
// detection logic (staleness thresholds, the PID-probe vs. no-PID fallback,
// and the settleOnly side-effect gate) all live in DB queries and writes.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat orphan-reap settlement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const FOUR_HOUR_WALL_MS = 14_400_000;

function fullTaskReservationContextSnapshot() {
  const policy = parseExecutionAdmissionPolicy({
    PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
    PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "3",
    PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "2",
    PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000000",
    PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200000",
    PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: String(FOUR_HOUR_WALL_MS),
    PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "400000",
    PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "100000",
    PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "6",
    PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "24",
  });
  if (!policy.enabled) throw new Error("expected enabled policy");
  const envelope = buildExecutionAdmissionEnvelope({
    identity: { budgetId: "issue:orphan-reap-settlement-test:default", epoch: "default" },
    policy,
    decision: evaluateExecutionAdmission(policy, []),
    evaluatedAt: new Date("2026-08-01T00:00:00Z"),
  });
  expect(envelope.reservation?.maxWallMs).toBe(FOUR_HOUR_WALL_MS);
  return { [EXECUTION_ADMISSION_CONTEXT_KEY]: envelope };
}

describeEmbeddedPostgres("heartbeat orphan reap settlement (Phase 1.3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orphan-reap-settlement-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "GatewayAgent",
      role: "engineer",
      status: "running",
      // hermes_gateway is a remote/webhook-driven adapter: it never
      // populates heartbeat_runs.process_pid for this control plane, which
      // is exactly the case reapOrphanedRuns' no-PID fallback exists for.
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return agentId;
  }

  async function seedOrphanRun(input: {
    companyId: string;
    agentId: string;
    lastOutputAt: Date | null;
    updatedAt: Date;
    startedAt?: Date | null;
    processPid?: number | null;
    resultJson?: Record<string, unknown> | null;
    contextSnapshot?: Record<string, unknown> | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      processPid: input.processPid ?? null,
      processGroupId: null,
      startedAt: input.startedAt ?? input.updatedAt,
      lastOutputAt: input.lastOutputAt,
      updatedAt: input.updatedAt,
      resultJson: input.resultJson ?? null,
      contextSnapshot: input.contextSnapshot ?? {},
    });
    return runId;
  }

  async function getRunRow(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  const STALE_TIMESTAMP = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago: past any default staleness floor

  it("(a) settles an orphan with a null PID and stale lastOutputAt/updatedAt", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedOrphanRun({
      companyId,
      agentId,
      processPid: null,
      lastOutputAt: STALE_TIMESTAMP,
      updatedAt: STALE_TIMESTAMP,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ settleOnly: true });

    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const settled = await getRunRow(runId);
    expect(settled?.status).toBe("failed");
    expect(settled?.errorCode).toBe("process_lost");
    expect(settled?.finishedAt).not.toBeNull();
  });

  it("(b) an orphan that never reached the adapter is budget-exempt after settling", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const reservedContextSnapshot = fullTaskReservationContextSnapshot();
    const runId = await seedOrphanRun({
      companyId,
      agentId,
      processPid: null,
      lastOutputAt: STALE_TIMESTAMP,
      updatedAt: STALE_TIMESTAMP,
      // No provider_invocation evidence at all: this run never reached the
      // adapter before the control plane lost it.
      resultJson: {},
      contextSnapshot: reservedContextSnapshot,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ settleOnly: true });
    expect(result.runIds).toEqual([runId]);

    const settled = await getRunRow(runId);
    expect(settled).not.toBeNull();
    const providerInvocation = (settled?.resultJson as Record<string, unknown> | null)?.provider_invocation as
      | { attempted?: boolean }
      | undefined;
    expect(providerInvocation?.attempted).toBe(false);
    expect(
      isBudgetExemptPreflightFailure({
        providerInvocationAttempted: providerInvocation?.attempted ?? null,
        errorCode: settled?.errorCode ?? null,
      }),
    ).toBe(true);

    // Close the loop end-to-end: feeding the actually-persisted row through
    // priorExecutionRun (the function production's task-budget accounting
    // reads) must show it does NOT count toward the task budget at all, and
    // does not fall back to charging the full reservation for wall time.
    const accounted = priorExecutionRun(
      {
        retryOfRunId: settled!.retryOfRunId,
        usageJson: settled!.usageJson,
        resultJson: settled!.resultJson,
        contextSnapshot: settled!.contextSnapshot,
        errorCode: settled!.errorCode,
        startedAt: settled!.startedAt,
        finishedAt: settled!.finishedAt,
      },
      new Date(),
    );
    expect(accounted.countsTowardTaskBudget).toBe(false);
    expect(accounted.wallMs).not.toBe(FOUR_HOUR_WALL_MS);
  });

  it("(b again) an orphan that DID reach the adapter is settled with measured elapsed usage, not held reservation, and is NOT forced budget-exempt", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const reservedContextSnapshot = fullTaskReservationContextSnapshot();
    const startedAt = new Date(Date.now() - 90 * 60 * 1000); // started 90 minutes ago
    const runId = await seedOrphanRun({
      companyId,
      agentId,
      processPid: null,
      lastOutputAt: STALE_TIMESTAMP,
      updatedAt: STALE_TIMESTAMP,
      startedAt,
      // Evidence the adapter WAS invoked before the control plane lost it.
      resultJson: { provider_invocation: { attempted: true } },
      contextSnapshot: reservedContextSnapshot,
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns({ settleOnly: true });

    const settled = await getRunRow(runId);
    expect(settled?.status).toBe("failed");
    // Not forced exempt: real provider evidence must survive settlement.
    const providerInvocation = (settled?.resultJson as Record<string, unknown> | null)?.provider_invocation as
      | { attempted?: boolean }
      | undefined;
    expect(providerInvocation?.attempted).toBe(true);
    // usageJson must be non-null so priorExecutionRun's useReservation
    // predicate flips to the elapsed-wall-time branch instead of the
    // reservation cap, and it should carry an honestly-measured wallMs.
    const usage = settled?.usageJson as Record<string, unknown> | null;
    expect(usage).not.toBeNull();
    expect(usage?.providerInvocationAttempted).toBe(true);
    expect(typeof usage?.wallMs).toBe("number");
    expect(usage?.wallMs as number).toBeGreaterThan(0);

    const accounted = priorExecutionRun(
      {
        retryOfRunId: settled!.retryOfRunId,
        usageJson: settled!.usageJson,
        resultJson: settled!.resultJson,
        contextSnapshot: settled!.contextSnapshot,
        errorCode: settled!.errorCode,
        startedAt: settled!.startedAt,
        finishedAt: settled!.finishedAt,
      },
      new Date(),
    );
    expect(accounted.countsTowardTaskBudget).toBe(true);
    expect(accounted.wallMs).not.toBe(FOUR_HOUR_WALL_MS);
    expect(accounted.wallMs).toBeGreaterThan(0);
  });

  it("(c) a run with a live in-memory handle is NOT reaped", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedOrphanRun({
      companyId,
      agentId,
      processPid: null,
      lastOutputAt: STALE_TIMESTAMP,
      updatedAt: STALE_TIMESTAMP,
    });
    runningProcesses.set(runId, {
      child: {} as ChildProcess,
      graceSec: 30,
      processGroupId: null,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ settleOnly: true });

    expect(result.reaped).toBe(0);
    const stillRunning = await getRunRow(runId);
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.errorCode).toBeNull();
  });

  it("(c) a run with fresh output is NOT reaped", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const now = new Date();
    const runId = await seedOrphanRun({
      companyId,
      agentId,
      processPid: null,
      lastOutputAt: now,
      updatedAt: now,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRuns({ settleOnly: true });

    expect(result.reaped).toBe(0);
    const stillRunning = await getRunRow(runId);
    expect(stillRunning?.status).toBe("running");
  });

  it("(d) settleOnly settling does not re-spawn, re-queue, or wake anything", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, {
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    const orphanRunId = await seedOrphanRun({
      companyId,
      agentId,
      processPid: null,
      lastOutputAt: STALE_TIMESTAMP,
      updatedAt: STALE_TIMESTAMP,
      resultJson: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Locked by the orphaned run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: orphanRunId,
      executionRunId: orphanRunId,
    });

    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ settleOnly: true });
    expect(result.runIds).toEqual([orphanRunId]);

    // The orphan itself is settled...
    const settledOrphan = await getRunRow(orphanRunId);
    expect(settledOrphan?.status).toBe("failed");

    // ...but nothing downstream was touched: the queued run was never
    // claimed/started, no retry run was created, the agent's status was
    // left alone, and the issue's execution lock still points at the
    // now-finalized orphan run rather than being released/promoted.
    const stillQueued = await getRunRow(queuedRunId);
    expect(stillQueued?.status).toBe("queued");

    const allRunsForAgent = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(allRunsForAgent).toHaveLength(2);
    expect(allRunsForAgent.some((run) => run.retryOfRunId === orphanRunId)).toBe(false);

    const agentRow = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agentRow?.status).toBe("running");

    const issueRow = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionRunId).toBe(orphanRunId);
    expect(issueRow?.checkoutRunId).toBe(orphanRunId);
  });
});
