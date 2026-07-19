import type {
  AdapterHermesTerminalEvidenceProjection,
  AdapterProviderIoTerminalEvidence,
} from "@paperclipai/adapter-utils";
import { createHash, type Hash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const TERMINAL_DIGEST_DOMAIN = Buffer.from("gloops.hermes-terminal-evidence.v1\0", "utf8");
const EVENT_SEQUENCE_DOMAIN = Buffer.from("gloops.paperclip-event-sequence.v1\0", "utf8");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface ResponseEntityEvidence {
  rawByteLength: number;
  rawSha256: string;
  canonicalSha256: string;
}

export interface ParsedJsonEntity {
  value: Record<string, unknown>;
  evidence: ResponseEntityEvidence;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Hermes terminal evidence field ${key} is required`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Hermes terminal evidence field ${key} must be a string`);
  }
  return value.trim();
}

function requiredNonnegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Hermes terminal evidence field ${key} must be a non-negative integer`);
  }
  return value as number;
}

function exactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function canonicalize(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (!record) throw new Error("Evidence contains a non-JSON value");
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalJsonDigest(value: unknown): string {
  return digestBytes(canonicalJsonBytes(value));
}

export function parseJsonEntityBytes(bytes: Uint8Array): ParsedJsonEntity {
  const body = Buffer.from(bytes);
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  const value = asRecord(parsed);
  if (!value) throw new Error("Hermes response body must be a JSON object");
  return {
    value,
    evidence: {
      rawByteLength: body.byteLength,
      rawSha256: digestBytes(body),
      canonicalSha256: canonicalJsonDigest(value),
    },
  };
}

export class EventStreamEvidenceAccumulator {
  private readonly rawHash: Hash = createHash("sha256");
  private readonly eventHash: Hash = createHash("sha256").update(EVENT_SEQUENCE_DOMAIN);
  private rawByteLength = 0;
  private eventCount = 0;
  private finalized = false;

  recordRawChunk(bytes: Uint8Array): void {
    if (this.finalized) throw new Error("Event stream evidence is already finalized");
    this.rawHash.update(bytes);
    this.rawByteLength += bytes.byteLength;
  }

  recordEvent(event: string | null, data: unknown): void {
    if (this.finalized) throw new Error("Event stream evidence is already finalized");
    const canonical = canonicalJsonBytes({ event, data });
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(canonical.byteLength));
    this.eventHash.update(length);
    this.eventHash.update(canonical);
    this.eventCount += 1;
  }

  finalize(): AdapterProviderIoTerminalEvidence["eventStream"] {
    if (this.finalized) throw new Error("Event stream evidence was finalized twice");
    this.finalized = true;
    return {
      rawByteLength: this.rawByteLength,
      rawSha256: `sha256:${this.rawHash.digest("hex")}`,
      canonicalEventSequenceSha256: `sha256:${this.eventHash.digest("hex")}`,
      eventCount: this.eventCount,
    };
  }
}

function parseUsageValue(value: unknown, label: string) {
  const record = asRecord(value);
  if (!record) throw new Error(`${label} must be an object`);
  exactKeys(record, ["present", "value"], label);
  if (typeof record.present !== "boolean") throw new Error(`${label}.present must be boolean`);
  const usageValue = requiredNonnegativeInteger(record, "value");
  return { present: record.present, value: usageValue };
}

function parseRoute(value: unknown, label: string) {
  const record = asRecord(value);
  if (!record) throw new Error(`${label} must be an object`);
  exactKeys(record, ["provider", "model", "transportClass", "billingClass"], label);
  return {
    provider: requiredString(record, "provider"),
    model: requiredString(record, "model"),
    transportClass: requiredString(record, "transportClass"),
    billingClass: requiredString(record, "billingClass"),
  };
}

export function parseHermesTerminalProjection(value: unknown): AdapterHermesTerminalEvidenceProjection {
  const record = asRecord(value);
  if (!record) throw new Error("Hermes terminal evidence projection is missing");
  exactKeys(record, [
    "schemaVersion",
    "hermesRunId",
    "requestByteLength",
    "requestSha256",
    "resolvedProvider",
    "resolvedModel",
    "transportClass",
    "billingClass",
    "fallbackPath",
    "inputUsage",
    "outputUsage",
    "cachedUsage",
    "usageSource",
    "turnTotal",
    "toolCallTotal",
    "terminalStatus",
  ], "Hermes terminal evidence projection");
  if (record.schemaVersion !== "gloops.hermes-terminal-evidence.v1") {
    throw new Error("Unsupported Hermes terminal evidence schema");
  }
  const requestSha256 = requiredString(record, "requestSha256");
  if (!SHA256.test(requestSha256)) throw new Error("Hermes request SHA-256 is malformed");
  const terminalStatus = requiredString(record, "terminalStatus");
  if (!TERMINAL_STATUSES.has(terminalStatus)) throw new Error("Hermes terminal status is unsupported");
  if (!Array.isArray(record.fallbackPath)) throw new Error("Hermes fallbackPath must be an array");
  return {
    schemaVersion: "gloops.hermes-terminal-evidence.v1",
    hermesRunId: requiredString(record, "hermesRunId"),
    requestByteLength: requiredNonnegativeInteger(record, "requestByteLength"),
    requestSha256,
    resolvedProvider: terminalStatus === "completed"
      ? requiredString(record, "resolvedProvider")
      : stringField(record, "resolvedProvider"),
    resolvedModel: terminalStatus === "completed"
      ? requiredString(record, "resolvedModel")
      : stringField(record, "resolvedModel"),
    transportClass: terminalStatus === "completed"
      ? requiredString(record, "transportClass")
      : stringField(record, "transportClass"),
    billingClass: terminalStatus === "completed"
      ? requiredString(record, "billingClass")
      : stringField(record, "billingClass"),
    fallbackPath: record.fallbackPath.map((entry, index) => parseRoute(entry, `fallbackPath[${index}]`)),
    inputUsage: parseUsageValue(record.inputUsage, "inputUsage"),
    outputUsage: parseUsageValue(record.outputUsage, "outputUsage"),
    cachedUsage: parseUsageValue(record.cachedUsage, "cachedUsage"),
    usageSource: requiredString(record, "usageSource"),
    turnTotal: requiredNonnegativeInteger(record, "turnTotal"),
    toolCallTotal: requiredNonnegativeInteger(record, "toolCallTotal"),
    terminalStatus: terminalStatus as AdapterHermesTerminalEvidenceProjection["terminalStatus"],
  };
}

function terminalEnvelope(value: Record<string, unknown>, label: string) {
  const projection = parseHermesTerminalProjection(value.terminalEvidence);
  const digest = requiredString(value, "terminalEvidenceDigest");
  if (!SHA256.test(digest)) throw new Error(`${label} terminal evidence digest is malformed`);
  const computed = createHash("sha256")
    .update(TERMINAL_DIGEST_DOMAIN)
    .update(canonicalJsonBytes(projection))
    .digest("hex");
  if (computed !== digest) throw new Error(`${label} terminal evidence digest does not match its projection`);
  return { projection, digest };
}

function topLevelRunId(value: Record<string, unknown>): string | null {
  const raw = value.run_id ?? value.runId ?? value.id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function topLevelStatus(value: Record<string, unknown>): string | null {
  const raw = value.status ?? (
    typeof value.event === "string" && value.event.startsWith("run.")
      ? value.event.slice(4)
      : null
  );
  if (raw === "canceled") return "cancelled";
  return typeof raw === "string" ? raw.toLowerCase() : null;
}

function reconcileLegacyUsage(
  payload: Record<string, unknown>,
  projection: AdapterHermesTerminalEvidenceProjection,
  label: string,
): void {
  const usage = asRecord(payload.usage);
  if (!usage) return;
  const checks: Array<[string, number]> = [
    ["input_tokens", projection.inputUsage.value],
    ["output_tokens", projection.outputUsage.value],
  ];
  for (const [key, expected] of checks) {
    if (usage[key] !== undefined && usage[key] !== expected) {
      throw new Error(`${label} ${key} contradicts Hermes terminal evidence`);
    }
  }
}

export function reconcileProviderIoEvidence(input: {
  preparedRequest: { requestByteLength: number; requestSha256: string };
  hermesRunId: string;
  createResponse: ParsedJsonEntity;
  eventStream: AdapterProviderIoTerminalEvidence["eventStream"];
  terminalEvent: Record<string, unknown>;
  finalStatusResponse: ParsedJsonEntity;
}): AdapterProviderIoTerminalEvidence {
  if (!PREFIXED_SHA256.test(input.preparedRequest.requestSha256)) {
    throw new Error("Prepared request SHA-256 is malformed");
  }
  if (input.eventStream.eventCount < 1 || input.eventStream.rawByteLength < 1) {
    throw new Error("Hermes terminal event stream evidence is missing");
  }
  const createdRunId = topLevelRunId(input.createResponse.value);
  const finalRunId = topLevelRunId(input.finalStatusResponse.value);
  if (createdRunId !== input.hermesRunId || finalRunId !== input.hermesRunId) {
    throw new Error("Hermes create/final run identity is missing or contradictory");
  }

  const terminal = terminalEnvelope(input.terminalEvent, "SSE terminal event");
  const final = terminalEnvelope(input.finalStatusResponse.value, "final status");
  if (
    terminal.digest !== final.digest
    || canonicalJsonDigest(terminal.projection) !== canonicalJsonDigest(final.projection)
  ) {
    throw new Error("Hermes SSE and final terminal evidence contradict each other");
  }
  const projection = terminal.projection;
  if (projection.hermesRunId !== input.hermesRunId) {
    throw new Error("Hermes terminal evidence run identity contradicts the created run");
  }
  if (
    projection.requestByteLength !== input.preparedRequest.requestByteLength
    || `sha256:${projection.requestSha256}` !== input.preparedRequest.requestSha256
  ) {
    throw new Error("Hermes received-request evidence contradicts Paperclip prepared evidence");
  }
  const eventStatus = topLevelStatus(input.terminalEvent);
  const finalStatus = topLevelStatus(input.finalStatusResponse.value);
  if (eventStatus !== projection.terminalStatus || finalStatus !== projection.terminalStatus) {
    throw new Error("Hermes terminal status is missing or contradictory");
  }
  if (projection.fallbackPath.length > 0) {
    const resolvedRoute = projection.fallbackPath[projection.fallbackPath.length - 1];
    if (
      resolvedRoute.provider !== projection.resolvedProvider
      || resolvedRoute.model !== projection.resolvedModel
      || resolvedRoute.transportClass !== projection.transportClass
      || resolvedRoute.billingClass !== projection.billingClass
    ) {
      throw new Error("Hermes resolved route contradicts its fallback path");
    }
  }
  if (projection.terminalStatus === "completed") {
    if (
      projection.fallbackPath.length < 1
      || !projection.resolvedProvider
      || !projection.resolvedModel
      || !projection.transportClass
      || !projection.billingClass
      || !projection.inputUsage.present
      || !projection.outputUsage.present
      || !projection.cachedUsage.present
      || projection.usageSource !== "provider_response_aggregate"
      || projection.turnTotal < 1
    ) {
      throw new Error("Completed Hermes run lacks authoritative usage or turn evidence");
    }
  }
  reconcileLegacyUsage(input.terminalEvent, projection, "SSE terminal event");
  reconcileLegacyUsage(input.finalStatusResponse.value, projection, "final status");

  return {
    schemaVersion: "gloops.provider-io-terminal.v1",
    preparedRequest: input.preparedRequest,
    hermesRunId: input.hermesRunId,
    createResponse: input.createResponse.evidence,
    eventStream: input.eventStream,
    finalStatusResponse: input.finalStatusResponse.evidence,
    terminalEvidence: projection,
    terminalEvidenceDigest: `sha256:${terminal.digest}`,
    rawPayloadDisposition: "not_retained",
    reconciledAt: new Date().toISOString(),
  };
}
