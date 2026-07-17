import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentWakeupIdempotency = pgTable(
  "agent_wakeup_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    outcomeKind: text("outcome_kind").notNull(),
    runId: uuid("run_id"),
    errorStatus: integer("error_status"),
    errorMessage: text("error_message"),
    errorDetails: jsonb("error_details").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentKeyUq: uniqueIndex("agent_wakeup_idempotency_company_agent_key_uq").on(
      table.companyId,
      table.agentId,
      table.idempotencyKey,
    ),
    companyCreatedIdx: index("agent_wakeup_idempotency_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
