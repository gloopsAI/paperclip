import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_EXECUTION_DEFAULTS,
  allowsAutomaticRecoveryCreation,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionReservationUsage,
  evaluateExecutionAdmission,
  isBudgetExemptPreflightFailure,
  parseExecutionAdmissionPolicy,
  parseReconciledExecutionAdapters,
  readExecutionAdmissionEnvelope,
  rehydrateExecutionAdmissionPolicy,
  resolveEffectiveExecutionAdmissionPolicy,
  resolveEpochBoundExecutionAdmissionPolicy,
  resolveExecutionAdmissionPolicyForResourceBudget,
  resolveExecutionAdmissionPolicyForResourceBudgetChain,
  resolveExecutionBudgetIdentity,
  resolveReportedReservationExceeded,
  selectEpochLockingAdmissionEnvelope,
  splitInputTokenAccounting,
  summarizePriorExecution,
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
      fixedOverheadInputTokens: 0,
      discretionaryInputTokens: 400,
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

  it("folds ancestor and issue resource budgets root-to-leaf without widening", () => {
    const global = policy();
    const ancestor = {
      maxInputTokensPerTask: 500,
      maxRetriesPerTask: 1,
      maxTurnsPerInvocation: 12,
    };
    const child = {
      maxInputTokensPerTask: 800,
      maxRetriesPerTask: 0,
      maxTurnsPerInvocation: 20,
      maxToolCallsPerInvocation: 60,
    };
    const resolved = resolveExecutionAdmissionPolicyForResourceBudgetChain(global, [ancestor, child]);
    expect(resolved).toMatchObject({
      enabled: true,
      maxInputTokensPerTask: 500,
      maxRetriesPerTask: 0,
      // Parent structural ceiling of 12 blocks the child's 20-turn request.
      maxTurnsPerInvocation: 12,
      maxToolCallsPerInvocation: 60,
    });
    // A lone child budget without ancestors may still pick a larger coding envelope.
    expect(resolveExecutionAdmissionPolicyForResourceBudgetChain(global, [child])).toMatchObject({
      maxInputTokensPerTask: 800,
      maxTurnsPerInvocation: 20,
      maxToolCallsPerInvocation: 60,
    });
  });

  it("caps explicit turn envelopes at the Hermes host safety ceiling", () => {
    const global = policy();
    const resolved = resolveExecutionAdmissionPolicyForResourceBudgetChain(global, [{
      maxTurnsPerInvocation: 33,
    }]);

    expect(resolved).toMatchObject({
      enabled: true,
      maxTurnsPerInvocation: 32,
    });
  });

  it("locks the first admitted effective policy for an epoch", () => {
    const global = policy();
    const admitted = resolveEffectiveExecutionAdmissionPolicy(global, {
      maxInputTokensPerTask: 400,
      maxRetriesPerTask: 0,
      maxTurnsPerInvocation: 10,
    }, null);
    const envelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:locked:default", epoch: "default" },
      policy: admitted,
      decision: evaluateExecutionAdmission(admitted, []),
      evaluatedAt: new Date("2026-07-20T21:00:00.000Z"),
    });
    expect(envelope.policy).toEqual({
      maxRunsPerTask: admitted.maxRunsPerTask,
      maxRetriesPerTask: admitted.maxRetriesPerTask,
      maxInputTokensPerTask: admitted.maxInputTokensPerTask,
      maxOutputTokensPerTask: admitted.maxOutputTokensPerTask,
      maxWallMsPerTask: admitted.maxWallMsPerTask,
      maxInputTokensPerInvocation: admitted.maxInputTokensPerInvocation,
      maxOutputTokensPerInvocation: admitted.maxOutputTokensPerInvocation,
      maxTurnsPerInvocation: admitted.maxTurnsPerInvocation,
      maxToolCallsPerInvocation: admitted.maxToolCallsPerInvocation,
      fixedOverheadInputTokens: admitted.fixedOverheadInputTokens,
      executionClass: admitted.executionClass,
    });
    expect(readExecutionAdmissionEnvelope(envelope)?.policy).toEqual(envelope.policy);

    const widenedLive = resolveEffectiveExecutionAdmissionPolicy(global, {
      maxInputTokensPerTask: 900,
      maxRetriesPerTask: 2,
      maxTurnsPerInvocation: 20,
    }, null);
    const locked = resolveEpochBoundExecutionAdmissionPolicy(widenedLive, envelope);
    expect(locked).toEqual(admitted);
    expect(locked.digest).toBe(envelope.policyDigest);
    expect(rehydrateExecutionAdmissionPolicy(envelope.policy!, envelope.policyDigest)).toEqual(admitted);

    const later = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:locked:default", epoch: "default" },
      policy: widenedLive,
      decision: evaluateExecutionAdmission(widenedLive, [{ retryOfRunId: null }]),
      evaluatedAt: new Date("2026-07-20T21:05:00.000Z"),
    });
    const selected = selectEpochLockingAdmissionEnvelope([later, envelope, null]);
    expect(selected?.policyDigest).toBe(envelope.policyDigest);
    expect(resolveEpochBoundExecutionAdmissionPolicy(widenedLive, selected)).toEqual(admitted);
  });

  it("fails closed when a legacy locked envelope drifts without a policy snapshot", () => {
    const global = policy();
    const admitted = resolveEffectiveExecutionAdmissionPolicy(global, {
      maxInputTokensPerTask: 400,
    }, null);
    const envelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:legacy:default", epoch: "default" },
      policy: admitted,
      decision: evaluateExecutionAdmission(admitted, []),
      evaluatedAt: new Date("2026-07-20T21:00:00.000Z"),
    });
    const { policy: _drop, ...legacy } = envelope;
    expect(readExecutionAdmissionEnvelope(legacy)?.policy).toBeUndefined();
    expect(resolveEpochBoundExecutionAdmissionPolicy(admitted, legacy as typeof envelope)).toEqual(admitted);
    expect(() => resolveEpochBoundExecutionAdmissionPolicy(global, legacy as typeof envelope)).toThrow(
      "cannot be rehydrated after policy drift",
    );
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

  it("exempts preflight failures from run, retry, and token budget usage", () => {
    expect(isBudgetExemptPreflightFailure({
      providerInvocationAttempted: false,
      errorCode: "adapter_failed",
    })).toBe(true);
    expect(isBudgetExemptPreflightFailure({
      providerInvocationAttempted: null,
      errorCode: "workspace_validation_failed",
    })).toBe(true);
    expect(isBudgetExemptPreflightFailure({
      providerInvocationAttempted: true,
      errorCode: "adapter_failed",
    })).toBe(false);
    expect(isBudgetExemptPreflightFailure({
      providerInvocationAttempted: true,
      errorCode: "execution_admission.input_reservation_exceeded",
    })).toBe(false);
    expect(isBudgetExemptPreflightFailure({
      providerInvocationAttempted: true,
      errorCode: "execution_admission.reservation_exceeded",
    })).toBe(false);

    const observed = summarizePriorExecution([
      {
        retryOfRunId: null,
        countsTowardTaskBudget: false,
        inputTokens: 400,
        outputTokens: 100,
        wallMs: 60_000,
      },
      {
        retryOfRunId: null,
        inputTokens: 100,
        outputTokens: 10,
        wallMs: 1_000,
      },
    ]);

    expect(observed).toMatchObject({
      runCount: 1,
      retryCount: 0,
      inputTokens: 100,
      outputTokens: 10,
      wallMs: 1_000,
      preflightExemptRunCount: 1,
    });
    expect(evaluateExecutionAdmission(policy(), [
      {
        retryOfRunId: null,
        countsTowardTaskBudget: false,
        inputTokens: 1_000,
        outputTokens: 200,
        wallMs: 60_000,
      },
    ])).toMatchObject({
      allowed: true,
      observed: {
        runCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        wallMs: 0,
        preflightExemptRunCount: 1,
      },
    });
  });

  it("accounts fixed input overhead separately from discretionary task budget", () => {
    expect(splitInputTokenAccounting({
      inputTokens: 450,
      fixedOverheadInputTokens: 50,
    })).toEqual({
      fixedOverheadInputTokens: 50,
      discretionaryInputTokens: 400,
    });
    expect(splitInputTokenAccounting({
      inputTokens: 450,
      fixedOverheadInputTokens: 100,
      discretionaryInputTokens: 300,
    })).toEqual({
      fixedOverheadInputTokens: 100,
      discretionaryInputTokens: 300,
    });

    const global = policy();
    const withOverhead = resolveEffectiveExecutionAdmissionPolicy(global, {
      fixedOverheadInputTokens: 50,
      maxInputTokensPerTask: 400,
      maxInputTokensPerInvocation: 400,
    }, null);
    const envelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:overhead:default", epoch: "default" },
      policy: withOverhead,
      decision: evaluateExecutionAdmission(withOverhead, []),
      evaluatedAt: new Date("2026-07-21T00:00:00Z"),
    });

    expect(envelope.reservation).toMatchObject({
      maxInputTokens: 450,
      fixedOverheadInputTokens: 50,
      discretionaryInputTokens: 400,
    });
    expect(readExecutionAdmissionEnvelope(envelope)).toEqual(envelope);
    expect(evaluateExecutionAdmission(withOverhead, [{
      inputTokens: 450,
      fixedOverheadInputTokens: 50,
      discretionaryInputTokens: 400,
    }], { isRetry: true })).toMatchObject({
      allowed: false,
      reason: "input_token_limit_exhausted",
      observed: {
        inputTokens: 400,
        fixedOverheadInputTokens: 50,
      },
    });
  });

  it("rehydrates pre-change v2 observed usage with zero-valued accounting fields", () => {
    const current = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:legacy-observed:default", epoch: "default" },
      policy: policy(),
      decision: evaluateExecutionAdmission(policy(), []),
      evaluatedAt: new Date("2026-07-21T00:00:00Z"),
    });
    const legacyObserved = { ...current.observed } as Partial<typeof current.observed>;
    delete legacyObserved.fixedOverheadInputTokens;
    delete legacyObserved.preflightExemptRunCount;

    expect(readExecutionAdmissionEnvelope({ ...current, observed: legacyObserved })).toMatchObject({
      observed: {
        fixedOverheadInputTokens: 0,
        preflightExemptRunCount: 0,
      },
    });
  });

  it("allows bootstrap tasks to declare a generous bounded completion envelope", () => {
    const global = policy();
    const bootstrap = resolveEffectiveExecutionAdmissionPolicy(global, {
      executionClass: "bootstrap",
      fixedOverheadInputTokens: 2_000,
    }, null);

    expect(bootstrap).toMatchObject({
      executionClass: "bootstrap",
      fixedOverheadInputTokens: 2_000,
      maxInputTokensPerTask: BOOTSTRAP_EXECUTION_DEFAULTS.maxInputTokensPerTask,
      maxOutputTokensPerTask: BOOTSTRAP_EXECUTION_DEFAULTS.maxOutputTokensPerTask,
      maxTurnsPerInvocation: BOOTSTRAP_EXECUTION_DEFAULTS.maxTurnsPerInvocation,
      maxToolCallsPerInvocation: BOOTSTRAP_EXECUTION_DEFAULTS.maxToolCallsPerInvocation,
    });
    expect(bootstrap.maxRunsPerTask).toBeGreaterThanOrEqual(BOOTSTRAP_EXECUTION_DEFAULTS.maxRunsPerTask);
    expect(bootstrap.maxRetriesPerTask).toBeGreaterThanOrEqual(BOOTSTRAP_EXECUTION_DEFAULTS.maxRetriesPerTask);
    expect(bootstrap.maxInputTokensPerInvocation).toBeLessThanOrEqual(bootstrap.maxInputTokensPerTask);

    const envelope = buildExecutionAdmissionEnvelope({
      identity: { budgetId: "issue:bootstrap:default", epoch: "default" },
      policy: bootstrap,
      decision: evaluateExecutionAdmission(bootstrap, []),
      evaluatedAt: new Date("2026-07-21T00:00:00Z"),
    });
    expect(envelope.reservation).toMatchObject({
      maxInputTokens:
        BOOTSTRAP_EXECUTION_DEFAULTS.maxInputTokensPerInvocation + 2_000,
      discretionaryInputTokens: BOOTSTRAP_EXECUTION_DEFAULTS.maxInputTokensPerInvocation,
      fixedOverheadInputTokens: 2_000,
    });
    expect(rehydrateExecutionAdmissionPolicy(envelope.policy!, envelope.policyDigest)).toEqual(bootstrap);
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
