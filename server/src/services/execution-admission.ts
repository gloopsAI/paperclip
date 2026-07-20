import { createHash } from "node:crypto";
import type { IssueExecutionResourceBudget } from "@paperclipai/shared";
import type { ExecutionInvocationBudget } from "@paperclipai/adapter-utils";

export const EXECUTION_ADMISSION_SCHEMA_VERSION = "gloops.execution-admission.v2" as const;
export const EXECUTION_ADMISSION_CONTEXT_KEY = "gloopsExecutionAdmission" as const;
export const EXECUTION_ADMISSION_RESET_CONTEXT_KEY = "gloopsExecutionBudgetResetId" as const;

export type ExecutionAdmissionPolicy =
  | { enabled: false }
  | {
      enabled: true;
      maxRunsPerTask: number;
      maxRetriesPerTask: number;
      maxInputTokensPerTask: number;
      maxOutputTokensPerTask: number;
      maxWallMsPerTask: number;
      maxInputTokensPerInvocation: number;
      maxOutputTokensPerInvocation: number;
      maxTurnsPerInvocation: number;
      maxToolCallsPerInvocation: number;
      digest: string;
    };

export type ExecutionAdmissionReason =
  | "run_limit_exhausted"
  | "retry_limit_exhausted"
  | "input_token_limit_exhausted"
  | "output_token_limit_exhausted"
  | "wall_time_limit_exhausted"
  | "input_reservation_unavailable"
  | "output_reservation_unavailable";

export type ExecutionAdmissionUsage = {
  runCount: number;
  retryCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  wallMs: number;
};

export type ExecutionAdmissionEnvelope = {
  schemaVersion: typeof EXECUTION_ADMISSION_SCHEMA_VERSION;
  budgetId: string;
  epoch: string;
  policyDigest: string;
  attempt: number;
  decision: "allowed" | "denied";
  reason: ExecutionAdmissionReason | null;
  observed: ExecutionAdmissionUsage;
  reservation: ExecutionInvocationBudget | null;
  evaluatedAt: string;
};

export type PriorExecutionRun = {
  retryOfRunId?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  wallMs?: number | null;
};

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;
const RESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function parseEnabled(value: string | undefined) {
  if (value === undefined || value.trim() === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  throw new Error("PAPERCLIP_EXECUTION_ADMISSION_ENABLED must be true or false");
}

function parsePositiveInteger(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value || !POSITIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a positive integer when execution admission is enabled`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value || !NON_NEGATIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a non-negative integer when execution admission is enabled`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return parsed;
}

export function parseExecutionAdmissionPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionAdmissionPolicy {
  if (!parseEnabled(env.PAPERCLIP_EXECUTION_ADMISSION_ENABLED)) return { enabled: false };

  const values = {
    maxRunsPerTask: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK"),
    maxRetriesPerTask: parseNonNegativeInteger(env, "PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK"),
    maxInputTokensPerTask: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK"),
    maxOutputTokensPerTask: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK"),
    maxWallMsPerTask: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK"),
    maxInputTokensPerInvocation: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION"),
    maxOutputTokensPerInvocation: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION"),
    maxTurnsPerInvocation: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION"),
    maxToolCallsPerInvocation: parsePositiveInteger(env, "PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION"),
  };
  if (values.maxRetriesPerTask >= values.maxRunsPerTask) {
    throw new Error("PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK must be lower than max runs per task");
  }
  if (values.maxInputTokensPerInvocation > values.maxInputTokensPerTask) {
    throw new Error("PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION must not exceed the task input-token limit");
  }
  if (values.maxOutputTokensPerInvocation > values.maxOutputTokensPerTask) {
    throw new Error("PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION must not exceed the task output-token limit");
  }
  return {
    enabled: true,
    ...values,
    digest: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
  };
}

const LIMIT_FIELDS: Array<keyof IssueExecutionResourceBudget & keyof Extract<ExecutionAdmissionPolicy, { enabled: true }>> = [
  "maxRunsPerTask",
  "maxRetriesPerTask",
  "maxInputTokensPerTask",
  "maxOutputTokensPerTask",
  "maxWallMsPerTask",
  "maxInputTokensPerInvocation",
  "maxOutputTokensPerInvocation",
  "maxTurnsPerInvocation",
  "maxToolCallsPerInvocation",
];

function validateLimitNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Execution admission ${name} must be a finite number`);
  }
  const minimum = name === "maxRetriesPerTask" ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    const requirement = minimum === 0 ? "a non-negative" : "a positive";
    throw new Error(`Execution admission ${name} must be ${requirement} safe integer`);
  }
  return Math.floor(value);
}

export function resolveEffectiveExecutionAdmissionPolicy(
  globalPolicy: Extract<ExecutionAdmissionPolicy, { enabled: true }>,
  requestBudget?: IssueExecutionResourceBudget | null,
  parentPolicy?: Extract<ExecutionAdmissionPolicy, { enabled: true }> | null,
): Extract<ExecutionAdmissionPolicy, { enabled: true }> {
  const pick = (field: typeof LIMIT_FIELDS[number]) => {
    const candidates: number[] = [
      validateLimitNumber(field, globalPolicy[field]),
    ];
    if (requestBudget != null && requestBudget[field] !== undefined) {
      candidates.push(validateLimitNumber(field, requestBudget[field]));
    }
    if (parentPolicy != null) {
      candidates.push(validateLimitNumber(field, parentPolicy[field]));
    }
    return Math.min(...candidates);
  };

  const values = {
    maxRunsPerTask: pick("maxRunsPerTask"),
    maxRetriesPerTask: pick("maxRetriesPerTask"),
    maxInputTokensPerTask: pick("maxInputTokensPerTask"),
    maxOutputTokensPerTask: pick("maxOutputTokensPerTask"),
    maxWallMsPerTask: pick("maxWallMsPerTask"),
    maxInputTokensPerInvocation: pick("maxInputTokensPerInvocation"),
    maxOutputTokensPerInvocation: pick("maxOutputTokensPerInvocation"),
    maxTurnsPerInvocation: pick("maxTurnsPerInvocation"),
    maxToolCallsPerInvocation: pick("maxToolCallsPerInvocation"),
  };

  if (values.maxRetriesPerTask >= values.maxRunsPerTask) {
    values.maxRetriesPerTask = Math.max(0, values.maxRunsPerTask - 1);
  }
  values.maxInputTokensPerInvocation = Math.min(
    values.maxInputTokensPerInvocation,
    values.maxInputTokensPerTask,
  );
  values.maxOutputTokensPerInvocation = Math.min(
    values.maxOutputTokensPerInvocation,
    values.maxOutputTokensPerTask,
  );

  return {
    enabled: true,
    ...values,
    digest: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
  };
}


export function readExecutionAdmissionEnvelope(value: unknown): ExecutionAdmissionEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ExecutionAdmissionEnvelope>;
  const observed = candidate.observed as Partial<ExecutionAdmissionUsage> | undefined;
  const validObserved = observed && [
    observed.runCount,
    observed.retryCount,
    observed.inputTokens,
    observed.cachedInputTokens,
    observed.outputTokens,
    observed.wallMs,
  ].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
  const validReason = candidate.reason === null || [
    "run_limit_exhausted",
    "retry_limit_exhausted",
    "input_token_limit_exhausted",
    "output_token_limit_exhausted",
    "wall_time_limit_exhausted",
    "input_reservation_unavailable",
    "output_reservation_unavailable",
  ].includes(candidate.reason as string);
  const reservation = candidate.reservation as Partial<ExecutionInvocationBudget> | null | undefined;
  const validReservation = reservation === null || Boolean(
    reservation &&
    reservation.schemaVersion === "paperclip.provider-invocation-budget.v1" &&
    typeof reservation.budgetId === "string" && reservation.budgetId === candidate.budgetId &&
    typeof reservation.reservationId === "string" && /^[a-f0-9]{64}$/.test(reservation.reservationId) &&
    [reservation.maxInputTokens, reservation.maxOutputTokens, reservation.maxTurns,
      reservation.maxToolCalls, reservation.maxWallMs]
      .every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0)
  );
  if (
    candidate.schemaVersion !== EXECUTION_ADMISSION_SCHEMA_VERSION ||
    typeof candidate.budgetId !== "string" || candidate.budgetId.length > 256 ||
    typeof candidate.epoch !== "string" || !RESET_ID.test(candidate.epoch) && candidate.epoch !== "default" ||
    typeof candidate.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(candidate.policyDigest) ||
    !Number.isSafeInteger(candidate.attempt) || (candidate.attempt ?? 0) < 1 ||
    (candidate.decision !== "allowed" && candidate.decision !== "denied") ||
    !validReason ||
    !validObserved ||
    !validReservation ||
    typeof candidate.evaluatedAt !== "string" || !Number.isFinite(Date.parse(candidate.evaluatedAt))
  ) {
    return null;
  }
  return candidate as ExecutionAdmissionEnvelope;
}

/**
 * Decide before any wake/run insertion whether automatic recovery is legal.
 * Admission at claim time remains the final concurrency guard; this earlier
 * gate prevents knowingly impossible continuation rows from being created.
 */
export function allowsAutomaticRecoveryCreation(
  policy: ExecutionAdmissionPolicy,
  envelope: ExecutionAdmissionEnvelope | null,
  bindingPresent = envelope !== null,
): boolean {
  // Preserve upstream behavior only when no execution-admission authority was
  // ever bound. Once a binding exists, disabling or misconfiguring admission
  // must not widen the authority granted to the original run.
  if (!policy.enabled) return !bindingPresent;
  if (!envelope || envelope.policyDigest !== policy.digest) return false;
  if (policy.maxRetriesPerTask === 0) return false;
  return envelope.decision === "allowed" && envelope.attempt < policy.maxRunsPerTask;
}

export function resolveExecutionBudgetIdentity(input: {
  issueId: string | null;
  runId: string;
  retryOfRunId: string | null;
  parentEnvelope: ExecutionAdmissionEnvelope | null;
  resetId: unknown;
  requestedByActorType: string | null;
}) {
  if (input.parentEnvelope) {
    return { budgetId: input.parentEnvelope.budgetId, epoch: input.parentEnvelope.epoch };
  }

  let epoch = "default";
  if (input.resetId !== undefined && input.resetId !== null) {
    if (input.requestedByActorType !== "user") {
      throw new Error("An execution budget reset is only valid on a user-requested wake");
    }
    if (typeof input.resetId !== "string" || !RESET_ID.test(input.resetId)) {
      throw new Error("Execution budget reset id must be 1-64 URL-safe characters");
    }
    epoch = input.resetId;
  }

  const root = input.issueId ? `issue:${input.issueId}` : `run:${input.retryOfRunId ?? input.runId}`;
  return { budgetId: `${root}:${epoch}`, epoch };
}

function nonNegative(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function summarizePriorExecution(priorRuns: PriorExecutionRun[]): ExecutionAdmissionUsage {
  return priorRuns.reduce<ExecutionAdmissionUsage>(
    (total, run) => ({
      runCount: total.runCount + 1,
      // Independent workflow stages consume run budget but are not retries.
      retryCount: total.retryCount + (run.retryOfRunId ? 1 : 0),
      inputTokens: total.inputTokens + nonNegative(run.inputTokens),
      cachedInputTokens: total.cachedInputTokens + nonNegative(run.cachedInputTokens),
      outputTokens: total.outputTokens + nonNegative(run.outputTokens),
      wallMs: total.wallMs + nonNegative(run.wallMs),
    }),
    { runCount: 0, retryCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, wallMs: 0 },
  );
}

export function evaluateExecutionAdmission(
  policy: Extract<ExecutionAdmissionPolicy, { enabled: true }>,
  priorRuns: PriorExecutionRun[],
  currentRun: {
    isRetry?: boolean;
    isAuthorizedIndependentStage?: boolean;
  } = {},
): { allowed: boolean; reason: ExecutionAdmissionReason | null; observed: ExecutionAdmissionUsage } {
  const observed = summarizePriorExecution(priorRuns);
  const remainingInputTokens = Math.max(0, policy.maxInputTokensPerTask - observed.inputTokens);
  const remainingOutputTokens = Math.max(0, policy.maxOutputTokensPerTask - observed.outputTokens);
  const isUnclassifiedContinuation =
    observed.runCount > 0 &&
    currentRun.isRetry !== true &&
    currentRun.isAuthorizedIndependentStage !== true;
  const reason = observed.runCount >= policy.maxRunsPerTask
    ? "run_limit_exhausted"
    : isUnclassifiedContinuation ||
        (currentRun.isRetry === true && observed.retryCount >= policy.maxRetriesPerTask)
      ? "retry_limit_exhausted"
      : observed.inputTokens >= policy.maxInputTokensPerTask
        ? "input_token_limit_exhausted"
        : observed.outputTokens >= policy.maxOutputTokensPerTask
          ? "output_token_limit_exhausted"
          : observed.wallMs >= policy.maxWallMsPerTask
            ? "wall_time_limit_exhausted"
            : remainingInputTokens <= 0
              ? "input_reservation_unavailable"
              : remainingOutputTokens <= 0
                ? "output_reservation_unavailable"
            : null;
  return { allowed: reason === null, reason, observed };
}

export function buildExecutionAdmissionEnvelope(input: {
  identity: { budgetId: string; epoch: string };
  policy: Extract<ExecutionAdmissionPolicy, { enabled: true }>;
  decision: ReturnType<typeof evaluateExecutionAdmission>;
  evaluatedAt: Date;
}): ExecutionAdmissionEnvelope {
  const attempt = input.decision.observed.runCount + 1;
  const remainingInputTokens = Math.max(0, input.policy.maxInputTokensPerTask - input.decision.observed.inputTokens);
  const remainingOutputTokens = Math.max(0, input.policy.maxOutputTokensPerTask - input.decision.observed.outputTokens);
  const remainingWallMs = Math.max(0, input.policy.maxWallMsPerTask - input.decision.observed.wallMs);
  const reservation = input.decision.allowed ? {
    schemaVersion: "paperclip.provider-invocation-budget.v1" as const,
    budgetId: input.identity.budgetId,
    reservationId: createHash("sha256")
      .update(`${input.identity.budgetId}:${input.identity.epoch}:${attempt}:${input.policy.digest}`)
      .digest("hex"),
    maxInputTokens: Math.min(input.policy.maxInputTokensPerInvocation, remainingInputTokens),
    maxOutputTokens: Math.min(input.policy.maxOutputTokensPerInvocation, remainingOutputTokens),
    maxTurns: input.policy.maxTurnsPerInvocation,
    maxToolCalls: input.policy.maxToolCallsPerInvocation,
    maxWallMs: remainingWallMs,
  } : null;
  return {
    schemaVersion: EXECUTION_ADMISSION_SCHEMA_VERSION,
    budgetId: input.identity.budgetId,
    epoch: input.identity.epoch,
    policyDigest: input.policy.digest,
    attempt,
    decision: input.decision.allowed ? "allowed" : "denied",
    reason: input.decision.reason,
    observed: input.decision.observed,
    reservation,
    evaluatedAt: input.evaluatedAt.toISOString(),
  };
}

export function executionInvocationBudgetFromEnvelope(value: unknown): ExecutionInvocationBudget | null {
  return readExecutionAdmissionEnvelope(value)?.reservation ?? null;
}

export function evaluateExecutionReservationUsage(input: {
  reservation: ExecutionInvocationBudget;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
}) {
  const exceeded = [
    input.inputTokens > input.reservation.maxInputTokens ? "input_tokens" : null,
    input.outputTokens > input.reservation.maxOutputTokens ? "output_tokens" : null,
    input.wallMs > input.reservation.maxWallMs ? "wall_ms" : null,
  ].filter((value): value is string => Boolean(value));
  return { compliant: exceeded.length === 0, exceeded };
}
