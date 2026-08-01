import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupIdempotency,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  repositoryMutationReceipts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  EXECUTION_ADMISSION_CONTEXT_KEY,
  EXECUTION_ADMISSION_RESET_CONTEXT_KEY,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionAdmission,
  parseExecutionAdmissionPolicy,
} from "../services/execution-admission.js";
import { guardedAdmissionResetService } from "../services/guarded-admission-reset.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres guarded admission-reset tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const enabledEnv = {
  PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
  PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "2",
  PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "1",
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000",
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200",
  PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "60000",
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "400",
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "100",
  PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "6",
  PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "24",
};

function admissionPolicy() {
  const parsed = parseExecutionAdmissionPolicy(enabledEnv);
  if (!parsed.enabled) throw new Error("expected execution admission to be enabled");
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describeEmbeddedPostgres("guarded exhausted-admission reset and checkout", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guarded-admission-reset-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(repositoryMutationReceipts);
    await db.delete(activityLog);
    await db.delete(agentWakeupIdempotency);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { exhausted?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const responsibleUserId = "responsible-user";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: responsibleUserId,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RepairWorker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Control plane",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/workspace/paperclip",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      defaultRef: "master",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Repair admission liveness",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId,
    });

    let exhaustedRunId: string | null = null;
    if (options.exhausted !== false) {
      const policy = admissionPolicy();
      const decision = evaluateExecutionAdmission(policy, [{ retryOfRunId: null }]);
      expect(decision).toMatchObject({ allowed: false, reason: "retry_limit_exhausted" });
      const envelope = buildExecutionAdmissionEnvelope({
        identity: { budgetId: `issue:${issueId}:default`, epoch: "default" },
        policy,
        decision,
        evaluatedAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      exhaustedRunId = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "cancelled",
          responsibleUserId,
          finishedAt: new Date("2026-08-01T00:00:00.000Z"),
          errorCode: "execution_admission.retry_limit_exhausted",
          contextSnapshot: {
            issueId,
            taskId: issueId,
            [EXECUTION_ADMISSION_CONTEXT_KEY]: envelope,
          },
        })
        .returning({ id: heartbeatRuns.id })
        .then((rows) => rows[0]!.id);
    }

    return {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      issueId,
      responsibleUserId,
      exhaustedRunId,
    };
  }

  function resetInput(seeded: Awaited<ReturnType<typeof seed>>, resetId = "board-reset-1") {
    return {
      issueId: seeded.issueId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      resetId,
      requestedByUserId: "board-user",
    };
  }

  async function insertRepositoryReceipt(
    seeded: Awaited<ReturnType<typeof seed>>,
    state: "bounded_failure" | "reconciled_success",
  ) {
    if (!seeded.exhaustedRunId) throw new Error("expected exhausted run");
    return db
      .insert(repositoryMutationReceipts)
      .values({
        schemaVersion: "gloops.repository-mutation-receipt.v1",
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        heartbeatRunId: seeded.exhaustedRunId,
        issueId: seeded.issueId,
        projectId: seeded.projectId,
        projectWorkspaceId: seeded.projectWorkspaceId,
        repositoryId: "1",
        repositoryFullName: "paperclipai/paperclip",
        defaultBranch: "master",
        branchRef: `refs/heads/paperclip/${seeded.exhaustedRunId}/calibration`,
        mutationClass: "create_one_branch_ref",
        rootAuthorizationDigest: `sha256:${"1".repeat(64)}`,
        leaseDigest: `sha256:${"2".repeat(64)}`,
        nonce: "3".repeat(64),
        expectedOldOid: "4".repeat(40),
        expectedNewOid: "5".repeat(40),
        state,
        brokerReceiptDigest: `sha256:${"6".repeat(64)}`,
        remoteOldOid: "4".repeat(40),
        remoteNewOid: state === "reconciled_success" ? "5".repeat(40) : "4".repeat(40),
        receipt: { state },
        preparedAt: new Date("2026-08-01T00:00:00.000Z"),
        terminalAt: new Date("2026-08-01T00:01:00.000Z"),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("fails closed on terminal issue state, succeeded runs, and reconciled-success receipts", async () => {
    const seeded = await seed();
    const service = guardedAdmissionResetService(db);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seeded.issueId));
    await expect(service.resetExhaustedAdmissionAndCheckout(resetInput(seeded))).rejects.toMatchObject({
      details: { code: "admission_reset_terminal_issue" },
    });

    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, seeded.issueId));
    // Disposition-satisfied success still blocks reset.
    const succeededRunId = await db
      .insert(heartbeatRuns)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        finishedAt: new Date(),
        issueCommentStatus: "satisfied",
        contextSnapshot: { issueId: seeded.issueId, wakeReason: "issue_assigned" },
      })
      .returning({ id: heartbeatRuns.id })
      .then((rows) => rows[0]!.id);
    await expect(service.resetExhaustedAdmissionAndCheckout(resetInput(seeded))).rejects.toMatchObject({
      details: { code: "admission_reset_success_evidence", succeededRunId },
    });

    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, succeededRunId));
    // Exit-0 without disposition comment must NOT block reset (Gate5 thrash root cause).
    const nonDispositionalId = await db
      .insert(heartbeatRuns)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "succeeded",
        invocationSource: "assignment",
        finishedAt: new Date(),
        issueCommentStatus: "retry_exhausted",
        contextSnapshot: { issueId: seeded.issueId, wakeReason: "issue_assigned" },
      })
      .returning({ id: heartbeatRuns.id })
      .then((rows) => rows[0]!.id);
    // Not success-evidence: reset may proceed past this check (seed has exhausted envelope).
    await expect(service.resetExhaustedAdmissionAndCheckout(resetInput(seeded))).resolves.toMatchObject({
      created: true,
    });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, nonDispositionalId));

    // Fresh seed for repository-mutation success evidence (prior reset may have mutated state).
    const seededForReceipt = await seed();
    const receipt = await insertRepositoryReceipt(seededForReceipt, "reconciled_success");
    await expect(
      service.resetExhaustedAdmissionAndCheckout(resetInput(seededForReceipt)),
    ).rejects.toMatchObject({
      details: { code: "admission_reset_success_evidence", repositoryMutationReceiptId: receipt.id },
    });
  });

  it("denies any live issue execution binding", async () => {
    const seeded = await seed();
    const liveRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        status: "queued",
        invocationSource: "assignment",
        responsibleUserId: seeded.responsibleUserId,
        contextSnapshot: { issueId: seeded.issueId },
      })
      .returning()
      .then((rows) => rows[0]!);

    await expect(
      guardedAdmissionResetService(db).resetExhaustedAdmissionAndCheckout(resetInput(seeded)),
    ).rejects.toMatchObject({
      details: { code: "admission_reset_live_binding", runId: liveRun.id },
    });
  });

  it("serializes concurrent double calls into exactly one queued run", async () => {
    const seeded = await seed();
    const service = guardedAdmissionResetService(db);
    const [first, second] = await Promise.all([
      service.resetExhaustedAdmissionAndCheckout(resetInput(seeded)),
      service.resetExhaustedAdmissionAndCheckout(resetInput(seeded)),
    ]);

    expect(new Set([first.run.id, second.run.id]).size).toBe(1);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    const queuedRuns = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(queuedRuns).toBe(1);
  });

  it("returns the same durable run and receipt on idempotent replay", async () => {
    const seeded = await seed();
    const service = guardedAdmissionResetService(db);
    const first = await service.resetExhaustedAdmissionAndCheckout(resetInput(seeded));
    const replay = await service.resetExhaustedAdmissionAndCheckout(resetInput(seeded));

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.receipt).toEqual(first.receipt);
  });

  it("fails closed when an idempotent replay receipt no longer binds the reset facts", async () => {
    const seeded = await seed();
    const service = guardedAdmissionResetService(db);
    const first = await service.resetExhaustedAdmissionAndCheckout(resetInput(seeded));
    const context = record(first.run.contextSnapshot);
    const receipt = record(context.gloopsIssueAdmissionResetReceipt);
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          ...context,
          gloopsIssueAdmissionResetReceipt: {
            ...receipt,
            priorBudgetId: `issue:${randomUUID()}:default`,
          },
        },
      })
      .where(eq(heartbeatRuns.id, first.run.id));

    await expect(service.resetExhaustedAdmissionAndCheckout(resetInput(seeded))).rejects.toMatchObject({
      details: { code: "admission_reset_replay_missing" },
    });
  });

  it("permits at most one reset of the default epoch even with a new idempotency key", async () => {
    const seeded = await seed();
    const service = guardedAdmissionResetService(db);
    const first = await service.resetExhaustedAdmissionAndCheckout(resetInput(seeded));
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date("2026-08-01T00:03:00.000Z") })
      .where(eq(heartbeatRuns.id, first.run.id));
    await db
      .update(issues)
      .set({ status: "blocked", checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, seeded.issueId));

    await expect(
      service.resetExhaustedAdmissionAndCheckout(resetInput(seeded, "board-reset-2")),
    ).rejects.toMatchObject({
      details: {
        code: "admission_reset_epoch_already_reset",
        runId: first.run.id,
        priorResetId: "board-reset-1",
      },
    });
    const resetRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, seeded.companyId))
      .then((rows) => rows.filter((row) =>
        record(row.contextSnapshot)[EXECUTION_ADMISSION_RESET_CONTEXT_KEY] !== undefined
      ));
    expect(resetRuns).toHaveLength(1);
  });

  it("preserves historical admission and repository receipts", async () => {
    const seeded = await seed();
    const historicalReceipt = await insertRepositoryReceipt(seeded, "bounded_failure");
    await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "failed",
      invocationSource: "assignment",
      finishedAt: new Date("2026-08-01T00:02:00.000Z"),
      errorCode: "workspace_validation_failed",
      contextSnapshot: { issueId: seeded.issueId },
    });
    const service = guardedAdmissionResetService(db);
    await service.resetExhaustedAdmissionAndCheckout(resetInput(seeded));

    const [priorRun, priorReceipt] = await Promise.all([
      db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, seeded.exhaustedRunId!))
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(repositoryMutationReceipts)
        .where(eq(repositoryMutationReceipts.id, historicalReceipt.id))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(priorRun?.errorCode).toBe("execution_admission.retry_limit_exhausted");
    expect(priorReceipt?.state).toBe("bounded_failure");
  });

  it("binds the fresh envelope to the exact issue and workspace with checkout-only ownership", async () => {
    const seeded = await seed();
    const result = await guardedAdmissionResetService(db)
      .resetExhaustedAdmissionAndCheckout(resetInput(seeded));
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]!);
    const context = record(result.run.contextSnapshot);
    const receipt = record(context.gloopsIssueAdmissionResetReceipt);

    expect(context).toMatchObject({
      issueId: seeded.issueId,
      projectId: seeded.projectId,
      projectWorkspaceId: seeded.projectWorkspaceId,
      [EXECUTION_ADMISSION_RESET_CONTEXT_KEY]: "board-reset-1",
    });
    expect(receipt).toMatchObject({
      issueId: seeded.issueId,
      agentId: seeded.agentId,
      projectId: seeded.projectId,
      projectWorkspaceId: seeded.projectWorkspaceId,
      runId: result.run.id,
    });
    expect(issue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: seeded.agentId,
      checkoutRunId: result.run.id,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.execution_admission_reset_checkout"))
      .then((rows) => rows[0] ?? null);
    expect(audit).toMatchObject({
      companyId: seeded.companyId,
      actorType: "user",
      actorId: "board-user",
      entityId: seeded.issueId,
      runId: result.run.id,
    });
  });

  it("does not mistake ordinary failed preflight history for an exhausted epoch", async () => {
    const seeded = await seed({ exhausted: false });
    await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "failed",
      invocationSource: "assignment",
      finishedAt: new Date(),
      errorCode: "workspace_validation_failed",
      contextSnapshot: { issueId: seeded.issueId },
    });

    await expect(
      guardedAdmissionResetService(db).resetExhaustedAdmissionAndCheckout(resetInput(seeded)),
    ).rejects.toMatchObject({
      details: { code: "admission_reset_epoch_not_exhausted" },
    });
  });

  it("fails closed when the latest retry-exhaustion denial has a malformed envelope", async () => {
    const seeded = await seed();
    await db.insert(heartbeatRuns).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      status: "cancelled",
      invocationSource: "assignment",
      finishedAt: new Date("2026-08-01T00:03:00.000Z"),
      errorCode: "execution_admission.retry_limit_exhausted",
      contextSnapshot: {
        issueId: seeded.issueId,
        [EXECUTION_ADMISSION_CONTEXT_KEY]: {
          budgetId: `issue:${seeded.issueId}:default`,
          epoch: "default",
          decision: "denied",
          reason: "retry_limit_exhausted",
        },
      },
    });

    await expect(
      guardedAdmissionResetService(db).resetExhaustedAdmissionAndCheckout(resetInput(seeded)),
    ).rejects.toMatchObject({
      details: { code: "admission_reset_epoch_not_exhausted" },
    });
  });
});
