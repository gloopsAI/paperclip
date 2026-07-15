import { describe, expect, it } from "vitest";
import {
  allowsAutomaticRecoveryCreation,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionAdmission,
  parseExecutionAdmissionPolicy,
  readExecutionAdmissionEnvelope,
  resolveExecutionBudgetIdentity,
} from "./execution-admission.js";

const enabledEnv = {
  PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
  PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "3",
  PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "2",
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000",
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200",
  PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "60000",
  PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "400",
  PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "100",
  PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "6",
  PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "24",
};

function policy() {
  const parsed = parseExecutionAdmissionPolicy(enabledEnv);
  if (!parsed.enabled) throw new Error("expected enabled policy");
  return parsed;
}

describe("execution admission", () => {
  it("is default-off and fails closed on incomplete enabled configuration", () => {
    expect(parseExecutionAdmissionPolicy({})).toEqual({ enabled: false });
    expect(() => parseExecutionAdmissionPolicy({ PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true" })).toThrow(
      "PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK",
    );
    expect(() => parseExecutionAdmissionPolicy({ ...enabledEnv, PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "3" }))
      .toThrow("must be lower");
  });

  it("allows an initial run and bounded continuations, then denies further execution", () => {
    expect(evaluateExecutionAdmission(policy(), [])).toMatchObject({ allowed: true });
    expect(evaluateExecutionAdmission(policy(), [{}])).toMatchObject({ allowed: true });
    expect(evaluateExecutionAdmission(policy(), [{}, {}])).toMatchObject({ allowed: true });
    expect(evaluateExecutionAdmission(policy(), [{}, {}, {}])).toMatchObject({
      allowed: false,
      reason: "run_limit_exhausted",
    });
  });

  it("allows the initial run when retries are disabled, then denies a continuation", () => {
    const parsed = parseExecutionAdmissionPolicy({
      ...enabledEnv,
      PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "2",
      PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "0",
    });
    if (!parsed.enabled) throw new Error("expected enabled policy");

    expect(evaluateExecutionAdmission(parsed, [])).toMatchObject({
      allowed: true,
      reason: null,
      observed: { runCount: 0, retryCount: 0 },
    });
    expect(evaluateExecutionAdmission(parsed, [{}])).toMatchObject({
      allowed: false,
      reason: "retry_limit_exhausted",
      observed: { runCount: 1, retryCount: 0 },
    });
  });

  it("suppresses automatic recovery before row creation when retries are disabled or runs are exhausted", () => {
    const zeroRecovery = parseExecutionAdmissionPolicy({
      ...enabledEnv,
      PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "1",
      PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "0",
    });
    const multiRun = policy();
    const first = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:abc:default", epoch: "default" },
      policy: multiRun,
      decision: evaluateExecutionAdmission(multiRun, []),
      evaluatedAt: new Date("2026-07-13T00:00:00Z"),
    });
    const last = { ...first, attempt: multiRun.maxRunsPerTask };

    expect(allowsAutomaticRecoveryCreation({ enabled: false }, null)).toBe(true);
    expect(allowsAutomaticRecoveryCreation({ enabled: false }, first)).toBe(false);
    expect(allowsAutomaticRecoveryCreation({ enabled: false }, null, true)).toBe(false);
    expect(allowsAutomaticRecoveryCreation(multiRun, null)).toBe(false);
    expect(allowsAutomaticRecoveryCreation(multiRun, { ...first, policyDigest: "0".repeat(64) })).toBe(false);
    expect(allowsAutomaticRecoveryCreation(zeroRecovery, first)).toBe(false);
    expect(allowsAutomaticRecoveryCreation(multiRun, first)).toBe(true);
    expect(allowsAutomaticRecoveryCreation(multiRun, last)).toBe(false);
  });

  it("denies when token or wall ceilings are already spent", () => {
    expect(evaluateExecutionAdmission(policy(), [{ inputTokens: 1000 }]).reason).toBe(
      "input_token_limit_exhausted",
    );
    expect(evaluateExecutionAdmission(policy(), [{ outputTokens: 200 }]).reason).toBe(
      "output_token_limit_exhausted",
    );
    expect(evaluateExecutionAdmission(policy(), [{ wallMs: 60000 }]).reason).toBe(
      "wall_time_limit_exhausted",
    );
  });

  it("inherits a retry-chain budget and only accepts user-authored reset epochs", () => {
    const parent = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:abc:default", epoch: "default" },
      policy: policy(),
      decision: evaluateExecutionAdmission(policy(), []),
      evaluatedAt: new Date("2026-07-13T00:00:00Z"),
    });
    expect(resolveExecutionBudgetIdentity({
      issueId: "abc",
      runId: "run-2",
      retryOfRunId: "run-1",
      parentEnvelope: parent,
      resetId: null,
      requestedByActorType: "system",
    })).toEqual({ budgetId: "issue:abc:default", epoch: "default" });

    expect(resolveExecutionBudgetIdentity({
      issueId: "abc",
      runId: "run-3",
      retryOfRunId: null,
      parentEnvelope: null,
      resetId: "operator-2",
      requestedByActorType: "user",
    })).toEqual({ budgetId: "issue:abc:operator-2", epoch: "operator-2" });

    expect(() => resolveExecutionBudgetIdentity({
      issueId: "abc",
      runId: "run-3",
      retryOfRunId: null,
      parentEnvelope: null,
      resetId: "operator-2",
      requestedByActorType: "system",
    })).toThrow("only valid on a user-requested wake");

    expect(readExecutionAdmissionEnvelope(parent)).toEqual(parent);
    expect(parent.reservation).toMatchObject({
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      maxInputTokens: 400,
      maxOutputTokens: 100,
      maxTurns: 6,
      maxToolCalls: 24,
    });
    expect(readExecutionAdmissionEnvelope({ ...parent, policyDigest: "forged" })).toBeNull();
    expect(readExecutionAdmissionEnvelope({ ...parent, observed: { ...parent.observed, runCount: -1 } })).toBeNull();
  });
});
