CREATE TABLE "provider_io_terminal_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"issue_id" uuid,
	"prepared_evidence_id" uuid NOT NULL,
	"hermes_run_id" text NOT NULL,
	"create_raw_byte_length" integer NOT NULL,
	"create_raw_sha256" text NOT NULL,
	"create_canonical_sha256" text NOT NULL,
	"event_raw_byte_length" integer NOT NULL,
	"event_raw_sha256" text NOT NULL,
	"event_canonical_sequence_sha256" text NOT NULL,
	"event_count" integer NOT NULL,
	"final_raw_byte_length" integer NOT NULL,
	"final_raw_sha256" text NOT NULL,
	"final_canonical_sha256" text NOT NULL,
	"terminal_evidence" jsonb NOT NULL,
	"terminal_evidence_digest" text NOT NULL,
	"raw_payload_disposition" text NOT NULL,
	"reconciled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_io_terminal_evidence_lengths_nonnegative" CHECK (
		"create_raw_byte_length" >= 0 AND
		"event_raw_byte_length" >= 0 AND
		"event_count" >= 0 AND
		"final_raw_byte_length" >= 0
	),
	CONSTRAINT "provider_io_terminal_evidence_digests_format" CHECK (
		"create_raw_sha256" ~ '^sha256:[0-9a-f]{64}$' AND
		"create_canonical_sha256" ~ '^sha256:[0-9a-f]{64}$' AND
		"event_raw_sha256" ~ '^sha256:[0-9a-f]{64}$' AND
		"event_canonical_sequence_sha256" ~ '^sha256:[0-9a-f]{64}$' AND
		"final_raw_sha256" ~ '^sha256:[0-9a-f]{64}$' AND
		"final_canonical_sha256" ~ '^sha256:[0-9a-f]{64}$' AND
		"terminal_evidence_digest" ~ '^sha256:[0-9a-f]{64}$'
	),
	CONSTRAINT "provider_io_terminal_evidence_raw_not_retained" CHECK (
		"raw_payload_disposition" = 'not_retained'
	)
);
--> statement-breakpoint
ALTER TABLE "provider_io_terminal_evidence" ADD CONSTRAINT "provider_io_terminal_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_io_terminal_evidence" ADD CONSTRAINT "provider_io_terminal_evidence_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_io_terminal_evidence" ADD CONSTRAINT "provider_io_terminal_evidence_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_io_terminal_evidence" ADD CONSTRAINT "provider_io_terminal_evidence_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "provider_io_terminal_evidence" ADD CONSTRAINT "provider_io_terminal_evidence_prepared_evidence_id_provider_request_evidence_id_fk" FOREIGN KEY ("prepared_evidence_id") REFERENCES "public"."provider_request_evidence"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_io_terminal_evidence_heartbeat_run_uq" ON "provider_io_terminal_evidence" USING btree ("heartbeat_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_io_terminal_evidence_prepared_evidence_uq" ON "provider_io_terminal_evidence" USING btree ("prepared_evidence_id");
--> statement-breakpoint
CREATE INDEX "provider_io_terminal_evidence_company_created_idx" ON "provider_io_terminal_evidence" USING btree ("company_id","created_at");
