import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { providerRequestEvidence } from "@paperclipai/db";
import type {
  AdapterProviderRequestPreparedAcknowledgement,
  AdapterProviderRequestPreparedEvidence,
} from "@paperclipai/adapter-utils";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface PreparedProviderRequestIdentity {
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
  issueId: string | null;
}

export class ProviderRequestEvidenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestEvidenceConflictError";
  }
}

function validatePreparedEvidence(evidence: AdapterProviderRequestPreparedEvidence) {
  if (evidence.schemaVersion !== "gloops.provider-request-prepared.v1") {
    throw new ProviderRequestEvidenceConflictError("Unsupported prepared provider evidence schema");
  }
  if (evidence.destinationClass !== "hermes_gateway") {
    throw new ProviderRequestEvidenceConflictError("Unsupported provider destination class");
  }
  if (evidence.requestSchemaVersion !== "hermes.run.create.v1") {
    throw new ProviderRequestEvidenceConflictError("Unsupported provider request schema");
  }
  if (!Number.isSafeInteger(evidence.requestByteLength) || evidence.requestByteLength < 0) {
    throw new ProviderRequestEvidenceConflictError("Provider request byte length must be a non-negative integer");
  }
  if (!SHA256_PATTERN.test(evidence.requestSha256)) {
    throw new ProviderRequestEvidenceConflictError("Provider request SHA-256 is malformed");
  }
  if (!evidence.idempotencyKey.trim()) {
    throw new ProviderRequestEvidenceConflictError("Provider request idempotency key is required");
  }
  if (!Number.isFinite(Date.parse(evidence.requestPreparedAt))) {
    throw new ProviderRequestEvidenceConflictError("Provider request prepared timestamp is malformed");
  }
}

function evidenceMatches(
  existing: typeof providerRequestEvidence.$inferSelect,
  identity: PreparedProviderRequestIdentity,
  evidence: AdapterProviderRequestPreparedEvidence,
) {
  return existing.schemaVersion === evidence.schemaVersion
    && existing.companyId === identity.companyId
    && existing.agentId === identity.agentId
    && existing.heartbeatRunId === identity.heartbeatRunId
    && existing.issueId === identity.issueId
    && existing.destinationClass === evidence.destinationClass
    && existing.requestSchemaVersion === evidence.requestSchemaVersion
    && existing.requestByteLength === evidence.requestByteLength
    && existing.requestSha256 === evidence.requestSha256
    && existing.idempotencyKey === evidence.idempotencyKey;
}

function acknowledgement(
  row: typeof providerRequestEvidence.$inferSelect,
): AdapterProviderRequestPreparedAcknowledgement {
  return {
    schemaVersion: "gloops.provider-request-prepared-ack.v1",
    evidenceId: row.id,
    requestSha256: row.requestSha256,
    acknowledgedAt: row.acknowledgedAt.toISOString(),
  };
}

export function providerRequestEvidenceService(db: Db) {
  return {
    acknowledgePreparedRequest: async (
      identity: PreparedProviderRequestIdentity,
      evidence: AdapterProviderRequestPreparedEvidence,
    ): Promise<AdapterProviderRequestPreparedAcknowledgement> => {
      validatePreparedEvidence(evidence);

      const inserted = await db
        .insert(providerRequestEvidence)
        .values({
          schemaVersion: evidence.schemaVersion,
          companyId: identity.companyId,
          agentId: identity.agentId,
          heartbeatRunId: identity.heartbeatRunId,
          issueId: identity.issueId,
          destinationClass: evidence.destinationClass,
          requestSchemaVersion: evidence.requestSchemaVersion,
          requestByteLength: evidence.requestByteLength,
          requestSha256: evidence.requestSha256,
          idempotencyKey: evidence.idempotencyKey,
          requestPreparedAt: new Date(evidence.requestPreparedAt),
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);

      if (inserted) return acknowledgement(inserted);

      const existing = await db
        .select()
        .from(providerRequestEvidence)
        .where(eq(providerRequestEvidence.heartbeatRunId, identity.heartbeatRunId))
        .then((rows) => rows[0] ?? null);

      if (!existing || !evidenceMatches(existing, identity, evidence)) {
        throw new ProviderRequestEvidenceConflictError(
          `Prepared provider evidence conflicts with the immutable receipt for run ${identity.heartbeatRunId}`,
        );
      }

      return acknowledgement(existing);
    },
  };
}
