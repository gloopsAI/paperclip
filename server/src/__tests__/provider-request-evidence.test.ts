import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  providerRequestEvidence,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ProviderRequestEvidenceConflictError,
  providerRequestEvidenceService,
} from "../services/provider-request-evidence.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("prepared provider request evidence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-request-evidence-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(providerRequestEvidence);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Prepared Evidence Co",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Calibrate provider evidence",
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
    return { companyId, agentId, issueId, heartbeatRunId };
  }

  it("durably acknowledges one immutable prepared request and replays it idempotently", async () => {
    const identity = await seedRun();
    const service = providerRequestEvidenceService(db);
    const evidence = {
      schemaVersion: "gloops.provider-request-prepared.v1" as const,
      destinationClass: "hermes_gateway" as const,
      requestSchemaVersion: "hermes.run.create.v1" as const,
      requestByteLength: 17,
      requestSha256: `sha256:${"a".repeat(64)}`,
      idempotencyKey: identity.heartbeatRunId,
      requestPreparedAt: new Date().toISOString(),
    };

    const first = await service.acknowledgePreparedRequest(identity, evidence);
    const replay = await service.acknowledgePreparedRequest(
      identity,
      { ...evidence, requestPreparedAt: new Date(Date.now() + 1_000).toISOString() },
    );
    const rows = await db.select().from(providerRequestEvidence);

    expect(first).toEqual(replay);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: identity.companyId,
      agentId: identity.agentId,
      heartbeatRunId: identity.heartbeatRunId,
      issueId: identity.issueId,
      requestByteLength: 17,
      requestSha256: evidence.requestSha256,
      idempotencyKey: identity.heartbeatRunId,
    });
  });

  it("rejects conflicting replay without changing the durable evidence", async () => {
    const identity = await seedRun();
    const service = providerRequestEvidenceService(db);
    const evidence = {
      schemaVersion: "gloops.provider-request-prepared.v1" as const,
      destinationClass: "hermes_gateway" as const,
      requestSchemaVersion: "hermes.run.create.v1" as const,
      requestByteLength: 17,
      requestSha256: `sha256:${"a".repeat(64)}`,
      idempotencyKey: identity.heartbeatRunId,
      requestPreparedAt: new Date().toISOString(),
    };
    await service.acknowledgePreparedRequest(identity, evidence);

    await expect(
      service.acknowledgePreparedRequest(identity, {
        ...evidence,
        requestSha256: `sha256:${"b".repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(ProviderRequestEvidenceConflictError);

    const rows = await db.select().from(providerRequestEvidence);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestSha256).toBe(evidence.requestSha256);
  });
});
