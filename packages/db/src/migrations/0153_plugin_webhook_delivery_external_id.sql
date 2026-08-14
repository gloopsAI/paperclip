-- The pre-0153 route committed pending before worker dispatch. During this
-- migration the old server is stopped, so any surviving pending row is a
-- crash-stranded claim and must become explicitly retryable rather than a
-- permanent duplicate-suppression tombstone.
UPDATE "plugin_webhook_deliveries"
SET "status" = 'failed',
    "error" = 'migration_recovered_pretransaction_pending',
    "finished_at" = now()
WHERE "status" = 'pending';

CREATE UNIQUE INDEX "plugin_webhook_deliveries_external_id_uq"
ON "plugin_webhook_deliveries" USING btree ("plugin_id", "webhook_key", "external_id")
WHERE "external_id" IS NOT NULL;
