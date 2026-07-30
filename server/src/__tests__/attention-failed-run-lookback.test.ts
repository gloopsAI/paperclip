/**
 * PS2-E / GLO-2024 (GLO-2050): cockpit attention failed-run lookback.
 *
 * Before this slice, the failed_run attention branch scanned every
 * "Bounded retry exhausted" lifecycle event the company had ever
 * produced — with no time bound and no per-agent cap — and then ran a
 * second unbounded scan for every follow-up run for every agent that
 * ever failed. Steady-state cockpit feeds both slowed down and
 * surfaced stale "failed" rows from weeks-old runs.
 *
 * These tests cover the new lookback + per-agent cap contract:
 *  - runs outside the 30-day lookback window do not surface
 *  - one agent with many recent failures does not crowd out the feed
 *  - newer follow-up runs still suppress older failed rows
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issueApprovals,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  joinRequests,
  invites,
  projects,
  projectWorkspaces,
  assets,
  documents,
  approvals,
  activityLog,
  budgetIncidents,
  budgetPolicies,
  issueAttachments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = Awaited<ReturnType<typeof createDb>>;

describeEmbeddedPostgres("attention failed-run lookback (GLO-2050 / PS2-E)", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const LOOKBACK_MS = 30 * DAY_MS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attn-failed-run-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(inboxDismissals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(issueAttachments);
    await db.delete(issueDocuments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(assets);
    await db.delete(documents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    const noisyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: workerId,
        companyId,
        name: "Worker",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: noisyId,
        companyId,
        name: "Noisy Worker",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, workerId, noisyId };
  }

  async function insertIssue(companyId: string, identifier: string, assigneeAgentId: string) {
    const id = randomUUID();
    const now = new Date();
    await db.insert(issues).values({
      id,
      companyId,
      identifier,
      title: `Issue ${identifier}`,
      status: "in_progress",
      priority: "medium",
      parentId: null,
      projectId: null,
      projectWorkspaceId: null,
      assigneeAgentId,
      assigneeUserId: null,
      originKind: "manual",
      originId: null,
      originFingerprint: `fingerprint-${identifier}`,
      executionState: null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  function exhaustionMessage() {
    return "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued";
  }

  async function insertExhaustedRun(opts: {
    runId: string;
    companyId: string;
    agentId: string;
    issueId: string;
    finishedAt: Date;
  }) {
    const { runId, companyId, agentId, issueId, finishedAt } = opts;
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "adapter failure",
      errorCode: "adapter_failed",
      contextSnapshot: { issueId },
      scheduledRetryAttempt: 4,
      scheduledRetryReason: "transient_failure",
      createdAt: finishedAt,
      updatedAt: finishedAt,
      finishedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      message: exhaustionMessage(),
      createdAt: new Date(finishedAt.getTime() + 1000),
    });
  }

  it("exhausted runs older than the 30-day lookback do not surface", async () => {
    const { companyId, workerId } = await seedCompany("ATL");
    const issueId = await insertIssue(companyId, "ATL-1", workerId);

    const stale = new Date(Date.now() - (LOOKBACK_MS + 5 * DAY_MS));
    await insertExhaustedRun({
      runId: randomUUID(),
      companyId,
      agentId: workerId,
      issueId,
      finishedAt: stale,
    });

    const feed = await attentionService(db).list(companyId);
    const failed = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failed).toEqual([]);
  });

  it("exhausted runs inside the lookback surface normally", async () => {
    const { companyId, workerId } = await seedCompany("ATF");
    const issueId = await insertIssue(companyId, "ATF-1", workerId);

    const recent = new Date(Date.now() - 2 * DAY_MS);
    await insertExhaustedRun({
      runId: randomUUID(),
      companyId,
      agentId: workerId,
      issueId,
      finishedAt: recent,
    });

    const feed = await attentionService(db).list(companyId);
    const failed = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.relatedIssue?.id).toBe(issueId);
  });

  it("a noisy agent with many recent failures does not crowd the feed past the per-agent cap", async () => {
    const { companyId, workerId, noisyId } = await seedCompany("ATP");
    const workerIssue = await insertIssue(companyId, "ATP-1", workerId);

    const baseTs = Date.now();
    // The noisy agent gets 40 recent failed runs across many issues — far
    // more than the per-agent cap. Insert one workerIssue failed run too,
    // which must still surface even though the noisy agent is way over.
    for (let i = 0; i < 40; i += 1) {
      const issueId = await insertIssue(companyId, `ATP-N-${i}`, noisyId);
      await insertExhaustedRun({
        runId: randomUUID(),
        companyId,
        agentId: noisyId,
        issueId,
        finishedAt: new Date(baseTs - i * 60_000),
      });
    }
    await insertExhaustedRun({
      runId: randomUUID(),
      companyId,
      agentId: workerId,
      issueId: workerIssue,
      finishedAt: new Date(baseTs - 30 * 60_000),
    });

    const feed = await attentionService(db).list(companyId);
    const failed = feed.items.filter((item) => item.sourceKind === "failed_run");

    // Per-agent cap = 25 combined with the overall limit. Worker must
    // remain visible because its failed row is the most recent across all
    // failing agents (per-agent cap takes per-agent newest).
    const noisyRows = failed.filter((item) => item.subject.metadata?.agentId === noisyId);
    const workerRows = failed.filter((item) => item.subject.metadata?.agentId === workerId);
    expect(noisyRows.length).toBeGreaterThan(0);
    expect(noisyRows.length).toBeLessThanOrEqual(25);
    expect(workerRows.length).toBe(1);
    expect(workerRows[0]?.relatedIssue?.id).toBe(workerIssue);

    // Sort: cockpits are ranked by activityAt desc; both must be present.
    expect(failed.length).toBeGreaterThanOrEqual(1 + Math.min(25, noisyRows.length));
  });

  it("newer follow-up runs still suppress the older failed-run row even with the lookback", async () => {
    const { companyId, workerId } = await seedCompany("ATS");
    const issueId = await insertIssue(companyId, "ATS-1", workerId);
    const failedRunId = randomUUID();
    const laterAt = new Date(Date.now() - 1 * DAY_MS);

    await insertExhaustedRun({
      runId: failedRunId,
      companyId,
      agentId: workerId,
      issueId,
      finishedAt: new Date(laterAt.getTime() - 60_000),
    });

    // A newer follow-up run for the same agent+issue must keep the
    // failed row suppressed, even after the lookback bound is applied.
    const newerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId,
      agentId: workerId,
      invocationSource: "automation",
      status: "succeeded",
      contextSnapshot: { issueId },
      createdAt: laterAt,
      updatedAt: laterAt,
      finishedAt: laterAt,
    });

    const feed = await attentionService(db).list(companyId);
    const failed = feed.items.filter((item) => item.sourceKind === "failed_run");
    expect(failed).toEqual([]);
  });
});
