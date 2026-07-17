import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupIdempotency,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Wake idempotency test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wake idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-wakeup-idempotency-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    const agentIds = await db.select({ id: agents.id }).from(agents).then((rows) => rows.map((row) => row.id));
    await db.update(agents).set({ status: "paused" });
    await heartbeat.cancelInvocationsForAgents(agentIds, "test teardown");
    runningProcesses.clear();
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).then((rows) => rows.map((row) => row.id));
    for (const runId of runIds) {
      await heartbeat.waitForRunExecutionDrain(runId);
    }
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentWakeupIdempotency);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RepairWorker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Repair bounded defect",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  function wakeOptions(issueId: string, idempotencyKey: string) {
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "controlled_swarm_repair",
      payload: { issueId, mutation: "plugin_wakeup" },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "controlled_swarm_repair",
        source: "plugin.issue.requestWakeup",
      },
      idempotencyKey,
      requestedByActorType: "system" as const,
      requestedByActorId: "controlled-swarm-projector",
    };
  }

  it("returns one logical run for sequential and concurrent replay", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
    const key = `campaign:run:${randomUUID()}`;
    const options = wakeOptions(issueId, key);

    const [first, concurrentReplay] = await Promise.all([
      heartbeat.wakeup(agentId, options),
      heartbeat.wakeup(agentId, options),
    ]);
    const sequentialReplay = await heartbeat.wakeup(agentId, options);

    expect(first?.id).toBeTruthy();
    expect(concurrentReplay?.id).toBe(first?.id);
    expect(sequentialReplay?.id).toBe(first?.id);

    const wakeCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key))
      .then((rows) => rows[0]?.count ?? 0);
    const idempotencyRows = await db
      .select()
      .from(agentWakeupIdempotency)
      .where(eq(agentWakeupIdempotency.idempotencyKey, key));
    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);

    expect(wakeCount).toBe(1);
    expect(idempotencyRows).toHaveLength(1);
    expect(idempotencyRows[0]?.runId).toBe(first?.id);
    expect(runCount).toBe(1);
  });

  it("rejects reuse of a key for a materially different wake", async () => {
    const { agentId, issueId } = await seedCompanyAgentIssue();
    const key = `campaign:run:${randomUUID()}`;
    const options = wakeOptions(issueId, key);

    await heartbeat.wakeup(agentId, options);

    await expect(
      heartbeat.wakeup(agentId, {
        ...options,
        reason: "different_repair",
      }),
    ).rejects.toMatchObject({
      status: 409,
    });

    const wakeCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, key))
      .then((rows) => rows[0]?.count ?? 0);
    expect(wakeCount).toBe(1);
  });
});
