import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
  repositoryMutationReceipts,
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

const mockAdapterState = vi.hoisted(() => ({
  supportsBudget: true,
  includeUsage: true,
  resultOverride: null as Record<string, unknown> | null,
}));
const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => mockAdapterState.resultOverride ?? ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Execution admission integration run.",
  provider: "test",
  model: "test-model",
  ...(mockAdapterState.includeUsage
    ? { usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 100 } }
    : {}),
})));

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

  async function seedExhaustedIssue(input: {
    terminalSuccess?: boolean;
    liveRun?: boolean;
    reconciledMutation?: boolean;
    executionAdmission?: Record<string, unknown> | null;
  } = {}) {
    const { companyId, agentId } = await seedDirectAgent();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const exhaustedRunId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reset exhausted admission project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Reset exhausted admission workspace",
      sourceType: "git",
      repoUrl: "https://github.com/gloopsAI/paperclip.git",
      repoRef: "gloops/stable",
      defaultRef: "gloops/stable",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Reset exhausted admission fixture",
      status: "blocked",
      priority: "medium",
      responsibleUserId: "operator",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `RST-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [] },
    });
    await db.insert(heartbeatRuns).values({
      id: exhaustedRunId,
      companyId,
      agentId,
      status: input.terminalSuccess ? "succeeded" : "cancelled",
      startedAt: new Date(),
      finishedAt: new Date(),
      errorCode: input.terminalSuccess ? null : "execution_admission.retry_limit_exhausted",
      contextSnapshot: {
        issueId,
        ...(input.executionAdmission === null
          ? {}
          : {
              gloopsExecutionAdmission: input.executionAdmission ?? {
                budgetId: `issue:${issueId}:default`,
                epoch: "default",
                decision: input.terminalSuccess ? "allowed" : "denied",
                reason: input.terminalSuccess ? null : "retry_limit_exhausted",
              },
            }),
      },
    });
    if (input.reconciledMutation) {
      await db.insert(repositoryMutationReceipts).values({
        schemaVersion: "gloops.repository-mutation-receipt.v1",
        companyId,
        agentId,
        heartbeatRunId: exhaustedRunId,
        issueId,
        projectId,
        projectWorkspaceId,
        repositoryId: "1297008772",
        repositoryFullName: "gloopsAI/paperclip",
        defaultBranch: "gloops/stable",
        branchRef: `refs/heads/bootstrap/${issueId}`,
        mutationClass: "create_one_branch_ref",
        rootAuthorizationDigest: `sha256:${"a".repeat(64)}`,
        leaseDigest: `sha256:${"b".repeat(64)}`,
        nonce: "c".repeat(64),
        expectedOldOid: "0".repeat(40),
        expectedNewOid: "d".repeat(40),
        state: "reconciled_success",
        brokerReceiptDigest: `sha256:${"e".repeat(64)}`,
        remoteOldOid: "0".repeat(40),
        remoteNewOid: "d".repeat(40),
        receipt: { fixture: "reconciled-success" },
        preparedAt: new Date(),
        terminalAt: new Date(),
      });
    }
    if (input.liveRun) {
      const liveRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveRunId,
        companyId,
        agentId,
        status: "queued",
        contextSnapshot: { issueId },
      });
      await db.update(issues).set({ executionRunId: liveRunId }).where(eq(issues.id, issueId));
    }
    return { companyId, agentId, issueId, exhaustedRunId, projectWorkspaceId };
  }

  function resetCheckoutOptions(issueId: string, expectedStatuses = ["blocked"]) {
    return {
      source: "on_demand" as const,
      triggerDetail: "manual" as const,
      reason: "reset_exhausted_admission_and_checkout",
      payload: { issueId },
      idempotencyKey: `reset-${issueId}`,
      requestedByActorType: "user" as const,
      requestedByActorId: "operator",
      contextSnapshot: {
        issueId,
        gloopsExecutionBudgetResetId: "bootstrap-reset-v1",
      },
      resetExhaustedIssueCheckout: { expectedStatuses },
    };
  }

  it("creates exactly one fresh issue-bound run for an exhausted epoch and preserves history", async () => {
    const { agentId, issueId, exhaustedRunId, projectWorkspaceId } = await seedExhaustedIssue();
    const heartbeat = heartbeatService(db);
    const [first, replay] = await Promise.all([
      heartbeat.wakeup(agentId, resetCheckoutOptions(issueId)),
      heartbeat.wakeup(agentId, resetCheckoutOptions(issueId)),
    ]);

    expect(first?.id).toBeTruthy();
    expect(replay?.id).toBe(first?.id);
    expect(first?.contextSnapshot?.issueId).toBe(issueId);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.checkoutRunId).toBe(first?.id);
    // enqueueWakeup immediately hands the run to claimQueuedRun. The reset
    // transaction stamps only checkoutRunId; by the time this public API call
    // returns, a successful claim may legitimately have acquired execution.
    expect(issue?.executionRunId === null || issue?.executionRunId === first?.id).toBe(true);
    expect(issue?.projectWorkspaceId).toBe(projectWorkspaceId);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, issue!.companyId));
    expect(runs.some((run) => run.id === exhaustedRunId)).toBe(true);
    expect(runs.filter((run) => run.contextSnapshot?.issueId === issueId)).toHaveLength(2);
  });

  it("denies reset checkout when terminal success or a live issue execution exists", async () => {
    const terminal = await seedExhaustedIssue({ terminalSuccess: true });
    const live = await seedExhaustedIssue({ liveRun: true });
    const terminalIssue = await seedExhaustedIssue();
    const heartbeat = heartbeatService(db);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, terminalIssue.issueId));

    await expect(heartbeat.wakeup(terminal.agentId, resetCheckoutOptions(terminal.issueId)))
      .rejects.toMatchObject({ status: 409 });
    await expect(heartbeat.wakeup(live.agentId, resetCheckoutOptions(live.issueId)))
      .rejects.toMatchObject({ status: 409 });
    await expect(heartbeat.wakeup(terminalIssue.agentId, resetCheckoutOptions(terminalIssue.issueId, ["done"])))
      .rejects.toMatchObject({ status: 409 });
  });

  it("denies reset checkout when a reconciled repository mutation receipt exists", async () => {
    const fixture = await seedExhaustedIssue({ reconciledMutation: true });
    await expect(heartbeatService(db).wakeup(fixture.agentId, resetCheckoutOptions(fixture.issueId)))
      .rejects.toMatchObject({ status: 409 });
  });

  it("fails closed unless the exact default epoch denial envelope proves exhaustion", async () => {
    const missing = await seedExhaustedIssue({ executionAdmission: null });
    const malformed = await seedExhaustedIssue({
      executionAdmission: {
        budgetId: `issue:${randomUUID()}:default`,
        epoch: "default",
        decision: "denied",
        reason: "retry_limit_exhausted",
      },
    });
    const heartbeat = heartbeatService(db);

    await expect(heartbeat.wakeup(missing.agentId, resetCheckoutOptions(missing.issueId)))
      .rejects.toMatchObject({ status: 409 });
    await expect(heartbeat.wakeup(malformed.agentId, resetCheckoutOptions(malformed.issueId)))
      .rejects.toMatchObject({ status: 409 });
  });

  it("denies reset checkout that would change the assigned agent", async () => {
    const fixture = await seedExhaustedIssue();
    const alternateAgentId = randomUUID();
    await db.insert(agents).values({
      id: alternateAgentId,
      companyId: fixture.companyId,
      name: "Alternate reset agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await expect(heartbeatService(db).wakeup(alternateAgentId, resetCheckoutOptions(fixture.issueId)))
      .rejects.toMatchObject({ status: 409 });
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
