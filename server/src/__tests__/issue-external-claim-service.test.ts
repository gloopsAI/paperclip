import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import { issueService } from "../services/issues.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("atomic external issue claim", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const baseSha = "a".repeat(40);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-claim-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(label: string) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const issueId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${label}`,
      issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: `Project ${label}` });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Primary",
      isPrimary: true,
      repoUrl: "https://github.com/gloopsAI/paperclip.git",
      repoRef: baseSha,
      defaultRef: "gloops/stable",
    });
    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: `Writer A ${label}`,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: `Writer B ${label}`,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      identifier: `${label}-1`,
      title: `Atomic claim ${label}`,
      description: `Repository: https://github.com/gloopsAI/paperclip\nExact base/head SHA: ${baseSha}`,
      status: "todo",
      priority: "high",
    });
    return { companyId, projectId, workspaceId, issueId, firstAgentId, secondAgentId };
  }

  function input(claimId: string, agentId: string, workspaceIdentity: string) {
    return {
      claimId,
      agentId,
      entryPoint: "interactive_codex" as const,
      repositoryFullName: "gloopsAI/paperclip",
      baseSha,
      branchName: `paperclip/${claimId}/calibration`,
      workspaceIdentity,
    };
  }

  it("admits exactly one concurrent writer and leaves the loser with zero workspace effects", async () => {
    const seeded = await seed("RACE");
    const svcA = issueService(db);
    const svcB = issueService(db);
    const claimA = randomUUID();
    const claimB = randomUUID();
    const results = await Promise.allSettled([
      svcA.claimExternalIssue(seeded.issueId, input(claimA, seeded.firstAgentId, "/workspace/a")),
      svcB.claimExternalIssue(seeded.issueId, input(claimB, seeded.secondAgentId, "/workspace/b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { status: 409 } });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, seeded.companyId));
    expect(runs).toHaveLength(1);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, seeded.companyId))).toEqual([]);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.companyId, seeded.companyId))).toEqual([]);
  });

  it("is idempotent, rejects live-owner theft, reconciles a terminal owner, and never completes the issue", async () => {
    const seeded = await seed("LIFE");
    const svc = issueService(db);
    const firstClaimId = randomUUID();
    const firstInput = input(firstClaimId, seeded.firstAgentId, "/workspace/life");
    const created = await svc.claimExternalIssue(seeded.issueId, firstInput);
    const replay = await svc.claimExternalIssue(seeded.issueId, firstInput);
    expect(created.created).toBe(true);
    expect(replay).toMatchObject({ created: false, run: { id: firstClaimId } });
    await expect(svc.claimExternalIssue(
      seeded.issueId,
      input(randomUUID(), seeded.secondAgentId, "/workspace/thief"),
    )).rejects.toMatchObject({ status: 409 });

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, firstClaimId));
    const secondClaimId = randomUUID();
    const adopted = await svc.claimExternalIssue(
      seeded.issueId,
      input(secondClaimId, seeded.firstAgentId, "/workspace/recovered"),
    );
    expect(adopted.created).toBe(true);
    const validated = await svc.validateExternalIssueClaim(
      seeded.issueId,
      { ...input(secondClaimId, seeded.firstAgentId, "/workspace/recovered"), headSha: "b".repeat(40) },
      seeded.firstAgentId,
    );
    expect(validated.valid).toBe(true);
    await expect(svc.validateExternalIssueClaim(
      seeded.issueId,
      {
        ...input(secondClaimId, seeded.firstAgentId, "/workspace/recovered"),
        baseSha: "c".repeat(40),
        headSha: "b".repeat(40),
      },
      seeded.firstAgentId,
    )).rejects.toMatchObject({ status: 409 });

    await svc.releaseExternalIssueClaim(
      seeded.issueId,
      { claimId: secondClaimId, disposition: "handoff" },
      seeded.firstAgentId,
    );
    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject({ status: "in_review", checkoutRunId: null, executionRunId: null });
    expect(issue.status).not.toBe("done");
  });

  it("isolates claims for different issues and companies", async () => {
    const one = await seed("ONE");
    const two = await seed("TWO");
    const [claimOne, claimTwo] = await Promise.all([
      issueService(db).claimExternalIssue(one.issueId, input(randomUUID(), one.firstAgentId, "/workspace/one")),
      issueService(db).claimExternalIssue(two.issueId, input(randomUUID(), two.firstAgentId, "/workspace/two")),
    ]);
    expect(claimOne.binding.companyId).toBe(one.companyId);
    expect(claimTwo.binding.companyId).toBe(two.companyId);
    expect(claimOne.binding.issueId).not.toBe(claimTwo.binding.issueId);
  });
});
