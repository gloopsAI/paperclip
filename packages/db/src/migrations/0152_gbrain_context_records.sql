-- Append-only, company-scoped context projections. Source systems retain raw
-- transcripts and documents; this table carries bounded, cited summaries only.
CREATE TABLE "gbrain_context_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schema_version" text NOT NULL,
	"company_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_uri" text NOT NULL,
	"source_event_id" text,
	"source_author" text,
	"visibility" text DEFAULT 'company' NOT NULL,
	"summary" text NOT NULL,
	"content_digest" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gbrain_context_records_schema" CHECK (
		"schema_version" = 'gloops.context-record.v1'
	),
	CONSTRAINT "gbrain_context_records_source_kind" CHECK (
		"source_kind" IN ('buzz_thread_summary', 'paperclip_work_receipt', 'knowledge_document')
	),
	CONSTRAINT "gbrain_context_records_visibility" CHECK (
		"visibility" = 'company'
	),
	CONSTRAINT "gbrain_context_records_digest" CHECK (
		"content_digest" ~ '^sha256:[0-9a-f]{64}$'
	),
	CONSTRAINT "gbrain_context_records_expiry" CHECK (
		"expires_at" IS NULL OR "expires_at" > "occurred_at"
	)
);
--> statement-breakpoint
ALTER TABLE "gbrain_context_records" ADD CONSTRAINT "gbrain_context_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "gbrain_context_records_company_source_digest_uq" ON "gbrain_context_records" USING btree ("company_id","source_uri","content_digest");
--> statement-breakpoint
CREATE INDEX "gbrain_context_records_company_kind_occurred_idx" ON "gbrain_context_records" USING btree ("company_id","source_kind","occurred_at");
--> statement-breakpoint
CREATE INDEX "gbrain_context_records_company_expiry_idx" ON "gbrain_context_records" USING btree ("company_id","expires_at");
