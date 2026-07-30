/**
 * Token Economics MTE rollup surface (GLO-2021 / GLO-2048).
 *
 * `MTE` here is the Measurement / Tracking / Economics aggregation layer that
 * sits between the canonical ledger (cost_events / finance_events) and any
 * downstream steward consumer (budget policy enforcement, operations
 * improvement proposals, accountant dashboards, etc).
 *
 * The rollup names below document the rollups that `server/src/services/costs.ts`
 * and `server/src/services/finance.ts` actually implement. They are exposed as
 * a shared constant so tests, docs, and steward consumers can refer to a
 * stable name rather than to a query string.
 *
 * The schemas are intentionally narrow: each rollup is identified by its
 * name, the dimensional axes it groups on, and the source ledger
 * (cost_events vs finance_events). This file is documentation + a tiny
 * registry; nothing here mutates the database.
 *
 * Steward pipeline contract (GLO-2048): when the operations-improvement
 * proposal owner is `token_economics`, the steward wake payload stamps
 * `mteRollupHint` referencing the relevant entries of MTE_ROLLUP_QUERIES so
 * downstream consumers can fetch the rollups by name instead of by query
 * string.
 */

export type MteLedgerSource = "cost_events" | "finance_events";

export type MteRollupGroupAxis =
  | "agentId"
  | "provider"
  | "biller"
  | "billingType"
  | "model"
  | "projectId"
  | "eventKind"
  | "rollingWindow";

/**
 * A rollup's source ledger and the axes it groups on.
 *
 * The names are stable contract identifiers; changing one requires updating
 * both `server/src/services/costs.ts` and `server/src/services/finance.ts`
 * plus the related routes under `server/src/routes/costs.ts`.
 */
export interface MteRollupSpec {
  /** Stable rollup name; mirrors the cost/finance service method name. */
  name:
    | "byAgent"
    | "byAgentModel"
    | "byProvider"
    | "byBiller"
    | "byProject"
    | "windowSpend"
    | "issueTreeSummary"
    | "summary"
    | "financeSummary"
    | "financeByBiller"
    | "financeByKind";
  source: MteLedgerSource;
  /** Axes that participate in the GROUP BY; affects which fields are queryable on the result row. */
  groupBy: readonly MteRollupGroupAxis[];
  /** Human-readable summary of what is summed or counted. */
  measure:
    | "costCents+tokenSums"
    | "costCents+tokenSums+runCounts"
    | "tokenSums+windowedCostCents"
    | "debitCents+creditCents+estimatedDebitCents"
    | "netCents+kindCounts";
}

/**
 * The canonical MTE rollup surface. Adding a row here is the durable
 * documentation step for "which rollups ship today"; the implementation
 * that backs each row lives in `server/src/services/costs.ts` /
 * `server/src/services/finance.ts`.
 */
export const MTE_ROLLUP_QUERIES: readonly MteRollupSpec[] = [
  {
    name: "byAgent",
    source: "cost_events",
    groupBy: ["agentId"],
    measure: "costCents+tokenSums+runCounts",
  },
  {
    name: "byAgentModel",
    source: "cost_events",
    groupBy: ["agentId", "provider", "biller", "billingType", "model"],
    measure: "costCents+tokenSums",
  },
  {
    name: "byProvider",
    source: "cost_events",
    groupBy: ["provider", "biller", "billingType", "model"],
    measure: "costCents+tokenSums+runCounts",
  },
  {
    name: "byBiller",
    source: "cost_events",
    groupBy: ["biller"],
    measure: "costCents+tokenSums+runCounts",
  },
  {
    name: "byProject",
    source: "cost_events",
    groupBy: ["projectId"],
    measure: "costCents+tokenSums",
  },
  {
    name: "windowSpend",
    source: "cost_events",
    groupBy: ["provider", "biller", "rollingWindow"],
    measure: "tokenSums+windowedCostCents",
  },
  {
    name: "issueTreeSummary",
    source: "cost_events",
    groupBy: [],
    measure: "costCents+tokenSums+runCounts",
  },
  {
    name: "summary",
    source: "cost_events",
    groupBy: [],
    measure: "costCents+tokenSums+runCounts",
  },
  {
    name: "financeSummary",
    source: "finance_events",
    groupBy: [],
    measure: "debitCents+creditCents+estimatedDebitCents",
  },
  {
    name: "financeByBiller",
    source: "finance_events",
    groupBy: ["biller"],
    measure: "netCents+kindCounts",
  },
  {
    name: "financeByKind",
    source: "finance_events",
    groupBy: ["eventKind"],
    measure: "netCents+kindCounts",
  },
];

export function getMteRollup(name: MteRollupSpec["name"]): MteRollupSpec | undefined {
  for (const rollup of MTE_ROLLUP_QUERIES) {
    if (rollup.name === name) return rollup;
  }
  return undefined;
}

/**
 * The rollups the token-economics steward pipeline should consume by default.
 * Steward wakes stamped with the token_economics owner carry these names so
 * the steward can fetch the rollups without re-deriving the names from a
 * query string.
 *
 * These are stable contract names; see MTE_ROLLUP_QUERIES for shape.
 */
export const TOKEN_ECONOMICS_STEWARD_ROLLUPS: readonly MteRollupSpec["name"][] = [
  "byAgent",
  "byProvider",
  "byBiller",
  "summary",
  "financeSummary",
  "financeByBiller",
  "financeByKind",
];

/**
 * Build the steward rollup hint shape used in the operations-improvement
 * steward wake payload. Pure helper so tests can assert the projection.
 */
export interface MteStewardRollupHint {
  tokenEconomicsOwner: boolean;
  rollupNames: readonly MteRollupSpec["name"][];
}

export function buildMteStewardRollupHint(input: {
  owner: "capacity" | "token_economics";
}): MteStewardRollupHint {
  if (input.owner !== "token_economics") {
    return { tokenEconomicsOwner: false, rollupNames: [] };
  }
  return {
    tokenEconomicsOwner: true,
    rollupNames: TOKEN_ECONOMICS_STEWARD_ROLLUPS,
  };
}
