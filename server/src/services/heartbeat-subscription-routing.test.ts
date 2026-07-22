import { describe, expect, it } from "vitest";
import { subscriptionRouteAdvanceForRun } from "./heartbeat.js";

function run(overrides: Record<string, unknown> = {}) {
  return {
    status: "failed",
    error: null,
    errorCode: null,
    resultJson: null,
    ...overrides,
  } as never;
}

describe("subscription route advancement", () => {
  it("advances quota-exhausted Ollama/Hermes work to Grok CLI", () => {
    expect(subscriptionRouteAdvanceForRun("hermes_gateway", run({
      errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota" },
    }))).toEqual({
      provider: "ollama",
      transport: "subscription_cli",
      reason: "quota_exhausted",
      targetAdapterType: "grok_local",
    });
  });

  it("advances an unavailable Grok CLI run to Codex", () => {
    expect(subscriptionRouteAdvanceForRun("grok_local", run({
      status: "timed_out",
      errorCode: "timeout",
    }))).toEqual({
      provider: "grok",
      transport: "cli",
      reason: "provider_unavailable",
      targetAdapterType: "codex_local",
    });
  });

  it("does not escalate ordinary failures, authentication defects, or Codex exhaustion", () => {
    expect(subscriptionRouteAdvanceForRun("hermes_gateway", run({ error: "tests failed" }))).toBeNull();
    expect(subscriptionRouteAdvanceForRun("grok_local", run({ error: "authentication required" }))).toBeNull();
    expect(subscriptionRouteAdvanceForRun("codex_local", run({
      errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota" },
    }))).toBeNull();
  });

  it("honors an explicit capability-floor receipt without guessing from prose", () => {
    expect(subscriptionRouteAdvanceForRun("hermes_local", run({
      resultJson: { subscriptionRouteAdvance: { reason: "capability_floor" } },
    }))).toMatchObject({
      provider: "ollama",
      reason: "capability_floor",
      targetAdapterType: "grok_local",
    });
  });
});
