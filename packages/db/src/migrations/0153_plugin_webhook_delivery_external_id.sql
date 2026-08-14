CREATE UNIQUE INDEX "plugin_webhook_deliveries_external_id_uq"
ON "plugin_webhook_deliveries" USING btree ("plugin_id", "webhook_key", "external_id")
WHERE "external_id" IS NOT NULL;
