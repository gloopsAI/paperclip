/**
 * Continuation / escalation protocol routes (OK-07).
 *
 * Adapters can POST structured escalation inputs and receive a compact
 * EscalationPacket plus size validation — never a transcript resend path.
 */
import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  DEFAULT_ESCALATION_PACKET_MAX_CHARS,
  EscalationPacketSizeError,
  EscalationPacketTranscriptError,
  assertEscalationPacketSize,
  buildEscalationPacket,
  checkEscalationPacketSize,
  measureEscalationPacketChars,
} from "../services/continuation-packet.js";
import { assertCompanyAccess } from "./authz.js";

const escalationAttemptSchema = z
  .object({
    turn: z.number().int().nonnegative().nullable().optional(),
    summary: z.string().min(1),
    tool: z.string().nullable().optional(),
    errorCode: z.string().nullable().optional(),
    at: z.string().nullable().optional(),
  })
  .strict();

const buildEscalationPacketBodySchema = z
  .object({
    intent: z.string().min(1),
    currentState: z.string().min(1),
    attempts: z.array(escalationAttemptSchema).default([]),
    failureFingerprint: z.string().min(1),
    nonGoals: z.array(z.string()).default([]),
    authority: z
      .object({
        companyId: z.string().min(1).optional(),
        issueId: z.string().nullable().optional(),
        runId: z.string().nullable().optional(),
        assigneeAgentId: z.string().nullable().optional(),
        responsibleUserId: z.string().nullable().optional(),
      })
      .strict(),
    remainingBudget: z
      .object({
        turnsRemaining: z.number().int().nonnegative().nullable().optional(),
        maxTurns: z.number().int().nonnegative().nullable().optional(),
        uncachedTokensRemaining: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional(),
        maxUncachedTokens: z.number().int().nonnegative().nullable().optional(),
      })
      .strict()
      .default({}),
    requiredTerminalArtifact: z.string().min(1),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(100_000)
      .optional(),
  })
  .strict();

export function continuationRoutes() {
  const router = Router();

  /**
   * POST /companies/:companyId/continuation/escalation-packet
   *
   * Body: structured escalation fields (no transcript).
   * Response: { packet, size: { ok, chars, maxChars } }
   */
  router.post(
    "/companies/:companyId/continuation/escalation-packet",
    validate(buildEscalationPacketBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof buildEscalationPacketBodySchema>;
      const maxChars = body.maxChars ?? DEFAULT_ESCALATION_PACKET_MAX_CHARS;

      // Authority company must match the route company.
      const authorityCompanyId = body.authority.companyId ?? companyId;
      if (authorityCompanyId !== companyId) {
        throw badRequest(
          "authority.companyId must match the route companyId",
        );
      }

      let packet;
      try {
        packet = buildEscalationPacket({
          intent: body.intent,
          currentState: body.currentState,
          attempts: body.attempts,
          failureFingerprint: body.failureFingerprint,
          nonGoals: body.nonGoals,
          authority: {
            ...body.authority,
            companyId,
          },
          remainingBudget: body.remainingBudget,
          requiredTerminalArtifact: body.requiredTerminalArtifact,
        });
      } catch (error) {
        if (error instanceof EscalationPacketTranscriptError) {
          res.status(400).json({
            error: error.message,
            code: error.code,
            keys: error.keys,
          });
          return;
        }
        throw badRequest(
          error instanceof Error ? error.message : "invalid escalation packet",
        );
      }

      const size = checkEscalationPacketSize(packet, maxChars);
      if (!size.ok) {
        res.status(413).json({
          error: size.error,
          code: "escalation_packet.size_exceeded",
          chars: size.chars,
          maxChars: size.maxChars,
          packet,
        });
        return;
      }

      // Hard assert for defense-in-depth (should already pass via check).
      try {
        assertEscalationPacketSize(packet, maxChars);
      } catch (error) {
        if (error instanceof EscalationPacketSizeError) {
          res.status(413).json({
            error: error.message,
            code: error.code,
            chars: error.chars,
            maxChars: error.maxChars,
            packet,
          });
          return;
        }
        throw error;
      }

      res.status(201).json({
        packet,
        size: {
          ok: true as const,
          chars: measureEscalationPacketChars(packet),
          maxChars,
        },
      });
    },
  );

  return router;
}
