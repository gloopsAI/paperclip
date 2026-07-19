CREATE TABLE "repository_mutation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"repository_id" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"branch_ref" text NOT NULL,
	"mutation_class" text NOT NULL,
	"root_authorization_digest" text NOT NULL,
	"lease_digest" text NOT NULL,
	"nonce" text NOT NULL,
	"expected_old_oid" text NOT NULL,
	"expected_new_oid" text NOT NULL,
	"state" text NOT NULL,
	"broker_receipt_digest" text,
	"remote_old_oid" text,
	"remote_new_oid" text,
	"receipt" jsonb NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_mutation_receipts_schema" CHECK (
		"schema_version" = 'gloops.repository-mutation-receipt.v1'
	),
	CONSTRAINT "repository_mutation_receipts_class" CHECK (
		"mutation_class" = 'create_one_branch_ref'
	),
	CONSTRAINT "repository_mutation_receipts_state" CHECK (
		"state" IN ('prepared', 'reconciled_success', 'bounded_failure', 'conflict')
	),
	CONSTRAINT "repository_mutation_receipts_digests" CHECK (
		"root_authorization_digest" ~ '^sha256:[0-9a-f]{64}$'
		AND "lease_digest" ~ '^sha256:[0-9a-f]{64}$'
		AND (
			"broker_receipt_digest" IS NULL
			OR "broker_receipt_digest" ~ '^sha256:[0-9a-f]{64}$'
		)
	),
	CONSTRAINT "repository_mutation_receipts_oids" CHECK (
		"expected_old_oid" ~ '^[0-9a-f]{40,64}$'
		AND "expected_new_oid" ~ '^[0-9a-f]{40,64}$'
		AND ("remote_old_oid" IS NULL OR "remote_old_oid" ~ '^[0-9a-f]{40,64}$')
		AND ("remote_new_oid" IS NULL OR "remote_new_oid" ~ '^[0-9a-f]{40,64}$')
	),
	CONSTRAINT "repository_mutation_receipts_terminal_fields" CHECK (
		(
			"state" = 'prepared'
			AND "broker_receipt_digest" IS NULL
			AND "remote_old_oid" IS NULL
			AND "remote_new_oid" IS NULL
			AND "terminal_at" IS NULL
		)
		OR
		(
			"state" IN ('reconciled_success', 'bounded_failure', 'conflict')
			AND "broker_receipt_digest" IS NOT NULL
			AND "remote_old_oid" IS NOT NULL
			AND "remote_new_oid" IS NOT NULL
			AND "terminal_at" IS NOT NULL
		)
	)
);
--> statement-breakpoint
ALTER TABLE "repository_mutation_receipts" ADD CONSTRAINT "repository_mutation_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_mutation_receipts" ADD CONSTRAINT "repository_mutation_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_mutation_receipts" ADD CONSTRAINT "repository_mutation_receipts_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_mutation_receipts" ADD CONSTRAINT "repository_mutation_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_mutation_receipts" ADD CONSTRAINT "repository_mutation_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "repository_mutation_receipts" ADD CONSTRAINT "repository_mutation_receipts_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_mutation_receipts_heartbeat_run_uq" ON "repository_mutation_receipts" USING btree ("heartbeat_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_mutation_receipts_authorization_run_uq" ON "repository_mutation_receipts" USING btree ("root_authorization_digest","heartbeat_run_id","repository_id","mutation_class");
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_mutation_receipts_repository_branch_uq" ON "repository_mutation_receipts" USING btree ("repository_id","branch_ref");
--> statement-breakpoint
CREATE UNIQUE INDEX "repository_mutation_receipts_nonce_uq" ON "repository_mutation_receipts" USING btree ("nonce");
--> statement-breakpoint
CREATE INDEX "repository_mutation_receipts_company_prepared_idx" ON "repository_mutation_receipts" USING btree ("company_id","prepared_at");
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" DROP CONSTRAINT "heartbeat_run_settlements_mutation_disposition";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" DROP CONSTRAINT "heartbeat_run_settlements_broker_fields";
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_mutation_disposition" CHECK (
	"mutation_disposition" IN ('not_authorized', 'reconciled_success', 'bounded_failure', 'conflict')
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_broker_fields" CHECK (
	(
		"mutation_disposition" = 'not_authorized'
		AND "broker_receipt_digest" IS NULL
		AND "remote_old_oid" IS NULL
		AND "remote_new_oid" IS NULL
	)
	OR
	(
		"mutation_disposition" IN ('reconciled_success', 'bounded_failure', 'conflict')
		AND "broker_receipt_digest" ~ '^sha256:[0-9a-f]{64}$'
		AND "remote_old_oid" ~ '^[0-9a-f]{40,64}$'
		AND "remote_new_oid" ~ '^[0-9a-f]{40,64}$'
	)
);
