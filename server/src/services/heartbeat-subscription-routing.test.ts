import { describe, expect, it } from "vitest";
import { isWorkforceCapacityFailedRun, subscriptionRouteAdvanceForRun } from "./heartbeat.js";

function run(overrides: Record<string, unknown> = {}) {
  return {
    status: "failed",
    error: null,
    errorCode: null,
    resultJson: null,
    usageJson: null,
    ...overrides,
  } as never;
}

describe("subscription route advancement", () => {
  it("advances quota-exhausted supplemental Ollama/Hermes work directly to Grok", () => {
    expect(subscriptionRouteAdvanceForRun("hermes_gateway", null, run({
      errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota" },
    }))).toEqual({
      provider: "ollama",
      transport: "subscription_cli",
      reason: "quota_exhausted",
      targetAdapterType: "grok_local",
      targetLane: "grok_burst",
    });
  });

  it("never silently advances an unavailable Grok CLI run to Codex", () => {
    expect(subscriptionRouteAdvanceForRun("grok_local", null, run({
      status: "timed_out",
      errorCode: "timeout",
    }))).toBeNull();
  });

  it("advances a failed Luna/Terra durable run to a bounded Grok burst lane", () => {
    expect(subscriptionRouteAdvanceForRun("codex_local", "gpt-5.6-luna", run({
      errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota" },
    }))).toEqual({
      provider: "luna",
      transport: "subscription_cli",
      reason: "quota_exhausted",
      targetAdapterType: "grok_local",
      targetLane: "grok_burst",
    });
  });

  it("does not escalate ordinary failures, authentication defects, or Codex exhaustion", () => {
    expect(subscriptionRouteAdvanceForRun("hermes_gateway", null, run({ error: "tests failed" }))).toBeNull();
    expect(subscriptionRouteAdvanceForRun("grok_local", null, run({ error: "authentication required" }))).toBeNull();
    expect(subscriptionRouteAdvanceForRun("codex_local", "gpt-5.6-sol", run({
      errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota" },
    }))).toBeNull();
  });

  it("honors an explicit capability-floor receipt without guessing from prose", () => {
    expect(subscriptionRouteAdvanceForRun("hermes_local", null, run({
      resultJson: { subscriptionRouteAdvance: { reason: "capability_floor" } },
    }))).toMatchObject({
      provider: "ollama",
      reason: "capability_floor",
      targetAdapterType: "grok_local",
      targetLane: "grok_burst",
    });
  });

  it("does not mint evidence, reassign, or wake after a pre-invocation capacity denial", () => {
    const effects = {
      attemptedFailureReceipts: 0,
      reassignments: 0,
      wakeups: 0,
      recoveryRows: 0,
      retries: 0,
    };
    const deniedRun = run({
      errorCode: "workforce_capacity.denied",
      error: "Workforce capacity denied provider execution: capacity_snapshot_missing",
      resultJson: {
        providerInvocationAttempted: false,
        workforceCapacity: { decision: "denied", reasons: ["capacity_snapshot_missing"] },
      },
    });
    const advance = subscriptionRouteAdvanceForRun("codex_local", "gpt-5.6-luna", deniedRun);
    if (advance) {
      effects.attemptedFailureReceipts += 1;
      effects.reassignments += 1;
      effects.wakeups += 1;
    }
    // Mirrors releaseIssueExecutionAndPromote's immediate-block branch: a
    // capacity admission denial must not enter generic same-agent recovery.
    if (!isWorkforceCapacityFailedRun(deniedRun)) {
      effects.recoveryRows += 1;
      effects.retries += 1;
      effects.wakeups += 1;
    }

    expect(advance).toBeNull();
    expect(isWorkforceCapacityFailedRun(deniedRun)).toBe(true);
    expect(effects).toEqual({
      attemptedFailureReceipts: 0,
      reassignments: 0,
      wakeups: 0,
      recoveryRows: 0,
      retries: 0,
    });
  });

  it("suppresses historical admission denials even when false-attempt metadata is absent", () => {
    expect(subscriptionRouteAdvanceForRun("codex_local", "gpt-5.6-terra", run({
      errorCode: "workforce_capacity.denied",
      error: "capacity snapshot missing",
    }))).toBeNull();
  });
});
