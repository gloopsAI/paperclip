import { describe, expect, it } from "vitest";
import {
  buildExecutionPhaseBudgetPlan,
  buildSubscriptionRouteAttemptEvidence,
  type ExecutionInvocationBudget,
} from "@paperclipai/adapter-utils/execution-envelope";
import {
  assessWorkforceCapacity,
  classifyWorkforceRoute,
  probeWorkforceCapacity,
  workforceCapacityRequiredForRoute,
} from "./workforce-capacity.js";

function budget(overrides: Partial<ExecutionInvocationBudget> = {}): ExecutionInvocationBudget {
  return {
    schemaVersion: "paperclip.provider-invocation-budget.v1",
    budgetId: "issue:issue-1:default",
    reservationId: "reservation-1",
    maxInputTokens: 12_000,
    maxOutputTokens: 3_000,
    maxTurns: 8,
    maxToolCalls: 20,
    maxWallMs: 300_000,
    phasePlan: buildExecutionPhaseBudgetPlan({
      inputTokens: 12_000,
      outputTokens: 3_000,
      turns: 8,
      toolCalls: 20,
      wallMs: 300_000,
    }),
    ...overrides,
  };
}

function quota(usedPercent = 40) {
  return {
    provider: "openai",
    ok: true,
    windows: [{ label: "weekly", usedPercent, resetsAt: null, valueLabel: null }],
  };
}

function durableEvidence(overrides: Record<string, unknown> = {}) {
  const attempt = buildSubscriptionRouteAttemptEvidence({
    provider: "luna",
    transport: "subscription_cli",
    disposition: "attempted_failed",
    reason: "quality_failure",
    runId: "run-luna",
    issueId: "issue-1",
    observedAt: "2026-08-13T10:00:00.000Z",
  });
  return {
    gloopsProviderRouteEvidence: {
      schemaVersion: "gloops.subscription-route-evidence.v1",
      attempts: [{ ...attempt, ...overrides }],
    },
  };
}

describe("workforce capacity admission (network-free failure harness)", () => {
  it("turns injected probe rejection and timeout into fail-closed snapshots", async () => {
    await expect(probeWorkforceCapacity("openai", async () => {
      throw new Error("offline fixture");
    })).resolves.toEqual({
      provider: "openai",
      ok: false,
      error: "offline fixture",
      windows: [],
    });

    await expect(probeWorkforceCapacity(
      "openai",
      () => new Promise(() => undefined),
      1,
    )).resolves.toEqual({
      provider: "openai",
      ok: false,
      error: "capacity probe timed out after 1ms",
      windows: [],
    });
  });

  it("classifies Luna and Terra as the durable bench while Codex/Grok remain burst lanes", () => {
    expect(classifyWorkforceRoute("codex_local", "gpt-5.6-luna")).toMatchObject({
      lane: "durable_bench",
      provider: "luna",
    });
    expect(classifyWorkforceRoute("codex_local", "gpt-5.6-terra")).toMatchObject({
      lane: "durable_bench",
      provider: "terra",
    });
    expect(classifyWorkforceRoute("codex_local", "gpt-5.6-sol")).toMatchObject({
      lane: "burst",
      provider: "codex",
    });
    expect(classifyWorkforceRoute("grok_local", null)).toMatchObject({
      lane: "burst",
      provider: "grok",
    });
  });

  it("enforces capacity by default for every durable role while preserving non-durable compatibility", () => {
    expect(workforceCapacityRequiredForRoute({
      route: classifyWorkforceRoute("codex_local", "gpt-5.6-luna"),
    })).toBe(true);
    expect(workforceCapacityRequiredForRoute({
      route: classifyWorkforceRoute("codex_local", "gpt-5.6-terra"),
      runtimeRequired: false,
      issueRequired: false,
    })).toBe(true);
    expect(workforceCapacityRequiredForRoute({
      route: classifyWorkforceRoute("codex_local", "gpt-5.6-sol"),
    })).toBe(false);
    expect(workforceCapacityRequiredForRoute({
      route: classifyWorkforceRoute("grok_local", null),
      runtimeRequired: true,
    })).toBe(true);
  });

  it("issues an issue/run/reservation-bound Luna lease without using billed cost", () => {
    const receipt = assessWorkforceCapacity({
      runId: "run-1",
      issueId: "issue-1",
      agentId: "wren",
      adapterType: "codex_local",
      model: "gpt-5.6-luna",
      invocationBudget: budget(),
      quota: quota(40),
      queuedAt: new Date("2026-08-13T10:00:00.000Z"),
      evaluatedAt: new Date("2026-08-13T10:00:02.000Z"),
    });

    expect(receipt.decision).toBe("ready");
    expect(receipt.lease).toMatchObject({ issuedAt: "2026-08-13T10:00:02.000Z" });
    expect(receipt.binding).toMatchObject({ issueId: "issue-1", runId: "run-1", reservationId: "reservation-1" });
    expect(receipt.metrics.rawTokenReservation).toEqual({
      maxInputTokens: 12_000,
      maxOutputTokens: 3_000,
      provenance: "reservation",
    });
    expect(receipt.metrics.subscriptionCapacity).toMatchObject({
      source: "provider_quota_window",
      state: "available",
      maxUsedPercent: 40,
    });
    expect(receipt.metrics.queue).toEqual({ latencyMs: 2_000 });
    expect(receipt.metrics.billing).toEqual({
      usedForAdmission: false,
      billedCostCents: null,
      note: "billed cost is measured separately from capacity admission",
    });
  });

  it("fails closed before provider invocation when durable capacity is exhausted or unavailable", () => {
    const common = {
      runId: "run-1",
      issueId: "issue-1",
      agentId: "argus",
      adapterType: "codex_local",
      model: "gpt-5.6-terra",
      invocationBudget: budget(),
      evaluatedAt: new Date("2026-08-13T10:01:00.000Z"),
    };
    expect(assessWorkforceCapacity({ ...common, quota: quota(100) })).toMatchObject({
      decision: "denied",
      reasons: ["capacity_exhausted"],
      lease: null,
    });
    expect(assessWorkforceCapacity({ ...common, quota: null })).toMatchObject({
      decision: "denied",
      reasons: ["capacity_snapshot_missing"],
      lease: null,
    });
    expect(assessWorkforceCapacity({
      ...common,
      quota: { provider: "openai", ok: false, error: "probe offline", windows: [] },
    })).toMatchObject({
      decision: "denied",
      reasons: ["capacity_probe_failed"],
      lease: null,
    });
  });

  it("admits a Grok burst only after a fresh typed durable failure receipt", () => {
    const common = {
      runId: "run-grok",
      issueId: "issue-1",
      agentId: "grok-burst",
      adapterType: "grok_local",
      model: null,
      invocationBudget: budget(),
      quota: null,
      evaluatedAt: new Date("2026-08-13T10:02:00.000Z"),
    };
    expect(assessWorkforceCapacity(common)).toMatchObject({
      decision: "denied",
      reasons: ["burst_escalation_receipt_missing"],
      lease: null,
    });
    const admitted = assessWorkforceCapacity({ ...common, context: durableEvidence() });
    expect(admitted.decision).toBe("ready");
    expect(admitted.metrics.subscriptionCapacity).toMatchObject({
      source: "bounded_execution_budget",
      state: "available",
    });
    expect(admitted.metrics.quality).toEqual({
      source: "typed_escalation_receipt",
      reason: "quality_failure",
    });
  });

  it("rejects tampered and stale escalation evidence", () => {
    const common = {
      runId: "run-sol",
      issueId: "issue-1",
      agentId: "codex-burst",
      adapterType: "codex_local",
      model: "gpt-5.6-sol",
      invocationBudget: budget(),
      quota: quota(20),
      evaluatedAt: new Date("2026-08-13T10:02:00.000Z"),
    };
    expect(assessWorkforceCapacity({
      ...common,
      context: durableEvidence({ receiptDigest: `sha256:${"0".repeat(64)}` }),
    }).reasons).toContain("burst_escalation_receipt_missing");
    expect(assessWorkforceCapacity({
      ...common,
      context: durableEvidence({ observedAt: "2026-08-13T03:59:00.000Z" }),
    }).reasons).toContain("burst_escalation_receipt_missing");
    const otherIssueAttempt = buildSubscriptionRouteAttemptEvidence({
      provider: "terra",
      transport: "subscription_cli",
      disposition: "attempted_failed",
      reason: "quality_failure",
      runId: "run-other",
      issueId: "issue-other",
      observedAt: "2026-08-13T10:00:00.000Z",
    });
    expect(assessWorkforceCapacity({
      ...common,
      context: {
        gloopsProviderRouteEvidence: {
          schemaVersion: "gloops.subscription-route-evidence.v1",
          attempts: [otherIssueAttempt],
        },
      },
    }).reasons).toContain("burst_escalation_receipt_missing");
  });

  it("denies every model lane when the per-item phase budget is absent or invalid", () => {
    const missing = assessWorkforceCapacity({
      runId: "run-1",
      issueId: "issue-1",
      agentId: "wren",
      adapterType: "codex_local",
      model: "gpt-5.6-luna",
      invocationBudget: budget({ phasePlan: undefined }),
      quota: quota(),
    });
    expect(missing.reasons).toContain("phase_budget_missing");

    const invalid = assessWorkforceCapacity({
      runId: "run-1",
      issueId: "issue-1",
      agentId: "wren",
      adapterType: "codex_local",
      model: "gpt-5.6-luna",
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({
          inputTokens: 12_000,
          outputTokens: 3_000,
          turns: 0,
          toolCalls: 20,
          wallMs: 300_000,
        }),
      }),
      quota: quota(),
    });
    expect(invalid.reasons).toContain("phase_budget_invalid");
  });
});
