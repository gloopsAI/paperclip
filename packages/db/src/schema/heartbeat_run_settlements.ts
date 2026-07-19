import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { providerIoTerminalEvidence } from "./provider_io_terminal_evidence.js";

export const heartbeatRunSettlements = pgTable(
  "heartbeat_run_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    providerIoTerminalEvidenceId: uuid("provider_io_terminal_evidence_id")
      .notNull()
      .references(() => providerIoTerminalEvidence.id),
    costEventId: uuid("cost_event_id").notNull().references(() => costEvents.id),
    terminalStatus: text("terminal_status").notNull(),
    normalizedUsage: jsonb("normalized_usage")
      .$type<{
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
      }>()
      .notNull(),
    accountingContinuation: jsonb("accounting_continuation")
      .$type<Record<string, unknown>>()
      .notNull(),
    mutationDisposition: text("mutation_disposition").notNull(),
    brokerReceiptDigest: text("broker_receipt_digest"),
    remoteOldOid: text("remote_old_oid"),
    remoteNewOid: text("remote_new_oid"),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    heartbeatRunUq: uniqueIndex("heartbeat_run_settlements_heartbeat_run_uq").on(
      table.heartbeatRunId,
    ),
    providerEvidenceUq: uniqueIndex("heartbeat_run_settlements_provider_evidence_uq").on(
      table.providerIoTerminalEvidenceId,
    ),
    costEventUq: uniqueIndex("heartbeat_run_settlements_cost_event_uq").on(
      table.costEventId,
    ),
    companySettledIdx: index("heartbeat_run_settlements_company_settled_idx").on(
      table.companyId,
      table.settledAt,
    ),
  }),
);
