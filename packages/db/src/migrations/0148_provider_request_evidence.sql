CREATE TABLE "provider_request_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"issue_id" uuid,
	"destination_class" text NOT NULL,
	"request_schema_version" text NOT NULL,
	"request_byte_length" integer NOT NULL,
	"request_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_prepared_at" timestamp with time zone NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_request_evidence_request_byte_length_nonnegative" CHECK ("request_byte_length" >= 0),
	CONSTRAINT "provider_request_evidence_request_sha256_format" CHECK ("request_sha256" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "provider_request_evidence" ADD CONSTRAINT "provider_request_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_request_evidence" ADD CONSTRAINT "provider_request_evidence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_request_evidence" ADD CONSTRAINT "provider_request_evidence_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_request_evidence" ADD CONSTRAINT "provider_request_evidence_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_request_evidence_heartbeat_run_uq" ON "provider_request_evidence" USING btree ("heartbeat_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_request_evidence_company_idempotency_uq" ON "provider_request_evidence" USING btree ("company_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "provider_request_evidence_company_created_idx" ON "provider_request_evidence" USING btree ("company_id","created_at");
