import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  heartbeatRunIssueProjections,
  issueComments,
} from "@paperclipai/db";
import { buildHeartbeatRunIssueComment } from "./heartbeat-run-summary.js";
import { classifyReviewVerdict, type ReviewVerdict } from "./review-path-slo.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const PROJECTION_SCHEMA_VERSION = "gloops.heartbeat-run-issue-projection.v1";
const MAX_DRAIN_LIMIT = 100;

export type HeartbeatRunIssueProjectionKind = "workspace_readiness" | "review_verdict";

export type HeartbeatRunIssueProjectionInput = {
  companyId: string;
  agentId: string | null;
  heartbeatRunId: string;
  issueId: string;
  kind: HeartbeatRunIssueProjectionKind;
  body: string;
  exactHeadSha: string | null;
  disposition: Exclude<ReviewVerdict, "unknown"> | null;
};

export type ReviewVerdictProjectionCandidate = HeartbeatRunIssueProjectionInput & {
  kind: "review_verdict";
  exactHeadSha: string;
  disposition: Exclude<ReviewVerdict, "unknown">;
};

export class HeartbeatRunIssueProjectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeartbeatRunIssueProjectionConflictError";
  }
}

export function issueProjectionBodySha256(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function normalizeProjectionInput(input: HeartbeatRunIssueProjectionInput) {
  const body = input.body.trim();
  if (!body) {
    throw new HeartbeatRunIssueProjectionConflictError("Issue projection body must not be empty");
  }
  const exactHeadSha = input.exactHeadSha?.trim().toLowerCase() ?? null;
  if (exactHeadSha !== null && !FULL_SHA_RE.test(exactHeadSha)) {
    throw new HeartbeatRunIssueProjectionConflictError(
      "Issue projection exact head must be a full 40-character SHA",
    );
  }
  if (input.kind === "review_verdict") {
    if (!exactHeadSha || input.disposition == null) {
      throw new HeartbeatRunIssueProjectionConflictError(
        "Review verdict projection requires an exact head and typed disposition",
      );
    }
    if (!body.toLowerCase().includes(exactHeadSha)) {
      throw new HeartbeatRunIssueProjectionConflictError(
        "Review verdict body must name the exact reviewed head",
      );
    }
  } else if (input.disposition !== null) {
    throw new HeartbeatRunIssueProjectionConflictError(
      "Workspace readiness projection cannot carry a review disposition",
    );
  }
  return {
    ...input,
    body,
    bodySha256: issueProjectionBodySha256(body),
    exactHeadSha,
  };
}

/**
 * Derive a terminal review projection only from a successful, typed verdict
 * that names the exact reviewed head. Unknown/ambiguous output remains subject
 * to the existing missing-disposition policy instead of being made authoritative.
 */
export function buildReviewVerdictProjection(input: {
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
  issueId: string;
  terminalStatus: string;
  exactHeadSha: string | null | undefined;
  resultJson: Record<string, unknown> | null;
  workMode?: string | null;
}): ReviewVerdictProjectionCandidate | null {
  if (input.terminalStatus !== "succeeded") return null;
  const exactHeadSha = input.exactHeadSha?.trim().toLowerCase() ?? null;
  if (!exactHeadSha || !FULL_SHA_RE.test(exactHeadSha)) return null;
  const disposition = classifyReviewVerdict(input.resultJson, { status: input.terminalStatus });
  if (disposition === "unknown") return null;
  const body = buildHeartbeatRunIssueComment(input.resultJson, { workMode: input.workMode });
  if (!body || !body.toLowerCase().includes(exactHeadSha)) return null;
  return normalizeProjectionInput({
    companyId: input.companyId,
    agentId: input.agentId,
    heartbeatRunId: input.heartbeatRunId,
    issueId: input.issueId,
    kind: "review_verdict",
    body,
    exactHeadSha,
    disposition,
  }) as ReviewVerdictProjectionCandidate;
}

function assertProjectionReplayMatches(
  existing: typeof heartbeatRunIssueProjections.$inferSelect,
  normalized: ReturnType<typeof normalizeProjectionInput>,
) {
  if (
    existing.schemaVersion !== PROJECTION_SCHEMA_VERSION
    || existing.companyId !== normalized.companyId
    || existing.agentId !== normalized.agentId
    || existing.issueId !== normalized.issueId
    || existing.kind !== normalized.kind
    || existing.bodySha256 !== normalized.bodySha256
    || existing.exactHeadSha !== normalized.exactHeadSha
    || existing.disposition !== normalized.disposition
  ) {
    throw new HeartbeatRunIssueProjectionConflictError(
      `Issue projection replay conflicts for run ${normalized.heartbeatRunId} kind ${normalized.kind}`,
    );
  }
}

export type HeartbeatRunIssueProjectionHooks = {
  afterCommentInsert?: (projectionId: string, commentId: string) => void | Promise<void>;
};

export function heartbeatRunIssueProjectionService(
  db: Db,
  hooks: HeartbeatRunIssueProjectionHooks = {},
) {
  return {
    enqueue: async (input: HeartbeatRunIssueProjectionInput) => {
      const normalized = normalizeProjectionInput(input);
      const inserted = await db
        .insert(heartbeatRunIssueProjections)
        .values({
          schemaVersion: PROJECTION_SCHEMA_VERSION,
          companyId: normalized.companyId,
          agentId: normalized.agentId,
          heartbeatRunId: normalized.heartbeatRunId,
          issueId: normalized.issueId,
          kind: normalized.kind,
          body: normalized.body,
          bodySha256: normalized.bodySha256,
          exactHeadSha: normalized.exactHeadSha,
          disposition: normalized.disposition,
        })
        .onConflictDoNothing({
          target: [
            heartbeatRunIssueProjections.heartbeatRunId,
            heartbeatRunIssueProjections.kind,
          ],
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      const projection = inserted ?? await db
        .select()
        .from(heartbeatRunIssueProjections)
        .where(and(
          eq(heartbeatRunIssueProjections.heartbeatRunId, normalized.heartbeatRunId),
          eq(heartbeatRunIssueProjections.kind, normalized.kind),
        ))
        .then((rows) => rows[0] ?? null);
      if (!projection) {
        throw new HeartbeatRunIssueProjectionConflictError("Issue projection insert was lost");
      }
      assertProjectionReplayMatches(projection, normalized);
      return { projection, replayed: inserted == null };
    },

    assertExisting: async (input: HeartbeatRunIssueProjectionInput | null, heartbeatRunId: string) => {
      const rows = await db.select()
        .from(heartbeatRunIssueProjections)
        .where(eq(heartbeatRunIssueProjections.heartbeatRunId, heartbeatRunId));
      if (input == null) {
        if (rows.length > 0) {
          throw new HeartbeatRunIssueProjectionConflictError(
            `Issue projection replay omitted the committed projection for run ${heartbeatRunId}`,
          );
        }
        return null;
      }
      const normalized = normalizeProjectionInput(input);
      const projection = rows.find((row) => row.kind === normalized.kind) ?? null;
      if (!projection || rows.length !== 1) {
        throw new HeartbeatRunIssueProjectionConflictError(
          `Issue projection replay does not match the committed projection set for run ${heartbeatRunId}`,
        );
      }
      assertProjectionReplayMatches(projection, normalized);
      return projection;
    },

    getForRun: async (heartbeatRunId: string, kind?: HeartbeatRunIssueProjectionKind) =>
      db.select()
        .from(heartbeatRunIssueProjections)
        .where(and(
          eq(heartbeatRunIssueProjections.heartbeatRunId, heartbeatRunId),
          kind ? eq(heartbeatRunIssueProjections.kind, kind) : undefined,
        ))
        .orderBy(asc(heartbeatRunIssueProjections.createdAt)),

    /**
     * Deliver due projections. The outbox row, comment insert and delivered
     * marker share one database transaction. A failure at any point leaves the
     * projection pending and cannot demote or replay the provider run.
     */
    drain: async (input: {
      now?: Date;
      limit?: number;
      addComment: (
        projection: typeof heartbeatRunIssueProjections.$inferSelect,
        tx: Db,
      ) => Promise<{ id: string }>;
    }) => {
      const now = input.now ?? new Date();
      const limit = Math.max(0, Math.min(MAX_DRAIN_LIMIT, input.limit ?? 20));
      let delivered = 0;
      let failed = 0;
      const deliveredProjectionIds: string[] = [];

      for (let index = 0; index < limit; index += 1) {
        let attemptedProjectionId: string | null = null;
        let attemptedProjectionCount = 0;
        try {
          const result = await db.transaction(async (tx) => {
            const projection = await tx
              .select()
              .from(heartbeatRunIssueProjections)
              .where(and(
                eq(heartbeatRunIssueProjections.status, "pending"),
                lte(heartbeatRunIssueProjections.availableAt, now),
              ))
              .orderBy(
                asc(heartbeatRunIssueProjections.availableAt),
                asc(heartbeatRunIssueProjections.createdAt),
              )
              .limit(1)
              .for("update", { skipLocked: true })
              .then((rows) => rows[0] ?? null);
            if (!projection) return null;
            attemptedProjectionId = projection.id;
            attemptedProjectionCount = projection.attemptCount;

            const existing = await tx
              .select({ id: issueComments.id, body: issueComments.body })
              .from(issueComments)
              .where(and(
                eq(issueComments.companyId, projection.companyId),
                eq(issueComments.issueId, projection.issueId),
                eq(issueComments.createdByRunId, projection.heartbeatRunId),
                eq(issueComments.body, projection.body),
                isNull(issueComments.deletedAt),
              ))
              .limit(1)
              .then((rows) => rows[0] ?? null);
            const comment = existing ?? await input.addComment(
              projection,
              tx as unknown as Db,
            );
            await hooks.afterCommentInsert?.(projection.id, comment.id);
            const updated = await tx
              .update(heartbeatRunIssueProjections)
              .set({
                status: "delivered",
                deliveredCommentId: comment.id,
                deliveredAt: now,
                attemptCount: projection.attemptCount + 1,
                lastErrorClass: null,
                updatedAt: now,
              })
              .where(and(
                eq(heartbeatRunIssueProjections.id, projection.id),
                eq(heartbeatRunIssueProjections.status, "pending"),
              ))
              .returning({ id: heartbeatRunIssueProjections.id })
              .then((rows) => rows[0] ?? null);
            if (!updated) {
              throw new HeartbeatRunIssueProjectionConflictError(
                `Issue projection ${projection.id} left pending state during delivery`,
              );
            }
            if (projection.kind === "review_verdict") {
              await tx.update(heartbeatRuns)
                .set({
                  issueCommentStatus: "satisfied",
                  issueCommentSatisfiedByCommentId: comment.id,
                  issueCommentRetryQueuedAt: null,
                  updatedAt: now,
                })
                .where(eq(heartbeatRuns.id, projection.heartbeatRunId));
            }
            return updated.id;
          });
          if (!result) break;
          delivered += 1;
          deliveredProjectionIds.push(result);
        } catch (error) {
          failed += 1;
          if (attemptedProjectionId) {
            const errorClass = error instanceof Error && error.name
              ? error.name.slice(0, 120)
              : "UnknownError";
            // Delivery is infrastructure reconciliation, never provider work.
            // Back off aggressively so a broken issue bridge cannot become a
            // positive-feedback heartbeat loop.
            const retryDelayMs = Math.min(
              60 * 60 * 1_000,
              30_000 * (2 ** Math.min(attemptedProjectionCount, 7)),
            );
            const retryAt = new Date(now.getTime() + retryDelayMs);
            await db.update(heartbeatRunIssueProjections)
              .set({
                attemptCount: sql`${heartbeatRunIssueProjections.attemptCount} + 1`,
                availableAt: retryAt,
                lastErrorClass: errorClass,
                updatedAt: now,
              })
              .where(and(
                eq(heartbeatRunIssueProjections.id, attemptedProjectionId),
                eq(heartbeatRunIssueProjections.status, "pending"),
              ));
          }
          break;
        }
      }

      return { delivered, failed, deliveredProjectionIds };
    },
  };
}
