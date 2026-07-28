/**
 * Agent Capacity Truth (OK-02)
 *
 * Classifies company agents into MVP capacity lifecycle states and encodes
 * earned-unpause gates. Read-only report only — does not pause/unpause agents.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { notFound } from "../errors.js";

export type AgentCapacityLifecycle =
  | "active_capacity"
  | "pool_ready"
  | "invoked_only"
  | "archived"
  | "unknown";

/** Recommended pause reasons for non-MVP capacity roles. */
export const PAUSE_REASON = {
  not_in_mvp: "not_in_mvp",
  invoked_only: "invoked_only",
  archived_pilot: "archived_pilot",
} as const;

export type AgentCapacityPauseReason =
  (typeof PAUSE_REASON)[keyof typeof PAUSE_REASON];

/** Default MVP role name map (case-insensitive exact name match). */
export const MVP_CAPACITY_ROLE_NAMES: Readonly<
  Record<Exclude<AgentCapacityLifecycle, "unknown">, readonly string[]>
> = {
  active_capacity: ["Dispatch", "Wren", "Argus", "Harbor"],
  pool_ready: ["Mason"],
  invoked_only: [
    "Northstar",
    "Atlas",
    "Conductor",
    "Scout",
    "Radar",
    "Context Steward",
    "Codex Burst",
    "Grok Burst",
    "Sentinel",
    "Capacity Manager",
    "Sage",
  ],
  archived: [
    "Fourth Pilot Engineer",
    "Reflection Coach",
    "Token Economics Steward",
    "Reception",
  ],
};

const NAME_TO_LIFECYCLE: ReadonlyMap<string, Exclude<AgentCapacityLifecycle, "unknown">> =
  (() => {
    const map = new Map<string, Exclude<AgentCapacityLifecycle, "unknown">>();
    for (const [lifecycle, names] of Object.entries(MVP_CAPACITY_ROLE_NAMES) as Array<
      [Exclude<AgentCapacityLifecycle, "unknown">, readonly string[]]
    >) {
      for (const name of names) {
        map.set(normalizeAgentName(name), lifecycle);
      }
    }
    return map;
  })();

export type ClassifyAgentCapacityInput = {
  name: string;
  status: string;
  pauseReason?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AgentCapacityClassification = {
  lifecycle: AgentCapacityLifecycle;
  countsAsCapacity: boolean;
  reason: string;
};

export type UnpauseGateInput = {
  lifecycle: AgentCapacityLifecycle;
  acceptedOutcomes: number;
  humanInterventions: number;
  openP0KernelDefects: number;
  minAccepted?: number;
};

export type UnpauseGateResult = {
  allowed: boolean;
  reasons: string[];
};

export type AgentCapacityReportAgent = {
  id: string;
  name: string;
  status: string;
  pauseReason: string | null;
  lifecycle: AgentCapacityLifecycle;
  countsAsCapacity: boolean;
  reason: string;
  recommendedPauseReason: AgentCapacityPauseReason | null;
};

export type AgentCapacitySummary = {
  activeCapacity: number;
  poolReady: number;
  invokedOnly: number;
  archived: number;
  pausedErrorUnknown: number;
};

export type AgentCapacityReport = {
  companyId: string;
  summary: AgentCapacitySummary;
  agents: AgentCapacityReportAgent[];
};

export const DEFAULT_UNPAUSE_MIN_ACCEPTED = 3;

export function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve lifecycle from the default MVP role name map.
 * Case-insensitive exact match on agent name. Unknown names → `unknown`.
 */
export function lifecycleForAgentName(name: string): AgentCapacityLifecycle {
  return NAME_TO_LIFECYCLE.get(normalizeAgentName(name)) ?? "unknown";
}

/**
 * Recommended pause reason constant for a lifecycle (for ops apply later).
 * Active capacity is never paused for MVP reasons; unknown defaults to not_in_mvp.
 */
export function recommendedPauseReasonForLifecycle(
  lifecycle: AgentCapacityLifecycle,
): AgentCapacityPauseReason | null {
  switch (lifecycle) {
    case "active_capacity":
      return null;
    case "pool_ready":
      return PAUSE_REASON.not_in_mvp;
    case "invoked_only":
      return PAUSE_REASON.invoked_only;
    case "archived":
      return PAUSE_REASON.archived_pilot;
    case "unknown":
      return PAUSE_REASON.not_in_mvp;
  }
}

/**
 * Classify an agent into an MVP capacity lifecycle.
 *
 * Capacity truth is name-map driven for the MVP. Only `active_capacity` roles
 * count as capacity. Status/pauseReason/metadata are accepted for future
 * refinement and appear in the report, but do not override the name map.
 */
export function classifyAgentCapacity(
  agent: ClassifyAgentCapacityInput,
): AgentCapacityClassification {
  const lifecycle = lifecycleForAgentName(agent.name);

  switch (lifecycle) {
    case "active_capacity":
      return {
        lifecycle,
        countsAsCapacity: true,
        reason: `MVP active capacity role '${agent.name.trim()}'`,
      };
    case "pool_ready":
      return {
        lifecycle,
        countsAsCapacity: false,
        reason: `MVP pool-ready role '${agent.name.trim()}' — earn unpause via gate`,
      };
    case "invoked_only":
      return {
        lifecycle,
        countsAsCapacity: false,
        reason: `MVP invoked-only role '${agent.name.trim()}' — not standing capacity`,
      };
    case "archived":
      return {
        lifecycle,
        countsAsCapacity: false,
        reason: `Archived pilot role '${agent.name.trim()}' — never standing capacity`,
      };
    case "unknown":
      return {
        lifecycle,
        countsAsCapacity: false,
        reason: `Agent '${agent.name.trim()}' is not in the MVP capacity role map`,
      };
  }
}

/**
 * Evaluate earned-unpause eligibility for a capacity lifecycle.
 *
 * Rules:
 * - `active_capacity` is already allowed for work
 * - `archived` is never allowed
 * - `pool_ready` / `invoked_only` require acceptedOutcomes >= minAccepted (default 3),
 *   humanInterventions <= 0, and openP0KernelDefects === 0
 * - `unknown` is not eligible for staged unpause
 */
export function evaluateUnpauseGate(input: UnpauseGateInput): UnpauseGateResult {
  const minAccepted = input.minAccepted ?? DEFAULT_UNPAUSE_MIN_ACCEPTED;

  if (input.lifecycle === "active_capacity") {
    return {
      allowed: true,
      reasons: ["active_capacity agents are already allowed for work"],
    };
  }

  if (input.lifecycle === "archived") {
    return {
      allowed: false,
      reasons: ["archived agents are never eligible for unpause"],
    };
  }

  if (input.lifecycle !== "pool_ready" && input.lifecycle !== "invoked_only") {
    return {
      allowed: false,
      reasons: [`lifecycle '${input.lifecycle}' is not eligible for staged unpause`],
    };
  }

  const reasons: string[] = [];

  if (input.acceptedOutcomes < minAccepted) {
    reasons.push(
      `acceptedOutcomes ${input.acceptedOutcomes} < minAccepted ${minAccepted}`,
    );
  }
  if (input.humanInterventions > 0) {
    reasons.push(`humanInterventions ${input.humanInterventions} > 0`);
  }
  if (input.openP0KernelDefects !== 0) {
    reasons.push(`openP0KernelDefects ${input.openP0KernelDefects} !== 0`);
  }

  if (reasons.length > 0) {
    return { allowed: false, reasons };
  }

  return {
    allowed: true,
    reasons: [`lifecycle '${input.lifecycle}' cleared earned-unpause gates`],
  };
}

function emptySummary(): AgentCapacitySummary {
  return {
    activeCapacity: 0,
    poolReady: 0,
    invokedOnly: 0,
    archived: 0,
    pausedErrorUnknown: 0,
  };
}

export function summarizeCapacityClassifications(
  classifications: Array<{ lifecycle: AgentCapacityLifecycle }>,
): AgentCapacitySummary {
  const summary = emptySummary();
  for (const row of classifications) {
    switch (row.lifecycle) {
      case "active_capacity":
        summary.activeCapacity += 1;
        break;
      case "pool_ready":
        summary.poolReady += 1;
        break;
      case "invoked_only":
        summary.invokedOnly += 1;
        break;
      case "archived":
        summary.archived += 1;
        break;
      case "unknown":
        summary.pausedErrorUnknown += 1;
        break;
    }
  }
  return summary;
}

export function agentCapacityService(db: Db) {
  return {
    /**
     * List all agents for a company with capacity classification.
     * Read-only — does not mutate pause state.
     */
    report: async (companyId: string): Promise<AgentCapacityReport> => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
          pauseReason: agents.pauseReason,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      const classified: AgentCapacityReportAgent[] = rows.map((row) => {
        const classification = classifyAgentCapacity({
          name: row.name,
          status: row.status,
          pauseReason: row.pauseReason,
          metadata: row.metadata,
        });
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          pauseReason: row.pauseReason ?? null,
          lifecycle: classification.lifecycle,
          countsAsCapacity: classification.countsAsCapacity,
          reason: classification.reason,
          recommendedPauseReason: recommendedPauseReasonForLifecycle(
            classification.lifecycle,
          ),
        };
      });

      return {
        companyId,
        summary: summarizeCapacityClassifications(classified),
        agents: classified,
      };
    },
  };
}
