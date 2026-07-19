CREATE TABLE "heartbeat_run_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"heartbeat_run_id" uuid NOT NULL,
	"provider_io_terminal_evidence_id" uuid NOT NULL,
	"cost_event_id" uuid NOT NULL,
	"terminal_status" text NOT NULL,
	"normalized_usage" jsonb NOT NULL,
	"accounting_continuation" jsonb NOT NULL,
	"mutation_disposition" text NOT NULL,
	"broker_receipt_digest" text,
	"remote_old_oid" text,
	"remote_new_oid" text,
	"settled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heartbeat_run_settlements_terminal_status" CHECK (
		"terminal_status" IN ('succeeded', 'failed', 'timed_out', 'cancelled')
	),
	CONSTRAINT "heartbeat_run_settlements_mutation_disposition" CHECK (
		"mutation_disposition" IN ('not_authorized', 'reconciled_success')
	),
	CONSTRAINT "heartbeat_run_settlements_broker_fields" CHECK (
		(
			"mutation_disposition" = 'not_authorized'
			AND "broker_receipt_digest" IS NULL
			AND "remote_old_oid" IS NULL
			AND "remote_new_oid" IS NULL
		)
		OR
		(
			"mutation_disposition" = 'reconciled_success'
			AND "broker_receipt_digest" ~ '^sha256:[0-9a-f]{64}$'
			AND "remote_old_oid" ~ '^[0-9a-f]{40,64}$'
			AND "remote_new_oid" ~ '^[0-9a-f]{40,64}$'
		)
	),
	CONSTRAINT "heartbeat_run_settlements_usage_shape" CHECK (
		jsonb_typeof("normalized_usage") = 'object'
		AND jsonb_typeof("normalized_usage"->'inputTokens') = 'number'
		AND jsonb_typeof("normalized_usage"->'cachedInputTokens') = 'number'
		AND jsonb_typeof("normalized_usage"->'outputTokens') = 'number'
		AND ("normalized_usage"->>'inputTokens')::bigint >= 0
		AND ("normalized_usage"->>'cachedInputTokens')::bigint >= 0
		AND ("normalized_usage"->>'outputTokens')::bigint >= 0
	)
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_provider_io_terminal_evidence_id_provider_io_terminal_evidence_id_fk" FOREIGN KEY ("provider_io_terminal_evidence_id") REFERENCES "public"."provider_io_terminal_evidence"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_settlements" ADD CONSTRAINT "heartbeat_run_settlements_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_settlements_heartbeat_run_uq" ON "heartbeat_run_settlements" USING btree ("heartbeat_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_settlements_provider_evidence_uq" ON "heartbeat_run_settlements" USING btree ("provider_io_terminal_evidence_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_settlements_cost_event_uq" ON "heartbeat_run_settlements" USING btree ("cost_event_id");
--> statement-breakpoint
CREATE INDEX "heartbeat_run_settlements_company_settled_idx" ON "heartbeat_run_settlements" USING btree ("company_id","settled_at");
