import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentCapacityService } from "../services/agent-capacity.js";
import { assertCompanyAccess } from "./authz.js";

export function agentCapacityRoutes(db: Db) {
  const router = Router();
  const svc = agentCapacityService(db);

  /**
   * GET /companies/:companyId/agent-capacity
   *
   * Read-only capacity truth report. Classifies every agent into an MVP
   * lifecycle bucket and returns summary counts. Does not pause/unpause.
   */
  router.get("/companies/:companyId/agent-capacity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const report = await svc.report(companyId);
    res.json(report);
  });

  return router;
}
