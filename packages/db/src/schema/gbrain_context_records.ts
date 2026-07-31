import { index, text, timestamp, uniqueIndex, uuid, pgTable } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Provenance-bound, advisory inputs for GBrain retrieval. These are compact
 * projections, never a copy of a source system's raw transcript or authority.
 */
export const gbrainContextRecords = pgTable(
  "gbrain_context_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceKind: text("source_kind").notNull(),
    sourceUri: text("source_uri").notNull(),
    sourceEventId: text("source_event_id"),
    sourceAuthor: text("source_author"),
    visibility: text("visibility").notNull().default("company"),
    summary: text("summary").notNull(),
    contentDigest: text("content_digest").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceDigestUq: uniqueIndex("gbrain_context_records_company_source_digest_uq").on(
      table.companyId,
      table.sourceUri,
      table.contentDigest,
    ),
    companyKindOccurredIdx: index("gbrain_context_records_company_kind_occurred_idx").on(
      table.companyId,
      table.sourceKind,
      table.occurredAt,
    ),
    companyExpiryIdx: index("gbrain_context_records_company_expiry_idx").on(
      table.companyId,
      table.expiresAt,
    ),
  }),
);
