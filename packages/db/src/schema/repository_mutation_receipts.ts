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
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

export const repositoryMutationReceipts = pgTable(
  "repository_mutation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    schemaVersion: text("schema_version").notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    branchRef: text("branch_ref").notNull(),
    mutationClass: text("mutation_class").notNull(),
    rootAuthorizationDigest: text("root_authorization_digest").notNull(),
    leaseDigest: text("lease_digest").notNull(),
    nonce: text("nonce").notNull(),
    expectedOldOid: text("expected_old_oid").notNull(),
    expectedNewOid: text("expected_new_oid").notNull(),
    state: text("state").notNull(),
    brokerReceiptDigest: text("broker_receipt_digest"),
    remoteOldOid: text("remote_old_oid"),
    remoteNewOid: text("remote_new_oid"),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    heartbeatRunUq: uniqueIndex("repository_mutation_receipts_heartbeat_run_uq").on(
      table.heartbeatRunId,
    ),
    authorizationRunUq: uniqueIndex("repository_mutation_receipts_authorization_run_uq").on(
      table.rootAuthorizationDigest,
      table.heartbeatRunId,
      table.repositoryId,
      table.mutationClass,
    ),
    repositoryBranchUq: uniqueIndex("repository_mutation_receipts_repository_branch_uq").on(
      table.repositoryId,
      table.branchRef,
    ),
    nonceUq: uniqueIndex("repository_mutation_receipts_nonce_uq").on(table.nonce),
    companyPreparedIdx: index("repository_mutation_receipts_company_prepared_idx").on(
      table.companyId,
      table.preparedAt,
    ),
  }),
);
