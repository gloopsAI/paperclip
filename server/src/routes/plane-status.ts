/**
 * GET /api/plane-status — Induct SDLC plane status (S1).
 *
 * Requires agent or board actor in authenticated mode (same bar as full health details).
 * Returns evaluatePlaneStatusFromEnv + version. Host S0 lease/epoch probes stay null.
 */

import { Router } from "express";
import type { DeploymentMode } from "@paperclipai/shared";
import { evaluatePlaneStatusFromEnv } from "../services/sdlc-preflight.js";
import { serverVersion } from "../version.js";

function shouldExposePlaneStatus(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

export function planeStatusRoutes(
  opts: {
    deploymentMode: DeploymentMode;
  } = {
    deploymentMode: "local_trusted",
  },
) {
  const router = Router();

  router.get("/", (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    if (!shouldExposePlaneStatus(actorType, opts.deploymentMode)) {
      res.status(403).json({ error: "agent_or_board_access_required" });
      return;
    }

    const plane = evaluatePlaneStatusFromEnv(process.env);
    res.json({
      status: plane.ok ? "ok" : "degraded",
      version: serverVersion,
      schemaVersion: "gloops.plane-status.v1",
      ...plane,
    });
  });

  return router;
}
