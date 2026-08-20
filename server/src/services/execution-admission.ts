import { createHash } from "node:crypto";
import type { IssueExecutionResourceBudget, IssueExecutionTaskClass } from "@paperclipai/shared";
import type { ExecutionInvocationBudget } from "@paperclipai/adapter-utils";
import { buildExecutionPhaseBudgetPlan } from "@paperclipai/adapter-utils/execution-envelope";

export const EXECUTION_ADMISSION_SCHEMA_VERSION = "gloops.execution-admission.v2" as const;
export const EXECUTION_ADMISSION_CONTEXT_KEY = "gloopsExecutionAdmission" as const;
export const EXECUTION_ADMISSION_RESET_CONTEXT_KEY = "gloopsExecutionBudgetResetId" as const;
export const PRE_PROVIDER_STOP_LOSS_CONTEXT_KEY = "gloopsPreProviderStopLoss" as const;
export const PRE_PROVIDER_FAILURE_RESULT_KEY = "preProviderFailure" as const;

export const PRE_PROVIDER_STOP_LOSS_POLICY = {
  maxFailuresPerBudgetEpoch: 2,
  maxRemediationAttempts: 1,
  maxExemptWallMsPerBudgetEpoch: 15 * 60 * 1000,
  requireObservedStateChangeBeforeRetry: true,
} as const;

export type PreProviderFailureObservation = {
  schemaVersion: "gloops.pre-provider-failure.v1";
  stage: "pre_provider";
  errorCode: string;
  adapterType: string;
  repository: string | null;
  exactHead: string | null;
  workspaceMode: string | null;
  failureFingerprint: string;
  stateDigest: string;
  observedAt: string;
  receiptDigest: string;
};

export type PreProviderStopLossReceipt = {
  schemaVersion: "gloops.pre-provider-stop-loss.v1";
  decision: "allowed" | "denied";
  reason: "initial_attempt" | "observed_state_change" | "state_unchanged";
  policy: typeof PRE_PROVIDER_STOP_LOSS_POLICY;
  priorFailureReceiptDigest: string | null;
  priorStateDigest: string | null;
  currentStateDigest: string;
  evaluatedAt: string;
  receiptDigest: string;
};

/**
 * Explicit task policy may request a larger calibration envelope than the
 * conservative environment default. Keep a bounded outer ceiling, but do not
 * make the default itself the maximum: meaningful repository work has been
 * observed to require more than 32 Hermes turns before reaching execution.
 */
export const MAX_EXPLICIT_TURNS_PER_INVOCATION = 128;

/** Bootstrap class may declare generous bounded capacity for tool/input provisioning. */
export const BOOTSTRAP_EXECUTION_DEFAULTS = {
  maxRunsPerTask: 2,
  maxRetriesPerTask: 1,
  maxInputTokensPerTask: 220_000,
  maxOutputTokensPerTask: 22_000,
  maxWallMsPerTask: 30 * 60 * 1000,
  maxInputTokensPerInvocation: 180_000,
  maxOutputTokensPerInvocation: 18_000,
  maxTurnsPerInvocation: 25,
  maxToolCallsPerInvocation: 45,
} as const;

/**
 * Preflight / bootstrap failures that must not consume task run/retry budget
 * and must not charge provider reservation tokens.
 */
export const PREFLIGHT_BUDGET_EXEMPT_ERROR_CODES = new Set([
  "workspace_validation_failed",
  "workspace_preparation_failed",
  "execution_admission.adapter_budget_unsupported",
  "configuration_incomplete",
  "agent_not_invokable",
  "hermes_gateway_auth_failed",
  "hermes_gateway_api_key_missing",
  "hermes_gateway_connect_failed",
  "review_missing_disposition",
  "missing_issue_comment",
  "backlog_bankruptcy.company_frozen",
  "backlog_bankruptcy.readmit_budget_required",
]);

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
      /**
       * Fixed overhead reserved on top of discretionary input ceilings.
       * Not part of the epoch digest; carried for admission + receipts.
       */
      fixedOverheadInputTokens: number;
      executionClass: IssueExecutionTaskClass;
      digest: string;
    };

export type ExecutionAdmissionReason =
  | "run_limit_exhausted"
  | "retry_limit_exhausted"
  | "input_token_limit_exhausted"
  | "output_token_limit_exhausted"
  | "wall_time_limit_exhausted"
  | "pre_provider_failure_limit_exhausted"
  | "pre_provider_wall_time_limit_exhausted"
  | "input_reservation_unavailable"
  | "output_reservation_unavailable";

export type ExecutionAdmissionUsage = {
  /** Provider-invoking runs counted against maxRunsPerTask. */
  runCount: number;
  /** Provider-invoking retries counted against maxRetriesPerTask. */
  retryCount: number;
  /** Discretionary input tokens spent (excludes fixed overhead). */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  wallMs: number;
  /** Fixed overhead charged across counted runs (receipt field). */
  fixedOverheadInputTokens: number;
  /** Preflight/bootstrap failures excluded from run/retry ceilings. */
  preflightExemptRunCount: number;
  /** Wall time in exempt work remains economically bounded. */
  preflightExemptWallMs: number;
  /** Latest server-authored failure used to require observed change. */
  lastPreProviderFailure: PreProviderFailureObservation | null;
};

/**
 * Snapshot of the effective task policy admitted for a budget epoch.
 * Stored on the envelope so retries and continuations can rehydrate the exact
 * ceilings without re-reading live env or issue edits.
 *
 * `maxInputTokensPerTask` / `maxInputTokensPerInvocation` are discretionary
 * ceilings. Fixed overhead is carried separately and reserved on top.
 */
export type ExecutionAdmissionPolicyLimits = {
  maxRunsPerTask: number;
  maxRetriesPerTask: number;
  maxInputTokensPerTask: number;
  maxOutputTokensPerTask: number;
  maxWallMsPerTask: number;
  maxInputTokensPerInvocation: number;
  maxOutputTokensPerInvocation: number;
  maxTurnsPerInvocation: number;
  maxToolCallsPerInvocation: number;
  fixedOverheadInputTokens: number;
  executionClass: IssueExecutionTaskClass;
};

export type ExecutionAdmissionEnvelope = {
  schemaVersion: typeof EXECUTION_ADMISSION_SCHEMA_VERSION;
  budgetId: string;
  epoch: string;
  policyDigest: string;
  /**
   * Exact effective policy admitted for this budget epoch. Optional only for
   * legacy envelopes written before policy snapshots; new envelopes always set it.
   */
  policy?: ExecutionAdmissionPolicyLimits;
  attempt: number;
  decision: "allowed" | "denied";
  reason: ExecutionAdmissionReason | null;
  observed: ExecutionAdmissionUsage;
  reservation: ExecutionInvocationBudget | null;
  evaluatedAt: string;
};

export type PriorExecutionRun = {
  retryOfRunId?: string | null;
  /**
   * Durable retry classification for sibling lifecycle wakes that cannot use
   * the retryOfRunId parent/child shape. Falls back to retryOfRunId when absent.
   */
  countsAsRetry?: boolean;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  wallMs?: number | null;
  /**
   * When false, the run is a preflight/bootstrap failure that must not
   * consume run/retry budget or discretionary token spend.
   * Defaults to true when omitted (legacy rows).
   */
  countsTowardTaskBudget?: boolean;
  /** Fixed overhead charged for this run (0 for preflight-exempt). */
  fixedOverheadInputTokens?: number | null;
  /** Discretionary input charged for this run. */
  discretionaryInputTokens?: number | null;
  /** Server-observed provider boundary; false is required for stop-loss use. */
  providerInvocationAttempted?: boolean | null;
  preProviderFailure?: PreProviderFailureObservation | null;
};

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function boundedIdentity(value: string | null | undefined, max = 512): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

export function buildPreProviderReadinessStateDigest(evidence: unknown): string {
  return sha256({ schemaVersion: "gloops.pre-provider-readiness-state.v1", evidence });
}

export function buildPreProviderFailureObservation(input: {
  errorCode: string;
  adapterType: string;
  repository?: string | null;
  exactHead?: string | null;
  workspaceMode?: string | null;
  stateDigest: string;
  observedAt?: Date;
}): PreProviderFailureObservation {
  const errorCode = boundedIdentity(input.errorCode, 256);
  const adapterType = boundedIdentity(input.adapterType, 128);
  if (!errorCode || !adapterType || !/^[a-f0-9]{64}$/.test(input.stateDigest)) {
    throw new Error("Pre-provider failure evidence is incomplete");
  }
  const repository = boundedIdentity(input.repository);
  const exactHead = boundedIdentity(input.exactHead, 256);
  const workspaceMode = boundedIdentity(input.workspaceMode, 128);
  const body = {
    schemaVersion: "gloops.pre-provider-failure.v1" as const,
    stage: "pre_provider" as const,
    errorCode,
    adapterType,
    repository,
    exactHead,
    workspaceMode,
    failureFingerprint: sha256({
      stage: "pre_provider",
      errorCode,
      repository,
      exactHead,
      adapterType,
      workspaceMode,
    }),
    stateDigest: input.stateDigest,
    observedAt: (input.observedAt ?? new Date()).toISOString(),
  };
  return { ...body, receiptDigest: sha256(body) };
}

export function readPreProviderFailureObservation(value: unknown): PreProviderFailureObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PreProviderFailureObservation>;
  const body = {
    schemaVersion: candidate.schemaVersion,
    stage: candidate.stage,
    errorCode: candidate.errorCode,
    adapterType: candidate.adapterType,
    repository: candidate.repository ?? null,
    exactHead: candidate.exactHead ?? null,
    workspaceMode: candidate.workspaceMode ?? null,
    failureFingerprint: candidate.failureFingerprint,
    stateDigest: candidate.stateDigest,
    observedAt: candidate.observedAt,
  };
  if (
    body.schemaVersion !== "gloops.pre-provider-failure.v1" ||
    body.stage !== "pre_provider" ||
    !boundedIdentity(body.errorCode, 256) ||
    !boundedIdentity(body.adapterType, 128) ||
    (body.repository !== null && boundedIdentity(body.repository) !== body.repository) ||
    (body.exactHead !== null && boundedIdentity(body.exactHead, 256) !== body.exactHead) ||
    (body.workspaceMode !== null && boundedIdentity(body.workspaceMode, 128) !== body.workspaceMode) ||
    typeof body.failureFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.failureFingerprint) ||
    typeof body.stateDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.stateDigest) ||
    typeof body.observedAt !== "string" || !Number.isFinite(Date.parse(body.observedAt)) ||
    typeof candidate.receiptDigest !== "string" || candidate.receiptDigest !== sha256(body)
  ) return null;
  const expectedFingerprint = sha256({
    stage: body.stage,
    errorCode: body.errorCode,
    repository: body.repository,
    exactHead: body.exactHead,
    adapterType: body.adapterType,
    workspaceMode: body.workspaceMode,
  });
  return expectedFingerprint === body.failureFingerprint
    ? candidate as PreProviderFailureObservation
    : null;
}

export function evaluatePreProviderStopLoss(input: {
  priorFailure: PreProviderFailureObservation | null;
  currentStateDigest: string;
  evaluatedAt?: Date;
}): PreProviderStopLossReceipt {
  if (!/^[a-f0-9]{64}$/.test(input.currentStateDigest)) {
    throw new Error("Pre-provider readiness state digest is invalid");
  }
  const unchanged = Boolean(
    input.priorFailure && input.priorFailure.stateDigest === input.currentStateDigest,
  );
  const body = {
    schemaVersion: "gloops.pre-provider-stop-loss.v1" as const,
    decision: unchanged ? "denied" as const : "allowed" as const,
    reason: !input.priorFailure
      ? "initial_attempt" as const
      : unchanged
        ? "state_unchanged" as const
        : "observed_state_change" as const,
    policy: PRE_PROVIDER_STOP_LOSS_POLICY,
    priorFailureReceiptDigest: input.priorFailure?.receiptDigest ?? null,
    priorStateDigest: input.priorFailure?.stateDigest ?? null,
    currentStateDigest: input.currentStateDigest,
    evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
  };
  return { ...body, receiptDigest: sha256(body) };
}

export function readPreProviderStopLossReceipt(value: unknown): PreProviderStopLossReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<PreProviderStopLossReceipt>;
  const policy = candidate.policy as Partial<typeof PRE_PROVIDER_STOP_LOSS_POLICY> | undefined;
  const body = {
    schemaVersion: candidate.schemaVersion,
    decision: candidate.decision,
    reason: candidate.reason,
    policy: candidate.policy,
    priorFailureReceiptDigest: candidate.priorFailureReceiptDigest ?? null,
    priorStateDigest: candidate.priorStateDigest ?? null,
    currentStateDigest: candidate.currentStateDigest,
    evaluatedAt: candidate.evaluatedAt,
  };
  if (
    body.schemaVersion !== "gloops.pre-provider-stop-loss.v1" ||
    (body.decision !== "allowed" && body.decision !== "denied") ||
    !["initial_attempt", "observed_state_change", "state_unchanged"].includes(String(body.reason)) ||
    !policy ||
    policy.maxFailuresPerBudgetEpoch !== PRE_PROVIDER_STOP_LOSS_POLICY.maxFailuresPerBudgetEpoch ||
    policy.maxRemediationAttempts !== PRE_PROVIDER_STOP_LOSS_POLICY.maxRemediationAttempts ||
    policy.maxExemptWallMsPerBudgetEpoch !== PRE_PROVIDER_STOP_LOSS_POLICY.maxExemptWallMsPerBudgetEpoch ||
    policy.requireObservedStateChangeBeforeRetry !== true ||
    (body.priorFailureReceiptDigest !== null &&
      (typeof body.priorFailureReceiptDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.priorFailureReceiptDigest))) ||
    (body.priorStateDigest !== null &&
      (typeof body.priorStateDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.priorStateDigest))) ||
    typeof body.currentStateDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.currentStateDigest) ||
    typeof body.evaluatedAt !== "string" || !Number.isFinite(Date.parse(body.evaluatedAt)) ||
    typeof candidate.receiptDigest !== "string" || candidate.receiptDigest !== sha256(body) ||
    (body.reason === "initial_attempt" &&
      (body.decision !== "allowed" || body.priorFailureReceiptDigest !== null || body.priorStateDigest !== null)) ||
    (body.reason === "state_unchanged" &&
      (body.decision !== "denied" || body.priorStateDigest !== body.currentStateDigest)) ||
    (body.reason === "observed_state_change" &&
      (body.decision !== "allowed" || !body.priorStateDigest || body.priorStateDigest === body.currentStateDigest))
  ) return null;
  return candidate as PreProviderStopLossReceipt;
}

/**
 * True when a terminal run failed before provider invocation and must not
 * burn the sole implementation retry or task token reservation.
 */
export function isBudgetExemptPreflightFailure(input: {
  providerInvocationAttempted?: boolean | null;
  errorCode?: string | null;
}): boolean {
  const code = typeof input.errorCode === "string" ? input.errorCode.trim() : "";
  // A protected-route denial invokes no provider, but must consume the bounded
  // task attempt so repeated wakes cannot spin forever outside the provider
  // budget. Provider token/cost accounting remains zero.
  if (code.startsWith("execution_route.")) return false;
  if (input.providerInvocationAttempted === false) return true;
  if (!code) return false;
  if (PREFLIGHT_BUDGET_EXEMPT_ERROR_CODES.has(code)) return true;
  if (
    code.startsWith("workspace_validation") ||
    code.startsWith("configuration_") ||
    code === "missing_workspace" ||
    code === "workspace_not_ready"
  ) {
    return true;
  }
  return false;
}

/**
 * Split observed input tokens into fixed overhead vs discretionary spend.
 * Legacy rows without an explicit split charge the full amount as discretionary
 * except when a reservation recorded the fixed overhead portion.
 */
export function splitInputTokenAccounting(input: {
  inputTokens: number;
  fixedOverheadInputTokens?: number | null;
  discretionaryInputTokens?: number | null;
}): { fixedOverheadInputTokens: number; discretionaryInputTokens: number } {
  const total = nonNegative(input.inputTokens);
  if (
    input.discretionaryInputTokens != null &&
    Number.isFinite(input.discretionaryInputTokens)
  ) {
    const discretionary = nonNegative(input.discretionaryInputTokens);
    const fixed = input.fixedOverheadInputTokens != null
      ? nonNegative(input.fixedOverheadInputTokens)
      : Math.max(0, total - discretionary);
    return { fixedOverheadInputTokens: fixed, discretionaryInputTokens: discretionary };
  }
  if (input.fixedOverheadInputTokens != null && Number.isFinite(input.fixedOverheadInputTokens)) {
    const fixed = Math.min(total, nonNegative(input.fixedOverheadInputTokens));
    return {
      fixedOverheadInputTokens: fixed,
      discretionaryInputTokens: Math.max(0, total - fixed),
    };
  }
  return { fixedOverheadInputTokens: 0, discretionaryInputTokens: total };
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;
const RESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RECONCILED_EXECUTION_ADAPTERS = new Set(["codex_local", "grok_local"]);

export function parseReconciledExecutionAdapters(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const raw = env.PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS?.trim();
  if (!raw) return new Set();

  const adapters = raw.split(",").map((value) => value.trim());
  if (adapters.some((value) => !value || !RECONCILED_EXECUTION_ADAPTERS.has(value))) {
    throw new Error(
      "PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS may contain only codex_local and grok_local",
    );
  }
  return new Set(adapters);
}

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
  const limits: ExecutionAdmissionPolicyLimits = {
    ...values,
    fixedOverheadInputTokens: 0,
    executionClass: "steady_state",
  };
  return {
    enabled: true,
    ...limits,
    digest: digestPolicyLimits(limits),
  };
}

type ResourceBudgetLimitField =
  | "maxRunsPerTask"
  | "maxRetriesPerTask"
  | "maxInputTokensPerTask"
  | "maxOutputTokensPerTask"
  | "maxWallMsPerTask"
  | "maxInputTokensPerInvocation"
  | "maxOutputTokensPerInvocation"
  | "maxTurnsPerInvocation"
  | "maxToolCallsPerInvocation";

const LIMIT_FIELDS: ResourceBudgetLimitField[] = [
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

type SpendLimitField = Exclude<ResourceBudgetLimitField, "maxTurnsPerInvocation" | "maxToolCallsPerInvocation">;

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

export function executionAdmissionPolicyLimits(
  policy: Extract<ExecutionAdmissionPolicy, { enabled: true }>,
): ExecutionAdmissionPolicyLimits {
  return {
    maxRunsPerTask: policy.maxRunsPerTask,
    maxRetriesPerTask: policy.maxRetriesPerTask,
    maxInputTokensPerTask: policy.maxInputTokensPerTask,
    maxOutputTokensPerTask: policy.maxOutputTokensPerTask,
    maxWallMsPerTask: policy.maxWallMsPerTask,
    maxInputTokensPerInvocation: policy.maxInputTokensPerInvocation,
    maxOutputTokensPerInvocation: policy.maxOutputTokensPerInvocation,
    maxTurnsPerInvocation: policy.maxTurnsPerInvocation,
    maxToolCallsPerInvocation: policy.maxToolCallsPerInvocation,
    fixedOverheadInputTokens: policy.fixedOverheadInputTokens ?? 0,
    executionClass: policy.executionClass ?? "steady_state",
  };
}

/**
 * Digest only spend/structural ceilings so fixed-overhead and execution-class
 * accounting metadata can evolve without invalidating epoch locks that share
 * the same executable ceilings.
 */
function digestPolicyLimits(values: ExecutionAdmissionPolicyLimits): string {
  const {
    fixedOverheadInputTokens: _fixed,
    executionClass: _class,
    ...ceilings
  } = values;
  return createHash("sha256").update(JSON.stringify(ceilings)).digest("hex");
}

function normalizeExecutionTaskClass(value: unknown): IssueExecutionTaskClass {
  if (value === "bootstrap" || value === "steady_state" || value === "proven") return value;
  return "steady_state";
}

function normalizeFixedOverheadInputTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Execution admission fixedOverheadInputTokens must be a finite number");
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Execution admission fixedOverheadInputTokens must be a non-negative safe integer");
  }
  return Math.floor(value);
}

/**
 * Rehydrate an enabled policy from a stored limits snapshot. Validates every
 * field and recomputes the digest so a forged snapshot cannot silently raise
 * ceilings.
 */
export function rehydrateExecutionAdmissionPolicy(
  limits: ExecutionAdmissionPolicyLimits,
  expectedDigest?: string,
): Extract<ExecutionAdmissionPolicy, { enabled: true }> {
  const values: ExecutionAdmissionPolicyLimits = {
    maxRunsPerTask: validateLimitNumber("maxRunsPerTask", limits.maxRunsPerTask),
    maxRetriesPerTask: validateLimitNumber("maxRetriesPerTask", limits.maxRetriesPerTask),
    maxInputTokensPerTask: validateLimitNumber("maxInputTokensPerTask", limits.maxInputTokensPerTask),
    maxOutputTokensPerTask: validateLimitNumber("maxOutputTokensPerTask", limits.maxOutputTokensPerTask),
    maxWallMsPerTask: validateLimitNumber("maxWallMsPerTask", limits.maxWallMsPerTask),
    maxInputTokensPerInvocation: validateLimitNumber(
      "maxInputTokensPerInvocation",
      limits.maxInputTokensPerInvocation,
    ),
    maxOutputTokensPerInvocation: validateLimitNumber(
      "maxOutputTokensPerInvocation",
      limits.maxOutputTokensPerInvocation,
    ),
    maxTurnsPerInvocation: validateLimitNumber("maxTurnsPerInvocation", limits.maxTurnsPerInvocation),
    maxToolCallsPerInvocation: validateLimitNumber(
      "maxToolCallsPerInvocation",
      limits.maxToolCallsPerInvocation,
    ),
    fixedOverheadInputTokens: normalizeFixedOverheadInputTokens(limits.fixedOverheadInputTokens),
    executionClass: normalizeExecutionTaskClass(limits.executionClass),
  };
  if (values.maxRetriesPerTask >= values.maxRunsPerTask) {
    throw new Error("Execution admission maxRetriesPerTask must be lower than maxRunsPerTask");
  }
  if (values.maxInputTokensPerInvocation > values.maxInputTokensPerTask) {
    throw new Error("Execution admission maxInputTokensPerInvocation must not exceed the task input-token limit");
  }
  if (values.maxOutputTokensPerInvocation > values.maxOutputTokensPerTask) {
    throw new Error("Execution admission maxOutputTokensPerInvocation must not exceed the task output-token limit");
  }
  const digest = digestPolicyLimits(values);
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new Error("Execution admission policy snapshot does not match policyDigest");
  }
  return { enabled: true, ...values, digest };
}

export function resolveEffectiveExecutionAdmissionPolicy(
  globalPolicy: Extract<ExecutionAdmissionPolicy, { enabled: true }>,
  requestBudget?: IssueExecutionResourceBudget | null,
  parentPolicy?: Extract<ExecutionAdmissionPolicy, { enabled: true }> | null,
): Extract<ExecutionAdmissionPolicy, { enabled: true }> {
  const executionClass = normalizeExecutionTaskClass(
    requestBudget?.executionClass ?? parentPolicy?.executionClass ?? globalPolicy.executionClass,
  );
  const isBootstrap = executionClass === "bootstrap";
  const fixedOverheadInputTokens = normalizeFixedOverheadInputTokens(
    requestBudget?.fixedOverheadInputTokens ??
      parentPolicy?.fixedOverheadInputTokens ??
      globalPolicy.fixedOverheadInputTokens ??
      0,
  );

  const pickSpendLimit = (field: SpendLimitField) => {
    // Bootstrap tasks may declare generous bounded capacity that is not
    // clamped by tight steady-state environment ceilings. Parent authority,
    // when present, still caps the child.
    if (isBootstrap) {
      const bootstrapDefault = BOOTSTRAP_EXECUTION_DEFAULTS[field];
      const requested = requestBudget?.[field] === undefined
        ? Math.max(validateLimitNumber(field, globalPolicy[field]), bootstrapDefault)
        : validateLimitNumber(field, requestBudget[field]);
      if (parentPolicy != null && parentPolicy.executionClass !== "bootstrap") {
        // Non-bootstrap parent remains a hard authority ceiling.
        return Math.min(requested, validateLimitNumber(field, parentPolicy[field]));
      }
      if (parentPolicy != null) {
        return Math.min(requested, validateLimitNumber(field, parentPolicy[field]));
      }
      return requested;
    }

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

  const pickStructuralLimit = (
    field: "maxTurnsPerInvocation" | "maxToolCallsPerInvocation",
  ) => {
    // The environment value is the conservative default for unclassified
    // work. A task may explicitly select a larger bounded turn/tool envelope
    // without widening its token, wall-time, run, or retry ceilings. An
    // inherited parent policy, when present, remains an authority ceiling.
    // Bootstrap may also adopt generous structural defaults.
    const requested = requestBudget?.[field] === undefined
      ? (isBootstrap
        ? Math.max(
          validateLimitNumber(field, globalPolicy[field]),
          BOOTSTRAP_EXECUTION_DEFAULTS[field],
        )
        : validateLimitNumber(field, globalPolicy[field]))
      : validateLimitNumber(field, requestBudget[field]);
    const hostBoundedRequest = field === "maxTurnsPerInvocation"
      ? Math.min(requested, MAX_EXPLICIT_TURNS_PER_INVOCATION)
      : requested;
    if (parentPolicy == null) return hostBoundedRequest;
    if (isBootstrap && parentPolicy.executionClass === "bootstrap") {
      return Math.min(hostBoundedRequest, validateLimitNumber(field, parentPolicy[field]));
    }
    if (isBootstrap && parentPolicy.executionClass !== "bootstrap") {
      // Bootstrap child under non-bootstrap parent: allow request up to parent.
      return Math.min(hostBoundedRequest, validateLimitNumber(field, parentPolicy[field]));
    }
    return Math.min(hostBoundedRequest, validateLimitNumber(field, parentPolicy[field]));
  };

  const values: ExecutionAdmissionPolicyLimits = {
    maxRunsPerTask: pickSpendLimit("maxRunsPerTask"),
    maxRetriesPerTask: pickSpendLimit("maxRetriesPerTask"),
    maxInputTokensPerTask: pickSpendLimit("maxInputTokensPerTask"),
    maxOutputTokensPerTask: pickSpendLimit("maxOutputTokensPerTask"),
    maxWallMsPerTask: pickSpendLimit("maxWallMsPerTask"),
    maxInputTokensPerInvocation: pickSpendLimit("maxInputTokensPerInvocation"),
    maxOutputTokensPerInvocation: pickSpendLimit("maxOutputTokensPerInvocation"),
    maxTurnsPerInvocation: pickStructuralLimit("maxTurnsPerInvocation"),
    maxToolCallsPerInvocation: pickStructuralLimit("maxToolCallsPerInvocation"),
    fixedOverheadInputTokens,
    executionClass,
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
    digest: digestPolicyLimits(values),
  };
}

/**
 * Fold issue and ancestor resource budgets so each can only tighten the global
 * caps. Budgets are applied root-to-leaf: each step uses the original global
 * policy as the env baseline and the previously resolved policy as the
 * inherited authority ceiling.
 */
export function resolveExecutionAdmissionPolicyForResourceBudgetChain(
  globalPolicy: ExecutionAdmissionPolicy,
  budgets: Array<IssueExecutionResourceBudget | null | undefined>,
  parentPolicy?: Extract<ExecutionAdmissionPolicy, { enabled: true }> | null,
): ExecutionAdmissionPolicy {
  if (!globalPolicy.enabled) return globalPolicy;
  let inheritedStructuralLimits: Pick<
    Extract<ExecutionAdmissionPolicy, { enabled: true }>,
    "maxTurnsPerInvocation" | "maxToolCallsPerInvocation"
  > | null = parentPolicy
    ? {
      maxTurnsPerInvocation: parentPolicy.maxTurnsPerInvocation,
      maxToolCallsPerInvocation: parentPolicy.maxToolCallsPerInvocation,
    }
    : null;
  let inherited = parentPolicy
    ? {
      ...parentPolicy,
      maxTurnsPerInvocation: inheritedStructuralLimits?.maxTurnsPerInvocation ?? Number.MAX_SAFE_INTEGER,
      maxToolCallsPerInvocation: inheritedStructuralLimits?.maxToolCallsPerInvocation ?? Number.MAX_SAFE_INTEGER,
    }
    : null;
  let effective: Extract<ExecutionAdmissionPolicy, { enabled: true }> = inherited
    ? resolveEffectiveExecutionAdmissionPolicy(globalPolicy, null, inherited)
    : globalPolicy;
  for (const budget of budgets) {
    if (budget == null) continue;
    const authority = inherited
      ? {
        ...inherited,
        maxTurnsPerInvocation: inheritedStructuralLimits?.maxTurnsPerInvocation ?? Number.MAX_SAFE_INTEGER,
        maxToolCallsPerInvocation: inheritedStructuralLimits?.maxToolCallsPerInvocation ?? Number.MAX_SAFE_INTEGER,
      }
      : null;
    effective = resolveEffectiveExecutionAdmissionPolicy(globalPolicy, budget, authority);
    inheritedStructuralLimits = {
      maxTurnsPerInvocation: budget.maxTurnsPerInvocation === undefined
        ? inheritedStructuralLimits?.maxTurnsPerInvocation ?? Number.MAX_SAFE_INTEGER
        : effective.maxTurnsPerInvocation,
      maxToolCallsPerInvocation: budget.maxToolCallsPerInvocation === undefined
        ? inheritedStructuralLimits?.maxToolCallsPerInvocation ?? Number.MAX_SAFE_INTEGER
        : effective.maxToolCallsPerInvocation,
    };
    inherited = effective;
  }
  return effective;
}

/**
 * Once an epoch has an admitted (allowed) envelope, its effective policy is
 * immutable. Live resolution may only be used for the first admission of an
 * epoch, or when a legacy envelope lacks a policy snapshot and the live
 * digest still matches.
 */
export function resolveEpochBoundExecutionAdmissionPolicy(
  livePolicy: Extract<ExecutionAdmissionPolicy, { enabled: true }>,
  lockedEnvelope: ExecutionAdmissionEnvelope | null | undefined,
): Extract<ExecutionAdmissionPolicy, { enabled: true }> {
  if (!lockedEnvelope || lockedEnvelope.decision !== "allowed") {
    return livePolicy;
  }
  if (lockedEnvelope.policy) {
    return rehydrateExecutionAdmissionPolicy(lockedEnvelope.policy, lockedEnvelope.policyDigest);
  }
  if (livePolicy.digest === lockedEnvelope.policyDigest) {
    return livePolicy;
  }
  throw new Error(
    "Execution admission epoch policy is locked and cannot be rehydrated after policy drift",
  );
}

/**
 * Prefer the earliest admitted envelope for a budget epoch so retries and
 * continuations pin the first effective policy rather than a later rewrite.
 */
export function selectEpochLockingAdmissionEnvelope(
  candidates: Array<ExecutionAdmissionEnvelope | null | undefined>,
): ExecutionAdmissionEnvelope | null {
  let selected: ExecutionAdmissionEnvelope | null = null;
  for (const candidate of candidates) {
    if (!candidate || candidate.decision !== "allowed") continue;
    if (!selected) {
      selected = candidate;
      continue;
    }
    const selectedAt = Date.parse(selected.evaluatedAt);
    const candidateAt = Date.parse(candidate.evaluatedAt);
    if (
      Number.isFinite(candidateAt) &&
      (!Number.isFinite(selectedAt) || candidateAt < selectedAt ||
        (candidateAt === selectedAt && candidate.attempt < selected.attempt))
    ) {
      selected = candidate;
    }
  }
  return selected;
}


function readExecutionAdmissionPolicyLimits(value: unknown): ExecutionAdmissionPolicyLimits | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ExecutionAdmissionPolicyLimits>;
  try {
    return executionAdmissionPolicyLimits(rehydrateExecutionAdmissionPolicy({
      maxRunsPerTask: candidate.maxRunsPerTask as number,
      maxRetriesPerTask: candidate.maxRetriesPerTask as number,
      maxInputTokensPerTask: candidate.maxInputTokensPerTask as number,
      maxOutputTokensPerTask: candidate.maxOutputTokensPerTask as number,
      maxWallMsPerTask: candidate.maxWallMsPerTask as number,
      maxInputTokensPerInvocation: candidate.maxInputTokensPerInvocation as number,
      maxOutputTokensPerInvocation: candidate.maxOutputTokensPerInvocation as number,
      maxTurnsPerInvocation: candidate.maxTurnsPerInvocation as number,
      maxToolCallsPerInvocation: candidate.maxToolCallsPerInvocation as number,
      fixedOverheadInputTokens: candidate.fixedOverheadInputTokens ?? 0,
      executionClass: candidate.executionClass ?? "steady_state",
    }));
  } catch {
    return null;
  }
}

export function readExecutionAdmissionEnvelope(value: unknown): ExecutionAdmissionEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ExecutionAdmissionEnvelope>;
  const observed = candidate.observed as Partial<ExecutionAdmissionUsage> | undefined;
  const validObservedBase = observed && [
    observed.runCount,
    observed.retryCount,
    observed.inputTokens,
    observed.cachedInputTokens,
    observed.outputTokens,
    observed.wallMs,
  ].every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
  const validObserved = Boolean(
    validObservedBase &&
    (observed.fixedOverheadInputTokens === undefined ||
      (typeof observed.fixedOverheadInputTokens === "number" &&
        Number.isSafeInteger(observed.fixedOverheadInputTokens) &&
        observed.fixedOverheadInputTokens >= 0)) &&
    (observed.preflightExemptRunCount === undefined ||
      (typeof observed.preflightExemptRunCount === "number" &&
        Number.isSafeInteger(observed.preflightExemptRunCount) &&
        observed.preflightExemptRunCount >= 0)) &&
    (observed.preflightExemptWallMs === undefined ||
      (typeof observed.preflightExemptWallMs === "number" &&
        Number.isSafeInteger(observed.preflightExemptWallMs) &&
        observed.preflightExemptWallMs >= 0)) &&
    (observed.lastPreProviderFailure === undefined ||
      observed.lastPreProviderFailure === null ||
      readPreProviderFailureObservation(observed.lastPreProviderFailure) !== null),
  );
  const validReason = candidate.reason === null || [
    "run_limit_exhausted",
    "retry_limit_exhausted",
    "input_token_limit_exhausted",
    "output_token_limit_exhausted",
    "wall_time_limit_exhausted",
    "pre_provider_failure_limit_exhausted",
    "pre_provider_wall_time_limit_exhausted",
    "input_reservation_unavailable",
    "output_reservation_unavailable",
  ].includes(candidate.reason as string);
  const reservation = candidate.reservation as Partial<ExecutionInvocationBudget> | null | undefined;
  const validPhasePlan = (() => {
    if (!reservation || reservation.phasePlan === undefined) return true;
    if (!reservation.phasePlan || typeof reservation.phasePlan !== "object" || Array.isArray(reservation.phasePlan)) return false;
    const phases = ["plan", "implement", "verify", "closeout"] as const;
    const dimensions = ["inputTokens", "outputTokens", "turns", "toolCalls", "wallMs"] as const;
    const plan = reservation.phasePlan as Record<string, unknown>;
    if (Object.keys(plan).length !== phases.length || phases.some((phase) => {
      const value = plan[phase];
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const record = value as Record<string, unknown>;
      return Object.keys(record).length !== dimensions.length || dimensions.some((dimension) =>
        typeof record[dimension] !== "number" || !Number.isSafeInteger(record[dimension]) || Number(record[dimension]) < 0);
    })) return false;
    const sum = (dimension: typeof dimensions[number]) => phases.reduce((total, phase) =>
      total + Number((plan[phase] as Record<string, unknown>)[dimension]), 0);
    return sum("inputTokens") === (reservation.discretionaryInputTokens ?? reservation.maxInputTokens)
      && sum("outputTokens") === reservation.maxOutputTokens
      && sum("turns") === reservation.maxTurns
      && sum("toolCalls") === reservation.maxToolCalls
      && sum("wallMs") === reservation.maxWallMs;
  })();
  const validReservation = reservation === null || Boolean(
    reservation &&
    reservation.schemaVersion === "paperclip.provider-invocation-budget.v1" &&
    typeof reservation.budgetId === "string" && reservation.budgetId === candidate.budgetId &&
    typeof reservation.reservationId === "string" && /^[a-f0-9]{64}$/.test(reservation.reservationId) &&
    [reservation.maxInputTokens, reservation.maxOutputTokens, reservation.maxTurns,
      reservation.maxToolCalls, reservation.maxWallMs]
      .every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0) &&
    (reservation.fixedOverheadInputTokens === undefined ||
      (typeof reservation.fixedOverheadInputTokens === "number" &&
        Number.isSafeInteger(reservation.fixedOverheadInputTokens) &&
        reservation.fixedOverheadInputTokens >= 0)) &&
    (reservation.discretionaryInputTokens === undefined ||
      (typeof reservation.discretionaryInputTokens === "number" &&
        Number.isSafeInteger(reservation.discretionaryInputTokens) &&
        reservation.discretionaryInputTokens >= 0)) &&
    validPhasePlan
  );
  const hasPolicyField = Object.prototype.hasOwnProperty.call(candidate, "policy");
  const policy = hasPolicyField ? readExecutionAdmissionPolicyLimits(candidate.policy) : undefined;
  const validPolicy = !hasPolicyField || (
    policy != null &&
    typeof candidate.policyDigest === "string" &&
    digestPolicyLimits(policy) === candidate.policyDigest
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
    !validPolicy ||
    typeof candidate.evaluatedAt !== "string" || !Number.isFinite(Date.parse(candidate.evaluatedAt))
  ) {
    return null;
  }
  const envelope = {
    ...candidate,
    observed: {
      ...(observed as ExecutionAdmissionUsage),
      fixedOverheadInputTokens: observed?.fixedOverheadInputTokens ?? 0,
      preflightExemptRunCount: observed?.preflightExemptRunCount ?? 0,
      preflightExemptWallMs: observed?.preflightExemptWallMs ?? 0,
      lastPreProviderFailure:
        readPreProviderFailureObservation(observed?.lastPreProviderFailure) ?? null,
    },
  } as ExecutionAdmissionEnvelope;
  if (policy) {
    return { ...envelope, policy };
  }
  return envelope;
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
  /** Phase 5 surface: isolate budget per provider route so ladder advances do not inherit an exhausted default budget. */
  routePathId?: string | null;
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
  const routeRaw = typeof input.routePathId === "string" ? input.routePathId.trim() : "";
  const route =
    routeRaw && /^[A-Za-z0-9._:-]{1,64}$/.test(routeRaw) ? routeRaw : "default";
  // Keep historical default budget id when route is default for backward compatibility.
  if (route === "default") {
    return { budgetId: `${root}:${epoch}`, epoch };
  }
  return { budgetId: `${root}:${epoch}:route:${route}`, epoch };
}

function nonNegative(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function summarizePriorExecution(priorRuns: PriorExecutionRun[]): ExecutionAdmissionUsage {
  return priorRuns.reduce<ExecutionAdmissionUsage>(
    (total, run) => {
      if (run.countsTowardTaskBudget === false) {
        // Historical task-budget exemptions include a few provider-invoking
        // lifecycle outcomes. They stay exempt for compatibility, but cannot
        // consume or authorize the provider-free remediation stop-loss.
        const providerFree = run.providerInvocationAttempted === false || run.preProviderFailure != null;
        return {
          ...total,
          preflightExemptRunCount: total.preflightExemptRunCount + (providerFree ? 1 : 0),
          preflightExemptWallMs:
            total.preflightExemptWallMs + (providerFree ? nonNegative(run.wallMs) : 0),
          lastPreProviderFailure: providerFree
            ? run.preProviderFailure ?? total.lastPreProviderFailure
            : total.lastPreProviderFailure,
        };
      }
      const inputSplit = splitInputTokenAccounting({
        inputTokens: nonNegative(run.inputTokens),
        fixedOverheadInputTokens: run.fixedOverheadInputTokens,
        discretionaryInputTokens: run.discretionaryInputTokens,
      });
      return {
        runCount: total.runCount + 1,
        // Independent workflow stages consume run budget but are not retries.
        // Workspace-validation / preflight-exempt retries also do not increment
        // retryCount (handled above via countsTowardTaskBudget === false).
        retryCount: total.retryCount + (
          (run.countsAsRetry ?? Boolean(run.retryOfRunId)) ? 1 : 0
        ),
        inputTokens: total.inputTokens + inputSplit.discretionaryInputTokens,
        cachedInputTokens: total.cachedInputTokens + nonNegative(run.cachedInputTokens),
        outputTokens: total.outputTokens + nonNegative(run.outputTokens),
        wallMs: total.wallMs + nonNegative(run.wallMs),
        fixedOverheadInputTokens:
          total.fixedOverheadInputTokens + inputSplit.fixedOverheadInputTokens,
        preflightExemptRunCount: total.preflightExemptRunCount,
        preflightExemptWallMs: total.preflightExemptWallMs,
        lastPreProviderFailure: total.lastPreProviderFailure,
      };
    },
    {
      runCount: 0,
      retryCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      wallMs: 0,
      fixedOverheadInputTokens: 0,
      preflightExemptRunCount: 0,
      preflightExemptWallMs: 0,
      lastPreProviderFailure: null,
    },
  );
}

/**
 * True when a terminal "succeeded" row must not count as durable success
 * evidence for admission reset or task completion (review/assignment wakes
 * that never posted a disposition comment).
 */
export function isNonDispositionalReviewSuccess(input: {
  status?: string | null;
  errorCode?: string | null;
  issueCommentStatus?: string | null;
  wakeReason?: string | null;
  skipIssueComment?: boolean;
}): boolean {
  if (input.skipIssueComment === true) return false;
  if (input.errorCode === "review_missing_disposition" || input.errorCode === "missing_issue_comment") {
    return true;
  }
  if (input.status !== "succeeded") return false;
  const comment = typeof input.issueCommentStatus === "string" ? input.issueCommentStatus : "";
  if (comment === "satisfied" || comment === "not_applicable" || comment === "") return false;
  // retry_queued / retry_exhausted mean comment was required and not satisfied.
  if (comment === "retry_queued" || comment === "retry_exhausted") return true;
  const wake = typeof input.wakeReason === "string" ? input.wakeReason : "";
  return (
    wake === "issue_assigned" ||
    wake === "execution_review_requested" ||
    wake === "execution_approval_requested" ||
    wake === "execution_changes_requested"
  ) && comment !== "satisfied";
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
    : observed.preflightExemptRunCount >= PRE_PROVIDER_STOP_LOSS_POLICY.maxFailuresPerBudgetEpoch
      ? "pre_provider_failure_limit_exhausted"
      : observed.preflightExemptWallMs >= PRE_PROVIDER_STOP_LOSS_POLICY.maxExemptWallMsPerBudgetEpoch
        ? "pre_provider_wall_time_limit_exhausted"
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
  const reservationSequence = attempt + input.decision.observed.preflightExemptRunCount;
  const remainingInputTokens = Math.max(0, input.policy.maxInputTokensPerTask - input.decision.observed.inputTokens);
  const remainingOutputTokens = Math.max(0, input.policy.maxOutputTokensPerTask - input.decision.observed.outputTokens);
  const remainingWallMs = Math.max(0, input.policy.maxWallMsPerTask - input.decision.observed.wallMs);
  const discretionaryInputTokens = Math.min(input.policy.maxInputTokensPerInvocation, remainingInputTokens);
  const fixedOverheadInputTokens = input.policy.fixedOverheadInputTokens;
  const reservation = input.decision.allowed ? {
    schemaVersion: "paperclip.provider-invocation-budget.v1" as const,
    budgetId: input.identity.budgetId,
    reservationId: createHash("sha256")
      .update(`${input.identity.budgetId}:${input.identity.epoch}:${reservationSequence}:${input.policy.digest}`)
      .digest("hex"),
    maxInputTokens: discretionaryInputTokens + fixedOverheadInputTokens,
    maxOutputTokens: Math.min(input.policy.maxOutputTokensPerInvocation, remainingOutputTokens),
    maxTurns: input.policy.maxTurnsPerInvocation,
    maxToolCalls: input.policy.maxToolCallsPerInvocation,
    maxWallMs: remainingWallMs,
    fixedOverheadInputTokens,
    discretionaryInputTokens,
    phasePlan: buildExecutionPhaseBudgetPlan({
      inputTokens: discretionaryInputTokens,
      outputTokens: Math.min(input.policy.maxOutputTokensPerInvocation, remainingOutputTokens),
      turns: input.policy.maxTurnsPerInvocation,
      toolCalls: input.policy.maxToolCallsPerInvocation,
      wallMs: remainingWallMs,
    }),
  } : null;
  return {
    schemaVersion: EXECUTION_ADMISSION_SCHEMA_VERSION,
    budgetId: input.identity.budgetId,
    epoch: input.identity.epoch,
    policyDigest: input.policy.digest,
    policy: executionAdmissionPolicyLimits(input.policy),
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

/**
 * Claim-time admission reused for preflight decisions before a wake/run row is
 * created. The caller must supply the same effective policy and locking
 * envelope that claim time would use for the budget epoch, plus the prior runs
 * observed for that epoch. Callers may classify the prospective run when the
 * control plane has already established that it is a retry or an authorized
 * independent stage; otherwise it remains an unclassified new attempt.
 */
export function evaluateProspectiveExecutionAdmission(input: {
  identity: { budgetId: string; epoch: string };
  policy: Extract<ExecutionAdmissionPolicy, { enabled: true }>;
  lockingEnvelope: ExecutionAdmissionEnvelope | null;
  priorRuns: PriorExecutionRun[];
  currentRun?: {
    isRetry?: boolean;
    isAuthorizedIndependentStage?: boolean;
  };
}): { allowed: boolean; reason: ExecutionAdmissionReason | null; envelope: ExecutionAdmissionEnvelope } {
  let effectivePolicy: Extract<ExecutionAdmissionPolicy, { enabled: true }>;
  try {
    effectivePolicy = resolveEpochBoundExecutionAdmissionPolicy(
      input.policy,
      input.lockingEnvelope,
    );
  } catch {
    const deniedDecision = {
      allowed: false as const,
      reason: "run_limit_exhausted" as const,
      observed: summarizePriorExecution(input.priorRuns),
    };
    return {
      allowed: false,
      reason: deniedDecision.reason,
      envelope: buildExecutionAdmissionEnvelope({
        identity: input.identity,
        policy: input.policy,
        decision: deniedDecision,
        evaluatedAt: new Date(),
      }),
    };
  }

  const decision = evaluateExecutionAdmission(
    effectivePolicy,
    input.priorRuns,
    input.currentRun,
  );
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    envelope: buildExecutionAdmissionEnvelope({
      identity: input.identity,
      policy: effectivePolicy,
      decision,
      evaluatedAt: new Date(),
    }),
  };
}

export function evaluateExecutionReservationUsage(input: {
  reservation: ExecutionInvocationBudget;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  turns?: number | null;
  toolCalls?: number | null;
}) {
  const exceeded = [
    input.inputTokens > input.reservation.maxInputTokens ? "input_tokens" : null,
    input.outputTokens > input.reservation.maxOutputTokens ? "output_tokens" : null,
    input.wallMs > input.reservation.maxWallMs ? "wall_ms" : null,
    input.turns != null && input.turns > input.reservation.maxTurns ? "turns" : null,
    input.toolCalls != null && input.toolCalls > input.reservation.maxToolCalls ? "tool_calls" : null,
  ].filter((value): value is string => Boolean(value));
  return { compliant: exceeded.length === 0, exceeded };
}

/**
 * Resolve the effective policy for a task that carries an explicit
 * executionPolicy.resourceBudget. Spend-bearing limits are componentwise
 * tightened. Explicit turn/tool limits may choose a larger bounded coding
 * envelope while token, wall-time, run, and retry ceilings remain unchanged.
 * Absent budgets keep the conservative global defaults.
 */
export function resolveExecutionAdmissionPolicyForResourceBudget(
  globalPolicy: ExecutionAdmissionPolicy,
  resourceBudget?: IssueExecutionResourceBudget | null,
  parentPolicy?: Extract<ExecutionAdmissionPolicy, { enabled: true }> | null,
): ExecutionAdmissionPolicy {
  return resolveExecutionAdmissionPolicyForResourceBudgetChain(
    globalPolicy,
    resourceBudget == null ? [] : [resourceBudget],
    parentPolicy,
  );
}

const RESERVATION_EXCEEDED_DIMENSIONS = new Set([
  "input_tokens",
  "output_tokens",
  "wall_ms",
  "turns",
  "tool_calls",
  "usage_missing",
]);

/**
 * Prefer adapter-reported exact exceeded dimensions over a generic
 * usage_missing label so operator receipts keep turn/tool/wall truth.
 */
export function resolveReportedReservationExceeded(input: {
  resultJson?: unknown;
  errorCode?: string | null;
  reservation?: ExecutionInvocationBudget | null;
}): string[] {
  const reported: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim().toLowerCase();
    if (!RESERVATION_EXCEEDED_DIMENSIONS.has(normalized)) return;
    if (!reported.includes(normalized)) reported.push(normalized);
  };

  let metrics: { turns?: number; toolCalls?: number } | null = null;
  if (input.resultJson && typeof input.resultJson === "object" && !Array.isArray(input.resultJson)) {
    const root = input.resultJson as Record<string, unknown>;
    push(root.exceeded);
    if (Array.isArray(root.exceeded)) {
      for (const entry of root.exceeded) push(entry);
    }
    const reservation = root.executionReservation;
    if (reservation && typeof reservation === "object" && !Array.isArray(reservation)) {
      const exceeded = (reservation as Record<string, unknown>).exceeded;
      push(exceeded);
      if (Array.isArray(exceeded)) {
        for (const entry of exceeded) push(entry);
      }
    }
    const rawMetrics = root.execution_metrics;
    if (rawMetrics && typeof rawMetrics === "object" && !Array.isArray(rawMetrics)) {
      const record = rawMetrics as Record<string, unknown>;
      const turns = typeof record.turns === "number" && Number.isFinite(record.turns)
        ? Math.floor(record.turns)
        : undefined;
      const toolCalls = typeof record.tool_calls === "number" && Number.isFinite(record.tool_calls)
        ? Math.floor(record.tool_calls)
        : typeof record.toolCalls === "number" && Number.isFinite(record.toolCalls)
          ? Math.floor(record.toolCalls)
          : undefined;
      metrics = { turns, toolCalls };
    }
  }

  if (input.reservation && metrics) {
    const fromMetrics = evaluateExecutionReservationUsage({
      reservation: input.reservation,
      inputTokens: 0,
      outputTokens: 0,
      wallMs: 0,
      turns: metrics.turns ?? null,
      toolCalls: metrics.toolCalls ?? null,
    }).exceeded.filter((dimension) => dimension === "turns" || dimension === "tool_calls");
    for (const dimension of fromMetrics) push(dimension);
  }

  return reported;
}
