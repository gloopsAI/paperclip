/**
 * GBrain micro-plane routes (OK-09).
 *
 * Advisory context compile + failure fingerprint normalization.
 * GBrain cannot change authority — packets are assertably advisory.
 */
import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  ContextPacketAuthorityError,
  compileContextPacket,
  normalizeFailureFingerprint,
  type FailureFingerprint,
} from "../services/gbrain-microplane.js";
import { assertCompanyAccess } from "./authz.js";

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

export function gbrainRoutes() {
  const router = Router();

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

  return router;
}
