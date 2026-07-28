import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import {
  outcomeScorecardService,
  resolveScorecardWindow,
} from "../services/outcome-scorecard.js";
import { assertCompanyAccess } from "./authz.js";

function parseOptionalDate(raw: unknown, label: string): string | null {
  if (raw == null || raw === "") return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    throw badRequest(`invalid '${label}' date`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(`invalid '${label}' date`);
  }
  return value;
}

export function outcomeScorecardRoutes(db: Db) {
  const router = Router();
  const svc = outcomeScorecardService(db);

  router.get("/companies/:companyId/outcome-scorecard", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const sinceRaw = parseOptionalDate(req.query.since, "since");
    const untilRaw = parseOptionalDate(req.query.until, "until");

    // Validate window resolution early so callers get a 400, not a 500.
    try {
      resolveScorecardWindow({ since: sinceRaw, until: untilRaw });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : "invalid date window");
    }

    const scorecard = await svc.forCompany(companyId, {
      since: sinceRaw,
      until: untilRaw,
    });
    res.json(scorecard);
  });

  return router;
}
