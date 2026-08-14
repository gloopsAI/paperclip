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

/**
 * Durable run -> issue projection outbox.
 *
 * The row is committed in the same transaction as the state it represents.
 * Delivery into issue_comments is a separate idempotent transaction, so a
 * temporarily unavailable task bridge never changes terminal run truth.
 */
export const heartbeatRunIssueProjections = pgTable(
  "heartbeat_run_issue_projections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    bodySha256: text("body_sha256").notNull(),
    exactHeadSha: text("exact_head_sha"),
    disposition: text("disposition"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredCommentId: uuid("delivered_comment_id"),
    lastErrorClass: text("last_error_class"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runKindUq: uniqueIndex("heartbeat_run_issue_projections_run_kind_uq").on(
      table.heartbeatRunId,
      table.kind,
    ),
    pendingIdx: index("heartbeat_run_issue_projections_pending_idx").on(
      table.status,
      table.availableAt,
      table.createdAt,
    ),
    companyIssueIdx: index("heartbeat_run_issue_projections_company_issue_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  }),
);
