import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { providerRequestEvidence } from "./provider_request_evidence.js";

export const providerIoTerminalEvidence = pgTable(
  "provider_io_terminal_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    issueId: uuid("issue_id").references(() => issues.id),
    preparedEvidenceId: uuid("prepared_evidence_id")
      .notNull()
      .references(() => providerRequestEvidence.id),
    hermesRunId: text("hermes_run_id").notNull(),
    createRawByteLength: integer("create_raw_byte_length").notNull(),
    createRawSha256: text("create_raw_sha256").notNull(),
    createCanonicalSha256: text("create_canonical_sha256").notNull(),
    eventRawByteLength: integer("event_raw_byte_length").notNull(),
    eventRawSha256: text("event_raw_sha256").notNull(),
    eventCanonicalSequenceSha256: text("event_canonical_sequence_sha256").notNull(),
    eventCount: integer("event_count").notNull(),
    finalRawByteLength: integer("final_raw_byte_length").notNull(),
    finalRawSha256: text("final_raw_sha256").notNull(),
    finalCanonicalSha256: text("final_canonical_sha256").notNull(),
    terminalEvidence: jsonb("terminal_evidence")
      .$type<Record<string, unknown>>()
      .notNull(),
    terminalEvidenceDigest: text("terminal_evidence_digest").notNull(),
    rawPayloadDisposition: text("raw_payload_disposition").notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    heartbeatRunUq: uniqueIndex("provider_io_terminal_evidence_heartbeat_run_uq").on(
      table.heartbeatRunId,
    ),
    preparedEvidenceUq: uniqueIndex("provider_io_terminal_evidence_prepared_evidence_uq").on(
      table.preparedEvidenceId,
    ),
    companyCreatedIdx: index("provider_io_terminal_evidence_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
