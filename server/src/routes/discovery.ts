/**
 * Typed discovery plan routes (OK-08).
 *
 * Plan-only: returns routing + dedupe receipt without creating issues.
 * Callers supply projects (and optional existing fingerprints) in the body so
 * evaluation stays pure and deterministic.
 */
import { Router } from "express";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  planDiscovery,
  type DiscoveryExistingIssue,
  type DiscoveryProject,
  type DiscoveryRequest,
} from "../services/typed-discovery.js";
import { assertCompanyAccess } from "./authz.js";

const provenanceSchema = z
  .object({
    source: z.string().min(1),
    agentId: z.string().nullable().optional(),
    runId: z.string().nullable().optional(),
    companyId: z.string().nullable().optional(),
    discoveredAt: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

const projectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

const existingSchema = z
  .object({
    fingerprint: z.string().min(1),
    projectId: z.string().min(1),
    status: z.string().min(1),
    issueId: z.string().nullable().optional(),
  })
  .strict();

const discoveryPlanBodySchema = z
  .object({
    title: z.string().min(1),
    summary: z.string().min(1),
    provenance: provenanceSchema,
    sourceIssueId: z.string().nullable().optional(),
    fingerprint: z.string().nullable().optional(),
    projectKey: z.string().nullable().optional(),
    /** Optional project list used for deterministic routing. */
    projects: z.array(projectSchema).default([]),
    /** Optional existing fingerprint records used for dedupe. */
    existing: z.array(existingSchema).default([]),
  })
  .strict();

export function discoveryRoutes() {
  const router = Router();

  /**
   * POST /companies/:companyId/discovery/plan
   *
   * Body: DiscoveryRequest + optional projects + optional existing fingerprints.
   * Response: DiscoveryReceipt (plan-only; does not create an issue).
   */
  router.post(
    "/companies/:companyId/discovery/plan",
    validate(discoveryPlanBodySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as z.infer<typeof discoveryPlanBodySchema>;

      // If provenance.companyId is supplied it must match the route company.
      if (
        typeof body.provenance.companyId === "string" &&
        body.provenance.companyId.length > 0 &&
        body.provenance.companyId !== companyId
      ) {
        throw badRequest("provenance.companyId must match the route companyId");
      }

      const discoveryRequest: DiscoveryRequest = {
        title: body.title,
        summary: body.summary,
        provenance: {
          ...body.provenance,
          companyId: body.provenance.companyId ?? companyId,
        },
        sourceIssueId: body.sourceIssueId,
        fingerprint: body.fingerprint,
        projectKey: body.projectKey,
      };

      const projects: DiscoveryProject[] = body.projects;
      const existing: DiscoveryExistingIssue[] = body.existing.map((entry) => ({
        fingerprint: entry.fingerprint,
        projectId: entry.projectId,
        status: entry.status,
        issueId: entry.issueId ?? null,
      }));

      let receipt;
      try {
        receipt = planDiscovery({
          companyId,
          request: discoveryRequest,
          projects,
          existing,
        });
      } catch (error) {
        throw badRequest(
          error instanceof Error ? error.message : "invalid discovery plan",
        );
      }

      res.status(200).json({
        plan: receipt,
        // Convenience echo for clients that only need the decision surface.
        decision: receipt.decision,
        projectId: receipt.projectId,
        fingerprint: receipt.fingerprint,
      });
    },
  );

  return router;
}
