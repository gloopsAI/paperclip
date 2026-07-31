import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, gbrainContextRecords } from "@paperclipai/db";

export const GBRAIN_CONTEXT_RECORD_SCHEMA = "gloops.context-record.v1" as const;
export const GBRAIN_CONTEXT_SOURCE_KINDS = [
  "buzz_thread_summary",
  "paperclip_work_receipt",
  "knowledge_document",
] as const;
export type GbrainContextSourceKind = (typeof GBRAIN_CONTEXT_SOURCE_KINDS)[number];

export type GbrainContextRecordInput = {
  sourceKind: GbrainContextSourceKind;
  sourceUri: string;
  sourceEventId?: string | null;
  sourceAuthor?: string | null;
  summary: string;
  occurredAt: string;
  expiresAt?: string | null;
};

export type GbrainContextRecord = {
  id: string;
  companyId: string;
  sourceKind: GbrainContextSourceKind;
  sourceUri: string;
  sourceEventId: string | null;
  sourceAuthor: string | null;
  summary: string;
  contentDigest: string;
  occurredAt: string;
  expiresAt: string | null;
};

const MAX_SOURCE_URI = 1024;
const MAX_EVENT_ID = 256;
const MAX_AUTHOR = 256;
const MAX_SUMMARY = 6000;

export class GbrainContextRecordValidationError extends Error {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bounded(value: unknown, field: string, max: number, required = true): string | null {
  if (typeof value !== "string") {
    if (required) throw new GbrainContextRecordValidationError(`${field} is required`);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new GbrainContextRecordValidationError(`${field} is required`);
    return null;
  }
  if (trimmed.length > max) {
    throw new GbrainContextRecordValidationError(`${field} exceeds ${max} characters`);
  }
  return trimmed;
}

function iso(value: unknown, field: string, required = true): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) throw new GbrainContextRecordValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new GbrainContextRecordValidationError(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

export function normalizeGbrainContextRecord(input: GbrainContextRecordInput): Required<GbrainContextRecordInput> {
  if (!GBRAIN_CONTEXT_SOURCE_KINDS.includes(input.sourceKind)) {
    throw new GbrainContextRecordValidationError("sourceKind is unsupported");
  }
  const occurredAt = iso(input.occurredAt, "occurredAt")!;
  const expiresAt = iso(input.expiresAt, "expiresAt", false);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(occurredAt)) {
    throw new GbrainContextRecordValidationError("expiresAt must be after occurredAt");
  }
  return {
    sourceKind: input.sourceKind,
    sourceUri: bounded(input.sourceUri, "sourceUri", MAX_SOURCE_URI)!,
    sourceEventId: bounded(input.sourceEventId, "sourceEventId", MAX_EVENT_ID, false) ?? "",
    sourceAuthor: bounded(input.sourceAuthor, "sourceAuthor", MAX_AUTHOR, false) ?? "",
    summary: bounded(input.summary, "summary", MAX_SUMMARY)!,
    occurredAt,
    expiresAt: expiresAt ?? "",
  };
}

export function gbrainContextRecordDigest(input: GbrainContextRecordInput): string {
  const normalized = normalizeGbrainContextRecord(input);
  return `sha256:${createHash("sha256")
    .update("gloops.context-record.v1")
    .update("\0")
    .update(canonicalJson(normalized))
    .digest("hex")}`;
}

function toRecord(row: typeof gbrainContextRecords.$inferSelect): GbrainContextRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceKind: row.sourceKind as GbrainContextSourceKind,
    sourceUri: row.sourceUri,
    sourceEventId: row.sourceEventId,
    sourceAuthor: row.sourceAuthor,
    summary: row.summary,
    contentDigest: row.contentDigest,
    occurredAt: row.occurredAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

function paperclipActivityRecord(
  companyId: string,
  row: typeof activityLog.$inferSelect,
): GbrainContextRecord {
  const sourceUri = `paperclip://company/${companyId}/activity/${row.id}`;
  const summary = `Paperclip work receipt: ${row.action} on ${row.entityType}/${row.entityId}.`;
  const occurredAt = row.createdAt.toISOString();
  return {
    id: `activity:${row.id}`,
    companyId,
    sourceKind: "paperclip_work_receipt",
    sourceUri,
    sourceEventId: row.id,
    sourceAuthor: `${row.actorType}:${row.actorId}`,
    summary,
    contentDigest: gbrainContextRecordDigest({
      sourceKind: "paperclip_work_receipt",
      sourceUri,
      sourceEventId: row.id,
      sourceAuthor: `${row.actorType}:${row.actorId}`,
      summary,
      occurredAt,
    }),
    occurredAt,
    expiresAt: null,
  };
}

export function gbrainContextRecordService(db: Db) {
  return {
    async ingest(companyId: string, input: GbrainContextRecordInput): Promise<{ record: GbrainContextRecord; created: boolean }> {
      const normalized = normalizeGbrainContextRecord(input);
      const contentDigest = gbrainContextRecordDigest(normalized);
      const [inserted] = await db.insert(gbrainContextRecords).values({
        schemaVersion: GBRAIN_CONTEXT_RECORD_SCHEMA,
        companyId,
        sourceKind: normalized.sourceKind,
        sourceUri: normalized.sourceUri,
        sourceEventId: normalized.sourceEventId || null,
        sourceAuthor: normalized.sourceAuthor || null,
        visibility: "company",
        summary: normalized.summary,
        contentDigest,
        occurredAt: new Date(normalized.occurredAt),
        expiresAt: normalized.expiresAt ? new Date(normalized.expiresAt) : null,
      }).onConflictDoNothing().returning();
      if (inserted) return { record: toRecord(inserted), created: true };

      const [existing] = await db.select().from(gbrainContextRecords).where(and(
        eq(gbrainContextRecords.companyId, companyId),
        eq(gbrainContextRecords.sourceUri, normalized.sourceUri),
        eq(gbrainContextRecords.contentDigest, contentDigest),
      )).limit(1);
      if (!existing) throw new Error("GBrain context record idempotency lookup failed");
      return { record: toRecord(existing), created: false };
    },

    async retrieve(companyId: string, input: {
      goal: string;
      sourceKinds?: readonly GbrainContextSourceKind[];
      limit: number;
      now: Date;
    }): Promise<Array<GbrainContextRecord & { whyIncluded: string }>> {
      const stored = await db.select().from(gbrainContextRecords).where(and(
        eq(gbrainContextRecords.companyId, companyId),
        eq(gbrainContextRecords.visibility, "company"),
        or(isNull(gbrainContextRecords.expiresAt), gt(gbrainContextRecords.expiresAt, input.now)),
      )).orderBy(desc(gbrainContextRecords.occurredAt)).limit(100);
      // Paperclip is already the durable receipt plane. Project its most
      // recent auditable mutations at read time rather than creating a second
      // unsynchronized copy of its work log.
      const activity = await db.select().from(activityLog).where(
        eq(activityLog.companyId, companyId),
      ).orderBy(desc(activityLog.createdAt)).limit(25);
      const candidates = [
        ...stored.map(toRecord),
        ...activity.map((row) => paperclipActivityRecord(companyId, row)),
      ];
      const terms = new Set(input.goal.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []);
      const kindSet = input.sourceKinds?.length ? new Set(input.sourceKinds) : null;
      return candidates
        .filter((record) => !kindSet || kindSet.has(record.sourceKind))
        .map((record) => {
          const matches = [...terms].filter((term) => record.summary.toLowerCase().includes(term));
          return { record, matches };
        })
        .sort(
          (a, b) =>
            b.matches.length - a.matches.length
            || Date.parse(b.record.occurredAt) - Date.parse(a.record.occurredAt),
        )
        .slice(0, input.limit)
        .map(({ record, matches }) => ({
          ...record,
          whyIncluded: matches.length > 0 ? `goal_term_overlap:${matches.slice(0, 4).join(",")}` : "recent_company_context",
        }));
    },
  };
}
