-- The pre-0153 route committed pending before worker dispatch. During this
-- migration the old server is stopped, so any surviving pending row is a
-- crash-stranded claim and must become explicitly retryable rather than a
-- permanent duplicate-suppression tombstone.
UPDATE "plugin_webhook_deliveries"
SET "status" = 'failed',
    "error" = 'migration_recovered_pretransaction_pending',
    "finished_at" = now()
WHERE "status" = 'pending';

-- Older registry callers could persist more than one audit row for the same
-- provider delivery ID. Keep every historical row, but nominate exactly one
-- canonical host claim before adding the uniqueness boundary. A successful
-- audit is terminal and therefore wins; otherwise the earliest audit wins.
-- Non-canonical rows retain their payload, raw headers, state, timings, and
-- errors. Their original external ID and canonical row are added to a
-- per-row migration header so the normalization remains independently
-- auditable without allowing those rows to participate in future claims.
WITH "ranked_external_deliveries" AS (
  SELECT
    "id",
    "external_id" AS "original_external_id",
    first_value("id") OVER (
      PARTITION BY "plugin_id", "webhook_key", "external_id"
      ORDER BY
        CASE WHEN "status" = 'success' THEN 0 ELSE 1 END,
        "created_at",
        "id"
    ) AS "canonical_delivery_id",
    row_number() OVER (
      PARTITION BY "plugin_id", "webhook_key", "external_id"
      ORDER BY
        CASE WHEN "status" = 'success' THEN 0 ELSE 1 END,
        "created_at",
        "id"
    ) AS "delivery_rank"
  FROM "plugin_webhook_deliveries"
  WHERE "external_id" IS NOT NULL
)
UPDATE "plugin_webhook_deliveries" AS "delivery"
SET
  "external_id" = NULL,
  "headers" = COALESCE("delivery"."headers", '{}'::jsonb) || jsonb_build_object(
    'paperclip-migration-0153-duplicate-' || "delivery"."id"::text,
    "ranked"."original_external_id" ||
      ';canonical_delivery_id=' || "ranked"."canonical_delivery_id"::text
  )
FROM "ranked_external_deliveries" AS "ranked"
WHERE "delivery"."id" = "ranked"."id"
  AND "ranked"."delivery_rank" > 1;

CREATE UNIQUE INDEX "plugin_webhook_deliveries_external_id_uq"
ON "plugin_webhook_deliveries" USING btree ("plugin_id", "webhook_key", "external_id")
WHERE "external_id" IS NOT NULL;
