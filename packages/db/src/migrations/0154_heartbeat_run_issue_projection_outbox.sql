CREATE TABLE "heartbeat_run_issue_projections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"heartbeat_run_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	"exact_head_sha" text,
	"disposition" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_comment_id" uuid,
	"last_error_class" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_run_issue_projections_schema" CHECK (
		"schema_version" = 'gloops.heartbeat-run-issue-projection.v1'
	),
	CONSTRAINT "heartbeat_run_issue_projections_kind" CHECK (
		"kind" IN ('workspace_readiness', 'review_verdict')
	),
	CONSTRAINT "heartbeat_run_issue_projections_status" CHECK (
		"status" IN ('pending', 'delivered')
	),
	CONSTRAINT "heartbeat_run_issue_projections_body_digest" CHECK (
		"body_sha256" ~ '^sha256:[0-9a-f]{64}$'
	),
	CONSTRAINT "heartbeat_run_issue_projections_head" CHECK (
		"exact_head_sha" IS NULL OR "exact_head_sha" ~ '^[0-9a-f]{40}$'
	),
	CONSTRAINT "heartbeat_run_issue_projections_disposition" CHECK (
		("kind" = 'workspace_readiness' AND "disposition" IS NULL)
		OR
		("kind" = 'review_verdict' AND "disposition" IN ('accepted', 'rejected', 'escalated') AND "exact_head_sha" IS NOT NULL)
	),
	CONSTRAINT "heartbeat_run_issue_projections_delivery" CHECK (
		("status" = 'pending' AND "delivered_comment_id" IS NULL AND "delivered_at" IS NULL)
		OR
		("status" = 'delivered' AND "delivered_comment_id" IS NOT NULL AND "delivered_at" IS NOT NULL)
	)
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_issue_projections" ADD CONSTRAINT "heartbeat_run_issue_projections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_issue_projections" ADD CONSTRAINT "heartbeat_run_issue_projections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_issue_projections" ADD CONSTRAINT "heartbeat_run_issue_projections_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_issue_projections" ADD CONSTRAINT "heartbeat_run_issue_projections_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_issue_projections_run_kind_uq" ON "heartbeat_run_issue_projections" USING btree ("heartbeat_run_id", "kind");
--> statement-breakpoint
CREATE INDEX "heartbeat_run_issue_projections_pending_idx" ON "heartbeat_run_issue_projections" USING btree ("status", "available_at", "created_at");
--> statement-breakpoint
CREATE INDEX "heartbeat_run_issue_projections_company_issue_idx" ON "heartbeat_run_issue_projections" USING btree ("company_id", "issue_id", "created_at");
