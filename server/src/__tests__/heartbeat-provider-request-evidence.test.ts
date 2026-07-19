import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  heartbeatRunSettlements,
  issues,
  providerIoTerminalEvidence,
  providerRequestEvidence,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const adapterExecute = vi.hoisted(() => vi.fn(async (ctx: {
  runId: string;
  onProviderRequestPrepared?: (evidence: {
    schemaVersion: "gloops.provider-request-prepared.v1";
    destinationClass: "hermes_gateway";
    requestSchemaVersion: "hermes.run.create.v1";
    requestByteLength: number;
    requestSha256: string;
    idempotencyKey: string;
    requestPreparedAt: string;
  }) => Promise<unknown>;
}) => {
  if (!ctx.onProviderRequestPrepared) throw new Error("prepared-request callback missing");
  await ctx.onProviderRequestPrepared({
    schemaVersion: "gloops.provider-request-prepared.v1",
    destinationClass: "hermes_gateway",
    requestSchemaVersion: "hermes.run.create.v1",
    requestByteLength: 23,
    requestSha256: `sha256:${"c".repeat(64)}`,
    idempotencyKey: ctx.runId,
    requestPreparedAt: new Date().toISOString(),
  });
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    providerInvocationAttempted: true,
    summary: "Prepared evidence integration test.",
    provider: "ollama",
    model: "test-model",
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
    providerIoTerminalEvidence: {
      schemaVersion: "gloops.provider-io-terminal.v1" as const,
      preparedRequest: {
        requestByteLength: 23,
        requestSha256: `sha256:${"c".repeat(64)}`,
      },
      hermesRunId: "hermes-run-1",
      createResponse: {
        rawByteLength: 21,
        rawSha256: `sha256:${"1".repeat(64)}`,
        canonicalSha256: `sha256:${"2".repeat(64)}`,
      },
      eventStream: {
        rawByteLength: 200,
        rawSha256: `sha256:${"3".repeat(64)}`,
        canonicalEventSequenceSha256: `sha256:${"4".repeat(64)}`,
        eventCount: 1,
      },
      finalStatusResponse: {
        rawByteLength: 180,
        rawSha256: `sha256:${"5".repeat(64)}`,
        canonicalSha256: `sha256:${"6".repeat(64)}`,
      },
      terminalEvidence: {
        schemaVersion: "gloops.hermes-terminal-evidence.v1" as const,
        hermesRunId: "hermes-run-1",
        requestByteLength: 23,
        requestSha256: "c".repeat(64),
        resolvedProvider: "ollama-cloud",
        resolvedModel: "test-model",
        transportClass: "openai_chat_completions",
        billingClass: "subscription_included",
        fallbackPath: [{
          provider: "ollama-cloud",
          model: "test-model",
          transportClass: "openai_chat_completions",
          billingClass: "subscription_included",
        }],
        inputUsage: { present: true, value: 10 },
        outputUsage: { present: true, value: 2 },
        cachedUsage: { present: true, value: 0 },
        usageSource: "provider_response_aggregate",
        turnTotal: 1,
        toolCallTotal: 0,
        terminalStatus: "completed" as const,
      },
      terminalEvidenceDigest: `sha256:${"7".repeat(64)}`,
      rawPayloadDisposition: "not_retained" as const,
      reconciledAt: new Date().toISOString(),
    },
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

describeEmbeddedPostgres("heartbeat prepared provider evidence integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-provider-evidence-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("supplies the durable acknowledgement boundary to the adapter", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat Evidence Co",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes",
      role: "engineer",
      status: "active",
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Exercise prepared provider evidence",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "operator",
    });

    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
        PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "1",
        PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "0",
        PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000",
        PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200",
        PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "60000",
        PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "1000",
        PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "200",
        PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "4",
        PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "10",
      },
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "provider_evidence_test",
      payload: { issueId },
      contextSnapshot: { issueId, skipIssueComment: true },
      requestedByActorType: "user",
      requestedByActorId: "operator",
    });
    expect(run).not.toBeNull();
    const deadline = Date.now() + 8_000;
    let terminalStatus: string | null = null;
    while (Date.now() < deadline) {
      const status = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0]?.status ?? null);
      if (status && !["queued", "running", "scheduled_retry"].includes(status)) {
        terminalStatus = status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await heartbeat.waitForRunExecutionDrain(run!.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(terminalStatus).toBe("succeeded");

    const rows = await db
      .select()
      .from(providerRequestEvidence)
      .where(eq(providerRequestEvidence.heartbeatRunId, run!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      agentId,
      heartbeatRunId: run!.id,
      issueId,
      requestByteLength: 23,
      requestSha256: `sha256:${"c".repeat(64)}`,
      idempotencyKey: run!.id,
    });
    expect(adapterExecute).toHaveBeenCalled();
    const terminalRows = await db
      .select()
      .from(providerIoTerminalEvidence)
      .where(eq(providerIoTerminalEvidence.heartbeatRunId, run!.id));
    expect(terminalRows).toHaveLength(1);
    expect(terminalRows[0]).toMatchObject({
      companyId,
      agentId,
      heartbeatRunId: run!.id,
      issueId,
      hermesRunId: "hermes-run-1",
      terminalEvidenceDigest: `sha256:${"7".repeat(64)}`,
      rawPayloadDisposition: "not_retained",
    });
    const settlements = await db
      .select()
      .from(heartbeatRunSettlements)
      .where(eq(heartbeatRunSettlements.heartbeatRunId, run!.id));
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      companyId,
      agentId,
      heartbeatRunId: run!.id,
      terminalStatus: "succeeded",
      normalizedUsage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 2,
      },
      mutationDisposition: "not_authorized",
      brokerReceiptDigest: null,
      remoteOldOid: null,
      remoteNewOid: null,
      accountingContinuation: {
        schemaVersion: "gloops.accounting-continuation.v1",
        heartbeatRunId: run!.id,
        totalInputTokens: 10,
        totalCachedInputTokens: 0,
        totalOutputTokens: 2,
      },
    });
    const runCosts = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, run!.id));
    expect(runCosts).toHaveLength(1);
    expect(runCosts[0]).toMatchObject({
      provider: "ollama-cloud",
      biller: "ollama-cloud",
      billingType: "subscription_included",
      model: "test-model",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 2,
      costCents: 0,
    });
    await heartbeat.cancelInvocationsForAgents([agentId], "test teardown");
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runRows) => runRows.map((row) => row.id));
    for (const runId of runIds) {
      await heartbeat.waitForRunExecutionDrain(runId);
    }
  }, 10_000);

  it("leaves a Hermes run non-terminal when atomic settlement rolls back", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Heartbeat Rollback Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes Rollback",
      role: "engineer",
      status: "active",
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Preserve atomic rollback",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "operator",
    });

    const settlementHook = vi.fn((step: string) => {
      if (step === "cost") throw new Error("injected heartbeat settlement rollback");
    });
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
        PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "1",
        PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "0",
        PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000",
        PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200",
        PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "60000",
        PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "1000",
        PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "200",
        PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "4",
        PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "10",
      },
      heartbeatRunSettlementHooks: {
        afterStep: settlementHook,
      },
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "user",
      reason: "provider_evidence_rollback_test",
      payload: { issueId },
      contextSnapshot: { issueId, skipIssueComment: true },
      requestedByActorType: "user",
      requestedByActorId: "operator",
    });
    expect(run).not.toBeNull();
    const settlementDeadline = Date.now() + 8_000;
    while (
      Date.now() < settlementDeadline
      && !settlementHook.mock.calls.some(([step]) => step === "cost")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(settlementHook).toHaveBeenCalledWith("cost");
    await heartbeat.waitForRunExecutionDrain(run!.id);

    const persistedRun = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run!.id))
      .then((rows) => rows[0]);
    expect(persistedRun.status).toBe("running");
    expect(await db.select().from(providerIoTerminalEvidence)
      .where(eq(providerIoTerminalEvidence.heartbeatRunId, run!.id))).toHaveLength(0);
    expect(await db.select().from(costEvents)
      .where(eq(costEvents.heartbeatRunId, run!.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRunSettlements)
      .where(eq(heartbeatRunSettlements.heartbeatRunId, run!.id))).toHaveLength(0);

    await heartbeat.cancelInvocationsForAgents([agentId], "test teardown");
    await heartbeat.waitForRunExecutionDrain(run!.id);
  }, 10_000);
});
