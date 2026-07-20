import { describe, expect, it } from "vitest";
import {
  allowsAutomaticRecoveryCreation,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionReservationUsage,
  evaluateExecutionAdmission,
  parseExecutionAdmissionPolicy,
  parseReconciledExecutionAdapters,
  readExecutionAdmissionEnvelope,
  resolveEffectiveExecutionAdmissionPolicy,
  resolveExecutionAdmissionPolicyForResourceBudget,
  resolveExecutionBudgetIdentity,
  resolveReportedReservationExceeded,
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

  it("parses only explicit CLI adapters for reconciled execution", () => {
    expect([...parseReconciledExecutionAdapters({})]).toEqual([]);
    expect([
      ...parseReconciledExecutionAdapters({
        PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS: " grok_local, codex_local ",
      }),
    ]).toEqual(["grok_local", "codex_local"]);
    expect(() => parseReconciledExecutionAdapters({
      PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS: "hermes_gateway",
    })).toThrow("may contain only codex_local and grok_local");
    expect(() => parseReconciledExecutionAdapters({
      PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS: "grok_local,",
    })).toThrow("may contain only codex_local and grok_local");
  });

  it("allows an initial run and bounded continuations, then denies further execution", () => {
    expect(evaluateExecutionAdmission(policy(), [])).toMatchObject({ allowed: true });
    expect(evaluateExecutionAdmission(
      policy(),
      [{ retryOfRunId: null }],
      { isRetry: true },
    )).toMatchObject({ allowed: true });
    expect(evaluateExecutionAdmission(
      policy(),
      [{ retryOfRunId: null }, { retryOfRunId: "run-1" }],
      { isRetry: true },
    )).toMatchObject({ allowed: true });
    expect(evaluateExecutionAdmission(
      policy(),
      [
        { retryOfRunId: null },
        { retryOfRunId: "run-1" },
        { retryOfRunId: "run-2" },
      ],
      { isRetry: true },
    )).toMatchObject({
      allowed: false,
      reason: "run_limit_exhausted",
    });
  });

  it("allows an independent second stage when retries are disabled, but denies a retry", () => {
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
    expect(evaluateExecutionAdmission(
      parsed,
      [{ retryOfRunId: null }],
      { isAuthorizedIndependentStage: true },
    )).toMatchObject({
      allowed: true,
      reason: null,
      observed: { runCount: 1, retryCount: 0 },
    });
    expect(evaluateExecutionAdmission(parsed, [{ retryOfRunId: null }], { isRetry: true })).toMatchObject({
      allowed: false,
      reason: "retry_limit_exhausted",
      observed: { runCount: 1, retryCount: 0 },
    });
    expect(evaluateExecutionAdmission(parsed, [{ retryOfRunId: null }])).toMatchObject({
      allowed: false,
      reason: "retry_limit_exhausted",
      observed: { runCount: 1, retryCount: 0 },
    });
  });

  it("counts only explicit retry runs against the retry budget", () => {
    expect(evaluateExecutionAdmission(policy(), [
      { retryOfRunId: null },
      { retryOfRunId: "run-1" },
    ], { isAuthorizedIndependentStage: true })).toMatchObject({
      allowed: true,
      observed: { runCount: 2, retryCount: 1 },
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
    expect(evaluateExecutionAdmission(policy(), [{ inputTokens: 1000 }], { isRetry: true }).reason).toBe(
      "input_token_limit_exhausted",
    );
    expect(evaluateExecutionAdmission(policy(), [{ outputTokens: 200 }], { isRetry: true }).reason).toBe(
      "output_token_limit_exhausted",
    );
    expect(evaluateExecutionAdmission(policy(), [{ wallMs: 60000 }], { isRetry: true }).reason).toBe(
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

  it("resolves an effective policy from task and parent overrides", () => {
    const global = policy();
    const request = {
      maxInputTokensPerTask: 800,
      maxOutputTokensPerTask: 50,
      maxRetriesPerTask: 1,
    };
    expect(resolveEffectiveExecutionAdmissionPolicy(global, null, null)).toEqual(global);
    expect(resolveEffectiveExecutionAdmissionPolicy(global, request, null)).toMatchObject({
      maxInputTokensPerTask: 800,
      maxOutputTokensPerTask: 50,
      maxRetriesPerTask: 1,
    });
    const parent = resolveEffectiveExecutionAdmissionPolicy(global, { maxInputTokensPerTask: 500, maxRetriesPerTask: 1 }, null);
    expect(resolveEffectiveExecutionAdmissionPolicy(global, null, parent)).toMatchObject({
      maxInputTokensPerTask: 500,
      maxRetriesPerTask: 1,
    });
    const tightened = resolveEffectiveExecutionAdmissionPolicy(global, { maxInputTokensPerTask: 700, maxRetriesPerTask: 0 }, parent);
    expect(tightened).toMatchObject({
      maxInputTokensPerTask: 500,
      maxRetriesPerTask: 0,
    });
    const widened = resolveEffectiveExecutionAdmissionPolicy(global, { maxInputTokensPerTask: 900, maxRetriesPerTask: 2 }, parent);
    expect(widened).toMatchObject({
      maxInputTokensPerTask: 500,
      maxRetriesPerTask: 1,
    });
  });

  it("enforces relational clamps between effective retry and invocation settings", () => {
    const base = policy();
    const widerTokens = resolveEffectiveExecutionAdmissionPolicy(base, {
      maxInputTokensPerInvocation: 500,
      maxOutputTokensPerInvocation: 150,
      maxRetriesPerTask: 1,
    }, null);
    expect(widerTokens.maxInputTokensPerInvocation).toBe(base.maxInputTokensPerInvocation);
    expect(widerTokens.maxOutputTokensPerInvocation).toBe(base.maxOutputTokensPerInvocation);
    const narrowTask = resolveEffectiveExecutionAdmissionPolicy(base, {
      maxInputTokensPerTask: 200,
      maxOutputTokensPerTask: 50,
      maxRunsPerTask: 2,
      maxRetriesPerTask: 0,
    }, null);
    expect(narrowTask.maxInputTokensPerInvocation).toBe(200);
    expect(narrowTask.maxOutputTokensPerInvocation).toBe(50);
    expect(narrowTask.maxTurnsPerInvocation).toBeGreaterThan(0);
  });

  it("rejects malformed task or parent policy values", () => {
    const base = policy();
    const cases = [
      { label: "zero positive-only field", req: { maxRunsPerTask: 0 }, expected: "must be a positive safe integer" },
      { label: "negative retries", req: { maxRetriesPerTask: -1 }, expected: "must be a non-negative safe integer" },
      { label: "unsafe integer", req: { maxInputTokensPerTask: Number.MAX_SAFE_INTEGER + 1 }, expected: "safe integer" },
      { label: "NaN field", req: { maxWallMsPerTask: NaN }, expected: "must be a finite number" },
    ];
    for (const { label, req, expected } of cases) {
      expect(() => resolveEffectiveExecutionAdmissionPolicy(base, req, null), label).toThrow(expected);
    }
    const parent = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:abc:default", epoch: "default" },
      policy: base,
      decision: evaluateExecutionAdmission(base, []),
      evaluatedAt: new Date("2026-07-13T00:00:00Z"),
    });
    expect(() => resolveEffectiveExecutionAdmissionPolicy(base, null, { ...base, maxRetriesPerTask: -2 })).toThrow("must be a non-negative safe integer");
    expect(() => resolveEffectiveExecutionAdmissionPolicy({ ...base, maxRunsPerTask: 0 }, null, null)).toThrow("must be a positive safe integer");
  });

  it("preserves global numeric values when request and parent are absent", () => {
    const global = policy();
    const resolved = resolveEffectiveExecutionAdmissionPolicy(global, null, null);
    expect(resolved).toEqual(global);
  });

  it("tightens the global policy from an explicit issue resource budget", () => {
    const global = policy();
    const resolved = resolveExecutionAdmissionPolicyForResourceBudget(global, {
      maxRunsPerTask: 1,
      maxRetriesPerTask: 0,
      maxTurnsPerInvocation: 4,
      maxToolCallsPerInvocation: 12,
    });

    expect(resolved).toMatchObject({
      enabled: true,
      maxRunsPerTask: 1,
      maxRetriesPerTask: 0,
      maxTurnsPerInvocation: 4,
      maxToolCallsPerInvocation: 12,
    });
    expect(resolveExecutionAdmissionPolicyForResourceBudget(global, null)).toEqual(global);
  });

  it("uses an explicit larger coding envelope without widening spend ceilings", () => {
    const global = policy();
    const resolved = resolveExecutionAdmissionPolicyForResourceBudget(global, {
      maxRunsPerTask: global.maxRunsPerTask + 3,
      maxRetriesPerTask: global.maxRetriesPerTask + 3,
      maxInputTokensPerTask: global.maxInputTokensPerTask + 10_000,
      maxOutputTokensPerTask: global.maxOutputTokensPerTask + 10_000,
      maxWallMsPerTask: global.maxWallMsPerTask + 60_000,
      maxTurnsPerInvocation: 20,
      maxToolCallsPerInvocation: 60,
    });

    expect(resolved).toMatchObject({
      enabled: true,
      maxRunsPerTask: global.maxRunsPerTask,
      maxRetriesPerTask: global.maxRetriesPerTask,
      maxInputTokensPerTask: global.maxInputTokensPerTask,
      maxOutputTokensPerTask: global.maxOutputTokensPerTask,
      maxWallMsPerTask: global.maxWallMsPerTask,
      maxTurnsPerInvocation: 20,
      maxToolCallsPerInvocation: 60,
    });
  });

  it("keeps an inherited structural envelope as the authority ceiling", () => {
    const global = policy();
    const parent = {
      ...global,
      maxTurnsPerInvocation: 12,
      maxToolCallsPerInvocation: 36,
    };
    const resolved = resolveEffectiveExecutionAdmissionPolicy(global, {
      maxTurnsPerInvocation: 20,
      maxToolCallsPerInvocation: 60,
    }, parent);

    expect(resolved).toMatchObject({
      maxTurnsPerInvocation: 12,
      maxToolCallsPerInvocation: 36,
    });
  });

  it("preserves exact turn and tool-call overages in reservation receipts", () => {
    const global = policy();
    const envelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:budgeted:default", epoch: "default" },
      policy: global,
      decision: evaluateExecutionAdmission(global, []),
      evaluatedAt: new Date("2026-07-20T18:00:00.000Z"),
    });
    if (!envelope.reservation) throw new Error("expected reservation");

    expect(evaluateExecutionReservationUsage({
      reservation: envelope.reservation,
      inputTokens: 100,
      outputTokens: 50,
      wallMs: 1_000,
      turns: envelope.reservation.maxTurns + 1,
      toolCalls: envelope.reservation.maxToolCalls + 1,
    })).toEqual({
      compliant: false,
      exceeded: ["turns", "tool_calls"],
    });
    expect(resolveReportedReservationExceeded({
      reservation: envelope.reservation,
      resultJson: {
        exceeded: "turns",
        execution_metrics: {
          turns: envelope.reservation.maxTurns + 1,
          tool_calls: envelope.reservation.maxToolCalls + 1,
        },
      },
    })).toEqual(["turns", "tool_calls"]);
  });

});
