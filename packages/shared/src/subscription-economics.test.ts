import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_KNOWN_BASE_MONTHLY_CENTS,
  SUBSCRIPTION_PLAN_REGISTRY,
  allocatePlanFixedCost,
  allocationWeight,
  buildSubscriptionEconomicsSummary,
  knownSubscriptionBaseMonthlyCents,
  matchSubscriptionPlanId,
  parseUsageProvenance,
  type SubscriptionAllocatableRun,
} from "./subscription-economics.js";

function run(overrides: Partial<SubscriptionAllocatableRun> = {}): SubscriptionAllocatableRun {
  return {
    runId: overrides.runId ?? "run-1",
    agentId: overrides.agentId ?? "agent-1",
    agentName: overrides.agentName ?? "Grok Burst",
    planId: overrides.planId ?? "grok_supergrok_build",
    status: overrides.status ?? "succeeded",
    provider: overrides.provider ?? "xai",
    biller: overrides.biller ?? "xai",
    inputTokens: overrides.inputTokens ?? 100,
    cachedInputTokens: overrides.cachedInputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 50,
    usageProvenance: overrides.usageProvenance === undefined ? "measured" : overrides.usageProvenance,
    marginalCostCents: overrides.marginalCostCents ?? 0,
    outcomeGrade: overrides.outcomeGrade ?? null,
  };
}

describe("subscription plan registry", () => {
  it("ships the confirmed monthly fees and unknown Claude without fabricating zero", () => {
    const byId = Object.fromEntries(SUBSCRIPTION_PLAN_REGISTRY.map((plan) => [plan.id, plan]));
    expect(byId.ollama_cloud_max?.monthlyCostCents).toBe(10_000);
    expect(byId.grok_supergrok_build?.monthlyCostCents).toBe(3_000);
    expect(byId.codex_subscription?.monthlyCostCents).toBe(20_000);
    expect(byId.claude?.monthlyCostCents).toBeNull();
    expect(byId.claude?.costStatus).toBe("unknown");
    expect(knownSubscriptionBaseMonthlyCents()).toBe(SUBSCRIPTION_KNOWN_BASE_MONTHLY_CENTS);
    expect(SUBSCRIPTION_KNOWN_BASE_MONTHLY_CENTS).toBe(33_000);
    for (const plan of SUBSCRIPTION_PLAN_REGISTRY) {
      if (plan.costStatus === "known") {
        expect(plan.monthlyCostCents).toBeGreaterThan(0);
      }
    }
  });

  it("matches provider/subscription-class identities to registry plans", () => {
    expect(matchSubscriptionPlanId({ provider: "xai", billingType: "subscription_included" })).toBe("grok_supergrok_build");
    expect(matchSubscriptionPlanId({ provider: "hermes_gateway", subscriptionClass: "ollama-max" }))
      .toBe("ollama_cloud_max");
    expect(matchSubscriptionPlanId({ provider: "openai", biller: "chatgpt", billingType: "subscription_included" }))
      .toBe("codex_subscription");
    expect(matchSubscriptionPlanId({ provider: "anthropic", billingType: "subscription_included" })).toBe("claude");
    expect(matchSubscriptionPlanId({ provider: "google" })).toBeNull();
  });

  it("never classifies metered xAI/Grok API traffic as fixed subscription capacity", () => {
    expect(matchSubscriptionPlanId({
      provider: "xai",
      biller: "grok",
      billingType: "metered_api",
      subscriptionClass: "grok-build",
    })).toBeNull();
    expect(matchSubscriptionPlanId({ provider: "xai" })).toBeNull();
  });
});

describe("allocationWeight", () => {
  it("excludes unknown and missing-zero usage instead of treating them as free", () => {
    expect(allocationWeight(run({ usageProvenance: "unknown", inputTokens: 0, outputTokens: 0 }))).toBeNull();
    expect(allocationWeight(run({ usageProvenance: null, inputTokens: 0, outputTokens: 0 }))).toBeNull();
    expect(allocationWeight(run({ usageProvenance: "estimated", inputTokens: 40, outputTokens: 10 }))).toBe(50);
    expect(allocationWeight(run({ usageProvenance: "reserved", inputTokens: 40, outputTokens: 10 }))).toBeNull();
    expect(allocationWeight(run({ usageProvenance: null, inputTokens: 12, outputTokens: 0 }))).toBeNull();
  });
});

describe("usage provenance", () => {
  it("keeps reservation fallback separate from measured and estimated usage", () => {
    expect(parseUsageProvenance("reservation_fallback")).toBe("reserved");
    expect(parseUsageProvenance("measured")).toBe("measured");
    expect(parseUsageProvenance("estimated")).toBe("estimated");
  });
});

describe("allocatePlanFixedCost", () => {
  it("allocates proportionally and keeps failed runs in the cost pool", () => {
    const result = allocatePlanFixedCost(3_000, [
      run({ runId: "a", inputTokens: 75, outputTokens: 0, status: "succeeded" }),
      run({ runId: "b", inputTokens: 25, outputTokens: 0, status: "failed" }),
    ]);
    expect(result.allocationAvailable).toBe(true);
    expect(result.runAllocatedCents.a).toBe(2_250);
    expect(result.runAllocatedCents.b).toBe(750);
    expect(result.totalAllocatedCents).toBe(3_000);
    expect(result.unallocatedPlanCostCents).toBe(0);
  });

  it("marks allocation unavailable when usage is unknown rather than fabricating $0", () => {
    const result = allocatePlanFixedCost(10_000, [
      run({
        planId: "ollama_cloud_max",
        usageProvenance: "unknown",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(result.allocationAvailable).toBe(false);
    expect(result.totalAllocatedCents).toBeNull();
    expect(result.unallocatedPlanCostCents).toBeNull();
  });

  it("uses largest-remainder so integer cents sum to the plan total", () => {
    const result = allocatePlanFixedCost(100, [
      run({ runId: "a", inputTokens: 1, outputTokens: 0 }),
      run({ runId: "b", inputTokens: 1, outputTokens: 0 }),
      run({ runId: "c", inputTokens: 1, outputTokens: 0 }),
    ]);
    expect(result.totalAllocatedCents).toBe(100);
    const values = Object.values(result.runAllocatedCents).sort((a, b) => b - a);
    expect(values).toEqual([34, 33, 33]);
  });
});

describe("buildSubscriptionEconomicsSummary", () => {
  it("reports measured, estimated, reserved, and unknown usage as separate truth buckets", () => {
    const summary = buildSubscriptionEconomicsSummary({
      companyId: "company-1",
      runs: [
        run({ runId: "m", usageProvenance: "measured", inputTokens: 10, outputTokens: 2 }),
        run({ runId: "e", usageProvenance: "estimated", inputTokens: 20, outputTokens: 3 }),
        run({ runId: "r", usageProvenance: "reserved", inputTokens: 1000, outputTokens: 200 }),
        run({ runId: "u", usageProvenance: "unknown", inputTokens: 5000, outputTokens: 500 }),
      ],
    });
    expect(summary.usageTruth).toMatchObject({
      measuredTokenEquivalents: 12,
      estimatedTokenEquivalents: 23,
      reservedTokenCeilings: 1200,
      unknownRunCount: 1,
    });
    const grok = summary.plans.find((plan) => plan.planId === "grok_supergrok_build")!;
    expect(grok.tokenEquivalents).toBe(35);
    expect(grok.allocatedFixedCostCents).toBe(3000);
  });

  it("surfaces plan fees, allocation, and breakdown rows for the current UTC month", () => {
    const summary = buildSubscriptionEconomicsSummary({
      companyId: "company-1",
      now: new Date("2026-07-15T12:00:00.000Z"),
      runs: [
        run({
          runId: "g1",
          planId: "grok_supergrok_build",
          provider: "xai",
          agentId: "agent-g",
          agentName: "Grok Burst",
          inputTokens: 100,
          outputTokens: 0,
          usageProvenance: "estimated",
          marginalCostCents: 0,
        }),
        run({
          runId: "o1",
          planId: "ollama_cloud_max",
          provider: "ollama-cloud",
          agentId: "agent-o",
          agentName: "Steward",
          inputTokens: 50,
          outputTokens: 50,
          usageProvenance: "measured",
          status: "failed",
          marginalCostCents: 0,
        }),
        run({
          runId: "c1",
          planId: "claude",
          provider: "anthropic",
          agentId: "agent-c",
          agentName: "Claude",
          inputTokens: 10,
          outputTokens: 10,
          usageProvenance: "measured",
          marginalCostCents: 12,
        }),
      ],
    });

    expect(summary.periodStart).toBe("2026-07-01T00:00:00.000Z");
    expect(summary.periodEnd).toBe("2026-08-01T00:00:00.000Z");
    expect(summary.knownBaseMonthlyCents).toBe(33_000);

    const grok = summary.plans.find((plan) => plan.planId === "grok_supergrok_build")!;
    expect(grok.monthlyCostCents).toBe(3_000);
    expect(grok.allocatedFixedCostCents).toBe(3_000);
    expect(grok.usageProvenance).toBe("estimated");
    expect(grok.terminalRunCount).toBe(1);

    const ollama = summary.plans.find((plan) => plan.planId === "ollama_cloud_max")!;
    expect(ollama.monthlyCostCents).toBe(10_000);
    expect(ollama.failedOrNoValueRunCount).toBe(1);
    expect(ollama.allocatedFixedCostCents).toBe(10_000);

    const claude = summary.plans.find((plan) => plan.planId === "claude")!;
    expect(claude.monthlyCostCents).toBeNull();
    expect(claude.costStatus).toBe("unknown");
    expect(claude.allocationAvailable).toBe(false);
    expect(claude.allocatedFixedCostCents).toBeNull();
    expect(claude.marginalCostCents).toBe(12);

    const codex = summary.plans.find((plan) => plan.planId === "codex_subscription")!;
    expect(codex.monthlyCostCents).toBe(20_000);
    // No usage → allocation unavailable (not $0 free capacity).
    expect(codex.allocationAvailable).toBe(false);
    expect(codex.allocatedFixedCostCents).toBeNull();
    expect(codex.unallocatedPlanCostCents).toBeNull();

    expect(summary.byProvider.some((row) => row.key === "xai" && row.allocatedFixedCostCents === 3_000)).toBe(true);
    expect(summary.byAgent.some((row) => row.key === "agent-o" && row.failedOrNoValueRunCount === 1)).toBe(true);
  });
});
