import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  buildExecutionAdmissionEnvelope,
  evaluateExecutionAdmission,
  parseExecutionAdmissionPolicy,
} from "../services/execution-admission.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Execution admission integration run.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
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

async function waitForTerminalRuns(db: ReturnType<typeof createDb>, ids: string[]) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, ids));
    if (rows.length === ids.length && rows.every((row) => !["queued", "running"].includes(row.status))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("execution admission runs did not reach terminal states");
}

describeEmbeddedPostgres("heartbeat execution admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, {
      PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
      PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "2",
      PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "1",
      PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "100000",
      PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "10000",
      PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "600000",
    });
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    process.env = previousEnv;
    await tempDb?.cleanup();
  });

  it("serializes direct recovery claims and invokes only the remaining allowed attempt", async () => {
    const companyId = randomUUID();
    const parentAgentId = randomUUID();
    const contenderAgentIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Admission Test",
      issuePrefix: "ADM",
      defaultResponsibleUserId: "operator",
      requireBoardApprovalForNewAgents: false,
    });
    for (const [index, agentId] of [parentAgentId, ...contenderAgentIds].entries()) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `AdmissionAgent${index}`,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });
    }

    const parentRunId = randomUUID();
    const parsedPolicy = parseExecutionAdmissionPolicy(process.env);
    if (!parsedPolicy.enabled) throw new Error("expected enabled execution policy");
    const parentEnvelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: `run:${parentRunId}:default`, epoch: "default" },
      policy: parsedPolicy,
      decision: evaluateExecutionAdmission(parsedPolicy, []),
      evaluatedAt: new Date("2026-07-13T00:00:00Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId,
      agentId: parentAgentId,
      status: "succeeded",
      startedAt: new Date("2026-07-13T00:00:00Z"),
      finishedAt: new Date("2026-07-13T00:00:01Z"),
      usageJson: {
        inputTokens: 1_000,
        rawInputTokens: 200_000,
        usageSource: "session_delta",
      },
      contextSnapshot: { gloopsExecutionAdmission: parentEnvelope },
    });

    const contenderRunIds: string[] = [];
    for (const agentId of contenderAgentIds) {
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      contenderRunIds.push(runId);
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "direct_recovery",
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "recovery",
        runId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        triggerDetail: "system",
        retryOfRunId: parentRunId,
        wakeupRequestId,
        contextSnapshot: { wakeReason: "direct_recovery" },
      });
    }

    await heartbeatService(db).resumeQueuedRuns();
    await waitForTerminalRuns(db, contenderRunIds);
    // Terminal status is persisted immediately before the final lifecycle
    // event; let the executor finish that receipt before the database closes.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rows = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, contenderRunIds));
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(rows.filter((row) => row.status === "succeeded")).toHaveLength(1);
    expect(rows.filter((row) => row.errorCode === "execution_admission.run_limit_exhausted")).toHaveLength(2);
    expect(rows.every((row) => {
      const admission = row.contextSnapshot?.gloopsExecutionAdmission as { budgetId?: string } | undefined;
      return admission?.budgetId === `run:${parentRunId}:default`;
    })).toBe(true);
  });
});
