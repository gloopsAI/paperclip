/**
 * GBrain micro-plane routes (OK-09).
 *
 * Advisory context compile + failure fingerprint normalization.
 * GBrain cannot change authority — packets are assertably advisory.
 */
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  ContextPacketAuthorityError,
  compileContextPacket,
  normalizeFailureFingerprint,
  type FailureFingerprint,
} from "../services/gbrain-microplane.js";
import {
  GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT,
  getRecentFingerprints,
} from "../services/gbrain-failure-recorder.js";
import {
  GBRAIN_CONTEXT_SOURCE_KINDS,
  GbrainContextRecordValidationError,
  gbrainContextRecordService,
  type GbrainContextSourceKind,
} from "../services/gbrain-context-records.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const fingerprintInputSchema = z
  .object({
    errorCode: z.string().min(1),
    message: z.string().min(1),
    tool: z.string().nullable().optional(),
    stage: z.string().nullable().optional(),
    recoveryHint: z.string().nullable().optional(),
  })
  .strict();

const contextAnchorSchema = z.union([
  z.string().min(1),
  z
    .object({
      kind: z.string().min(1),
      ref: z.string().min(1),
      label: z.string().nullable().optional(),
    })
    .strict(),
]);

const compileContextBodySchema = z
  .object({
    goal: z.string().min(1),
    scope: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    acceptance: z.array(z.string()).optional(),
    anchors: z.array(contextAnchorSchema).optional(),
    authority: z
      .object({
        companyId: z.string().nullable().optional(),
        issueId: z.string().nullable().optional(),
        runId: z.string().nullable().optional(),
        assigneeAgentId: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    continuation: z
      .object({
        cursor: z.string().nullable().optional(),
        checkpointTurn: z.number().int().nonnegative().nullable().optional(),
        next: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    facts: z.array(z.string()).optional(),
    fingerprints: z.array(fingerprintInputSchema).optional(),
    decisions: z.array(z.string()).optional(),
    tokenBudget: z.number().int().positive().max(200_000).optional(),
    sources: z.array(z.string()).optional(),
  })
  .strict();

const normalizeFingerprintBodySchema = fingerprintInputSchema;

const contextRecordBodySchema = z.object({
  sourceKind: z.enum(GBRAIN_CONTEXT_SOURCE_KINDS),
  sourceUri: z.string().min(1).max(1024),
  sourceEventId: z.string().min(1).max(256).nullable().optional(),
  sourceAuthor: z.string().min(1).max(256).nullable().optional(),
  summary: z.string().min(1).max(6000),
  occurredAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

const contextRetrieveBodySchema = compileContextBodySchema.extend({
  sourceKinds: z.array(z.enum(GBRAIN_CONTEXT_SOURCE_KINDS)).max(3).optional(),
  limit: z.number().int().min(1).max(10).default(6),
}).strict();

export function gbrainRoutes(db: Db) {
  const router = Router();
  const records = gbrainContextRecordService(db);

  router.post(
    "/companies/:companyId/gbrain/context-records",
    validate(contextRecordBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      try {
        const result = await records.ingest(companyId, req.body as z.infer<typeof contextRecordBodySchema>);
        if (result.created) {
          await logActivity(db, {
            companyId,
            actorType: actor.actorType === "user" ? "user" : "agent",
            actorId: actor.actorId,
            entityType: "gbrain_context_record",
            entityId: result.record.id,
            action: "gbrain_context_record_ingested",
            agentId: actor.agentId,
            runId: actor.runId,
            details: {
              sourceKind: result.record.sourceKind,
              sourceUri: result.record.sourceUri,
              contentDigest: result.record.contentDigest,
            },
          });
        }
        res.status(result.created ? 201 : 200).json({ ...result, advisory: true });
      } catch (error) {
        if (error instanceof GbrainContextRecordValidationError) throw badRequest(error.message);
        throw error;
      }
    },
  );

  router.post(
    "/companies/:companyId/gbrain/context/retrieve",
    validate(contextRetrieveBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = req.body as z.infer<typeof contextRetrieveBodySchema>;
      const selected = await records.retrieve(companyId, {
        goal: body.goal,
        sourceKinds: body.sourceKinds as GbrainContextSourceKind[] | undefined,
        limit: body.limit,
        now: new Date(),
      });
      try {
        const packet = compileContextPacket({
          goal: body.goal,
          scope: body.scope,
          nonGoals: body.nonGoals,
          acceptance: body.acceptance,
          anchors: body.anchors,
          authority: { ...body.authority, companyId },
          continuation: body.continuation,
        }, {
          facts: selected.map((record) => record.summary),
          sources: selected.map((record) => `${record.sourceKind}:${record.sourceUri}@${record.contentDigest}`),
          tokenBudget: body.tokenBudget,
        });
        res.status(200).json({ advisory: true, packet, records: selected });
      } catch (error) {
        if (error instanceof ContextPacketAuthorityError) {
          res.status(400).json({
            error: error.message,
            code: error.code,
            keys: error.keys,
          });
          return;
        }
        throw badRequest(
          error instanceof Error ? error.message : "invalid context retrieve request",
        );
      }
    },
  );

  /**
   * POST /companies/:companyId/gbrain/context/compile
   *
   * Compile a budgeted advisory ContextPacket for implementer/reviewer.
   * Never grants authority or promotes binding policy.
   */
  router.post(
    "/companies/:companyId/gbrain/context/compile",
    validate(compileContextBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof compileContextBodySchema>;

      // Authority company must match the route company when provided.
      const authorityCompanyId = body.authority?.companyId ?? companyId;
      if (authorityCompanyId !== companyId) {
        throw badRequest("authority.companyId must match the route companyId");
      }

      let fingerprints: FailureFingerprint[] | undefined;
      try {
        fingerprints = body.fingerprints?.map((fp) =>
          normalizeFailureFingerprint({
            errorCode: fp.errorCode,
            message: fp.message,
            tool: fp.tool,
            stage: fp.stage,
            recoveryHint: fp.recoveryHint,
          }),
        );
      } catch (error) {
        throw badRequest(
          error instanceof Error
            ? error.message
            : "invalid failure fingerprint",
        );
      }

      let packet;
      try {
        packet = compileContextPacket(
          {
            goal: body.goal,
            scope: body.scope,
            nonGoals: body.nonGoals,
            acceptance: body.acceptance,
            anchors: body.anchors,
            authority: {
              ...body.authority,
              companyId,
            },
            continuation: body.continuation,
          },
          {
            facts: body.facts,
            fingerprints,
            decisions: body.decisions,
            tokenBudget: body.tokenBudget,
            sources: body.sources,
          },
        );
      } catch (error) {
        if (error instanceof ContextPacketAuthorityError) {
          res.status(400).json({
            error: error.message,
            code: error.code,
            keys: error.keys,
          });
          return;
        }
        throw badRequest(
          error instanceof Error
            ? error.message
            : "invalid context compile request",
        );
      }

      res.status(200).json(packet);
    },
  );

  /**
   * POST /companies/:companyId/gbrain/fingerprints/normalize
   *
   * Normalize a failure into a stable advisory FailureFingerprint.
   */
  router.post(
    "/companies/:companyId/gbrain/fingerprints/normalize",
    validate(normalizeFingerprintBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof normalizeFingerprintBodySchema>;

      let fingerprint: FailureFingerprint;
      try {
        fingerprint = normalizeFailureFingerprint({
          errorCode: body.errorCode,
          message: body.message,
          tool: body.tool,
          stage: body.stage,
          recoveryHint: body.recoveryHint,
        });
      } catch (error) {
        throw badRequest(
          error instanceof Error
            ? error.message
            : "invalid failure fingerprint",
        );
      }

      res.status(200).json(fingerprint);
    },
  );

  /**
   * GET /companies/:companyId/gbrain/fingerprints/recent
   *
   * Return the recent normalized FailureFingerprints observed in this
   * process for the given company. Advisory only — informational context
   * for the OK-09 microplane, never a basis for authority decisions.
   */
  router.get(
    "/companies/:companyId/gbrain/fingerprints/recent",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const rawLimit = (req.query as Record<string, unknown> | undefined)?.limit;
      const parsedLimit =
        typeof rawLimit === "string" && rawLimit.length > 0
          ? Number(rawLimit)
          : typeof rawLimit === "number"
            ? rawLimit
            : 10;
      const safeLimit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : 10;
      const limit = Math.min(
        Math.max(1, safeLimit),
        GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT,
      );

      const payload = getRecentFingerprints(companyId, limit);
      res.status(200).json(payload);
    },
  );

  return router;
}
