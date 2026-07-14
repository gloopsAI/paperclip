import { createHash } from "node:crypto";

export const EXECUTION_ADMISSION_SCHEMA_VERSION = "gloops.execution-admission.v1" as const;
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
      digest: string;
    };

export type ExecutionAdmissionReason =
  | "run_limit_exhausted"
  | "retry_limit_exhausted"
  | "input_token_limit_exhausted"
  | "output_token_limit_exhausted"
  | "wall_time_limit_exhausted";

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
  evaluatedAt: string;
};

export type PriorExecutionRun = {
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
  };
  if (values.maxRetriesPerTask >= values.maxRunsPerTask) {
    throw new Error("PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK must be lower than max runs per task");
  }
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
  ].includes(candidate.reason as string);
  if (
    candidate.schemaVersion !== EXECUTION_ADMISSION_SCHEMA_VERSION ||
    typeof candidate.budgetId !== "string" || candidate.budgetId.length > 256 ||
    typeof candidate.epoch !== "string" || !RESET_ID.test(candidate.epoch) && candidate.epoch !== "default" ||
    typeof candidate.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(candidate.policyDigest) ||
    !Number.isSafeInteger(candidate.attempt) || (candidate.attempt ?? 0) < 1 ||
    (candidate.decision !== "allowed" && candidate.decision !== "denied") ||
    !validReason ||
    !validObserved ||
    typeof candidate.evaluatedAt !== "string" || !Number.isFinite(Date.parse(candidate.evaluatedAt))
  ) {
    return null;
  }
  return candidate as ExecutionAdmissionEnvelope;
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
    (total, run, index) => ({
      runCount: total.runCount + 1,
      retryCount: total.retryCount + (index === 0 ? 0 : 1),
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
): { allowed: boolean; reason: ExecutionAdmissionReason | null; observed: ExecutionAdmissionUsage } {
  const observed = summarizePriorExecution(priorRuns);
  const reason = observed.runCount >= policy.maxRunsPerTask
    ? "run_limit_exhausted"
    : observed.retryCount >= policy.maxRetriesPerTask
      ? "retry_limit_exhausted"
      : observed.inputTokens >= policy.maxInputTokensPerTask
        ? "input_token_limit_exhausted"
        : observed.outputTokens >= policy.maxOutputTokensPerTask
          ? "output_token_limit_exhausted"
          : observed.wallMs >= policy.maxWallMsPerTask
            ? "wall_time_limit_exhausted"
            : null;
  return { allowed: reason === null, reason, observed };
}

export function buildExecutionAdmissionEnvelope(input: {
  identity: { budgetId: string; epoch: string };
  policy: Extract<ExecutionAdmissionPolicy, { enabled: true }>;
  decision: ReturnType<typeof evaluateExecutionAdmission>;
  evaluatedAt: Date;
}): ExecutionAdmissionEnvelope {
  return {
    schemaVersion: EXECUTION_ADMISSION_SCHEMA_VERSION,
    budgetId: input.identity.budgetId,
    epoch: input.identity.epoch,
    policyDigest: input.policy.digest,
    attempt: input.decision.observed.runCount + 1,
    decision: input.decision.allowed ? "allowed" : "denied",
    reason: input.decision.reason,
    observed: input.decision.observed,
    evaluatedAt: input.evaluatedAt.toISOString(),
  };
}
