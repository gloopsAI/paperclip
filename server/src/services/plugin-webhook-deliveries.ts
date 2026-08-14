import { and, eq } from "drizzle-orm";
import { pluginWebhookDeliveries, type Db } from "@paperclipai/db";

const EXTERNAL_DELIVERY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type ClaimedPluginWebhookDelivery = {
  deliveryId: string;
  dispatch: boolean;
  status: "pending" | "success" | "failed";
};

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
 * Atomically creates or reclaims one persisted delivery row.
 *
 * A successful or in-flight external delivery is idempotent: the same
 * (plugin, endpoint, external ID) returns the existing row and never dispatches
 * the worker twice. A failed row can be reclaimed exactly once so a provider
 * redelivery can recover without creating a second audit record.
 */
export async function claimPluginWebhookDelivery(
  db: DbTransaction,
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
  if (existing.status !== "failed") {
    return { deliveryId: existing.id, dispatch: false, status: existing.status };
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
  return { deliveryId: raced.id, dispatch: false, status: raced.status };
}

/**
 * Persist, dispatch, and terminally receipt one delivery in one transaction.
 *
 * Keeping the pending row uncommitted across the bounded worker RPC removes
 * the crash-before-dispatch tombstone: a process/connection loss rolls the
 * row back, while a concurrent duplicate waits on the unique external-ID
 * constraint and then observes the committed terminal state. The provider's
 * external ID is also the stable worker requestId, so a crash after the worker
 * commits but before this transaction commits is an at-least-once replay with
 * a stable plugin idempotency key rather than a second logical request.
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
  return db.transaction(async (tx) => {
    const delivery = await claimPluginWebhookDelivery(tx, input);
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
      await tx
        .update(pluginWebhookDeliveries)
        .set({
          status: "failed",
          durationMs,
          error: message,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.deliveryId));
      return {
        deliveryId: delivery.deliveryId,
        duplicate: false,
        status: "failed",
        durationMs,
        error: message,
      };
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - input.startedAt.getTime();
    await tx
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
  });
}
