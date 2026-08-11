import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  CAMPAIGN_BINDING_CONTEXT_KEY,
  CAMPAIGN_BINDING_SCHEMA_VERSION,
  CAMPAIGN_BOUND_RUN_ERROR_CODE,
  CAMPAIGN_DEADMAN_SCHEMA_VERSION,
  CAMPAIGN_EPOCH_CONTEXT_KEY,
  CAMPAIGN_TERMINAL_CLEANUP_KEY,
  CAMPAIGN_TERMINAL_RECEIPT_KEY,
} from "../services/campaign-deadman.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const adapterState = vi.hoisted((): {
  active: number;
  maxActive: number;
  startedAgentIds: string[];
} => ({
  active: 0,
  maxActive: 0,
  startedAgentIds: [],
}));
const adapterExecute = vi.hoisted(() => vi.fn(async (input: { agent: { id: string } }) => {
  adapterState.startedAgentIds.push(input.agent.id);
  adapterState.active += 1;
  adapterState.maxActive = Math.max(adapterState.maxActive, adapterState.active);
  await new Promise((resolve) => setTimeout(resolve, 75));
  adapterState.active -= 1;
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Controlled-swarm admission test run.",
    provider: "test",
    model: "test-model",
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
  };
}));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      supportsExecutionBudget: true,
      execute: adapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const executionAdmissionEnv = {
  PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
  PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "3",
  PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "2",
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000",
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200",
  PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "60000",
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "400",
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "100",
  PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "6",
  PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "24",
};

async function waitForTerminalRuns(db: ReturnType<typeof createDb>, ids: string[]) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, ids));
    if (
      rows.length === ids.length &&
      rows.every((row) => !["scheduled_retry", "queued", "running"].includes(row.status))
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("controlled-swarm runs did not reach terminal states");
}

describeEmbeddedPostgres("heartbeat controlled-swarm admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-controlled-swarm-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(agentCount: number, maxConcurrentRuns = 1) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Controlled Swarm ${companyId.slice(0, 6)}`,
      issuePrefix: `CS${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: "operator",
      requireBoardApprovalForNewAgents: false,
    });
    const agentIds = Array.from({ length: agentCount }, () => randomUUID());
    for (const [index, agentId] of agentIds.entries()) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `SwarmAgent${index}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns } },
        permissions: {},
      });
    }
    return { companyId, agentIds };
  }

  it("serializes cross-agent claims at the company WIP ceiling and drains the queue", async () => {
    adapterState.active = 0;
    adapterState.maxActive = 0;
    adapterState.startedAgentIds = [];
    adapterExecute.mockClear();
    const { companyId, agentIds } = await seedCompany(3);
    const runIds: string[] = [];
    for (const agentId of agentIds) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "controlled_swarm_test",
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "operator",
        runId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: "system",
        wakeupRequestId,
        responsibleUserId: "operator",
        contextSnapshot: {},
      });
    }

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "1" },
    });
    await Promise.all([
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
    ]);
    await waitForTerminalRuns(db, runIds);
    for (const runId of runIds) {
      await heartbeat.waitForRunExecutionDrain(runId);
    }

    const rows = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    expect(rows.every((row) => row.status === "succeeded")).toBe(true);
    expect(adapterExecute).toHaveBeenCalledTimes(3);
    expect(adapterState.maxActive).toBe(1);
  });

  it("cancels claims only for the configured bankruptcy-frozen company", async () => {
    adapterState.active = 0;
    adapterState.maxActive = 0;
    adapterState.startedAgentIds = [];
    adapterExecute.mockClear();
    const frozen = await seedCompany(1);
    const open = await seedCompany(1);
    const rows = [
      { companyId: frozen.companyId, agentId: frozen.agentIds[0] },
      { companyId: open.companyId, agentId: open.agentIds[0] },
    ];
    const runIds: string[] = [];
    for (const row of rows) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId: row.companyId,
        agentId: row.agentId!,
        source: "assignment",
        triggerDetail: "system",
        reason: "backlog_bankruptcy_test",
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "operator",
        runId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: row.companyId,
        agentId: row.agentId!,
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: "system",
        wakeupRequestId,
        responsibleUserId: "operator",
        contextSnapshot: {},
      });
    }

    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: frozen.companyId,
      },
    });
    await heartbeat.resumeQueuedRuns();
    await waitForTerminalRuns(db, runIds);
    for (const runId of runIds) await heartbeat.waitForRunExecutionDrain(runId);

    const persisted = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    const byId = new Map(persisted.map((row) => [row.id, row]));
    expect(byId.get(runIds[0]!)).toMatchObject({
      status: "cancelled",
      errorCode: "backlog_bankruptcy.company_frozen",
    });
    expect(byId.get(runIds[1]!)).toMatchObject({ status: "succeeded", errorCode: null });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(adapterState.startedAgentIds).toEqual([open.agentIds[0]]);
  });

  it("gives each queued agent one claim before another agent can consume another company slot", async () => {
    adapterState.active = 0;
    adapterState.maxActive = 0;
    adapterState.startedAgentIds = [];
    adapterExecute.mockClear();
    const { companyId, agentIds } = await seedCompany(2, 2);
    const assignments = [agentIds[0], agentIds[0], agentIds[1]];
    const runIds: string[] = [];
    for (const [index, agentId] of assignments.entries()) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      const createdAt = new Date(`2026-07-17T07:00:0${index}.000Z`);
      runIds.push(runId);
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "controlled_swarm_fairness_test",
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "operator",
        runId,
        createdAt,
        updatedAt: createdAt,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: "system",
        wakeupRequestId,
        responsibleUserId: "operator",
        contextSnapshot: {},
        createdAt,
        updatedAt: createdAt,
      });
    }

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "2" },
    });
    await Promise.all([
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
    ]);
    await waitForTerminalRuns(db, runIds);
    for (const runId of runIds) {
      await heartbeat.waitForRunExecutionDrain(runId);
    }

    expect(new Set(adapterState.startedAgentIds.slice(0, 2))).toEqual(new Set(agentIds));
    expect(adapterState.maxActive).toBe(2);
  });

  it("cancels a budget-denied queued row without deadlocking the later eligible drain", async () => {
    adapterState.active = 0;
    adapterState.maxActive = 0;
    adapterState.startedAgentIds = [];
    adapterExecute.mockClear();
    const { companyId, agentIds } = await seedCompany(2);
    const [deniedAgentId, eligibleAgentId] = agentIds;
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: deniedAgentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
      createdByUserId: "operator",
      updatedByUserId: "operator",
    });
    await db.insert(costEvents).values({
      companyId,
      agentId: deniedAgentId,
      provider: "test",
      biller: "subscription",
      billingType: "subscription",
      model: "test-model",
      costCents: 2,
      occurredAt: new Date(),
    });

    const runIds: string[] = [];
    for (const [index, agentId] of [deniedAgentId, eligibleAgentId].entries()) {
      const wakeupRequestId = randomUUID();
      const runId = randomUUID();
      const createdAt = new Date(`2026-07-17T07:30:0${index}.000Z`);
      runIds.push(runId);
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "controlled_swarm_budget_deadlock_test",
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "operator",
        runId,
        createdAt,
        updatedAt: createdAt,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "assignment",
        triggerDetail: "system",
        wakeupRequestId,
        responsibleUserId: "operator",
        contextSnapshot: {},
        createdAt,
        updatedAt: createdAt,
      });
    }

    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "1" },
    });
    await heartbeat.resumeQueuedRuns();
    await waitForTerminalRuns(db, runIds);
    for (const runId of runIds) {
      await heartbeat.waitForRunExecutionDrain(runId);
    }

    const rows = await db
      .select({
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: deniedAgentId,
        status: "cancelled",
        error: expect.stringContaining("budget hard-stop"),
      }),
      expect.objectContaining({
        agentId: eligibleAgentId,
        status: "succeeded",
      }),
    ]));
    expect(adapterState.startedAgentIds).toEqual([eligibleAgentId]);
    expect(adapterState.maxActive).toBe(1);
  });

  it("rejects historical assignment wakes and queued-run replay before the campaign cutoff", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const cutoff = "2026-07-17T06:00:00.000Z";
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "LEGACY-1",
      title: "Historical issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdAt: new Date("2026-07-17T05:59:59.000Z"),
      updatedAt: new Date("2026-07-17T05:59:59.000Z"),
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE: cutoff },
    });

    const wake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "operator",
    });
    expect(wake).toBeNull();

    const skipped = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skipped).toContainEqual({
      status: "skipped",
      reason: "heartbeat.execution_issue_created_at_cutoff",
    });

    const queuedWakeId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "historical_queue_replay",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "startup_recovery",
      runId: queuedRunId,
      createdAt: new Date("2026-07-17T06:01:00.000Z"),
      updatedAt: new Date("2026-07-17T06:01:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      triggerDetail: "system",
      wakeupRequestId: queuedWakeId,
      responsibleUserId: "operator",
      contextSnapshot: { taskId: issueId },
      createdAt: new Date("2026-07-17T06:01:00.000Z"),
      updatedAt: new Date("2026-07-17T06:01:00.000Z"),
    });

    await heartbeat.resumeQueuedRuns();
    const replayed = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0] ?? null);
    expect(replayed).toEqual({
      status: "cancelled",
      errorCode: "execution_issue_created_at_cutoff",
    });

    const parentRunId = randomUUID();
    const scheduledRunId = randomUUID();
    const scheduledWakeId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "assignment",
      triggerDetail: "system",
      responsibleUserId: "operator",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-07-17T06:01:00.000Z"),
      finishedAt: new Date("2026-07-17T06:01:01.000Z"),
      createdAt: new Date("2026-07-17T06:01:00.000Z"),
      updatedAt: new Date("2026-07-17T06:01:01.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      id: scheduledWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "historical_retry",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "retry_scheduler",
      runId: scheduledRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: scheduledRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "assignment",
      triggerDetail: "system",
      wakeupRequestId: scheduledWakeId,
      responsibleUserId: "operator",
      retryOfRunId: parentRunId,
      scheduledRetryAt: new Date("2026-07-17T06:02:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_infrastructure",
      contextSnapshot: { issueId },
      createdAt: new Date("2026-07-17T06:01:02.000Z"),
      updatedAt: new Date("2026-07-17T06:01:02.000Z"),
    });

    const retryNow = await heartbeat.retryScheduledRetryNow({
      issueId,
      actor: { actorType: "user", actorId: "operator" },
      now: new Date("2026-07-17T06:03:00.000Z"),
    });
    expect(retryNow.outcome).toBe("gate_suppressed");
    expect(retryNow.scheduledRetry).toMatchObject({
      runId: scheduledRunId,
      status: "cancelled",
    });

    const dueRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: dueRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "assignment",
      triggerDetail: "system",
      responsibleUserId: "operator",
      retryOfRunId: parentRunId,
      scheduledRetryAt: new Date("2026-07-17T06:02:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_infrastructure",
      contextSnapshot: { issueId },
      createdAt: new Date("2026-07-17T06:01:03.000Z"),
      updatedAt: new Date("2026-07-17T06:01:03.000Z"),
    });
    const duePromotion = await heartbeat.promoteDueScheduledRetries(
      new Date("2026-07-17T06:03:00.000Z"),
    );
    expect(duePromotion).toEqual({ promoted: 0, runIds: [] });
    const dueRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, dueRunId))
      .then((rows) => rows[0] ?? null);
    expect(dueRun).toEqual({
      status: "cancelled",
      errorCode: "execution_issue_created_at_cutoff",
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("pumps a controlled-swarm retry-now promotion without timer-heartbeat polling", async () => {
    adapterState.active = 0;
    adapterState.maxActive = 0;
    adapterState.startedAgentIds = [];
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const cutoff = "2026-07-17T06:00:00.000Z";
    const issueId = randomUUID();
    const parentRunId = randomUUID();
    const retryRunId = randomUUID();
    const retryWakeId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "CURRENT-1",
      title: "Current campaign issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      createdAt: new Date("2026-07-17T06:00:01.000Z"),
      updatedAt: new Date("2026-07-17T06:00:01.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId,
      agentId,
      status: "failed",
      invocationSource: "assignment",
      triggerDetail: "system",
      responsibleUserId: "operator",
      contextSnapshot: { issueId },
      startedAt: new Date("2026-07-17T06:00:02.000Z"),
      finishedAt: new Date("2026-07-17T06:00:03.000Z"),
    });
    await db.insert(agentWakeupRequests).values({
      id: retryWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "campaign_retry",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "retry_scheduler",
      runId: retryRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "assignment",
      triggerDetail: "system",
      wakeupRequestId: retryWakeId,
      responsibleUserId: "operator",
      retryOfRunId: parentRunId,
      scheduledRetryAt: new Date("2026-07-17T06:05:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_infrastructure",
      contextSnapshot: {
        issueId,
        retryReason: "transient_infrastructure",
        gloopsExecutionAdmission: null,
      },
    });
    adapterExecute.mockImplementationOnce(async (input: { agent: { id: string } }) => {
      adapterState.startedAgentIds.push(input.agent.id);
      await db
        .update(issues)
        .set({
          status: "done",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issueId));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Controlled-swarm retry completed its issue.",
        provider: "test",
        model: "test-model",
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
      };
    });

    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "1",
        PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE: cutoff,
      },
    });
    const retried = await heartbeat.retryScheduledRetryNow({
      issueId,
      actor: { actorType: "user", actorId: "operator" },
      now: new Date("2026-07-17T06:01:00.000Z"),
    });
    expect(retried.outcome).toBe("promoted");
    await waitForTerminalRuns(db, [retryRunId]);
    await heartbeat.waitForRunExecutionDrain(retryRunId);
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(adapterState.startedAgentIds).toEqual([agentId]);
  });

  it("binds an attributable host-deadman epoch before adapter invocation", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "campaign_deadman_binding_test",
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: "operator",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      triggerDetail: "system",
      wakeupRequestId,
      responsibleUserId: "operator",
      contextSnapshot: {},
    });

    const firstAdmittedAt = new Date(Date.now() - 1_000).toISOString();
    const deadlineAt = new Date(Date.now() + 86_399_000).toISOString();
    const campaignDeadmanAdmission = vi.fn(async (
      policy: {
        campaignId: string;
        durationSeconds: number;
      },
      input: {
        companyId: string;
        runId: string;
      },
    ) => ({
      schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
      campaignId: policy.campaignId,
      companyId: input.companyId,
      firstRunId: input.runId,
      firstAdmittedAt,
      deadlineAt,
      durationSeconds: policy.durationSeconds,
      epochSha256: `sha256:${"d".repeat(64)}`,
    }));
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        ...executionAdmissionEnv,
        PAPERCLIP_CAMPAIGN_ID: "controlled-swarm-20260717",
        PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: "/run/paperclip-campaign/deadman.sock",
        PAPERCLIP_CAMPAIGN_DURATION_SECONDS: "86400",
      },
      campaignDeadmanAdmission,
    });

    await heartbeat.resumeQueuedRuns();
    await waitForTerminalRuns(db, [runId]);
    await heartbeat.waitForRunExecutionDrain(runId);

    expect(campaignDeadmanAdmission).toHaveBeenCalledTimes(1);
    expect(campaignDeadmanAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: "controlled-swarm-20260717" }),
      { companyId, runId },
    );
    const persisted = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.contextSnapshot).toMatchObject({
      [CAMPAIGN_EPOCH_CONTEXT_KEY]: {
        campaignId: "controlled-swarm-20260717",
        companyId,
        firstRunId: runId,
        deadlineAt,
      },
    });
    expect(adapterExecute).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit admissions behind the controlled-swarm commissioning barrier", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "controlled_swarm_commissioning_barrier_test",
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: "operator",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      triggerDetail: "system",
      wakeupRequestId,
      responsibleUserId: "operator",
      contextSnapshot: {},
    });
    const campaignDeadmanAdmission = vi.fn();
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "false",
        PAPERCLIP_CAMPAIGN_ID: "controlled-swarm-20260717",
        PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: "/run/paperclip-campaign/deadman.sock",
      },
      campaignDeadmanAdmission,
    });

    await expect(heartbeat.resumeQueuedRuns()).rejects.toThrow(
      "controlled swarm is not commissioned for execution",
    );
    const persisted = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toMatchObject({
      status: "queued",
      contextSnapshot: {},
    });
    expect(campaignDeadmanAdmission).not.toHaveBeenCalled();
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("leaves the run queued and never invokes an adapter when the host deadman fails closed", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "campaign_deadman_denial_test",
      status: "queued",
      requestedByActorType: "user",
      requestedByActorId: "operator",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      triggerDetail: "system",
      wakeupRequestId,
      responsibleUserId: "operator",
      contextSnapshot: {},
    });

    const campaignDeadmanAdmission = vi.fn(async () => {
      throw new Error("campaign deadman denied admission: expired");
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_CAMPAIGN_ID: "controlled-swarm-20260717",
        PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: "/run/paperclip-campaign/deadman.sock",
      },
      campaignDeadmanAdmission,
    });

    await expect(heartbeat.resumeQueuedRuns()).rejects.toThrow(
      "campaign deadman denied admission: expired",
    );
    const persisted = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toMatchObject({
      status: "queued",
      contextSnapshot: {},
    });
    expect(campaignDeadmanAdmission).toHaveBeenCalledTimes(1);
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("durably binds campaign-created queues and terminalizes them idempotently on both general claim branches", async () => {
    adapterExecute.mockClear();
    for (const admissionEnv of [{}, executionAdmissionEnv]) {
      const { companyId, agentIds: [agentId] } = await seedCompany(1);
      const campaignId = `handoff-${companyId.slice(0, 8)}`;
      const blockerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: blockerRunId,
        companyId,
        agentId: agentId!,
        status: "running",
        invocationSource: "on_demand",
        triggerDetail: "system",
        responsibleUserId: "operator",
        contextSnapshot: {},
        startedAt: new Date(),
      });
      const campaign = heartbeatService(db, {
        runtimeEnv: {
          ...admissionEnv,
          PAPERCLIP_CAMPAIGN_ID: campaignId,
          PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: "/run/paperclip-campaign/deadman.sock",
        },
        campaignDeadmanAdmission: vi.fn(),
      });
      const boundRun = await campaign.invoke(
        agentId!,
        "on_demand",
        {},
        "system",
        { actorType: "user", actorId: "operator" },
      );
      expect(boundRun?.status).toBe("queued");
      expect(boundRun?.contextSnapshot).toMatchObject({
        [CAMPAIGN_BINDING_CONTEXT_KEY]: {
          schemaVersion: CAMPAIGN_BINDING_SCHEMA_VERSION,
          scope: "campaign-bound",
          campaignId,
        },
      });

      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, blockerRunId));

      const general = heartbeatService(db, { runtimeEnv: admissionEnv });
      await general.resumeQueuedRuns();
      const cancelled = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, boundRun!.id))
        .then((rows) => rows[0]);
      expect(cancelled).toMatchObject({
        status: "cancelled",
        errorCode: CAMPAIGN_BOUND_RUN_ERROR_CODE,
        resultJson: {
          stopReason: CAMPAIGN_BOUND_RUN_ERROR_CODE,
          providerInvocationAttempted: false,
          [CAMPAIGN_TERMINAL_RECEIPT_KEY]: {
            campaignId,
            disposition: "cancelled",
          },
        },
      });
      const firstReceipt = (cancelled.resultJson as Record<string, unknown>)[CAMPAIGN_TERMINAL_RECEIPT_KEY];
      await general.resumeQueuedRuns();
      const replayed = await db
        .select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, boundRun!.id))
        .then((rows) => rows[0]);
      expect((replayed.resultJson as Record<string, unknown>)[CAMPAIGN_TERMINAL_RECEIPT_KEY])
        .toEqual(firstReceipt);

      const generalRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: generalRunId,
        companyId,
        agentId: agentId!,
        status: "queued",
        invocationSource: "on_demand",
        triggerDetail: "system",
        responsibleUserId: "operator",
        contextSnapshot: {},
      });
      await general.resumeQueuedRuns();
      await waitForTerminalRuns(db, [generalRunId]);
      await general.waitForRunExecutionDrain(generalRunId);
      expect(await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, generalRunId))
        .then((rows) => rows[0]?.status)).toBe("succeeded");
      expect(adapterExecute.mock.calls.filter(([input]) => input.agent.id === agentId))
        .toHaveLength(1);
    }
  }, 30_000);

  it("keeps issue-scoped campaign A immutable when campaign B arrives behind its execution lock", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const issueId = randomUUID();
    const blockerRunId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `SCOPE-${companyId.slice(0, 6)}`,
      title: "Preserve issue campaign scope while coalescing",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId!,
      responsibleUserId: "operator",
    });
    await db.insert(heartbeatRuns).values({
      id: blockerRunId,
      companyId,
      agentId: agentId!,
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "system",
      responsibleUserId: "operator",
      contextSnapshot: {},
      startedAt: new Date(),
    });

    const campaignAId = `campaign-a-${companyId.slice(0, 8)}`;
    const campaignBId = `campaign-b-${companyId.slice(0, 8)}`;
    const campaignA = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_CAMPAIGN_ID: campaignAId,
        PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: "/run/paperclip-campaign/deadman.sock",
      },
      campaignDeadmanAdmission: vi.fn(),
    });
    const campaignB = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_CAMPAIGN_ID: campaignBId,
        PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: "/run/paperclip-campaign/deadman.sock",
      },
      campaignDeadmanAdmission: vi.fn(),
    });

    const runA = await campaignA.invoke(
      agentId!,
      "on_demand",
      { issueId },
      "system",
      { actorType: "user", actorId: "operator" },
    );
    expect(runA?.status).toBe("queued");
    expect(await campaignB.invoke(
      agentId!,
      "on_demand",
      { issueId },
      "system",
      { actorType: "user", actorId: "operator" },
    )).toBeNull();

    const persistedA = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runA!.id))
      .then((rows) => rows[0]);
    expect(persistedA.contextSnapshot).toMatchObject({
      [CAMPAIGN_BINDING_CONTEXT_KEY]: { campaignId: campaignAId },
    });
    const deferredB = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ))
      .then((rows) => rows[0] ?? null);
    expect(deferredB?.payload).toMatchObject({
      issueId,
      _paperclipWakeContext: {
        [CAMPAIGN_BINDING_CONTEXT_KEY]: { campaignId: campaignBId },
      },
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, blockerRunId));
    const general = heartbeatService(db, { runtimeEnv: {} });
    await general.resumeQueuedRuns();
    await general.resumeQueuedRuns();
    const runB = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, deferredB!.id))
      .then((rows) => rows[0] ?? null);
    expect(await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runA!.id))
      .then((rows) => rows[0]?.status)).toBe("cancelled");
    expect(runB).toMatchObject({
      status: "cancelled",
      contextSnapshot: {
        [CAMPAIGN_BINDING_CONTEXT_KEY]: { campaignId: campaignBId },
      },
    });
    expect(adapterExecute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
  });

  it("replays interrupted campaign terminal cleanup with the exact receipt and one event", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const issueId = randomUUID();
    const runAId = randomUUID();
    const wakeAId = randomUUID();
    const deferredBId = randomUUID();
    const campaignAId = `replay-a-${companyId.slice(0, 8)}`;
    const campaignBId = `replay-b-${companyId.slice(0, 8)}`;
    const binding = (campaignId: string) => ({
      [CAMPAIGN_BINDING_CONTEXT_KEY]: {
        schemaVersion: CAMPAIGN_BINDING_SCHEMA_VERSION,
        scope: "campaign-bound",
        campaignId,
      },
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: wakeAId,
        companyId,
        agentId: agentId!,
        source: "on_demand",
        triggerDetail: "system",
        reason: "campaign_a",
        payload: { issueId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: "operator",
        runId: runAId,
      },
      {
        id: deferredBId,
        companyId,
        agentId: agentId!,
        source: "on_demand",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: {
          issueId,
          _paperclipWakeContext: { issueId, ...binding(campaignBId) },
        },
        status: "deferred_issue_execution",
        requestedByActorType: "user",
        requestedByActorId: "operator",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runAId,
      companyId,
      agentId: agentId!,
      status: "queued",
      invocationSource: "on_demand",
      triggerDetail: "system",
      wakeupRequestId: wakeAId,
      responsibleUserId: "operator",
      contextSnapshot: { issueId, ...binding(campaignAId) },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `REPLAY-${companyId.slice(0, 6)}`,
      title: "Replay interrupted campaign cleanup",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId!,
      checkoutRunId: runAId,
      executionRunId: runAId,
      executionAgentNameKey: "swarmagent0",
      executionLockedAt: new Date(),
      responsibleUserId: "operator",
    });

    let injected = false;
    const interrupted = heartbeatService(db, {
      runtimeEnv: {},
      campaignBoundRunTerminalizationHooks: {
        afterRunStatusPersisted: async () => {
          if (!injected) {
            injected = true;
            throw new Error("injected campaign terminal cleanup interruption");
          }
        },
      },
    });
    await expect(interrupted.resumeQueuedRuns()).rejects.toThrow(
      "injected campaign terminal cleanup interruption",
    );

    const partialA = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runAId))
      .then((rows) => rows[0]);
    const exactReceipt = (partialA.resultJson as Record<string, unknown>)[CAMPAIGN_TERMINAL_RECEIPT_KEY];
    expect(partialA).toMatchObject({ status: "cancelled", errorCode: CAMPAIGN_BOUND_RUN_ERROR_CODE });
    expect(partialA.resultJson as Record<string, unknown>).not.toHaveProperty(CAMPAIGN_TERMINAL_CLEANUP_KEY);
    expect(await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeAId))
      .then((rows) => rows[0]?.status)).toBe("queued");
    expect(await db
      .select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0])).toEqual({ executionRunId: runAId, checkoutRunId: runAId });

    const replay = heartbeatService(db, { runtimeEnv: {} });
    await replay.resumeQueuedRuns();
    await replay.resumeQueuedRuns();

    const cleanedA = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runAId))
      .then((rows) => rows[0]);
    expect((cleanedA.resultJson as Record<string, unknown>)[CAMPAIGN_TERMINAL_RECEIPT_KEY])
      .toEqual(exactReceipt);
    expect((cleanedA.resultJson as Record<string, unknown>)[CAMPAIGN_TERMINAL_CLEANUP_KEY])
      .toEqual(expect.any(String));
    expect(await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeAId))
      .then((rows) => rows[0]?.status)).toBe("cancelled");
    expect(await db
      .select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0])).toEqual({ executionRunId: null, checkoutRunId: null });
    const promotedB = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, deferredBId))
      .then((rows) => rows[0] ?? null);
    expect(promotedB).toMatchObject({
      status: "cancelled",
      contextSnapshot: {
        [CAMPAIGN_BINDING_CONTEXT_KEY]: { campaignId: campaignBId },
      },
    });
    const terminalEventCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.runId, runAId),
        sql`${heartbeatRunEvents.payload} ->> 'terminalizationKind' = 'campaign_bound_scope_unavailable'`,
      ))
      .then((rows) => rows[0]?.count ?? 0);
    expect(terminalEventCount).toBe(1);
    expect(adapterExecute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
  });

  it("converges concurrent campaign terminalizers on one canonical receipt, event, and promotion", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const issueId = randomUUID();
    const runAId = randomUUID();
    const wakeAId = randomUUID();
    const deferredBId = randomUUID();
    const campaignAId = `race-a-${companyId.slice(0, 8)}`;
    const campaignBId = `race-b-${companyId.slice(0, 8)}`;
    const binding = (campaignId: string) => ({
      [CAMPAIGN_BINDING_CONTEXT_KEY]: {
        schemaVersion: CAMPAIGN_BINDING_SCHEMA_VERSION,
        scope: "campaign-bound",
        campaignId,
      },
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: wakeAId,
        companyId,
        agentId: agentId!,
        source: "automation",
        triggerDetail: "system",
        reason: "campaign_retry",
        payload: { issueId },
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "retry_scheduler",
        runId: runAId,
      },
      {
        id: deferredBId,
        companyId,
        agentId: agentId!,
        source: "on_demand",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: {
          issueId,
          _paperclipWakeContext: { issueId, ...binding(campaignBId) },
        },
        status: "deferred_issue_execution",
        requestedByActorType: "user",
        requestedByActorId: "operator",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runAId,
      companyId,
      agentId: agentId!,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      wakeupRequestId: wakeAId,
      responsibleUserId: "operator",
      scheduledRetryAt: new Date("2026-01-01T00:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_infrastructure",
      contextSnapshot: { issueId, ...binding(campaignAId) },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: `RACE-${companyId.slice(0, 6)}`,
      title: "Converge concurrent campaign terminalizers",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId!,
      checkoutRunId: runAId,
      executionRunId: runAId,
      executionAgentNameKey: "swarmagent0",
      executionLockedAt: new Date(),
      responsibleUserId: "operator",
    });

    let arrivals = 0;
    let releaseBoth!: () => void;
    let firstArrived!: () => void;
    const bothAtCas = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const firstAtCas = new Promise<void>((resolve) => {
      firstArrived = resolve;
    });
    const beforeRunStatusPersisted = async () => {
      arrivals += 1;
      if (arrivals === 1) firstArrived();
      if (arrivals === 2) releaseBoth();
      await bothAtCas;
    };
    const first = heartbeatService(db, {
      runtimeEnv: {},
      campaignBoundRunTerminalizationHooks: { beforeRunStatusPersisted },
    });
    const second = heartbeatService(db, {
      runtimeEnv: {},
      campaignBoundRunTerminalizationHooks: { beforeRunStatusPersisted },
    });
    const now = new Date("2026-01-02T00:00:00.000Z");
    const firstTerminalizer = first.promoteDueScheduledRetries(now);
    await firstAtCas;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondTerminalizer = second.promoteDueScheduledRetries(now);
    expect(await Promise.all([firstTerminalizer, secondTerminalizer])).toEqual([
      { promoted: 0, runIds: [] },
      { promoted: 0, runIds: [] },
    ]);

    const canonicalA = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runAId))
      .then((rows) => rows[0]);
    const canonicalResult = canonicalA.resultJson as Record<string, unknown>;
    const canonicalReceipt = canonicalResult[CAMPAIGN_TERMINAL_RECEIPT_KEY] as Record<string, unknown>;
    expect(canonicalA).toMatchObject({ status: "cancelled", errorCode: CAMPAIGN_BOUND_RUN_ERROR_CODE });
    expect(canonicalA.finishedAt?.toISOString()).toBe(canonicalReceipt.terminalizedAt);
    expect(canonicalResult[CAMPAIGN_TERMINAL_CLEANUP_KEY]).toEqual(expect.any(String));

    const terminalEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(and(
        eq(heartbeatRunEvents.runId, runAId),
        sql`${heartbeatRunEvents.payload} ->> 'terminalizationKind' = 'campaign_bound_scope_unavailable'`,
      ));
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.payload).toMatchObject({
      campaignId: campaignAId,
      terminalizedAt: canonicalReceipt.terminalizedAt,
    });

    const promotedB = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, deferredBId));
    expect(promotedB).toHaveLength(1);
    expect(promotedB[0]).toMatchObject({
      status: "cancelled",
      contextSnapshot: {
        [CAMPAIGN_BINDING_CONTEXT_KEY]: { campaignId: campaignBId },
      },
    });
    expect(await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeAId))
      .then((rows) => rows[0]?.status)).toBe("cancelled");
    expect(await db
      .select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0])).toEqual({ executionRunId: null, checkoutRunId: null });
    expect(adapterExecute.mock.calls.filter(([input]) => input.agent.id === agentId)).toHaveLength(0);
  }, 30_000);

  it("publishes a campaign terminal event only after its transaction commits", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const runId = randomUUID();
    const campaignId = `event-commit-${companyId.slice(0, 8)}`;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: agentId!,
      status: "scheduled_retry",
      invocationSource: "automation",
      triggerDetail: "system",
      responsibleUserId: "operator",
      scheduledRetryAt: new Date("2026-01-01T00:00:00.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_infrastructure",
      contextSnapshot: {
        [CAMPAIGN_BINDING_CONTEXT_KEY]: {
          schemaVersion: CAMPAIGN_BINDING_SCHEMA_VERSION,
          scope: "campaign-bound",
          campaignId,
        },
      },
    });

    const liveTerminalEvents: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (
        event.type === "heartbeat.run.event" &&
        event.payload.runId === runId &&
        (event.payload.payload as Record<string, unknown> | undefined)?.terminalizationKind ===
          "campaign_bound_scope_unavailable"
      ) {
        liveTerminalEvents.push(event);
      }
    });
    try {
      const failCommit = heartbeatService(db, {
        runtimeEnv: {},
        campaignBoundRunTerminalizationHooks: {
          beforeTerminalEventTransactionCommit: async () => {
            throw new Error("inject campaign terminal event commit failure");
          },
        },
      });
      await expect(
        failCommit.promoteDueScheduledRetries(new Date("2026-01-02T00:00:00.000Z")),
      ).rejects.toThrow("inject campaign terminal event commit failure");

      expect(await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, runId),
          sql`${heartbeatRunEvents.payload} ->> 'terminalizationKind' = 'campaign_bound_scope_unavailable'`,
        ))
        .then((rows) => rows[0]?.count ?? 0)).toBe(0);
      expect(liveTerminalEvents).toHaveLength(0);

      const retry = heartbeatService(db, { runtimeEnv: {} });
      await retry.resumeQueuedRuns();
      await retry.resumeQueuedRuns();

      expect(await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, runId),
          sql`${heartbeatRunEvents.payload} ->> 'terminalizationKind' = 'campaign_bound_scope_unavailable'`,
        ))
        .then((rows) => rows[0]?.count ?? 0)).toBe(1);
      expect(liveTerminalEvents).toHaveLength(1);
      expect(adapterExecute).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  }, 30_000);

  it("terminalizes a due campaign-bound scheduled retry in the general plane without promotion", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const sourceRunId = randomUUID();
    const campaignId = "expired-scheduled-campaign";
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: agentId!,
      status: "failed",
      invocationSource: "automation",
      triggerDetail: "system",
      responsibleUserId: "operator",
      finishedAt: new Date("2026-01-01T00:00:00.000Z"),
      contextSnapshot: {
        [CAMPAIGN_BINDING_CONTEXT_KEY]: {
          schemaVersion: CAMPAIGN_BINDING_SCHEMA_VERSION,
          scope: "campaign-bound",
          campaignId,
        },
      },
    });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const dueAt = new Date("2026-01-02T00:00:00.000Z");
    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now: dueAt,
      delayMs: 0,
      maxAttempts: 1,
    });
    expect(scheduled).toMatchObject({
      outcome: "scheduled",
      run: {
        status: "scheduled_retry",
        retryOfRunId: sourceRunId,
        contextSnapshot: {
          [CAMPAIGN_BINDING_CONTEXT_KEY]: { campaignId },
        },
      },
    });
    if (scheduled.outcome !== "scheduled") throw new Error("expected bounded retry to be scheduled");
    const runId = scheduled.run.id;
    expect(await heartbeat.promoteDueScheduledRetries(dueAt))
      .toEqual({ promoted: 0, runIds: [] });
    const persisted = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(persisted).toMatchObject({
      status: "cancelled",
      errorCode: CAMPAIGN_BOUND_RUN_ERROR_CODE,
      resultJson: {
        [CAMPAIGN_TERMINAL_RECEIPT_KEY]: { campaignId },
      },
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("keeps legacy campaign epoch provenance on orphan recovery and terminalizes the retry in general mode", async () => {
    adapterExecute.mockClear();
    const { companyId, agentIds: [agentId] } = await seedCompany(1);
    const runId = randomUUID();
    const campaignId = "legacy-orphan-campaign";
    await db
      .update(agents)
      .set({ adapterType: "codex_local" })
      .where(eq(agents.id, agentId!));
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: agentId!,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      responsibleUserId: "operator",
      processPid: 99_999_999,
      processLossRetryCount: 0,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      contextSnapshot: {
        [CAMPAIGN_EPOCH_CONTEXT_KEY]: {
          schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
          campaignId,
          companyId,
          firstRunId: runId,
          firstAdmittedAt: "2026-01-01T00:00:00.000Z",
          deadlineAt: "2026-01-02T00:00:00.000Z",
          durationSeconds: 86_400,
          epochSha256: `sha256:${"e".repeat(64)}`,
        },
      },
    });
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    expect(await heartbeat.reapOrphanedRuns()).toEqual({ reaped: 1, runIds: [runId] });
    const retry = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
    expect(retry).toMatchObject({
      status: "cancelled",
      errorCode: CAMPAIGN_BOUND_RUN_ERROR_CODE,
      contextSnapshot: {
        [CAMPAIGN_EPOCH_CONTEXT_KEY]: { campaignId },
      },
      resultJson: {
        [CAMPAIGN_TERMINAL_RECEIPT_KEY]: { campaignId },
      },
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });
});
