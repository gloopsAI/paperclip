import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunIssueProjections,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat run issue projection parent deletion", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projection-parent-delete-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunIssueProjections);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProjection(status: "pending" | "delivered") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Projection deletion fixture",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Disposable reviewer",
      role: "reviewer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Dispose a projection parent safely",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date("2026-08-14T00:00:00.000Z"),
      finishedAt: new Date("2026-08-14T00:01:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(heartbeatRunIssueProjections).values({
      schemaVersion: "gloops.heartbeat-run-issue-projection.v1",
      companyId,
      agentId,
      heartbeatRunId,
      issueId,
      kind: status === "pending" ? "workspace_readiness" : "review_verdict",
      body: "Exact terminal projection evidence",
      bodySha256: `sha256:${"a".repeat(64)}`,
      exactHeadSha: status === "delivered" ? "b".repeat(40) : null,
      disposition: status === "delivered" ? "accepted" : null,
      status,
      deliveredCommentId: status === "delivered" ? randomUUID() : null,
      deliveredAt: status === "delivered" ? new Date("2026-08-14T00:02:00.000Z") : null,
    });
    return { companyId, agentId, issueId, heartbeatRunId };
  }

  it("removes a pending projection when its agent run is removed", async () => {
    const fixture = await seedProjection("pending");

    await expect(agentService(db).remove(fixture.agentId)).resolves.toMatchObject({
      id: fixture.agentId,
    });

    await expect(
      db.select().from(heartbeatRunIssueProjections)
        .where(eq(heartbeatRunIssueProjections.heartbeatRunId, fixture.heartbeatRunId)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, fixture.issueId)))
      .resolves.toMatchObject([{ assigneeAgentId: null }]);
  });

  it("removes a delivered projection during supported company deletion", async () => {
    const fixture = await seedProjection("delivered");

    await expect(companyService(db).remove(fixture.companyId)).resolves.toMatchObject({
      id: fixture.companyId,
    });

    await expect(db.select().from(heartbeatRunIssueProjections)).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, fixture.companyId)))
      .resolves.toHaveLength(0);
  });
});
