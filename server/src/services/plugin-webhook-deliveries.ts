import { and, eq } from "drizzle-orm";
import { pluginWebhookDeliveries, type Db } from "@paperclipai/db";

const EXTERNAL_DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type ClaimedPluginWebhookDelivery = {
  deliveryId: string;
  dispatch: boolean;
  status: "pending" | "success" | "failed";
};

export type ProcessedPluginWebhookDelivery = {
  deliveryId: string;
  duplicate: boolean;
  status: "pending" | "success" | "failed";
  durationMs?: number;
  error?: string;
};

export function parsePluginWebhookExternalId(
  value: string | string[] | undefined,
): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error("webhook external delivery id is ambiguous");
    value = value[0];
  }
  if (!value || !EXTERNAL_DELIVERY_ID.test(value)) {
    throw new Error("webhook external delivery id is invalid");
  }
  return value;
}

/**
 * Creates or reclaims one recoverable host audit row.
 *
 * A successful external delivery is terminal. Pending and failed deliveries
 * remain dispatchable with the same stable external ID. This is deliberately
 * at-least-once transport: the plugin worker owns the atomic logical-effect
 * claim, so a host crash or terminal-audit failure cannot leave a tombstone
 * that permanently suppresses recovery.
 */
export async function claimPluginWebhookDelivery(
  db: Db,
  input: {
    pluginId: string;
    webhookKey: string;
    externalId: string | null;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    startedAt: Date;
  },
): Promise<ClaimedPluginWebhookDelivery> {
  const inserted = await db
    .insert(pluginWebhookDeliveries)
    .values({
      pluginId: input.pluginId,
      webhookKey: input.webhookKey,
      externalId: input.externalId,
      status: "pending",
      payload: input.payload,
      headers: input.headers,
      startedAt: input.startedAt,
    })
    .onConflictDoNothing()
    .returning({ id: pluginWebhookDeliveries.id, status: pluginWebhookDeliveries.status })
    .then((rows) => rows[0] ?? null);

  if (inserted) {
    return { deliveryId: inserted.id, dispatch: true, status: inserted.status };
  }
  if (!input.externalId) {
    throw new Error("webhook delivery insert conflicted without an external id");
  }

  const existing = await db
    .select({ id: pluginWebhookDeliveries.id, status: pluginWebhookDeliveries.status })
    .from(pluginWebhookDeliveries)
    .where(and(
      eq(pluginWebhookDeliveries.pluginId, input.pluginId),
      eq(pluginWebhookDeliveries.webhookKey, input.webhookKey),
      eq(pluginWebhookDeliveries.externalId, input.externalId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!existing) {
    throw new Error("webhook delivery conflict could not be resolved");
  }
  if (existing.status === "success") {
    return { deliveryId: existing.id, dispatch: false, status: existing.status };
  }
  if (existing.status === "pending") {
    return { deliveryId: existing.id, dispatch: true, status: existing.status };
  }

  const reclaimed = await db
    .update(pluginWebhookDeliveries)
    .set({
      status: "pending",
      payload: input.payload,
      headers: input.headers,
      startedAt: input.startedAt,
      finishedAt: null,
      durationMs: null,
      error: null,
    })
    .where(and(
      eq(pluginWebhookDeliveries.id, existing.id),
      eq(pluginWebhookDeliveries.status, "failed"),
    ))
    .returning({ id: pluginWebhookDeliveries.id, status: pluginWebhookDeliveries.status })
    .then((rows) => rows[0] ?? null);
  if (reclaimed) {
    return { deliveryId: reclaimed.id, dispatch: true, status: reclaimed.status };
  }

  const raced = await db
    .select({ id: pluginWebhookDeliveries.id, status: pluginWebhookDeliveries.status })
    .from(pluginWebhookDeliveries)
    .where(eq(pluginWebhookDeliveries.id, existing.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!raced) throw new Error("webhook delivery disappeared during reclaim");
  return {
    deliveryId: raced.id,
    dispatch: raced.status !== "success",
    status: raced.status,
  };
}

/**
 * Dispatch one recoverable at-least-once delivery and update its host audit.
 *
 * No database connection or transaction is held across the worker RPC. The
 * provider's external ID is the stable worker requestId; handlers that create
 * side effects must atomically claim it. A crash after worker completion or a
 * success-bookkeeping failure therefore leaves a retryable pending audit, and
 * redelivery safely re-enters the worker with the same logical key.
 */
export async function processPluginWebhookDelivery(
  db: Db,
  input: {
    pluginId: string;
    webhookKey: string;
    externalId: string | null;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    startedAt: Date;
  },
  dispatch: (claim: { deliveryId: string; requestId: string }) => Promise<void>,
): Promise<ProcessedPluginWebhookDelivery> {
  const delivery = await claimPluginWebhookDelivery(db, input);
  if (!delivery.dispatch) {
    return {
      deliveryId: delivery.deliveryId,
      duplicate: true,
      status: delivery.status,
    };
  }

  const requestId = input.externalId ?? delivery.deliveryId;
  try {
    await dispatch({ deliveryId: delivery.deliveryId, requestId });
  } catch (error) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - input.startedAt.getTime();
    const message = error instanceof Error ? error.message : String(error);
    const failed = await db
      .update(pluginWebhookDeliveries)
      .set({
        status: "failed",
        durationMs,
        error: message,
        finishedAt,
      })
      .where(and(
        eq(pluginWebhookDeliveries.id, delivery.deliveryId),
        eq(pluginWebhookDeliveries.status, "pending"),
      ))
      .returning({ status: pluginWebhookDeliveries.status })
      .then((rows) => rows[0] ?? null);
    if (failed) {
      return {
        deliveryId: delivery.deliveryId,
        duplicate: false,
        status: "failed",
        durationMs,
        error: message,
      };
    }
    const raced = await db
      .select({ status: pluginWebhookDeliveries.status })
      .from(pluginWebhookDeliveries)
      .where(eq(pluginWebhookDeliveries.id, delivery.deliveryId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (raced?.status === "success") {
      return {
        deliveryId: delivery.deliveryId,
        duplicate: true,
        status: "success",
      };
    }
    throw new Error("webhook delivery could not record worker failure");
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - input.startedAt.getTime();
  await db
    .update(pluginWebhookDeliveries)
    .set({
      status: "success",
      durationMs,
      error: null,
      finishedAt,
    })
    .where(eq(pluginWebhookDeliveries.id, delivery.deliveryId));
    return {
      deliveryId: delivery.deliveryId,
      duplicate: false,
      status: "success",
      durationMs,
    };
}
