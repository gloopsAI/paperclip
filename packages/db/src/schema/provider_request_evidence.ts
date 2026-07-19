import {
  index,
  integer,
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

export const providerRequestEvidence = pgTable(
  "provider_request_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id")
      .notNull()
      .references(() => heartbeatRuns.id),
    issueId: uuid("issue_id").references(() => issues.id),
    destinationClass: text("destination_class").notNull(),
    requestSchemaVersion: text("request_schema_version").notNull(),
    requestByteLength: integer("request_byte_length").notNull(),
    requestSha256: text("request_sha256").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestPreparedAt: timestamp("request_prepared_at", { withTimezone: true }).notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    heartbeatRunUq: uniqueIndex("provider_request_evidence_heartbeat_run_uq").on(
      table.heartbeatRunId,
    ),
    companyIdempotencyUq: uniqueIndex("provider_request_evidence_company_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    companyCreatedIdx: index("provider_request_evidence_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
