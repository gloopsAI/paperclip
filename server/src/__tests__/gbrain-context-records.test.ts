import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  gbrainContextRecords,
  activityLog,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  gbrainContextRecordDigest,
  gbrainContextRecordService,
} from "../services/gbrain-context-records.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("GBrain context records", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gbrain-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(gbrainContextRecords);
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name,
      issuePrefix: `G${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  it("is idempotent by source version and only retrieves active same-company records", async () => {
    const companyId = await company("GBrain Context Co");
    const otherCompanyId = await company("Other Context Co");
    const service = gbrainContextRecordService(db);
    const buzzThread = {
      sourceKind: "buzz_thread_summary" as const,
      sourceUri: "buzz://channel/strategy/thread/abc",
      sourceEventId: "abc",
      sourceAuthor: "npub1zach",
      summary: "Decision: build a cited Context Fabric for Buzz and Paperclip.",
      occurredAt: "2026-07-31T20:00:00.000Z",
    };

    const first = await service.ingest(companyId, buzzThread);
    const replay = await service.ingest(companyId, buzzThread);
    await service.ingest(companyId, {
      ...buzzThread,
      sourceUri: "buzz://channel/strategy/thread/expired",
      summary: "Expired context must never be returned.",
      occurredAt: "2026-07-30T20:00:00.000Z",
      expiresAt: "2026-07-31T19:00:00.000Z",
    });
    await service.ingest(otherCompanyId, {
      ...buzzThread,
      summary: "Other company context must never cross a tenant boundary.",
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "paperclip",
      action: "issue.completed",
      entityType: "issue",
      entityId: "issue-123",
      createdAt: new Date("2026-07-31T20:00:30.000Z"),
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(first.record.contentDigest).toBe(gbrainContextRecordDigest(buzzThread));

    const records = await service.retrieve(companyId, {
      goal: "How should Buzz and Paperclip context flow?",
      limit: 10,
      now: new Date("2026-07-31T20:01:00.000Z"),
    });

    expect(records).toHaveLength(2);
    expect(records.find((record) => record.sourceKind === "buzz_thread_summary")).toMatchObject({
      id: first.record.id,
      sourceKind: "buzz_thread_summary",
      whyIncluded: expect.stringContaining("goal_term_overlap"),
    });
    expect(records.find((record) => record.sourceKind === "paperclip_work_receipt")).toMatchObject({
      sourceUri: expect.stringContaining("paperclip://company/"),
      summary: "Paperclip work receipt: issue.completed on issue/issue-123.",
    });
  });
});
