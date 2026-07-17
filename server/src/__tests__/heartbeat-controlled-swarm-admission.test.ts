import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
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
        adapterType: "codex_local",
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
});
