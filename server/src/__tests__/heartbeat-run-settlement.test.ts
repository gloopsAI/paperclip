import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  heartbeatRunIssueProjections,
  heartbeatRunSettlements,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
  providerIoTerminalEvidence,
  providerRequestEvidence,
  repositoryMutationReceipts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { providerRequestEvidenceService } from "../services/provider-request-evidence.js";
import {
  HeartbeatRunSettlementConflictError,
  heartbeatRunSettlementService,
} from "../services/heartbeat-run-settlement.js";
import {
  buildReviewVerdictProjection,
  heartbeatRunIssueProjectionService,
} from "../services/heartbeat-run-issue-projections.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("terminal review verdict projection derivation", () => {
  const exactHeadSha = "d".repeat(40);
  const base = {
    companyId: randomUUID(),
    agentId: randomUUID(),
    heartbeatRunId: randomUUID(),
    issueId: randomUUID(),
    terminalStatus: "succeeded",
    exactHeadSha,
    workMode: "review",
  };

  it("admits only a typed verdict that names the exact reviewed head", () => {
    expect(buildReviewVerdictProjection({
      ...base,
      resultJson: { summary: `APPROVED exact head ${exactHeadSha}; no P0/P1 findings.` },
    })).toMatchObject({
      kind: "review_verdict",
      disposition: "accepted",
      exactHeadSha,
    });
  });

  it("fails closed for ambiguous output or a verdict that omits the exact head", () => {
    expect(buildReviewVerdictProjection({
      ...base,
      resultJson: { summary: "Looks fine to me." },
    })).toBeNull();
    expect(buildReviewVerdictProjection({
      ...base,
      resultJson: { summary: "APPROVED; no P0/P1 findings." },
    })).toBeNull();
  });
});

describeEmbeddedPostgres("atomic heartbeat run settlement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-settlement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(issueComments);
    await db.delete(heartbeatRunIssueProjections);
    await db.delete(heartbeatRunSettlements);
    await db.delete(costEvents);
    await db.delete(providerIoTerminalEvidence);
    await db.delete(providerRequestEvidence);
    await db.delete(agentRuntimeState);
    await db.delete(repositoryMutationReceipts);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atomic Settlement Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Hermes",
      role: "engineer",
      status: "active",
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Atomic settlement calibration",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Calibration repository",
      sourceType: "git",
      repoUrl: "https://github.com/gloopsAI/gloops-paperclip-plugin.git",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Settle one provider run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    const identity = {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      issueId,
      heartbeatRunId,
    };
    await providerRequestEvidenceService(db).acknowledgePreparedRequest(identity, {
      schemaVersion: "gloops.provider-request-prepared.v1",
      destinationClass: "hermes_gateway",
      requestSchemaVersion: "hermes.run.create.v1",
      requestByteLength: 17,
      requestSha256: `sha256:${"a".repeat(64)}`,
      idempotencyKey: heartbeatRunId,
      requestPreparedAt: new Date().toISOString(),
    });
    return identity;
  }

  async function recordTerminalMutation(
    identity: Awaited<ReturnType<typeof seed>>,
    disposition: "reconciled_success" | "bounded_failure" | "conflict",
  ) {
    const expectedOldOid = "0".repeat(40);
    const expectedNewOid = "b".repeat(40);
    const remoteNewOid = disposition === "reconciled_success"
      ? expectedNewOid
      : disposition === "bounded_failure"
      ? expectedOldOid
      : "c".repeat(40);
    const brokerReceiptDigest = `sha256:${"8".repeat(64)}`;
    await db.insert(repositoryMutationReceipts).values({
      schemaVersion: "gloops.repository-mutation-receipt.v1",
      ...identity,
      repositoryId: "1297008772",
      repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
      defaultBranch: "main",
      branchRef: `refs/heads/paperclip/${identity.heartbeatRunId}/calibration`,
      mutationClass: "create_one_branch_ref",
      rootAuthorizationDigest: `sha256:${"a".repeat(64)}`,
      leaseDigest: `sha256:${"b".repeat(64)}`,
      nonce: "c".repeat(64),
      expectedOldOid,
      expectedNewOid,
      state: disposition,
      brokerReceiptDigest,
      remoteOldOid: expectedOldOid,
      remoteNewOid,
      receipt: { testFixture: true, disposition },
      preparedAt: new Date(),
      terminalAt: new Date(),
    });
    return {
      disposition,
      brokerReceiptDigest,
      remoteOldOid: expectedOldOid,
      remoteNewOid,
    } as const;
  }

  function receipt() {
    return {
      schemaVersion: "gloops.provider-io-terminal.v1" as const,
      preparedRequest: {
        requestByteLength: 17,
        requestSha256: `sha256:${"a".repeat(64)}`,
      },
      hermesRunId: "hermes-atomic-1",
      createResponse: {
        rawByteLength: 10,
        rawSha256: `sha256:${"1".repeat(64)}`,
        canonicalSha256: `sha256:${"2".repeat(64)}`,
      },
      eventStream: {
        rawByteLength: 20,
        rawSha256: `sha256:${"3".repeat(64)}`,
        canonicalEventSequenceSha256: `sha256:${"4".repeat(64)}`,
        eventCount: 1,
      },
      finalStatusResponse: {
        rawByteLength: 30,
        rawSha256: `sha256:${"5".repeat(64)}`,
        canonicalSha256: `sha256:${"6".repeat(64)}`,
      },
      terminalEvidence: {
        schemaVersion: "gloops.hermes-terminal-evidence.v1" as const,
        hermesRunId: "hermes-atomic-1",
        requestByteLength: 17,
        requestSha256: "a".repeat(64),
        resolvedProvider: "ollama-cloud",
        resolvedModel: "qwen3-coder",
        transportClass: "openai_chat_completions",
        billingClass: "subscription_included",
        fallbackPath: [{
          provider: "ollama-cloud",
          model: "qwen3-coder",
          transportClass: "openai_chat_completions",
          billingClass: "subscription_included",
        }],
        inputUsage: { present: true, value: 101 },
        outputUsage: { present: true, value: 17 },
        cachedUsage: { present: true, value: 9 },
        usageSource: "provider_response_aggregate",
        turnTotal: 1,
        toolCallTotal: 0,
        terminalStatus: "completed" as const,
      },
      terminalEvidenceDigest: `sha256:${"7".repeat(64)}`,
      rawPayloadDisposition: "not_retained" as const,
      reconciledAt: new Date().toISOString(),
    };
  }

  function input(identity: Awaited<ReturnType<typeof seed>>) {
    return {
      identity,
      terminalStatus: "succeeded" as const,
      runPatch: {
        finishedAt: new Date(),
        exitCode: 0,
        usageJson: { provider: "ollama-cloud", model: "qwen3-coder" },
        resultJson: { summary: "done" },
        sessionIdAfter: "session-1",
      },
      providerEvidence: receipt(),
      accounting: {
        adapterType: "hermes_gateway",
        sessionId: "session-1",
        lastError: null,
        provider: "ollama-cloud",
        biller: "ollama-cloud",
        billingType: "subscription_included",
        model: "qwen3-coder",
        costCents: 0,
      },
      mutation: { disposition: "not_authorized" as const },
    };
  }

  function reviewProjection(identity: Awaited<ReturnType<typeof seed>>) {
    const exactHeadSha = "d".repeat(40);
    return {
      companyId: identity.companyId,
      agentId: identity.agentId,
      heartbeatRunId: identity.heartbeatRunId,
      issueId: identity.issueId,
      kind: "review_verdict" as const,
      body: `APPROVE exact head ${exactHeadSha}; no P0/P1 findings.`,
      exactHeadSha,
      disposition: "accepted" as const,
    };
  }

  it("commits terminal run, usage, cost, provider receipt, continuation, and mutation disposition together", async () => {
    const identity = await seed();
    const result = await heartbeatRunSettlementService(db).settle(input(identity));

    expect(result.replayed).toBe(false);
    expect(result.run).toMatchObject({
      status: "succeeded",
      sessionIdAfter: "session-1",
      usageJson: {
        inputTokens: 101,
        cachedInputTokens: 9,
        outputTokens: 17,
        usageSource: "provider_terminal_evidence",
      },
    });
    expect(result.costEvent).toMatchObject({
      heartbeatRunId: identity.heartbeatRunId,
      inputTokens: 101,
      cachedInputTokens: 9,
      outputTokens: 17,
      costCents: 0,
    });
    expect(result.settlement).toMatchObject({
      heartbeatRunId: identity.heartbeatRunId,
      terminalStatus: "succeeded",
      normalizedUsage: {
        inputTokens: 101,
        cachedInputTokens: 9,
        outputTokens: 17,
      },
      mutationDisposition: "not_authorized",
      brokerReceiptDigest: null,
      remoteOldOid: null,
      remoteNewOid: null,
    });
    expect(result.settlement.accountingContinuation).toMatchObject({
      schemaVersion: "gloops.accounting-continuation.v1",
      heartbeatRunId: identity.heartbeatRunId,
      totalInputTokens: 101,
      totalCachedInputTokens: 9,
      totalOutputTokens: 17,
    });
  });

  it("commits a typed exact-head review projection in the same transaction as terminal run truth", async () => {
    const identity = await seed();
    const result = await heartbeatRunSettlementService(db).settle({
      ...input(identity),
      issueProjection: reviewProjection(identity),
    });

    expect(result.run.status).toBe("succeeded");
    const projections = await db.select().from(heartbeatRunIssueProjections);
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      heartbeatRunId: identity.heartbeatRunId,
      issueId: identity.issueId,
      kind: "review_verdict",
      status: "pending",
      disposition: "accepted",
      exactHeadSha: "d".repeat(40),
    });
  });

  it("rolls back run truth and projection together when a later settlement step fails", async () => {
    const identity = await seed();
    const service = heartbeatRunSettlementService(db, {
      afterStep: (step) => {
        if (step === "issue_projection") throw new Error("injected projection boundary failure");
      },
    });
    await expect(service.settle({
      ...input(identity),
      issueProjection: reviewProjection(identity),
    })).rejects.toThrow("injected projection boundary failure");

    const run = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, identity.heartbeatRunId))
      .then((rows) => rows[0]);
    expect(run.status).toBe("running");
    expect(await db.select().from(heartbeatRunIssueProjections)).toHaveLength(0);
    expect(await db.select().from(heartbeatRunSettlements)).toHaveLength(0);
  });

  it("replays a failed comment transaction from the outbox without rerunning or duplicating provider work", async () => {
    const identity = await seed();
    await heartbeatRunSettlementService(db).settle({
      ...input(identity),
      issueProjection: reviewProjection(identity),
    });

    let injectFailure = true;
    const outbox = heartbeatRunIssueProjectionService(db, {
      afterCommentInsert: () => {
        if (injectFailure) throw new Error("task bridge unavailable");
      },
    });
    const addComment = async (
      projection: typeof heartbeatRunIssueProjections.$inferSelect,
      tx: typeof db,
    ) => tx.insert(issueComments).values({
      companyId: projection.companyId,
      issueId: projection.issueId,
      authorAgentId: projection.agentId,
      authorType: "agent",
      createdByRunId: projection.heartbeatRunId,
      body: projection.body,
    }).returning({ id: issueComments.id }).then((rows) => rows[0]);

    const firstAttemptAt = new Date(Date.now() + 1_000);
    const first = await outbox.drain({
      now: firstAttemptAt,
      addComment,
    });
    expect(first).toMatchObject({ delivered: 0, failed: 1 });
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(await db.select().from(heartbeatRunIssueProjections)).toMatchObject([{
      status: "pending",
      attemptCount: 1,
      lastErrorClass: "Error",
    }]);
    expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, identity.heartbeatRunId))
      .then((rows) => rows[0]?.status)).toBe("succeeded");

    injectFailure = false;
    const second = await outbox.drain({
      now: new Date(firstAttemptAt.getTime() + 31_000),
      addComment,
    });
    expect(second).toMatchObject({ delivered: 1, failed: 0 });
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect(await db.select().from(heartbeatRunIssueProjections)).toMatchObject([{
      status: "delivered",
      attemptCount: 2,
      lastErrorClass: null,
    }]);
    const replay = await outbox.drain({
      now: new Date(firstAttemptAt.getTime() + 60_000),
      addComment,
    });
    expect(replay).toMatchObject({ delivered: 0, failed: 0 });
    expect(await db.select().from(issueComments)).toHaveLength(1);
  });

  it("replays by heartbeat run id without duplicating ledger totals or receipts", async () => {
    const identity = await seed();
    const service = heartbeatRunSettlementService(db);
    const first = await service.settle(input(identity));
    const replay = await service.settle(input(identity));

    expect(replay.replayed).toBe(true);
    expect(replay.settlement.id).toBe(first.settlement.id);
    expect(await db.select().from(heartbeatRunSettlements)).toHaveLength(1);
    expect(await db.select().from(providerIoTerminalEvidence)).toHaveLength(1);
    expect(await db.select().from(costEvents)).toHaveLength(1);
    const runtime = await db.select().from(agentRuntimeState);
    expect(runtime[0]).toMatchObject({
      totalInputTokens: 101,
      totalCachedInputTokens: 9,
      totalOutputTokens: 17,
    });
  });

  it("commits complete broker reconciliation facts when mutation is authorized", async () => {
    const identity = await seed();
    const mutation = await recordTerminalMutation(identity, "reconciled_success");
    const result = await heartbeatRunSettlementService(db).settle({
      ...input(identity),
      mutation,
    });

    expect(result.settlement).toMatchObject({
      mutationDisposition: "reconciled_success",
      brokerReceiptDigest: `sha256:${"8".repeat(64)}`,
      remoteOldOid: "0".repeat(40),
      remoteNewOid: "b".repeat(40),
    });
  });

  it.each(["bounded_failure", "conflict"] as const)(
    "allows a failed run to atomically retain a %s broker disposition",
    async (disposition) => {
      const identity = await seed();
      const failed = input(identity);
      const mutation = await recordTerminalMutation(identity, disposition);
      const result = await heartbeatRunSettlementService(db).settle({
        ...failed,
        terminalStatus: "failed",
        runPatch: {
          ...failed.runPatch,
          exitCode: 1,
        },
        mutation,
      });

      expect(result.settlement).toMatchObject({
        terminalStatus: "failed",
        mutationDisposition: disposition,
      });
    },
  );

  it.each(["bounded_failure", "conflict"] as const)(
    "rejects successful run settlement with a %s repository mutation",
    async (disposition) => {
      const identity = await seed();
      const mutation = await recordTerminalMutation(identity, disposition);
      await expect(heartbeatRunSettlementService(db).settle({
        ...input(identity),
        mutation,
      })).rejects.toBeInstanceOf(HeartbeatRunSettlementConflictError);
    },
  );

  it("commits a budget hard-stop pause in the same transaction as cost settlement", async () => {
    const identity = await seed();
    await db.insert(budgetPolicies).values({
      companyId: identity.companyId,
      scopeType: "agent",
      scopeId: identity.agentId,
      metric: "billed_cents",
      windowKind: "monthly",
      amount: 1,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    const settledInput = input(identity);
    const result = await heartbeatRunSettlementService(db).settle({
      ...settledInput,
      accounting: {
        ...settledInput.accounting,
        billingType: "metered_api",
        costCents: 1,
      },
    });

    expect(result.settlement).toBeTruthy();
    const agent = await db.select().from(agents)
      .where(eq(agents.id, identity.agentId))
      .then((rows) => rows[0]);
    expect(agent).toMatchObject({
      status: "paused",
      pauseReason: "budget",
    });
    const incidents = await db.select().from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, identity.companyId));
    expect(incidents.some((incident) =>
      incident.thresholdType === "hard" && incident.status === "open"
    )).toBe(true);
  });

  it("rolls back every settlement member when a later member fails", async () => {
    const identity = await seed();
    const service = heartbeatRunSettlementService(db, {
      afterStep: (step) => {
        if (step === "cost") throw new Error("injected settlement failure");
      },
    });
    await expect(service.settle(input(identity))).rejects.toThrow("injected settlement failure");

    const run = await db.select().from(heartbeatRuns)
      .then((rows) => rows.find((row) => row.id === identity.heartbeatRunId)!);
    expect(run.status).toBe("running");
    expect(await db.select().from(providerIoTerminalEvidence)).toHaveLength(0);
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect(await db.select().from(heartbeatRunSettlements)).toHaveLength(0);
    expect(await db.select().from(agentRuntimeState)).toHaveLength(0);
  });

  it("rejects a conflicting replay and incomplete broker success facts", async () => {
    const identity = await seed();
    const service = heartbeatRunSettlementService(db);
    await service.settle(input(identity));

    await expect(service.settle({
      ...input(identity),
      terminalStatus: "failed",
    })).rejects.toBeInstanceOf(HeartbeatRunSettlementConflictError);
    await expect(service.settle({
      ...input(identity),
      mutation: {
        disposition: "reconciled_success",
        brokerReceiptDigest: "bad",
        remoteOldOid: "bad",
        remoteNewOid: "bad",
      },
    })).rejects.toBeInstanceOf(HeartbeatRunSettlementConflictError);
  });
});
