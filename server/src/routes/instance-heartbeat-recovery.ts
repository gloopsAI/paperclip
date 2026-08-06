import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";
import { heartbeatService } from "../services/index.js";
import { logger } from "../middleware/logger.js";

function readOptionalPositiveMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/**
 * Phase 1.3 (budget-accounting fix, orphan settlement): explicitly-invoked
 * operator route for reapOrphanedRuns (heartbeat.ts). Both call sites that
 * would otherwise run it automatically — boot recovery and the periodic
 * scheduler in index.ts — are gated behind heartbeatSchedulerEnabled /
 * executionRecoveryDriverEnabled, which are both false in production
 * (HEARTBEAT_SCHEDULER_ENABLED=false, PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false,
 * and config.ts also forces both false under operatorOnlyMode). Without this
 * route nothing ever settles a run whose control plane restarted mid-flight
 * (finishedAt never gets set, so it holds its full task-budget reservation
 * forever — see priorExecutionRun in heartbeat.ts).
 *
 * This route is deliberately reap-only. It always calls reapOrphanedRuns
 * with `settleOnly: true`, which is not caller-overridable from the request
 * body: settling a row (terminal status + budget-exempt/elapsed-usage
 * accounting) is safe to run on demand, but the retry/promote/queue-drain
 * side effects reapOrphanedRuns performs outside settleOnly are not — see
 * paperclipai/paperclip#9552, where automatic boot recovery re-spawned 16
 * parallel processes in 3 seconds for a maxConcurrentRuns:1 paused agent.
 * Enabling that broader self-healing path remains a separate decision
 * (executionRecoveryDriverEnabled), not something this route silently opts
 * into.
 */
export function instanceHeartbeatRecoveryRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);

  router.post("/instance/heartbeat-runs/reap-orphaned", async (req, res) => {
    assertInstanceAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const staleThresholdMs = readOptionalPositiveMs(body.staleThresholdMs);
    const noPidStaleThresholdMs = readOptionalPositiveMs(body.noPidStaleThresholdMs);

    const actor = getActorInfo(req);
    const result = await heartbeat.reapOrphanedRuns({
      settleOnly: true,
      ...(staleThresholdMs !== undefined ? { staleThresholdMs } : {}),
      ...(noPidStaleThresholdMs !== undefined ? { noPidStaleThresholdMs } : {}),
    });

    logger.info(
      {
        actorType: actor.actorType,
        actorId: actor.actorId,
        reaped: result.reaped,
        runIds: result.runIds,
        staleThresholdMs: staleThresholdMs ?? null,
        noPidStaleThresholdMs: noPidStaleThresholdMs ?? null,
      },
      "operator-invoked orphaned heartbeat run reap (settle-only)",
    );

    res.status(200).json(result);
  });

  return router;
}
