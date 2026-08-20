import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueRecoveryActions,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  EXECUTION_ADMISSION_CONTEXT_KEY,
  EXECUTION_ADMISSION_RESET_CONTEXT_KEY,
  buildPreProviderFailureObservation,
  buildPreProviderReadinessStateDigest,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionAdmission,
  parseExecutionAdmissionPolicy,
} from "../services/execution-admission.js";
import { guardedAdmissionResetService } from "../services/guarded-admission-reset.js";
import { heartbeatService, WorkspaceValidationFailure } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("@paperclipai/adapter-utils/execution-envelope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-envelope")>();
  return {
    ...actual,
    evaluateSubscriptionRouteAdmission: vi.fn(() => ({
      allowed: true,
      provider: null,
      reason: "Execution-admission fixture tests a separate admission boundary.",
    })),
  };
});

const mockWorkspaceRuntimeState = vi.hoisted(() => ({
  setupFailure: null as (Error & { code?: string; resultJson?: Record<string, unknown> }) | null,
}));

vi.mock("../services/workspace-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    realizeExecutionWorkspace: vi.fn(async (...args: Parameters<typeof actual.realizeExecutionWorkspace>) => {
      if (mockWorkspaceRuntimeState.setupFailure) throw mockWorkspaceRuntimeState.setupFailure;
      return actual.realizeExecutionWorkspace(...args);
    }),
  };
});

const mockAdapterState = vi.hoisted(() => ({
  supportsBudget: true,
  includeUsage: true,
  resultOverride: null as Record<string, unknown> | null,
  throwOverride: null as Error | null,
  providerTerminalEvidence: false,
  summaryOverride: null as string | null,
  beforeReturn: null as ((runId: string) => Promise<void>) | null,
}));
const mockAdapterExecute = vi.hoisted(() => vi.fn(async (ctx: {
  runId: string;
  onProviderRequestPrepared?: (evidence: Record<string, unknown>) => Promise<unknown>;
}) => {
  if (mockAdapterState.throwOverride) throw mockAdapterState.throwOverride;
  await mockAdapterState.beforeReturn?.(ctx.runId);
  if (mockAdapterState.providerTerminalEvidence) {
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
      summary: mockAdapterState.summaryOverride ?? "Trusted terminal evidence integration run.",
      provider: "ollama",
      model: "test-model",
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2 },
      providerIoTerminalEvidence: {
        schemaVersion: "gloops.provider-io-terminal.v1" as const,
        preparedRequest: {
          requestByteLength: 23,
          requestSha256: `sha256:${"c".repeat(64)}`,
        },
        hermesRunId: `hermes-${ctx.runId}`,
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
          hermesRunId: `hermes-${ctx.runId}`,
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
  }
  return mockAdapterState.resultOverride ?? {
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: mockAdapterState.summaryOverride ?? "Execution admission integration run.",
    provider: "test",
    model: "test-model",
    ...(mockAdapterState.includeUsage
      ? { usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 } }
      : {}),
  };
}));

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      supportsExecutionBudget: mockAdapterState.supportsBudget,
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
    if (rows.length === ids.length && rows.every((row) => !["queued", "running"].includes(row.status))) {
      // Terminal status is persisted immediately before the final lifecycle
      // event. Let that receipt settle so database cleanup cannot race it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    }
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
      PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "30000",
      PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "5000",
      PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "8",
      PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "32",
    });
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    process.env = previousEnv;
    await tempDb?.cleanup();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS;
    mockAdapterState.supportsBudget = true;
    mockAdapterState.includeUsage = true;
    mockAdapterState.resultOverride = null;
    mockAdapterState.throwOverride = null;
    mockAdapterState.providerTerminalEvidence = false;
    mockAdapterState.summaryOverride = null;
    mockAdapterState.beforeReturn = null;
    mockWorkspaceRuntimeState.setupFailure = null;
    mockAdapterExecute.mockClear();
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

  it("atomically reserves the single provider-free remediation across concurrent claims", async () => {
    mockAdapterState.resultOverride = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_auth_failed",
      errorMessage: "Managed provider identity is unavailable",
      providerInvocationAttempted: false,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      usageBasis: "per_run",
    };
    const companyId = randomUUID();
    const agentIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Stop-loss concurrency",
      issuePrefix: "SLC",
      defaultResponsibleUserId: "operator",
      requireBoardApprovalForNewAgents: false,
    });
    for (const [index, agentId] of agentIds.entries()) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `StopLossAgent${index}`,
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
      evaluatedAt: new Date("2026-08-20T00:00:00Z"),
    });
    const stateDigest = buildPreProviderReadinessStateDigest({ readiness: "unchanged" });
    const failure = buildPreProviderFailureObservation({
      errorCode: "hermes_gateway_auth_failed",
      adapterType: "codex_local",
      stateDigest,
      observedAt: new Date("2026-08-20T00:00:01Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: parentRunId,
      companyId,
      agentId: agentIds[0]!,
      status: "failed",
      errorCode: "hermes_gateway_auth_failed",
      startedAt: new Date("2026-08-20T00:00:00Z"),
      finishedAt: new Date("2026-08-20T00:00:01Z"),
      usageJson: { providerInvocationAttempted: false },
      resultJson: { provider_invocation: { attempted: false }, preProviderFailure: failure },
      contextSnapshot: { gloopsExecutionAdmission: parentEnvelope },
    });

    const contenderRunIds: string[] = [];
    for (const agentId of agentIds.slice(1)) {
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
    const rows = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, contenderRunIds));
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(rows.filter((row) => row.errorCode === "execution_admission.pre_provider_failure_limit_exhausted"))
      .toHaveLength(1);
  });

  async function seedDirectAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Direct Admission Test",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "operator",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DirectAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  let runnableIssueNumber = 10_000;
  async function seedRunnableAdmissionIssue(input: {
    companyId: string;
    agentId: string;
    status: "backlog" | "todo" | "in_progress" | "blocked" | "in_review" | "done" | "cancelled";
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `Runnable admission ${input.status}`,
      description: "## Scope\nExercise claim admission.\n\n## Acceptance\nThe claim is mediated by current status and wake context.",
      status: input.status,
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: input.agentId,
      issueNumber: runnableIssueNumber++,
      identifier: `RUN-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: { mode: "normal", commentRequired: false, stages: [] },
    });
    return issueId;
  }

  it.each(["done", "cancelled"] as const)(
    "WG-PLAT-016 denies terminal %s unconditionally despite interaction and resume signals",
    async (status) => {
      const { companyId, agentId } = await seedDirectAgent();
      const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status });
      const commentId = randomUUID();
      await db.insert(issueComments).values({
        id: commentId,
        companyId,
        issueId,
        authorUserId: "operator",
        body: "This comment must not reopen a terminal issue.",
      });
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(
        agentId,
        "automation",
        {
          issueId,
          wakeReason: "issue_commented",
          commentId,
          wakeCommentId: commentId,
          resumeIntent: true,
          // Caller-supplied context must not impersonate the trusted
          // control-plane deferred-comment promotion exception.
          nonOwningDeferredCommentDelivery: true,
        },
        "system",
        { actorType: "user", actorId: "operator" },
      );
      expect(run).not.toBeNull();
      await waitForTerminalRuns(db, [run!.id]);
      expect(await heartbeat.getRun(run!.id)).toMatchObject({
        status: "cancelled",
        errorCode: "issue_terminal_status",
        resultJson: { stopReason: "issue_terminal_status" },
      });
    },
  );

  it("WG-PLAT-016 does not let a trusted non-owning marker bypass nonterminal runnable admission", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "backlog" });
    const commentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "operator",
      body: "A promoted marker must not make backlog executable.",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "automation",
      triggerDetail: "system",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        commentId,
        wakeCommentId: commentId,
        nonOwningDeferredCommentDelivery: true,
      },
    });

    await heartbeatService(db).resumeQueuedRuns();
    await waitForTerminalRuns(db, [runId]);

    expect(await heartbeatService(db).getRun(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "admission.issue_not_runnable",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("WG-PLAT-016 denies a todo-to-blocked race inside the queued-to-running claim", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    let raced = false;
    const heartbeat = heartbeatService(db, {
      queuedRunClaimHooks: {
        afterIssuePreflight: async ({ issueId: claimIssueId }) => {
          if (raced || claimIssueId !== issueId) return;
          raced = true;
          await db
            .update(issues)
            .set({ status: "blocked", updatedAt: new Date() })
            .where(eq(issues.id, issueId));
        },
      },
    });

    const run = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "race-test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(raced).toBe(true);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "admission.issue_blocked",
      resultJson: { stopReason: "admission.issue_blocked" },
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("WG-PLAT-016 denies a resolved-dependency wake when a blocker reappears before claim", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "blocked" });
    const blockerIssueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "done" });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    let raced = false;
    const heartbeat = heartbeatService(db, {
      queuedRunClaimHooks: {
        afterDependencyReadBeforeClaimUpdate: async ({ issueId: claimIssueId }) => {
          if (raced || claimIssueId !== issueId) return;
          raced = true;
          await db
            .update(issues)
            .set({ status: "blocked", updatedAt: new Date() })
            .where(eq(issues.id, blockerIssueId));
        },
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      requestedByActorType: "system",
      requestedByActorId: "dependency-race-test",
      payload: { issueId, resolvedBlockerIssueId: blockerIssueId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerIssueId,
      },
    });
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(raced).toBe(true);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "issue_dependencies_blocked",
      resultJson: {
        stopReason: "issue_dependencies_blocked",
      },
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("WG-PLAT-016 rejects a user-forged dependency-ready wake on a blocked issue", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "blocked" });
    const blockerIssueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "done" });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "manual",
      reason: "issue_blockers_resolved",
      requestedByActorType: "user",
      requestedByActorId: "forging-user",
      payload: { issueId, resolvedBlockerIssueId: blockerIssueId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerIssueId,
      },
    });
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "admission.issue_blocked",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("WG-PLAT-016 denies blocked assignment and unrelated wakes with the blocked code", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    for (const wakeReason of ["issue_assigned", "execution_workspace_settings_changed"]) {
      const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "blocked" });
      const run = await heartbeat.invoke(
        agentId,
        "automation",
        { issueId, wakeReason },
        "system",
        { actorType: "system", actorId: "test" },
      );
      expect(run).not.toBeNull();
      await waitForTerminalRuns(db, [run!.id]);
      expect(await heartbeat.getRun(run!.id)).toMatchObject({
        status: "cancelled",
        errorCode: "admission.issue_blocked",
      });
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("WG-PLAT-016 admits blocked only for verified interaction or real resume intent", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);

    const interactionIssueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "blocked" });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId: interactionIssueId,
      authorUserId: "operator",
      body: "Verified interaction may inspect the blocked issue.",
    });
    const interactionRun = await heartbeat.invoke(
      agentId,
      "automation",
      {
        issueId: interactionIssueId,
        wakeReason: "issue_commented",
        commentId,
        wakeCommentId: commentId,
      },
      "system",
      { actorType: "user", actorId: "operator" },
    );
    expect(interactionRun).not.toBeNull();
    await waitForTerminalRuns(db, [interactionRun!.id]);
    expect((await heartbeat.getRun(interactionRun!.id))?.status).toBe("succeeded");

    const resumeIssueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "blocked" });
    const resumeRun = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId: resumeIssueId, wakeReason: "issue_status_changed", resumeIntent: true },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(resumeRun).not.toBeNull();
    await waitForTerminalRuns(db, [resumeRun!.id]);
    expect((await heartbeat.getRun(resumeRun!.id))?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  });

  it.each(["todo", "in_progress", "in_review"] as const)(
    "WG-PLAT-016 leaves runnable %s claim behavior unchanged",
    async (status) => {
      const { companyId, agentId } = await seedDirectAgent();
      const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status });
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(
        agentId,
        "automation",
        { issueId, wakeReason: "issue_assigned" },
        "system",
        { actorType: "system", actorId: "test" },
      );
      expect(run).not.toBeNull();
      await waitForTerminalRuns(db, [run!.id]);
      expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
  );

  it("WG-PLAT-005 keeps dirty-workspace failure issue-scoped and retires poisoned session state", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    const staleDirtyError = "Workspace contains uncommitted or untracked changes.";
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      stateJson: {},
      lastError: staleDirtyError,
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: issueId,
      sessionParamsJson: { sessionId: "poisoned-dirty-session" },
      sessionDisplayId: "poisoned-dirty-session",
      lastError: staleDirtyError,
    });
    mockAdapterState.throwOverride = new WorkspaceValidationFailure(staleDirtyError, {
      workspaceValidation: { status: "failed", reason: "dirty_workspace" },
      provider_invocation: { attempted: false },
    });

    const heartbeat = heartbeatService(db);
    const failed = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(failed).not.toBeNull();
    await waitForTerminalRuns(db, [failed!.id]);
    expect(await heartbeat.getRun(failed!.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_validation_failed",
      error: staleDirtyError,
    });
    await expect.poll(
      () => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]),
    ).toMatchObject({ status: "idle", errorReason: null });
    expect(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]))
      .toMatchObject({ lastError: null });
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId)))
      .toHaveLength(0);

    mockAdapterState.throwOverride = null;
    const nextIssueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    const next = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId: nextIssueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(next).not.toBeNull();
    await waitForTerminalRuns(db, [next!.id]);
    expect((await heartbeat.getRun(next!.id))?.status).toBe("succeeded");
  });

  it("WG-PLAT-005 keeps the agent failed when setup-path session retirement fails", async () => {
    let triggerInstalled = false;
    try {
      const { companyId, agentId } = await seedDirectAgent();
      const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
      const staleDirtyError = "Workspace contains uncommitted or untracked changes.";
      const setupFailure = new Error(staleDirtyError) as Error & {
        code: string;
        resultJson: Record<string, unknown>;
      };
      setupFailure.code = "workspace_validation_failed";
      setupFailure.resultJson = {
        workspaceValidation: { status: "failed", reason: "dirty_workspace" },
        provider_invocation: { attempted: false },
      };
      mockWorkspaceRuntimeState.setupFailure = setupFailure;
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "codex_local",
        stateJson: {},
        lastError: staleDirtyError,
      });
      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "codex_local",
        taskKey: issueId,
        sessionParamsJson: { sessionId: "must-not-survive-clean-retirement" },
        sessionDisplayId: "must-not-survive-clean-retirement",
        lastError: staleDirtyError,
      });
      await db.execute(sql.raw(`
        create or replace function paperclip_test_fail_session_retirement()
        returns trigger language plpgsql as $$
        begin
          raise exception 'injected session retirement failure';
        end;
        $$;
        create trigger paperclip_test_fail_session_retirement
        before delete on agent_task_sessions
        for each row execute function paperclip_test_fail_session_retirement();
      `));
      triggerInstalled = true;

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(
        agentId,
        "automation",
        { issueId, wakeReason: "issue_assigned" },
        "system",
        { actorType: "system", actorId: "test" },
      );
      expect(run).not.toBeNull();
      await waitForTerminalRuns(db, [run!.id]);
      expect(await heartbeat.getRun(run!.id)).toMatchObject({
        status: "failed",
        errorCode: "workspace_validation_failed",
      });
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      await expect.poll(
        () => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]),
      ).toMatchObject({ status: "error", errorReason: expect.stringMatching(/uncommitted|untracked/i) });
      expect(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]))
        .toMatchObject({ lastError: staleDirtyError });
      expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId)))
        .toHaveLength(1);
    } finally {
      if (triggerInstalled) {
        await db.execute(sql.raw("drop trigger if exists paperclip_test_fail_session_retirement on agent_task_sessions"));
        await db.execute(sql.raw("drop function if exists paperclip_test_fail_session_retirement()"));
      }
    }
  });

  it("WG-PLAT-005 keeps the agent failed when runtime lastError changes during guarded retirement", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    const dirtyError = "Workspace contains uncommitted or untracked changes.";
    const concurrentError = "Concurrent provider credential failure";
    mockAdapterState.throwOverride = new WorkspaceValidationFailure(dirtyError, {
      workspaceValidation: { status: "failed", reason: "dirty_workspace" },
      provider_invocation: { attempted: false },
    });
    const heartbeat = heartbeatService(db, {
      dirtyWorkspaceFailureRetirementHooks: {
        afterRuntimeRead: async ({ agentId: retiringAgentId }) => {
          await db.update(agentRuntimeState)
            .set({ lastError: concurrentError, updatedAt: new Date() })
            .where(eq(agentRuntimeState.agentId, retiringAgentId));
        },
      },
    });

    const run = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "failed",
      errorCode: "workspace_validation_failed",
    });
    await expect.poll(
      () => db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]),
    ).toMatchObject({ status: "error", errorReason: dirtyError });
    expect(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId)).then((rows) => rows[0]))
      .toMatchObject({ lastError: concurrentError });
  });

  it("WG-PLAT-007/010 preserves a successful parent when a child opens between preflight and write", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const parentIssueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      executionPolicy: {
        mode: "normal",
        commentRequired: false,
        stages: [],
        completionProfile: "direct",
      },
    }).where(eq(issues.id, parentIssueId));
    const childIssueId = randomUUID();
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      parentId: parentIssueId,
      title: "Open child blocks terminal parent projection",
      description: "This child must close before its parent can be marked done.",
      status: "done",
      priority: "medium",
      responsibleUserId: "operator",
      issueNumber: runnableIssueNumber++,
      identifier: `CHILD-${childIssueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    mockAdapterState.providerTerminalEvidence = true;

    const heartbeat = heartbeatService(db, {
      terminalIssueReconciliationHooks: {
        afterDecisionBeforeProjection: async ({ targetStatus }) => {
          if (targetStatus !== "done") return;
          await db.update(issues)
            .set({ status: "todo", completedAt: null, updatedAt: new Date() })
            .where(eq(issues.id, childIssueId));
        },
      },
    });
    const run = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId: parentIssueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "succeeded",
      contextSnapshot: {
        gloopsTerminalReconciliationPreserve: {
          schemaVersion: "gloops.terminal-reconciliation-preserve.v1",
          reason: "children_not_done",
          runStatus: "succeeded",
          recordedAt: expect.any(String),
        },
      },
    });
    expect(await db.select().from(issues).where(eq(issues.id, parentIssueId)).then((rows) => rows[0]))
      .toMatchObject({ status: "in_progress" });
  });

  it("persists the sanitized ask answer before projecting the issue done", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      workMode: "ask",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        completionProfile: "direct",
      },
    }).where(eq(issues.id, issueId));
    mockAdapterState.providerTerminalEvidence = true;
    mockAdapterState.summaryOverride = "Planning and tool narration.\nAnswer: draft\nFinal answer: Durable Buzz answer.";

    const heartbeat = heartbeatService(db, {
      terminalIssueReconciliationHooks: {
        afterDecisionBeforeProjection: async ({ issueId: projectedIssueId, targetStatus }) => {
          if (projectedIssueId !== issueId || targetStatus !== "done") return;
          const comments = await db.select().from(issueComments)
            .where(eq(issueComments.issueId, issueId));
          expect(comments).toHaveLength(1);
          expect(comments[0]).toMatchObject({ body: "Durable Buzz answer." });
        },
      },
    });
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .toMatchObject({ status: "done", executionRunId: null });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .toMatchObject([{ body: "Durable Buzz answer.", createdByRunId: run!.id }]);
  });

  it("uses an invoked projectless task-bridge ask answer as bounded terminal evidence", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      originKind: "task_bridge",
      originId: randomUUID(),
      workMode: "ask",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        completionProfile: "direct",
        resourceBudget: { maxRunsPerTask: 1, maxRetriesPerTask: 0 },
      },
    }).where(eq(issues.id, issueId));
    mockAdapterState.summaryOverride = "Planning and tool narration.\nFinal answer: SAGE_BRIDGE_CANARY_OK";

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "succeeded",
      resultJson: { providerInvocationAttempted: true },
    });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .toMatchObject({ status: "done", assigneeAgentId: agentId, executionRunId: null });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .toMatchObject([{ body: "SAGE_BRIDGE_CANARY_OK", authorAgentId: agentId, createdByRunId: run!.id }]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .toHaveLength(0);
  });

  it("normalizes an existing same-run task-bridge ask comment to the last final answer", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      originKind: "task_bridge",
      originId: randomUUID(),
      workMode: "ask",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        completionProfile: "direct",
        resourceBudget: { maxRunsPerTask: 1, maxRetriesPerTask: 0 },
      },
    }).where(eq(issues.id, issueId));
    const noisy = "Planning and tool narration.\nAnswer: draft\nFinal answer: SAGE_BRIDGE_NORMALIZED";
    mockAdapterState.summaryOverride = noisy;
    mockAdapterState.beforeReturn = async (runId) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorType: "agent",
        authorAgentId: agentId,
        createdByRunId: runId,
        body: noisy,
      });
    };

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .toMatchObject({ status: "done" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .toMatchObject([{ body: "SAGE_BRIDGE_NORMALIZED", createdByRunId: run!.id }]);
  });

  it.each([
    { label: "ordinary ask", patch: { originKind: "manual", originId: null }, bounded: true },
    { label: "missing bridge key identity", patch: { originKind: "task_bridge", originId: null }, bounded: true },
    { label: "missing one-run budget", patch: { originKind: "task_bridge", originId: randomUUID() }, bounded: false },
  ])("does not relax provider terminal evidence for $label", async ({ patch, bounded }) => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      ...patch,
      workMode: "ask",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        completionProfile: "direct",
        ...(bounded ? { resourceBudget: { maxRunsPerTask: 1, maxRetriesPerTask: 0 } } : {}),
      },
    }).where(eq(issues.id, issueId));
    mockAdapterState.summaryOverride = "Final answer: MUST_NOT_AUTHORIZE";

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .not.toMatchObject({ status: "done" });
  });

  it("does not trust a task-bridge ask answer when provider invocation was not attempted", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      originKind: "task_bridge",
      originId: randomUUID(),
      workMode: "ask",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        completionProfile: "direct",
        resourceBudget: { maxRunsPerTask: 1, maxRetriesPerTask: 0 },
      },
    }).where(eq(issues.id, issueId));
    mockAdapterState.resultOverride = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      providerInvocationAttempted: false,
      summary: "Final answer: MUST_NOT_AUTHORIZE",
      provider: "test",
      model: "test-model",
    };

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      resultJson: { providerInvocationAttempted: false },
    });
    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .not.toMatchObject({ status: "done" });
  });

  it("does not trust a task-bridge ask answer attached to a parent execution", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const parentId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "in_progress" });
    const issueId = await seedRunnableAdmissionIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({
      parentId,
      originKind: "task_bridge",
      originId: randomUUID(),
      workMode: "ask",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        completionProfile: "direct",
        resourceBudget: { maxRunsPerTask: 1, maxRetriesPerTask: 0 },
      },
    }).where(eq(issues.id, issueId));
    mockAdapterState.summaryOverride = "Final answer: MUST_NOT_AUTHORIZE";

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    await heartbeat.waitForRunExecutionDrain(run!.id);

    expect(await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .not.toMatchObject({ status: "done" });
  });

  async function seedIssueBudgetHistory(input: {
    companyId: string;
    agentId: string;
    priorRunCount: 1 | 2;
    resourceBudget?: { maxRunsPerTask: number; maxRetriesPerTask: number };
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Recover workspace validation without admission thrash",
      description: "## Scope\nRestore the verified workspace.\n\n## Acceptance\nThe return owner can resume once.",
      status: "in_progress",
      priority: "high",
      responsibleUserId: "operator",
      assigneeAgentId: input.agentId,
      issueNumber: 1,
      identifier: `REC-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: false,
        stages: [],
        ...(input.resourceBudget ? { resourceBudget: input.resourceBudget } : {}),
      },
    });
    const policy = parseExecutionAdmissionPolicy({
      ...process.env,
      ...(input.resourceBudget
        ? {
            PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: String(input.resourceBudget.maxRunsPerTask),
            PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: String(input.resourceBudget.maxRetriesPerTask),
          }
        : {}),
    });
    if (!policy.enabled) throw new Error("expected enabled execution policy");
    const priorRuns: Array<{ retryOfRunId: string | null }> = [];
    for (let index = 0; index < input.priorRunCount; index += 1) {
      const runId = randomUUID();
      const decision = evaluateExecutionAdmission(
        policy,
        priorRuns,
        index === 0 ? {} : { isAuthorizedIndependentStage: true },
      );
      const envelope = buildExecutionAdmissionEnvelope({
        identity: { budgetId: `issue:${issueId}:default`, epoch: "default" },
        policy,
        decision,
        evaluatedAt: new Date(`2026-08-01T00:00:0${index}Z`),
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        startedAt: new Date(`2026-08-01T00:00:0${index}Z`),
        finishedAt: new Date(`2026-08-01T00:00:1${index}Z`),
        usageJson: { inputTokens: 1_000, outputTokens: 100, providerInvocationAttempted: true },
        contextSnapshot: {
          issueId,
          skipIssueComment: true,
          [EXECUTION_ADMISSION_CONTEXT_KEY]: envelope,
        },
      });
      priorRuns.push({ retryOfRunId: null });
    }
    return issueId;
  }

  it.each([
    "issue_recovery_action_restored",
    "issue_status_changed",
    "issue_checked_out",
    "issue_assigned",
  ])("admits bounded %s re-entry after a counted run", async (wakeReason) => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedIssueBudgetHistory({ companyId, agentId, priorRunCount: 1 });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, wakeReason, skipIssueComment: true },
      "system",
      { actorType: "system", actorId: "recovery" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.contextSnapshot).toMatchObject({
      [EXECUTION_ADMISSION_CONTEXT_KEY]: {
        decision: "allowed",
        reason: null,
        observed: { runCount: 1, retryCount: 0 },
      },
    });
  });

  it("durably counts sibling lifecycle re-entry against the retry ceiling", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedIssueBudgetHistory({
      companyId,
      agentId,
      priorRunCount: 1,
      resourceBudget: { maxRunsPerTask: 3, maxRetriesPerTask: 1 },
    });
    const heartbeat = heartbeatService(db);
    const restored = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, wakeReason: "issue_recovery_action_restored", skipIssueComment: true },
      "system",
      { actorType: "system", actorId: "recovery" },
    );
    expect(restored).not.toBeNull();
    await waitForTerminalRuns(db, [restored!.id]);
    expect((await heartbeat.getRun(restored!.id))?.status).toBe("succeeded");

    const statusWake = await heartbeat.invoke(
      agentId,
      "automation",
      { issueId, wakeReason: "issue_status_changed", skipIssueComment: true },
      "system",
      { actorType: "system", actorId: "recovery" },
    );
    expect(statusWake).not.toBeNull();
    await waitForTerminalRuns(db, [statusWake!.id]);
    expect(await heartbeat.getRun(statusWake!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "execution_admission.retry_limit_exhausted",
      contextSnapshot: {
        [EXECUTION_ADMISSION_CONTEXT_KEY]: {
          observed: { runCount: 2, retryCount: 1 },
        },
      },
    });
  });

  it("admits a verified issue comment as an independent interaction stage", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedIssueBudgetHistory({ companyId, agentId, priorRunCount: 1 });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "operator",
      body: "Continue with this new board input.",
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment" },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
        skipIssueComment: true,
      },
      requestedByActorType: "user",
      requestedByActorId: "operator",
    });
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "succeeded",
      contextSnapshot: {
        [EXECUTION_ADMISSION_CONTEXT_KEY]: {
          decision: "allowed",
          observed: { runCount: 1, retryCount: 0 },
        },
      },
    });
  });

  it("does not admit a replayed comment from an unrelated wake actor", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = await seedIssueBudgetHistory({ companyId, agentId, priorRunCount: 1 });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "board-author",
      body: "Old board input must not authorize an unrelated wake.",
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment" },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        commentId,
        wakeCommentId: commentId,
        source: "issue.comment",
        skipIssueComment: true,
      },
      requestedByActorType: "user",
      requestedByActorId: "unrelated-user",
    });
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "execution_admission.retry_limit_exhausted",
    });
  });

  it("clears a stale dirty-workspace agent error when restored re-entry is budget-denied", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    await db.update(agents).set({
      status: "error",
      errorReason: "Workspace contains uncommitted or untracked changes.",
    }).where(eq(agents.id, agentId));
    const issueId = await seedIssueBudgetHistory({ companyId, agentId, priorRunCount: 2 });
    const recoveryActionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "resolved",
      cause: "workspace_validation_failed",
      fingerprint: `workspace:${issueId}`,
      nextAction: "Restore the workspace.",
      outcome: "restored",
      resolvedAt: new Date(),
    });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "automation",
      {
        issueId,
        wakeReason: "issue_recovery_action_restored",
        recoveryActionId,
        recoveryCause: "workspace_validation_failed",
        skipIssueComment: true,
      },
      "system",
      { actorType: "system", actorId: "recovery" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    expect((await heartbeat.getRun(run!.id))?.errorCode).toBe("execution_admission.run_limit_exhausted");
    const [persistedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(persistedAgent).toMatchObject({ status: "idle", errorReason: null });
  });

  it("does not clear a dirty-workspace agent error from unverified restore metadata", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    await db.update(agents).set({
      status: "error",
      errorReason: "Workspace contains uncommitted or untracked changes.",
    }).where(eq(agents.id, agentId));
    const issueId = await seedIssueBudgetHistory({ companyId, agentId, priorRunCount: 2 });
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "automation",
      {
        issueId,
        wakeReason: "issue_recovery_action_restored",
        recoveryActionId: randomUUID(),
        recoveryCause: "workspace_validation_failed",
        skipIssueComment: true,
      },
      "system",
      { actorType: "system", actorId: "recovery" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const [persistedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(persistedAgent).toMatchObject({
      status: "error",
      errorReason: "Workspace contains uncommitted or untracked changes.",
    });
  });

  it("admits a guarded reset run under a fresh claim-time budget epoch", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const resetId = "board-reset-claim-e2e";

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Admission reset integration",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Current checkout",
      sourceType: "local_path",
      cwd: existsSync(path.join(process.cwd(), ".git"))
        ? process.cwd()
        : path.resolve(process.cwd(), ".."),
      repoUrl: "https://github.com/gloopsAI/paperclip.git",
      defaultRef: "gloops/stable",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Resume exhausted execution admission",
      description: "Prove the guarded reset reaches claim-time admission under a fresh epoch.",
      status: "in_progress",
      priority: "high",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `RESET-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: false,
        stages: [],
      },
    });

    const policy = parseExecutionAdmissionPolicy(process.env);
    if (!policy.enabled) throw new Error("expected enabled execution policy");
    const exhaustedDecision = evaluateExecutionAdmission(policy, [{ retryOfRunId: null }]);
    expect(exhaustedDecision).toMatchObject({ allowed: false, reason: "retry_limit_exhausted" });
    const exhaustedEnvelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: `issue:${issueId}:default`, epoch: "default" },
      policy,
      decision: exhaustedDecision,
      evaluatedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      responsibleUserId: "operator",
      finishedAt: new Date("2026-08-01T00:00:00Z"),
      errorCode: "execution_admission.retry_limit_exhausted",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        [EXECUTION_ADMISSION_CONTEXT_KEY]: exhaustedEnvelope,
      },
    });

    const reset = await guardedAdmissionResetService(db).resetExhaustedAdmissionAndCheckout({
      issueId,
      companyId,
      agentId,
      resetId,
      requestedByUserId: "board-user",
    });
    expect(reset.created).toBe(true);
    expect(reset.run).toMatchObject({
      status: "queued",
      contextSnapshot: {
        [EXECUTION_ADMISSION_RESET_CONTEXT_KEY]: resetId,
      },
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await waitForTerminalRuns(db, [reset.run.id]);

    const persisted = await heartbeat.getRun(reset.run.id);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.contextSnapshot).toMatchObject({
      [EXECUTION_ADMISSION_RESET_CONTEXT_KEY]: resetId,
      [EXECUTION_ADMISSION_CONTEXT_KEY]: {
        budgetId: `issue:${issueId}:${resetId}`,
        epoch: resetId,
        attempt: 1,
        decision: "allowed",
        reason: null,
        observed: { runCount: 0, retryCount: 0 },
      },
    });
  });

  it("refuses an adapter that cannot enforce the provider reservation", async () => {
    mockAdapterState.supportsBudget = false;
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(persisted?.status).toBe("failed");
    expect(persisted?.errorCode).toBe("execution_admission.adapter_budget_unsupported");
  });

  it("runs an explicitly allowlisted CLI adapter in reconciled mode", async () => {
    process.env.PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS = "codex_local";
    mockAdapterState.supportsBudget = false;
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({
      executionBudget: null,
    }));
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.usageJson).toMatchObject({
      executionReservation: {
        enforcementMode: "reconciled",
        compliant: true,
        exceeded: [],
      },
    });
  });

  it("persists normalized execution route with terminal usage evidence", async () => {
    mockAdapterState.resultOverride = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Measured subscription run.",
      provider: "ollama-cloud",
      model: "kimi-k2.7-code",
      usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 },
      resultJson: {
        execution_metrics: { turns: 1, tool_calls: 0 },
        execution_route: {
          provider_id: "ollama",
          observed_provider_id: "ollama-cloud",
          model_id: "kimi-k2.7-code",
          transport: "api",
          transport_class: "openai_chat_completions",
          path_id: "ollama-cloud",
          runner: "hermes_gateway",
          subscription_class: "ollama-max",
          billing_class: "subscription_included",
          routing_reason: "capacity-manager-ollama-first",
          fallback_occurred: false,
          execution_profile: "paperclip-execution-only",
        },
      },
    };
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.usageJson).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
      executionRoute: {
        provider_id: "ollama",
        observed_provider_id: "ollama-cloud",
        model_id: "kimi-k2.7-code",
        transport: "api",
        path_id: "ollama-cloud",
        runner: "hermes_gateway",
        subscription_class: "ollama-max",
        billing_class: "subscription_included",
        routing_reason: "capacity-manager-ollama-first",
        fallback_occurred: false,
        execution_profile: "paperclip-execution-only",
      },
    });
  });

  it("uses conservative turn and tool defaults when an issue has no explicit budget", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Default coding envelope",
      status: "todo",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `DEF-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({
      executionBudget: expect.objectContaining({
        maxTurns: 8,
        maxToolCalls: 32,
      }),
    }));
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.contextSnapshot).toMatchObject({
      gloopsExecutionAdmission: {
        reservation: {
          maxTurns: 8,
          maxToolCalls: 32,
        },
      },
    });
  });

  it("passes the computed work-preparation receipt to the adapter execution context", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Answer a repository-free product question",
      status: "todo",
      workMode: "ask",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `ASK-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        paperclipWorkPreparation: expect.objectContaining({
          decision: "ready",
          implementation: false,
          workspace: expect.objectContaining({
            required: false,
          }),
        }),
      }),
    }));
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.contextSnapshot).toMatchObject({
      paperclipWorkPreparation: {
        decision: "ready",
        implementation: false,
        workspace: {
          required: false,
        },
      },
    });
  });

  it("passes a larger explicit coding envelope through claim-time admission to the adapter", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Explicit coding envelope",
      status: "todo",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `BUD-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        resourceBudget: {
          maxRunsPerTask: 1,
          maxRetriesPerTask: 0,
          maxTurnsPerInvocation: 20,
          maxToolCallsPerInvocation: 60,
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({
      executionBudget: expect.objectContaining({
        maxTurns: 20,
        maxToolCalls: 60,
      }),
    }));
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.contextSnapshot).toMatchObject({
      gloopsExecutionAdmission: {
        reservation: {
          maxTurns: 20,
          maxToolCalls: 60,
        },
      },
    });
  });

  it("persists the fixed-overhead split and carries an executable bootstrap envelope", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bootstrap token-efficiency evaluation",
      status: "todo",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `BOOT-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        resourceBudget: {
          executionClass: "bootstrap",
          fixedOverheadInputTokens: 200,
        },
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);

    expect(mockAdapterExecute).toHaveBeenCalledWith(expect.objectContaining({
      executionBudget: expect.objectContaining({
        fixedOverheadInputTokens: 200,
        maxInputTokens: 180_200,
        maxTurns: 25,
        maxToolCalls: 45,
      }),
    }));
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.usageJson).toMatchObject({
      inputTokens: 1_000,
      fixedOverheadInputTokens: 200,
      discretionaryInputTokens: 800,
    });
    expect(persisted?.contextSnapshot).toMatchObject({
      gloopsExecutionAdmission: {
        policy: {
          executionClass: "bootstrap",
          maxRunsPerTask: 2,
          maxRetriesPerTask: 1,
        },
      },
    });
  });

  it("pessimistically settles missing usage from a reconciled CLI adapter", async () => {
    process.env.PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS = "codex_local";
    mockAdapterState.supportsBudget = false;
    mockAdapterState.includeUsage = false;
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.errorCode).toBe("execution_admission.usage_missing");
    expect(persisted?.usageJson).toMatchObject({
      inputTokens: 30_000,
      outputTokens: 5_000,
      usageSource: "reservation_fallback",
      executionReservation: {
        enforcementMode: "reconciled",
        compliant: false,
        exceeded: ["usage_missing"],
      },
    });
  });

  it("fails a reconciled CLI adapter after reported reservation overage", async () => {
    process.env.PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS = "codex_local";
    mockAdapterState.supportsBudget = false;
    mockAdapterState.resultOverride = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "test",
      model: "test-model",
      usage: { inputTokens: 30_001, cachedInputTokens: 0, outputTokens: 100 },
    };
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.errorCode).toBe("execution_admission.reservation_exceeded");
    expect(persisted?.usageJson).toMatchObject({
      executionReservation: {
        enforcementMode: "reconciled",
        compliant: false,
        exceeded: ["input_tokens"],
      },
    });
  });

  it("records Ollama Cloud reservation overage without failing completed work", async () => {
    mockAdapterState.resultOverride = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "ollama-cloud",
      model: "qwen3-coder",
      usage: { inputTokens: 1_000_001, cachedInputTokens: 0, outputTokens: 100 },
    };
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);

    expect(persisted?.status).toBe("succeeded");
    expect(persisted?.errorCode).toBeNull();
    expect(persisted?.usageJson).toMatchObject({
      executionReservation: {
        enforcementMode: "strict",
        compliant: false,
        exceeded: ["input_tokens"],
        advisoryOnly: true,
      },
    });
  });

  it("fails closed when a supported adapter completes without usage reconciliation", async () => {
    mockAdapterState.includeUsage = false;
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.errorCode).toBe("execution_admission.usage_missing");
    expect(persisted?.usageJson).toMatchObject({
      inputTokens: 30_000,
      cachedInputTokens: 0,
      outputTokens: 5_000,
      usageSource: "reservation_fallback",
    });
  });

  it("preserves a provider failure while conservatively settling missing usage", async () => {
    mockAdapterState.resultOverride = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_run_failed",
      errorMessage: "Hermes failed before returning usage",
      providerInvocationAttempted: true,
      provider: "hermes_gateway",
    };
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.errorCode).toBe("hermes_gateway_run_failed");
    expect(persisted?.usageJson).toMatchObject({
      inputTokens: 30_000,
      outputTokens: 5_000,
      usageSource: "reservation_fallback",
      providerInvocationAttempted: true,
    });
  });

  it("records deterministic pre-dispatch refusal as zero use without reservation fallback", async () => {
    mockAdapterState.resultOverride = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "workspace_validation_failed",
      errorMessage: "Workspace head is stale",
      providerInvocationAttempted: false,
      provider: "hermes_gateway",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      usageBasis: "per_run",
    };
    const { agentId } = await seedDirectAgent();
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.errorCode).toBe("workspace_validation_failed");
    expect(persisted?.usageJson).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      usageSource: "per_run",
      providerInvocationAttempted: false,
      fixedOverheadInputTokens: 0,
      discretionaryInputTokens: 0,
    });
  });

  it("stops unchanged pre-provider retries before a second adapter call and caps remediation", async () => {
    mockAdapterState.resultOverride = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "hermes_gateway_auth_failed",
      errorMessage: "Managed provider identity is unavailable",
      providerInvocationAttempted: false,
      provider: "hermes_gateway",
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      usageBasis: "per_run",
    };
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-provider stop-loss",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `STOP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(first).not.toBeNull();
    await waitForTerminalRuns(db, [first!.id]);
    await heartbeat.waitForRunExecutionDrain(first!.id);

    const second = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(second).not.toBeNull();
    await waitForTerminalRuns(db, [second!.id]);
    await heartbeat.waitForRunExecutionDrain(second!.id);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(await heartbeat.getRun(second!.id)).toMatchObject({
      status: "failed",
      errorCode: "execution_admission.pre_provider_state_unchanged",
      contextSnapshot: {
        gloopsPreProviderStopLoss: {
          decision: "denied",
          reason: "state_unchanged",
        },
      },
      resultJson: {
        providerInvocationAttempted: false,
        preProviderFailure: {
          schemaVersion: "gloops.pre-provider-failure.v1",
          errorCode: "execution_admission.pre_provider_state_unchanged",
        },
      },
    });

    const third = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(third).not.toBeNull();
    await waitForTerminalRuns(db, [third!.id]);
    expect(await heartbeat.getRun(third!.id)).toMatchObject({
      status: "cancelled",
      errorCode: "execution_admission.pre_provider_failure_limit_exhausted",
    });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("releases the admission reservation for a pre-model workspace preparation failure", async () => {
    const { companyId, agentId } = await seedDirectAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Workspace preparation failed before dispatch",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `PREP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const parsedPolicy = parseExecutionAdmissionPolicy(process.env);
    if (!parsedPolicy.enabled) throw new Error("expected enabled execution policy");
    const failedSetupEnvelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: `issue:${issueId}:default`, epoch: "default" },
      policy: parsedPolicy,
      decision: evaluateExecutionAdmission(parsedPolicy, []),
      evaluatedAt: new Date("2026-07-24T00:00:00Z"),
    });
    // A stale-base-clone worktree failure: the run died in setup with no
    // usage row, before any provider invocation.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      errorCode: "workspace_preparation_failed",
      error: "Cannot resolve base ref \"fix/hermes-supervisor-reconciliation\" to a commit",
      startedAt: new Date("2026-07-24T00:00:00Z"),
      finishedAt: new Date("2026-07-24T00:00:05Z"),
      usageJson: null,
      resultJson: {
        provider_invocation: { attempted: false },
        workspacePreparation: { reason: "base_ref_unresolvable" },
      },
      contextSnapshot: {
        issueId,
        skipIssueComment: true,
        gloopsExecutionAdmission: failedSetupEnvelope,
      },
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
      { actorType: "system", actorId: "test" },
    );
    expect(run).not.toBeNull();
    await waitForTerminalRuns(db, [run!.id]);
    const persisted = await heartbeat.getRun(run!.id);
    expect(persisted?.status).toBe("succeeded");
    // The setup failure neither consumed the run/retry attempt nor charged
    // the 30k/5k reservation fallback against the task budget.
    expect(persisted?.contextSnapshot).toMatchObject({
      gloopsExecutionAdmission: {
        attempt: 1,
        decision: "allowed",
        reason: null,
        observed: {
          runCount: 0,
          retryCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          preflightExemptRunCount: 1,
        },
        reservation: {
          maxInputTokens: 30_000,
          maxOutputTokens: 5_000,
        },
      },
    });
  });

  it("creates no recovery run when a one-run task fails", async () => {
    const previousMaxRuns = process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK;
    const previousMaxRetries = process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK;
    process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = "1";
    process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = "0";
    try {
      mockAdapterState.resultOverride = {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "hermes_gateway_run_failed",
        errorMessage: "Hermes failed",
        providerInvocationAttempted: true,
        provider: "hermes_gateway",
      };
      const { companyId, agentId } = await seedDirectAgent();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "One run only",
        status: "todo",
        priority: "medium",
        responsibleUserId: "operator",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `ONE-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(
        agentId,
        "assignment",
        { issueId, wakeReason: "issue_assigned" },
        "system",
        { actorType: "system", actorId: "test" },
      );
      expect(run).not.toBeNull();
      await waitForTerminalRuns(db, [run!.id]);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const companyRuns = await db.select().from(heartbeatRuns);
      const issueRuns = companyRuns.filter((row) =>
        row.companyId === companyId &&
        (row.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId,
      );
      expect(issueRuns.map((row) => ({
        id: row.id,
        status: row.status,
        retryOfRunId: row.retryOfRunId,
        errorCode: row.errorCode,
        invocationSource: row.invocationSource,
        contextSnapshot: row.contextSnapshot,
      }))).toEqual([expect.objectContaining({ id: run!.id })]);
      const issue = (await db.select().from(issues)).find((row) => row.id === issueId);
      expect(issue).toMatchObject({ status: "blocked", executionRunId: null });
      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ createdByRunId: run!.id, authorType: "system" });

      await heartbeat.reconcileStrandedAssignedIssues();
      const commentsAfterReconciliation = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(commentsAfterReconciliation).toHaveLength(1);
    } finally {
      process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = previousMaxRuns;
      process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = previousMaxRetries;
    }
  });

  it("invokes the initial run when the task permits zero retries", async () => {
    const previousMaxRuns = process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK;
    const previousMaxRetries = process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK;
    process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = "1";
    process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = "0";
    try {
      const { agentId } = await seedDirectAgent();
      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      await waitForTerminalRuns(db, [run!.id]);
      const persisted = await heartbeat.getRun(run!.id);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      expect(persisted?.status).toBe("succeeded");
      expect(persisted?.contextSnapshot).toMatchObject({
        gloopsExecutionAdmission: {
          attempt: 1,
          decision: "allowed",
          reason: null,
          observed: { runCount: 0, retryCount: 0 },
        },
      });
    } finally {
      process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = previousMaxRuns;
      process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = previousMaxRetries;
    }
  });

  it("admits a second independent stage while zero retries remain enforced", async () => {
    const previousMaxRuns = process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK;
    const previousMaxRetries = process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK;
    process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = "2";
    process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = "0";
    try {
      const { companyId, agentId } = await seedDirectAgent();
      const issueId = randomUUID();
      const parentRunId = randomUUID();
      const reviewStageId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Independent review stage",
        status: "in_review",
        priority: "medium",
        responsibleUserId: "operator",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `STAGE-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        executionPolicy: {
          mode: "normal",
          commentRequired: false,
          stages: [{
            id: reviewStageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ type: "agent", agentId }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          returnAssignee: { type: "agent", agentId },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
        },
      });
      const parsedPolicy = parseExecutionAdmissionPolicy(process.env);
      if (!parsedPolicy.enabled) throw new Error("expected enabled execution policy");
      const parentEnvelope = buildExecutionAdmissionEnvelope({
        identity: { budgetId: `issue:${issueId}:default`, epoch: "default" },
        policy: parsedPolicy,
        decision: evaluateExecutionAdmission(parsedPolicy, []),
        evaluatedAt: new Date("2026-07-13T00:00:00Z"),
      });
      await db.insert(heartbeatRuns).values({
        id: parentRunId,
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date("2026-07-13T00:00:00Z"),
        finishedAt: new Date("2026-07-13T00:00:01Z"),
        usageJson: { inputTokens: 1_000, outputTokens: 100 },
        contextSnapshot: {
          issueId,
          skipIssueComment: true,
          gloopsExecutionAdmission: parentEnvelope,
        },
      });

      const stageRunId = randomUUID();
      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "execution_review_requested",
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "workflow",
        runId: stageRunId,
      });
      await db.insert(heartbeatRuns).values({
        id: stageRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        triggerDetail: "system",
        retryOfRunId: null,
        wakeupRequestId,
        contextSnapshot: {
          issueId,
          skipIssueComment: true,
          wakeReason: "execution_review_requested",
          source: "issue.execution_stage",
          executionStage: {
            wakeRole: "reviewer",
            stageId: reviewStageId,
            stageType: "review",
            currentParticipant: { type: "agent", agentId },
            returnAssignee: { type: "agent", agentId },
            reviewRequest: null,
            lastDecisionOutcome: null,
            allowedActions: ["approve", "request_changes"],
          },
        },
      });

      await heartbeatService(db).resumeQueuedRuns();
      await waitForTerminalRuns(db, [stageRunId]);
      const persisted = await heartbeatService(db).getRun(stageRunId);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      expect(persisted?.status).toBe("succeeded");
      expect(persisted?.contextSnapshot).toMatchObject({
        gloopsExecutionAdmission: {
          attempt: 2,
          decision: "allowed",
          reason: null,
          observed: { runCount: 1, retryCount: 0 },
        },
      });
    } finally {
      process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = previousMaxRuns;
      process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = previousMaxRetries;
    }
  });

  it("denies a direct retry whose legacy parent has no admission envelope", async () => {
    const previousMaxRuns = process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK;
    const previousMaxRetries = process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK;
    process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = "1";
    process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = "0";
    try {
      const { companyId, agentId } = await seedDirectAgent();
      const parentRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: parentRunId,
        companyId,
        agentId,
        status: "succeeded",
        startedAt: new Date("2026-07-13T00:00:00Z"),
        finishedAt: new Date("2026-07-13T00:00:01Z"),
        contextSnapshot: {},
      });

      const retryRunId = randomUUID();
      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "legacy_parent_retry",
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "recovery",
        runId: retryRunId,
      });
      await db.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        triggerDetail: "system",
        retryOfRunId: parentRunId,
        wakeupRequestId,
        contextSnapshot: { wakeReason: "legacy_parent_retry" },
      });

      await heartbeatService(db).resumeQueuedRuns();
      await waitForTerminalRuns(db, [retryRunId]);
      const persisted = await heartbeatService(db).getRun(retryRunId);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect(persisted?.status).toBe("cancelled");
      expect(persisted?.errorCode).toBe("execution_admission.run_limit_exhausted");
      expect(persisted?.contextSnapshot).toMatchObject({
        gloopsExecutionAdmission: {
          attempt: 2,
          decision: "denied",
          observed: { runCount: 1, retryCount: 0 },
        },
      });
    } finally {
      process.env.PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK = previousMaxRuns;
      process.env.PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK = previousMaxRetries;
    }
  });
});
