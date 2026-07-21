/**
 * Canonical subscription economics registry and allocation helpers (v1).
 *
 * Fixed plan costs live here only — never write them into marginal costCents
 * events or company budget enforcement. Allocation is a derived view over
 * terminal runs for the current UTC month.
 */

/** How token-equivalent totals were obtained (aligned with PR #121 shapes). */
export type UsageProvenance = "measured" | "estimated" | "unknown";

export type SubscriptionPlanId =
  | "ollama_cloud_max"
  | "grok_supergrok_build"
  | "codex_subscription"
  | "claude";

export type SubscriptionCostStatus = "known" | "unknown";

export interface SubscriptionPlanRegistryEntry {
  id: SubscriptionPlanId;
  /** Operator-facing plan label */
  label: string;
  /**
   * Confirmed monthly fixed allocation in cents.
   * Null when the plan fee is unknown — never invent a zero dollar fee.
   */
  monthlyCostCents: number | null;
  costStatus: SubscriptionCostStatus;
  billingType: "subscription_included";
  /** Provider slugs observed on cost events / adapter results */
  providerKeys: string[];
  /** Optional biller slugs that strengthen a match */
  billerKeys: string[];
  /** Optional subscription-class markers (e.g. hermes ollama-max) */
  subscriptionClassKeys: string[];
}

/** Confirmed fixed base for known plans (excludes Claude). */
export const SUBSCRIPTION_KNOWN_BASE_MONTHLY_CENTS = 33_000;

export const SUBSCRIPTION_PLAN_REGISTRY: readonly SubscriptionPlanRegistryEntry[] = [
  {
    id: "ollama_cloud_max",
    label: "Ollama Cloud Max",
    monthlyCostCents: 10_000,
    costStatus: "known",
    billingType: "subscription_included",
    providerKeys: ["ollama-cloud", "ollama", "ollama_cloud"],
    billerKeys: ["ollama", "ollama-cloud"],
    subscriptionClassKeys: ["ollama-max", "ollama_max", "ollama-cloud-max"],
  },
  {
    id: "grok_supergrok_build",
    label: "Grok / SuperGrok Build",
    monthlyCostCents: 3_000,
    costStatus: "known",
    billingType: "subscription_included",
    providerKeys: ["xai", "grok"],
    billerKeys: ["xai", "grok"],
    subscriptionClassKeys: ["supergrok", "supergrok-build", "grok-build"],
  },
  {
    id: "codex_subscription",
    label: "Codex subscription",
    monthlyCostCents: 20_000,
    costStatus: "known",
    billingType: "subscription_included",
    providerKeys: ["openai", "codex"],
    billerKeys: ["chatgpt", "openai", "codex"],
    subscriptionClassKeys: ["codex", "chatgpt-plus", "chatgpt_pro"],
  },
  {
    id: "claude",
    label: "Claude",
    monthlyCostCents: null,
    costStatus: "unknown",
    billingType: "subscription_included",
    providerKeys: ["anthropic", "claude"],
    billerKeys: ["anthropic", "claude"],
    subscriptionClassKeys: ["claude", "claude-max", "claude-pro"],
  },
] as const;

export function getSubscriptionPlanById(
  planId: string,
): SubscriptionPlanRegistryEntry | undefined {
  return SUBSCRIPTION_PLAN_REGISTRY.find((plan) => plan.id === planId);
}

export function knownSubscriptionBaseMonthlyCents(): number {
  return SUBSCRIPTION_PLAN_REGISTRY.reduce((sum, plan) => {
    if (plan.costStatus !== "known" || plan.monthlyCostCents == null) return sum;
    return sum + plan.monthlyCostCents;
  }, 0);
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Map a run/cost provider identity onto a registry plan.
 * More specific subscription-class markers win when present.
 */
export function matchSubscriptionPlanId(input: {
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  subscriptionClass?: string | null;
  billingType?: string | null;
}): SubscriptionPlanId | null {
  const provider = normalizeKey(input.provider);
  const biller = normalizeKey(input.biller);
  const model = normalizeKey(input.model);
  const subscriptionClass = normalizeKey(input.subscriptionClass);
  const billingType = normalizeKey(input.billingType);

  // Prefer explicit subscription-class markers (Hermes path).
  if (subscriptionClass.length > 0) {
    for (const plan of SUBSCRIPTION_PLAN_REGISTRY) {
      if (
        plan.subscriptionClassKeys.some(
          (key) =>
            subscriptionClass === key
            || subscriptionClass.includes(key)
            || key.includes(subscriptionClass),
        )
      ) {
        return plan.id;
      }
    }
  }

  // Ollama models often look like ollama/… even when the gateway provider differs.
  if (provider.includes("ollama") || model.startsWith("ollama/") || model.includes("ollama/")) {
    return "ollama_cloud_max";
  }
  if (provider === "xai" || provider.includes("grok") || biller === "xai" || biller.includes("grok")) {
    return "grok_supergrok_build";
  }
  if (provider === "anthropic" || provider.includes("claude") || biller === "anthropic") {
    return "claude";
  }
  // Codex: OpenAI/ChatGPT subscription-backed paths (not metered API by default).
  const looksLikeCodexProvider =
    provider === "openai"
    || provider === "codex"
    || provider.includes("codex")
    || biller === "chatgpt"
    || biller === "codex";
  if (looksLikeCodexProvider) {
    if (
      billingType === "subscription_included"
      || billingType === "subscription_overage"
      || billingType === "subscription"
      || billingType === ""
      || biller === "chatgpt"
    ) {
      return "codex_subscription";
    }
  }

  for (const plan of SUBSCRIPTION_PLAN_REGISTRY) {
    if (plan.providerKeys.some((key) => provider === key || provider.includes(key))) {
      return plan.id;
    }
    if (plan.billerKeys.some((key) => biller === key || biller.includes(key))) {
      return plan.id;
    }
  }

  return null;
}

export interface SubscriptionAllocatableRun {
  runId: string;
  agentId: string;
  agentName?: string | null;
  planId: SubscriptionPlanId;
  /** Heartbeat terminal status */
  status: string;
  provider: string;
  biller?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /**
   * Provenance of token totals. Null means missing/legacy-unknown and is
   * treated as unavailable unless positive legacy token totals exist.
   */
  usageProvenance: UsageProvenance | null;
  marginalCostCents: number;
  /** Optional typed terminal grade; never inferred. */
  outcomeGrade?: string | null;
}

export function tokenEquivalentTotal(run: Pick<
  SubscriptionAllocatableRun,
  "inputTokens" | "cachedInputTokens" | "outputTokens"
>): number {
  return Math.max(0, run.inputTokens) + Math.max(0, run.cachedInputTokens) + Math.max(0, run.outputTokens);
}

/**
 * Weight used for proportional fixed-cost allocation.
 * Returns null when usage is missing/unknown — callers must not fabricate zero weight.
 */
export function allocationWeight(run: SubscriptionAllocatableRun): number | null {
  if (run.usageProvenance === "unknown") return null;
  if (run.usageProvenance === "measured" || run.usageProvenance === "estimated") {
    return tokenEquivalentTotal(run);
  }
  // Legacy rows without provenance: only positive token totals count as measured weight.
  const total = tokenEquivalentTotal(run);
  if (total > 0) return total;
  return null;
}

export function isFailedOrNoValueRun(status: string): boolean {
  return status === "failed"
    || status === "timed_out"
    || status === "cancelled"
    || status === "interrupted";
}

export function isTerminalHeartbeatStatus(status: string): boolean {
  return status === "succeeded"
    || status === "failed"
    || status === "timed_out"
    || status === "cancelled"
    || status === "interrupted";
}

export interface PlanAllocationResult {
  planId: SubscriptionPlanId;
  /** False when no non-unknown usage exists — amounts must not be shown as $0. */
  allocationAvailable: boolean;
  /** Per-run allocated fixed cents (only runs with allocation weight). */
  runAllocatedCents: Record<string, number>;
  totalAllocatedCents: number | null;
  unallocatedPlanCostCents: number | null;
}

/**
 * Distribute a known plan's monthly cents across runs with non-unknown usage,
 * proportional to token-equivalents. Uses largest-remainder for integer cents.
 * Failed runs still receive allocation weight (they consume capacity).
 */
export function allocatePlanFixedCost(
  planMonthlyCostCents: number,
  runs: SubscriptionAllocatableRun[],
): PlanAllocationResult {
  const planId = runs[0]?.planId ?? "grok_supergrok_build";
  if (!Number.isFinite(planMonthlyCostCents) || planMonthlyCostCents < 0) {
    return {
      planId,
      allocationAvailable: false,
      runAllocatedCents: {},
      totalAllocatedCents: null,
      unallocatedPlanCostCents: null,
    };
  }

  const weighted = runs
    .map((run) => ({ run, weight: allocationWeight(run) }))
    .filter((entry): entry is { run: SubscriptionAllocatableRun; weight: number } => entry.weight != null);

  if (weighted.length === 0) {
    return {
      planId,
      allocationAvailable: false,
      runAllocatedCents: {},
      totalAllocatedCents: null,
      unallocatedPlanCostCents: null,
    };
  }

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  // All eligible runs report zero token-equivalents — capacity is observed but
  // no proportional share can be formed without fabricating usage.
  if (totalWeight <= 0) {
    return {
      planId,
      allocationAvailable: false,
      runAllocatedCents: {},
      totalAllocatedCents: null,
      unallocatedPlanCostCents: null,
    };
  }

  const exact = weighted.map((entry) => ({
    runId: entry.run.runId,
    share: (planMonthlyCostCents * entry.weight) / totalWeight,
  }));
  const floors = exact.map((entry) => ({
    runId: entry.runId,
    cents: Math.floor(entry.share),
    fraction: entry.share - Math.floor(entry.share),
  }));
  let remaining = planMonthlyCostCents - floors.reduce((sum, entry) => sum + entry.cents, 0);
  floors
    .slice()
    .sort((a, b) => b.fraction - a.fraction || a.runId.localeCompare(b.runId))
    .forEach((entry) => {
      if (remaining <= 0) return;
      entry.cents += 1;
      remaining -= 1;
    });

  const runAllocatedCents: Record<string, number> = {};
  for (const entry of floors) {
    runAllocatedCents[entry.runId] = entry.cents;
  }
  const totalAllocatedCents = Object.values(runAllocatedCents).reduce((sum, n) => sum + n, 0);

  return {
    planId,
    allocationAvailable: true,
    runAllocatedCents,
    totalAllocatedCents,
    // Full plan is assigned to weighted runs; residual is only rounding dust (should be 0).
    unallocatedPlanCostCents: Math.max(0, planMonthlyCostCents - totalAllocatedCents),
  };
}

export function mergeUsageProvenance(
  values: Array<UsageProvenance | null | undefined>,
): UsageProvenance | "mixed" | null {
  const present = values.filter((value): value is UsageProvenance =>
    value === "measured" || value === "estimated" || value === "unknown"
  );
  if (present.length === 0) {
    // Legacy positive-token rows may have been treated as measured weight without
    // an explicit provenance label; callers should pass explicit values when known.
    return null;
  }
  const unique = new Set(present);
  if (unique.size === 1) return present[0]!;
  return "mixed";
}

export function currentUtcMonthWindow(now = new Date()): { start: Date; end: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

export function parseUsageProvenance(value: unknown): UsageProvenance | null {
  if (value === "measured" || value === "estimated" || value === "unknown") return value;
  return null;
}

export interface SubscriptionEconomicsPlanRow {
  planId: SubscriptionPlanId;
  label: string;
  billingType: "subscription_included";
  monthlyCostCents: number | null;
  costStatus: SubscriptionCostStatus;
  terminalRunCount: number;
  failedOrNoValueRunCount: number;
  tokenEquivalents: number | null;
  usageProvenance: UsageProvenance | "mixed" | null;
  marginalCostCents: number;
  allocatedFixedCostCents: number | null;
  unallocatedPlanCostCents: number | null;
  allocationAvailable: boolean;
}

export interface SubscriptionEconomicsBreakdownRow {
  key: string;
  label: string;
  planId: SubscriptionPlanId | null;
  terminalRunCount: number;
  failedOrNoValueRunCount: number;
  tokenEquivalents: number | null;
  usageProvenance: UsageProvenance | "mixed" | null;
  marginalCostCents: number;
  allocatedFixedCostCents: number | null;
  /** Plan residual is plan-scoped; agent/provider rows leave this null. */
  unallocatedPlanCostCents: number | null;
  outcomeGrade: string | null;
}

export interface SubscriptionEconomicsSummary {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  knownBaseMonthlyCents: number;
  knownBaseLabel: string;
  plans: SubscriptionEconomicsPlanRow[];
  byProvider: SubscriptionEconomicsBreakdownRow[];
  byAgent: SubscriptionEconomicsBreakdownRow[];
}

/**
 * Build the v1 subscription economics summary from already-loaded terminal runs.
 * Pure and unit-testable; the server service only loads runs and cost events.
 */
export function buildSubscriptionEconomicsSummary(input: {
  companyId: string;
  now?: Date;
  runs: SubscriptionAllocatableRun[];
}): SubscriptionEconomicsSummary {
  const { start, end } = currentUtcMonthWindow(input.now);
  const runsByPlan = new Map<SubscriptionPlanId, SubscriptionAllocatableRun[]>();
  for (const plan of SUBSCRIPTION_PLAN_REGISTRY) {
    runsByPlan.set(plan.id, []);
  }
  for (const run of input.runs) {
    const list = runsByPlan.get(run.planId);
    if (list) list.push(run);
    else runsByPlan.set(run.planId, [run]);
  }

  const planAllocations = new Map<SubscriptionPlanId, PlanAllocationResult>();
  const plans: SubscriptionEconomicsPlanRow[] = SUBSCRIPTION_PLAN_REGISTRY.map((plan) => {
    const planRuns = runsByPlan.get(plan.id) ?? [];
    const weights = planRuns.map((run) => allocationWeight(run));
    const hasAnyAvailableWeight = weights.some((weight) => weight != null);
    const tokenEquivalents = hasAnyAvailableWeight
      ? weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0)
      : null;
    const provenances = planRuns.map((run) => {
      if (run.usageProvenance) return run.usageProvenance;
      if (tokenEquivalentTotal(run) > 0) return "measured" as const;
      return null;
    });
    const usageProvenance = mergeUsageProvenance(provenances);

    let allocation: PlanAllocationResult;
    if (plan.costStatus === "known" && plan.monthlyCostCents != null) {
      allocation = allocatePlanFixedCost(plan.monthlyCostCents, planRuns);
    } else {
      allocation = {
        planId: plan.id,
        allocationAvailable: false,
        runAllocatedCents: {},
        totalAllocatedCents: null,
        unallocatedPlanCostCents: null,
      };
    }
    planAllocations.set(plan.id, allocation);

    return {
      planId: plan.id,
      label: plan.label,
      billingType: plan.billingType,
      monthlyCostCents: plan.monthlyCostCents,
      costStatus: plan.costStatus,
      terminalRunCount: planRuns.length,
      failedOrNoValueRunCount: planRuns.filter((run) => isFailedOrNoValueRun(run.status)).length,
      tokenEquivalents,
      usageProvenance,
      marginalCostCents: planRuns.reduce((sum, run) => sum + run.marginalCostCents, 0),
      allocatedFixedCostCents: allocation.allocationAvailable ? allocation.totalAllocatedCents : null,
      unallocatedPlanCostCents: allocation.allocationAvailable
        ? allocation.unallocatedPlanCostCents
        : null,
      allocationAvailable: allocation.allocationAvailable,
    };
  });

  function buildBreakdown(
    groupKey: (run: SubscriptionAllocatableRun) => string,
    groupLabel: (run: SubscriptionAllocatableRun) => string,
  ): SubscriptionEconomicsBreakdownRow[] {
    const groups = new Map<string, SubscriptionAllocatableRun[]>();
    for (const run of input.runs) {
      const key = groupKey(run);
      const list = groups.get(key) ?? [];
      list.push(run);
      groups.set(key, list);
    }

    const rows: SubscriptionEconomicsBreakdownRow[] = [];
    for (const [key, group] of groups) {
      const provenances = group.map((run) =>
        run.usageProvenance ?? (tokenEquivalentTotal(run) > 0 ? "measured" : null),
      );
      const weights = group.map((run) => allocationWeight(run));
      const anyWeight = weights.some((weight) => weight != null);
      let allocatedSum: number | null = null;
      let sawAllocation = false;
      for (const run of group) {
        const cents = planAllocations.get(run.planId)?.runAllocatedCents[run.runId];
        if (cents != null) {
          sawAllocation = true;
          allocatedSum = (allocatedSum ?? 0) + cents;
        }
      }
      const planIds = new Set(group.map((run) => run.planId));
      const grades = new Set(
        group.map((run) => run.outcomeGrade).filter((grade): grade is string => !!grade),
      );
      rows.push({
        key,
        label: groupLabel(group[0]!),
        planId: planIds.size === 1 ? group[0]!.planId : null,
        terminalRunCount: group.length,
        failedOrNoValueRunCount: group.filter((run) => isFailedOrNoValueRun(run.status)).length,
        tokenEquivalents: anyWeight ? weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0) : null,
        usageProvenance: mergeUsageProvenance(provenances),
        marginalCostCents: group.reduce((sum, run) => sum + run.marginalCostCents, 0),
        allocatedFixedCostCents: sawAllocation ? allocatedSum : null,
        unallocatedPlanCostCents: null,
        outcomeGrade: grades.size === 1 ? [...grades][0]! : null,
      });
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }

  const byProvider = buildBreakdown(
    (run) => run.provider || "unknown",
    (run) => run.provider || "unknown",
  );
  const byAgent = buildBreakdown(
    (run) => run.agentId,
    (run) => run.agentName?.trim() || run.agentId,
  );

  return {
    companyId: input.companyId,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    knownBaseMonthlyCents: knownSubscriptionBaseMonthlyCents(),
    knownBaseLabel: "Known fixed base $330/month plus Claude (unknown)",
    plans,
    byProvider,
    byAgent,
  };
}
