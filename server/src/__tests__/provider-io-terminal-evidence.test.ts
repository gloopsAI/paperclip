import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  providerIoTerminalEvidence,
  providerRequestEvidence,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { providerRequestEvidenceService } from "../services/provider-request-evidence.js";
import {
  ProviderIoTerminalEvidenceConflictError,
  providerIoTerminalEvidenceService,
} from "../services/provider-io-terminal-evidence.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("terminal provider I/O evidence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-io-terminal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(providerIoTerminalEvidence);
    await db.delete(providerRequestEvidence);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const heartbeatRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Evidence Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      title: "Persist terminal provider evidence",
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
    const identity = { companyId, agentId, issueId, heartbeatRunId };
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

  function receipt() {
    return {
      schemaVersion: "gloops.provider-io-terminal.v1" as const,
      preparedRequest: { requestByteLength: 17, requestSha256: `sha256:${"a".repeat(64)}` },
      hermesRunId: "hermes-1",
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
        hermesRunId: "hermes-1",
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
        inputUsage: { present: true, value: 1 },
        outputUsage: { present: true, value: 1 },
        cachedUsage: { present: true, value: 0 },
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

  it("persists one immutable receipt and replays exact evidence idempotently", async () => {
    const identity = await seed();
    const service = providerIoTerminalEvidenceService(db);
    const evidence = receipt();
    const first = await service.persistReconciledEvidence(identity, evidence);
    const replay = await service.persistReconciledEvidence(identity, evidence);
    expect(replay.id).toBe(first.id);
    expect(await db.select().from(providerIoTerminalEvidence)).toHaveLength(1);
  });

  it("rejects a conflicting terminal replay", async () => {
    const identity = await seed();
    const service = providerIoTerminalEvidenceService(db);
    const evidence = receipt();
    await service.persistReconciledEvidence(identity, evidence);
    await expect(service.persistReconciledEvidence(identity, {
      ...evidence,
      terminalEvidenceDigest: `sha256:${"8".repeat(64)}`,
    })).rejects.toBeInstanceOf(ProviderIoTerminalEvidenceConflictError);
    expect(await db.select().from(providerIoTerminalEvidence)).toHaveLength(1);
  });
});
