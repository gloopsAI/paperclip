import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  providerIoTerminalEvidence,
  providerRequestEvidence,
} from "@paperclipai/db";
import type { AdapterProviderIoTerminalEvidence } from "@paperclipai/adapter-utils";
import type { PreparedProviderRequestIdentity } from "./provider-request-evidence.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class ProviderIoTerminalEvidenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderIoTerminalEvidenceConflictError";
  }
}

function validateDigest(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new ProviderIoTerminalEvidenceConflictError(`${label} SHA-256 is malformed`);
  }
}

function validateEvidence(evidence: AdapterProviderIoTerminalEvidence): void {
  if (evidence.schemaVersion !== "gloops.provider-io-terminal.v1") {
    throw new ProviderIoTerminalEvidenceConflictError("Unsupported terminal provider evidence schema");
  }
  if (!evidence.hermesRunId.trim()) {
    throw new ProviderIoTerminalEvidenceConflictError("Hermes run identity is required");
  }
  for (const [label, entity] of [
    ["create raw", { length: evidence.createResponse.rawByteLength, digest: evidence.createResponse.rawSha256 }],
    ["event raw", { length: evidence.eventStream.rawByteLength, digest: evidence.eventStream.rawSha256 }],
    ["final raw", { length: evidence.finalStatusResponse.rawByteLength, digest: evidence.finalStatusResponse.rawSha256 }],
  ] as const) {
    if (!Number.isSafeInteger(entity.length) || entity.length < 0) {
      throw new ProviderIoTerminalEvidenceConflictError(`${label} byte length must be non-negative`);
    }
    validateDigest(entity.digest, label);
  }
  if (!Number.isSafeInteger(evidence.eventStream.eventCount) || evidence.eventStream.eventCount < 1) {
    throw new ProviderIoTerminalEvidenceConflictError("Terminal provider event count must be positive");
  }
  validateDigest(evidence.createResponse.canonicalSha256, "create canonical");
  validateDigest(evidence.eventStream.canonicalEventSequenceSha256, "event canonical sequence");
  validateDigest(evidence.finalStatusResponse.canonicalSha256, "final canonical");
  validateDigest(evidence.terminalEvidenceDigest, "terminal semantic evidence");
  if (evidence.rawPayloadDisposition !== "not_retained") {
    throw new ProviderIoTerminalEvidenceConflictError("Raw provider payload disposition must be not_retained");
  }
  if (!Number.isFinite(Date.parse(evidence.reconciledAt))) {
    throw new ProviderIoTerminalEvidenceConflictError("Terminal provider reconciliation timestamp is malformed");
  }
}

function evidenceMatches(
  row: typeof providerIoTerminalEvidence.$inferSelect,
  identity: PreparedProviderRequestIdentity,
  preparedEvidenceId: string,
  evidence: AdapterProviderIoTerminalEvidence,
): boolean {
  return row.schemaVersion === evidence.schemaVersion
    && row.companyId === identity.companyId
    && row.agentId === identity.agentId
    && row.heartbeatRunId === identity.heartbeatRunId
    && row.issueId === identity.issueId
    && row.preparedEvidenceId === preparedEvidenceId
    && row.hermesRunId === evidence.hermesRunId
    && row.createRawByteLength === evidence.createResponse.rawByteLength
    && row.createRawSha256 === evidence.createResponse.rawSha256
    && row.createCanonicalSha256 === evidence.createResponse.canonicalSha256
    && row.eventRawByteLength === evidence.eventStream.rawByteLength
    && row.eventRawSha256 === evidence.eventStream.rawSha256
    && row.eventCanonicalSequenceSha256 === evidence.eventStream.canonicalEventSequenceSha256
    && row.eventCount === evidence.eventStream.eventCount
    && row.finalRawByteLength === evidence.finalStatusResponse.rawByteLength
    && row.finalRawSha256 === evidence.finalStatusResponse.rawSha256
    && row.finalCanonicalSha256 === evidence.finalStatusResponse.canonicalSha256
    && isDeepStrictEqual(row.terminalEvidence, evidence.terminalEvidence)
    && row.terminalEvidenceDigest === evidence.terminalEvidenceDigest
    && row.rawPayloadDisposition === evidence.rawPayloadDisposition;
}

export function providerIoTerminalEvidenceService(db: Db) {
  return {
    persistReconciledEvidence: async (
      identity: PreparedProviderRequestIdentity,
      evidence: AdapterProviderIoTerminalEvidence,
    ) => {
      validateEvidence(evidence);
      const prepared = await db
        .select()
        .from(providerRequestEvidence)
        .where(eq(providerRequestEvidence.heartbeatRunId, identity.heartbeatRunId))
        .then((rows) => rows[0] ?? null);
      if (
        !prepared
        || prepared.companyId !== identity.companyId
        || prepared.agentId !== identity.agentId
        || prepared.issueId !== identity.issueId
        || prepared.requestByteLength !== evidence.preparedRequest.requestByteLength
        || prepared.requestSha256 !== evidence.preparedRequest.requestSha256
      ) {
        throw new ProviderIoTerminalEvidenceConflictError(
          `Terminal provider evidence does not match prepared evidence for run ${identity.heartbeatRunId}`,
        );
      }

      const inserted = await db
        .insert(providerIoTerminalEvidence)
        .values({
          schemaVersion: evidence.schemaVersion,
          companyId: identity.companyId,
          agentId: identity.agentId,
          heartbeatRunId: identity.heartbeatRunId,
          issueId: identity.issueId,
          preparedEvidenceId: prepared.id,
          hermesRunId: evidence.hermesRunId,
          createRawByteLength: evidence.createResponse.rawByteLength,
          createRawSha256: evidence.createResponse.rawSha256,
          createCanonicalSha256: evidence.createResponse.canonicalSha256,
          eventRawByteLength: evidence.eventStream.rawByteLength,
          eventRawSha256: evidence.eventStream.rawSha256,
          eventCanonicalSequenceSha256: evidence.eventStream.canonicalEventSequenceSha256,
          eventCount: evidence.eventStream.eventCount,
          finalRawByteLength: evidence.finalStatusResponse.rawByteLength,
          finalRawSha256: evidence.finalStatusResponse.rawSha256,
          finalCanonicalSha256: evidence.finalStatusResponse.canonicalSha256,
          terminalEvidence: evidence.terminalEvidence as unknown as Record<string, unknown>,
          terminalEvidenceDigest: evidence.terminalEvidenceDigest,
          rawPayloadDisposition: evidence.rawPayloadDisposition,
          reconciledAt: new Date(evidence.reconciledAt),
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
      if (inserted) return inserted;

      const existing = await db
        .select()
        .from(providerIoTerminalEvidence)
        .where(eq(providerIoTerminalEvidence.heartbeatRunId, identity.heartbeatRunId))
        .then((rows) => rows[0] ?? null);
      if (!existing || !evidenceMatches(existing, identity, prepared.id, evidence)) {
        throw new ProviderIoTerminalEvidenceConflictError(
          `Terminal provider evidence conflicts with the immutable receipt for run ${identity.heartbeatRunId}`,
        );
      }
      return existing;
    },
  };
}
