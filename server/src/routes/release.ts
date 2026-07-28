import { Router } from "express";
import {
  validateReleaseCandidate,
  type ReleaseCandidate,
} from "../services/release-contract.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Read-only Harbor release contract routes.
 *
 * Validates release candidates against the pure contract. Does not invoke
 * platform-ops deploy or otherwise widen deploy authority.
 */
export function releaseRoutes() {
  const router = Router();

  router.post("/companies/:companyId/release/validate-candidate", (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const result = validateReleaseCandidate(req.body as Partial<ReleaseCandidate>);
    if (!result.valid) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  return router;
}
