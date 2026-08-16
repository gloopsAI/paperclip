import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  REVIEW_FAILOVER_MARKER,
  persistImplementationReviewTerminalFailure,
} from "../services/implementation-review-handoff.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("implementation review failover", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-failover-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("moves only a typed availability failure to a healthy designated alternate", async () => {
    const companyId = randomUUID();
    const implementerAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const alternateReviewerAgentId = randomUUID();
    const parentIssueId = randomUUID();
    const reviewIssueId = randomUUID();
    const sourceRunId = randomUUID();
    const reviewRunId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Failover Co",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      { id: implementerAgentId, companyId, name: "Wren", role: "engineer", status: "idle", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: reviewerAgentId, companyId, name: "Argus", role: "qa", status: "error", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: alternateReviewerAgentId, companyId, name: "Review B", role: "reviewer", status: "idle", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      title: "Implementation",
      status: "in_review",
      priority: "high",
      assigneeAgentId: implementerAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: implementerAgentId,
      status: "succeeded",
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: { issueId: parentIssueId },
    });
    await db.update(issues).set({ executionRunId: sourceRunId }).where(eq(issues.id, parentIssueId));
    await db.insert(issues).values({
      id: reviewIssueId,
      companyId,
      title: "Review exact head",
      status: "in_progress",
      priority: "high",
      parentId: parentIssueId,
      assigneeAgentId: reviewerAgentId,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        reviewProvenance: {
          kind: "implementation_exact_head_v2",
          parentIssueId,
          sourceRunId,
          implementerAgentId,
          reviewerAgentId,
          alternateReviewerAgentIds: [alternateReviewerAgentId],
          projectWorkspaceId,
          repositoryId: "1299155335",
          repositoryFullName: "gloopsAI/paperclip",
          baseRef: "gloops/stable",
          exactBaseSha: "a".repeat(40),
          exactHeadSha: "b".repeat(40),
          pullRequestNumber: 300,
          pullRequestUrl: "https://github.com/gloopsAI/paperclip/pull/300",
        },
      },
    });
    await db.insert(heartbeatRuns).values({
      id: reviewRunId,
      companyId,
      agentId: reviewerAgentId,
      status: "failed",
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: { issueId: reviewIssueId },
    });
    await db.update(issues).set({ executionRunId: reviewRunId }).where(eq(issues.id, reviewIssueId));

    await expect(persistImplementationReviewTerminalFailure(db, {
      companyId,
      issueId: reviewIssueId,
      runId: reviewRunId,
      errorCode: "provider_quota",
      error: "provider unavailable",
    })).resolves.toEqual({
      action: "failed_over",
      parentBlocked: false,
      nextReviewerAgentId: alternateReviewerAgentId,
    });

    const review = await db.select().from(issues).where(eq(issues.id, reviewIssueId)).then((rows) => rows[0]);
    const parent = await db.select().from(issues).where(eq(issues.id, parentIssueId)).then((rows) => rows[0]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, reviewIssueId));
    expect(review).toMatchObject({ assigneeAgentId: alternateReviewerAgentId, status: "todo", executionRunId: null, checkoutRunId: null });
    expect(parent?.status).toBe("in_review");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(REVIEW_FAILOVER_MARKER);
  });
});
