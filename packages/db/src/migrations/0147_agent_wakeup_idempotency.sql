CREATE TABLE "agent_wakeup_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"outcome_kind" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_wakeup_idempotency" ADD CONSTRAINT "agent_wakeup_idempotency_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_idempotency" ADD CONSTRAINT "agent_wakeup_idempotency_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakeup_idempotency_company_agent_key_uq" ON "agent_wakeup_idempotency" USING btree ("company_id","agent_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "agent_wakeup_idempotency_company_created_idx" ON "agent_wakeup_idempotency" USING btree ("company_id","created_at");
