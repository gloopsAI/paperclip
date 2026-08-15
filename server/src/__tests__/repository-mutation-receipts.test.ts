import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
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
  RepositoryMutationReceiptConflictError,
  repositoryMutationReceiptService,
} from "../services/repository-mutation-receipts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("repository mutation receipts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repository-mutation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(repositoryMutationReceipts);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
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
      name: "Repository Mutation Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      name: "One push calibration",
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
      title: "Create one calibration branch",
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
    await db.update(issues).set({ executionRunId: heartbeatRunId });
    return {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      issueId,
      heartbeatRunId,
    };
  }

  function prepared(identity: Awaited<ReturnType<typeof seed>>) {
    return {
      schemaVersion: "gloops.repository-mutation-receipt.v1" as const,
      ...identity,
      repositoryId: "1297008772",
      repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
      defaultBranch: "main",
      branchRef: `refs/heads/paperclip/${identity.heartbeatRunId}/calibration`,
      mutationClass: "create_one_branch_ref" as const,
      rootAuthorizationDigest: `sha256:${"a".repeat(64)}`,
      leaseDigest: `sha256:${"b".repeat(64)}`,
      nonce: "c".repeat(64),
      expectedOldOid: "0".repeat(40),
      expectedNewOid: "d".repeat(40),
      state: "prepared" as const,
      preparedAt: new Date().toISOString(),
    };
  }

  function terminal(
    receipt: ReturnType<typeof prepared>,
    state: "reconciled_success" | "bounded_failure" | "conflict",
    remoteNewOid: string,
  ) {
    const projection = {
      ...receipt,
      state,
      remoteOldOid: receipt.expectedOldOid,
      remoteNewOid,
      terminalAt: new Date().toISOString(),
    };
    const canonical = JSON.stringify(
      projection,
      Object.keys(projection).sort(),
    );
    return {
      ...projection,
      brokerReceiptDigest: `sha256:${createHash("sha256")
        .update("gloops.github-push-terminal-receipt.v1")
        .update("\0")
        .update(canonical)
        .digest("hex")}`,
    };
  }

  function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      const recordValue = value as Record<string, unknown>;
      return `{${Object.keys(recordValue).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(recordValue[key])}`
      ).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function terminalWithDraftPullRequest(
    receipt: ReturnType<typeof prepared>,
    state: "reconciled_success" | "bounded_failure" | "conflict",
    remoteNewOid: string,
    draftPullRequest:
      | { disposition: "created"; prNumber: number; prUrl: string }
      | { disposition: "none" },
  ) {
    const projection = {
      ...receipt,
      state,
      remoteOldOid: receipt.expectedOldOid,
      remoteNewOid,
      terminalAt: new Date().toISOString(),
      draftPullRequest,
    };
    return {
      ...projection,
      brokerReceiptDigest: `sha256:${createHash("sha256")
        .update("gloops.github-push-terminal-receipt.v1")
        .update("\0")
        .update(canonicalJson(projection))
        .digest("hex")}`,
    };
  }

  it("binds the root receipt to live run, issue, workspace, and repository facts", async () => {
    const identity = await seed();
    const service = repositoryMutationReceiptService(db);
    const context = await service.getContext(identity.heartbeatRunId);

    expect(context).toMatchObject({
      heartbeatRunId: identity.heartbeatRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      issueId: identity.issueId,
      projectId: identity.projectId,
      projectWorkspaceId: identity.projectWorkspaceId,
      repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
      configuredDefaultBranch: "main",
    });

    const receipt = prepared(identity);
    const first = await service.recordPrepared(receipt);
    const replay = await service.recordPrepared(receipt);
    expect(replay.id).toBe(first.id);
    expect(await db.select().from(repositoryMutationReceipts)).toHaveLength(1);

    await db.delete(repositoryMutationReceipts);
    await db.update(issues).set({ status: "cancelled" });
    await expect(service.recordPrepared(receipt))
      .rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);
  });

  it("fails closed when an external run lacks the exact atomic claim binding", async () => {
    const identity = await seed();
    const baseSha = "a".repeat(40);
    await db.update(projectWorkspaces).set({ repoRef: baseSha });
    await db.update(heartbeatRuns).set({
      invocationSource: "external_claim",
      contextSnapshot: { issueId: identity.issueId },
    });
    const service = repositoryMutationReceiptService(db);
    await expect(service.getContext(identity.heartbeatRunId)).resolves.toBeNull();

    await db.update(heartbeatRuns).set({
      contextSnapshot: {
        issueId: identity.issueId,
        externalIssueClaim: {
          schemaVersion: "paperclip.external-issue-claim.v1",
          claimId: identity.heartbeatRunId,
          companyId: identity.companyId,
          issueId: identity.issueId,
          agentId: identity.agentId,
          entryPoint: "interactive_codex",
          repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
          baseSha,
          branchName: `paperclip/${identity.heartbeatRunId}/calibration`,
          projectWorkspaceId: identity.projectWorkspaceId,
          workspaceIdentity: "/workspace/interactive",
          claimedAt: "2026-08-15T00:00:00.000Z",
        },
      },
    });
    await expect(service.getContext(identity.heartbeatRunId)).resolves.toMatchObject({
      runInvocationSource: "external_claim",
      externalIssueClaim: {
        claimId: identity.heartbeatRunId,
        baseSha,
      },
    });
  });

  it("rejects conflicting allocation and terminal replay facts", async () => {
    const identity = await seed();
    const service = repositoryMutationReceiptService(db);
    const receipt = prepared(identity);
    await service.recordPrepared(receipt);

    await expect(service.recordPrepared({
      ...receipt,
      expectedNewOid: "e".repeat(40),
    })).rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);

    const terminalReceipt = terminal(receipt, "reconciled_success", receipt.expectedNewOid);
    await service.recordTerminal(terminalReceipt);
    await expect(service.recordTerminal({
      ...terminalReceipt,
      state: "conflict",
    })).rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);
  });

  it("accepts terminal receipts carrying leased draft pull request evidence", async () => {
    const identity = await seed();
    const service = repositoryMutationReceiptService(db);
    const receipt = prepared(identity);
    await service.recordPrepared(receipt);

    const terminalReceipt = terminalWithDraftPullRequest(
      receipt,
      "reconciled_success",
      receipt.expectedNewOid,
      {
        disposition: "created",
        prNumber: 7,
        prUrl: "https://github.com/gloopsAI/gloops-paperclip-plugin/pull/7",
      },
    );
    const recorded = await service.recordTerminal(terminalReceipt);
    expect((recorded.receipt as Record<string, unknown>).draftPullRequest).toEqual({
      disposition: "created",
      prNumber: 7,
      prUrl: "https://github.com/gloopsAI/gloops-paperclip-plugin/pull/7",
    });
    const replay = await service.recordTerminal(terminalReceipt);
    expect(replay.id).toBe(recorded.id);
    await expect(service.getForSettlement(identity.heartbeatRunId)).resolves.toMatchObject({
      disposition: "reconciled_success",
    });
  });

  it("accepts pr:none draft evidence and rejects malformed draft PR fields", async () => {
    const identity = await seed();
    const service = repositoryMutationReceiptService(db);
    const receipt = prepared(identity);
    await service.recordPrepared(receipt);

    const created = {
      disposition: "created" as const,
      prNumber: 7,
      prUrl: "https://github.com/gloopsAI/gloops-paperclip-plugin/pull/7",
    };
    // A created draft PR is only valid evidence on a reconciled_success push.
    await expect(service.recordTerminal(
      terminalWithDraftPullRequest(receipt, "bounded_failure", receipt.expectedOldOid, created),
    )).rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);
    // The PR URL must be exactly the leased repository's pull URL.
    await expect(service.recordTerminal(
      terminalWithDraftPullRequest(receipt, "reconciled_success", receipt.expectedNewOid, {
        ...created,
        prUrl: "https://github.com/attacker/elsewhere/pull/7",
      }),
    )).rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);
    await expect(service.recordTerminal(
      terminalWithDraftPullRequest(receipt, "reconciled_success", receipt.expectedNewOid, {
        disposition: "none",
        prNumber: 7,
      } as never),
    )).rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);

    const noneReceipt = terminalWithDraftPullRequest(
      receipt,
      "bounded_failure",
      receipt.expectedOldOid,
      { disposition: "none" },
    );
    const recorded = await service.recordTerminal(noneReceipt);
    expect((recorded.receipt as Record<string, unknown>).draftPullRequest).toEqual({
      disposition: "none",
    });
  });

  it("requires terminal reconciliation before atomic settlement consumes authorization", async () => {
    const identity = await seed();
    const service = repositoryMutationReceiptService(db);
    const receipt = prepared(identity);
    await service.recordPrepared(receipt);

    await expect(service.getForSettlement(identity.heartbeatRunId))
      .rejects.toBeInstanceOf(RepositoryMutationReceiptConflictError);

    const terminalReceipt = terminal(receipt, "bounded_failure", receipt.expectedOldOid);
    await service.recordTerminal(terminalReceipt);
    await expect(service.getForSettlement(identity.heartbeatRunId)).resolves.toEqual({
      disposition: "bounded_failure",
      brokerReceiptDigest: terminalReceipt.brokerReceiptDigest,
      remoteOldOid: receipt.expectedOldOid,
      remoteNewOid: receipt.expectedOldOid,
    });
  });
});
