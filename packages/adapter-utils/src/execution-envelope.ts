import { createHash } from "node:crypto";

export const EXECUTION_CONTEXT_BINDING_SCHEMA = "paperclip.execution-context-binding.v1" as const;
export const CONTINUATION_PACKET_SCHEMA = "gloops.continuation-packet.v1" as const;
export const OPERATOR_RECEIPT_SCHEMA = "gloops.execution-truth.operator-receipt.v2" as const;
export const PAPERCLIP_EXECUTION_CONTEXT_KEY = "paperclipExecutionContext" as const;
export const PAPERCLIP_EXECUTION_RECEIPT_KEY = "paperclipExecutionTruthReceipt" as const;
export const PAPERCLIP_PROVIDER_ROUTE_EVIDENCE_KEY = "gloopsProviderRouteEvidence" as const;
const PROVIDER_ROUTE_RECEIPT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const PROVIDER_ROUTE_RECEIPT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const EXECUTION_PHASE_SHARES = Object.freeze({
  plan: 15,
  implement: 55,
  verify: 20,
  closeout: 10,
} as const);

export type ExecutionBudgetPhase = keyof typeof EXECUTION_PHASE_SHARES;
export type ExecutionPhaseBudgetPlan = Record<ExecutionBudgetPhase, {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  toolCalls: number;
  wallMs: number;
}>;

export type ExecutionInvocationBudget = {
  schemaVersion: "paperclip.provider-invocation-budget.v1";
  budgetId: string;
  reservationId: string;
  /**
   * Total input reservation for this invocation: fixed overhead + discretionary.
   * Provider prompt size is checked against this combined ceiling.
   */
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTurns: number;
  maxToolCalls: number;
  maxWallMs: number;
  /**
   * Fixed charter/packet/tool-schema overhead reserved inside maxInputTokens.
   * Optional for legacy reservations written before net-of-overhead accounting.
   */
  fixedOverheadInputTokens?: number;
  /**
   * Discretionary task allowance reserved inside maxInputTokens.
   * Optional for legacy reservations; when absent, treat maxInputTokens as discretionary.
   */
  discretionaryInputTokens?: number;
  /**
   * Completion-aware allocation carried to the provider. Ten percent remains
   * reserved for a terminal receipt/continuation instead of being consumed by
   * discovery or implementation loops.
   */
  phasePlan?: ExecutionPhaseBudgetPlan;
};

export type SubscriptionRouteProvider = "ollama" | "luna" | "terra" | "grok" | "codex";
export type SubscriptionBillingPool = "ollama_cloud" | "codex_subscription" | "grok_subscription";

export function subscriptionBillingPool(provider: SubscriptionRouteProvider): SubscriptionBillingPool {
  if (provider === "ollama") return "ollama_cloud";
  if (provider === "grok") return "grok_subscription";
  return "codex_subscription";
}
export type SubscriptionRouteAttemptEvidence = {
  provider: Exclude<SubscriptionRouteProvider, "codex">;
  transport: "cli" | "subscription_cli";
  disposition: "attempted_failed" | "ineligible";
  reason: "quota_exhausted" | "provider_unavailable" | "capability_floor" | "quality_failure";
  runId: string;
  issueId: string;
  receiptDigest: string;
  observedAt: string;
};

export type SubscriptionRouteEvidence = {
  schemaVersion: "gloops.subscription-route-evidence.v1";
  attempts: SubscriptionRouteAttemptEvidence[];
};

export type SubscriptionRouteAdmission = {
  allowed: boolean;
  provider: SubscriptionRouteProvider | null;
  reason: string;
};

const DISALLOWED_AUTONOMOUS_MODEL_ADAPTERS = new Set([
  "claude-local",
  "claude_local",
  "cursor",
  "cursor-cloud",
  "cursor_cloud",
  "gemini_local",
  "openclaw_gateway",
  "opencode",
  "opencode_local",
  "pi_local",
]);

export function buildSubscriptionRouteAttemptEvidence(input: Omit<SubscriptionRouteAttemptEvidence, "receiptDigest">): SubscriptionRouteAttemptEvidence {
  const receiptBody = {
    schemaVersion: "gloops.subscription-route-attempt.v1",
    provider: input.provider,
    transport: input.transport,
    disposition: input.disposition,
    reason: input.reason,
    runId: input.runId,
    issueId: input.issueId,
    observedAt: input.observedAt,
  };
  return {
    ...input,
    receiptDigest: `sha256:${createHash("sha256").update(canonicalSerialize(receiptBody)).digest("hex")}`,
  };
}

function routeAttemptReceiptMatches(value: SubscriptionRouteAttemptEvidence): boolean {
  return buildSubscriptionRouteAttemptEvidence({
    provider: value.provider,
    transport: value.transport,
    disposition: value.disposition,
    reason: value.reason,
    runId: value.runId,
    issueId: value.issueId,
    observedAt: value.observedAt,
  }).receiptDigest === value.receiptDigest;
}

export function readSubscriptionRouteEvidence(value: unknown, now: string | Date | number = new Date()): SubscriptionRouteEvidence | null {
  const currentTime = typeof now === "string"
    ? Date.parse(now)
    : now instanceof Date
      ? now.getTime()
      : now;
  if (!Number.isFinite(currentTime)) return null;
  if (!isRecord(value) || value.schemaVersion !== "gloops.subscription-route-evidence.v1" || !Array.isArray(value.attempts)) {
    return null;
  }
  const attempts: SubscriptionRouteAttemptEvidence[] = [];
  for (const raw of value.attempts) {
    const observedAt = isRecord(raw) && typeof raw.observedAt === "string"
      ? Date.parse(raw.observedAt)
      : Number.NaN;
    if (!isRecord(raw) || !["ollama", "luna", "terra", "grok"].includes(String(raw.provider)) ||
        (raw.transport !== "cli" && raw.transport !== "subscription_cli") ||
        (raw.disposition !== "attempted_failed" && raw.disposition !== "ineligible") ||
        !["quota_exhausted", "provider_unavailable", "capability_floor", "quality_failure"].includes(String(raw.reason)) ||
        typeof raw.runId !== "string" || raw.runId.trim().length === 0 ||
        typeof raw.issueId !== "string" || raw.issueId.trim().length === 0 ||
        typeof raw.receiptDigest !== "string" || !SHA256.test(raw.receiptDigest) ||
        typeof raw.observedAt !== "string" || !Number.isFinite(observedAt) ||
        observedAt < currentTime - PROVIDER_ROUTE_RECEIPT_MAX_AGE_MS ||
        observedAt > currentTime + PROVIDER_ROUTE_RECEIPT_MAX_FUTURE_SKEW_MS ||
        (raw.provider === "grok" && raw.transport !== "cli") ||
        !routeAttemptReceiptMatches(raw as SubscriptionRouteAttemptEvidence)) {
      return null;
    }
    attempts.push(raw as SubscriptionRouteAttemptEvidence);
  }
  return { schemaVersion: "gloops.subscription-route-evidence.v1", attempts };
}

export function evaluateSubscriptionRouteAdmission(
  adapterType: string,
  context: Record<string, unknown>,
  now: string | Date = new Date(),
  model?: string | null,
): SubscriptionRouteAdmission {
  const normalizedAdapterType = adapterType.trim().toLowerCase();
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  const durableCodexProvider: SubscriptionRouteProvider | null = normalizedAdapterType === "codex_local"
    ? normalizedModel === "gpt-5.6-luna"
      ? "luna"
      : normalizedModel === "gpt-5.6-terra"
        ? "terra"
        : null
    : null;
  const provider: SubscriptionRouteProvider | null = normalizedAdapterType === "hermes_gateway" || normalizedAdapterType === "hermes_local"
    ? "ollama"
    : durableCodexProvider
      ? durableCodexProvider
    : normalizedAdapterType === "grok_local"
      ? "grok"
      : normalizedAdapterType === "codex_local"
        ? "codex"
        : null;
  if (!provider) {
    const resemblesProtectedRoute = /(ollama|hermes|grok|xai|codex|openai)/.test(normalizedAdapterType);
    if (resemblesProtectedRoute || DISALLOWED_AUTONOMOUS_MODEL_ADAPTERS.has(normalizedAdapterType)) {
      return {
        allowed: false,
        provider: null,
        reason: `${adapterType} denied: autonomous model adapter is outside the durable Luna/Terra bench and bounded Grok/Codex burst lanes`,
      };
    }
    return { allowed: true, provider: null, reason: "non-model adapter is outside the subscription route chain" };
  }
  const currentTime = typeof now === "string" ? Date.parse(now) : now.getTime();
  const evidence = Number.isFinite(currentTime)
    ? readSubscriptionRouteEvidence(context[PAPERCLIP_PROVIDER_ROUTE_EVIDENCE_KEY], currentTime)
    : null;
  const contextIssueId = typeof context.issueId === "string" ? context.issueId.trim() : "";
  const exhaustedPool = evidence?.attempts.find((attempt) =>
    (!contextIssueId || attempt.issueId === contextIssueId)
    && subscriptionBillingPool(attempt.provider) === subscriptionBillingPool(provider)
    && (attempt.reason === "quota_exhausted" || attempt.reason === "provider_unavailable")
  );
  if (exhaustedPool) {
    return {
      allowed: false,
      provider,
      reason: `${provider} denied: billing pool ${subscriptionBillingPool(provider)} already failed via ${exhaustedPool.provider}`,
    };
  }
  if (provider === "ollama") {
    return { allowed: true, provider, reason: "Ollama/Hermes is optional supplemental capacity, not a prerequisite" };
  }
  if (provider === "luna" || provider === "terra") {
    return { allowed: true, provider, reason: `${provider} is durable workforce capacity` };
  }
  const durableAttempt = evidence?.attempts.find((attempt) =>
    (!contextIssueId || attempt.issueId === contextIssueId) &&
    (attempt.provider === "luna" || attempt.provider === "terra" || attempt.provider === "ollama"));
  if (!durableAttempt) {
    return {
      allowed: false,
      provider,
      reason: `${provider} burst denied: missing typed terminal route receipt from Luna, Terra, or supplemental Ollama capacity`,
    };
  }
  return {
    allowed: true,
    provider,
    reason: `${provider} burst admitted after typed ${durableAttempt.provider} terminal route evidence`,
  };
}

function splitPhaseTotal(total: number): Record<ExecutionBudgetPhase, number> {
  const phases = Object.keys(EXECUTION_PHASE_SHARES) as ExecutionBudgetPhase[];
  const allocation = Object.fromEntries(phases.map((phase) => [
    phase,
    Math.floor(total * EXECUTION_PHASE_SHARES[phase] / 100),
  ])) as Record<ExecutionBudgetPhase, number>;
  let remainder = total - phases.reduce((sum, phase) => sum + allocation[phase], 0);
  for (const phase of ["closeout", "verify", "implement", "plan"] as ExecutionBudgetPhase[]) {
    if (remainder <= 0) break;
    allocation[phase] += 1;
    remainder -= 1;
  }
  return allocation;
}

export function buildExecutionPhaseBudgetPlan(input: {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  toolCalls: number;
  wallMs: number;
}): ExecutionPhaseBudgetPlan {
  const dimensions = {
    inputTokens: splitPhaseTotal(input.inputTokens),
    outputTokens: splitPhaseTotal(input.outputTokens),
    turns: splitPhaseTotal(input.turns),
    toolCalls: splitPhaseTotal(input.toolCalls),
    wallMs: splitPhaseTotal(input.wallMs),
  };
  return Object.fromEntries((Object.keys(EXECUTION_PHASE_SHARES) as ExecutionBudgetPhase[]).map((phase) => [
    phase,
    Object.fromEntries(Object.entries(dimensions).map(([name, values]) => [
      name,
      (values as Record<ExecutionBudgetPhase, number>)[phase],
    ])),
  ])) as ExecutionPhaseBudgetPlan;
}

export function renderExecutionPhaseBudgetPlan(budget: ExecutionInvocationBudget | null | undefined): string | null {
  if (!budget?.phasePlan) return null;
  return [
    "Completion-aware execution budget:",
    "- Plan/discovery: 15%; implementation: 55%; verification: 20%; closeout: 10%.",
    "- Do not borrow from closeout. If another phase exhausts its share, checkpoint and preserve the closeout share.",
    `- Exact phase ceilings: ${JSON.stringify(budget.phasePlan)}`,
  ].join("\n");
}

export type BoundExecutionContext = {
  schemaVersion: typeof EXECUTION_CONTEXT_BINDING_SCHEMA;
  packet: Record<string, unknown> & {
    schemaVersion: typeof CONTINUATION_PACKET_SCHEMA;
    digest: string;
    metrics: { serializedBytes: number; approximateTokens: number };
  };
  digest: string;
  serializedBytes: number;
  approximateTokens: number;
  cacheIdentity: string;
  excludedLegacyContext: string[];
};

export type CanonicalContinuationPacketInput = {
  issue: {
    id: string;
    identifier?: string | null;
    title: string;
    /** Issue objective / description text; bounded into work.objective. */
    objective?: string | null;
    status?: string | null;
    priority?: string | null;
    workMode?: string | null;
    projectId?: string | null;
    goalId?: string | null;
    parentId?: string | null;
  };
  ancestors?: Array<{
    id: string;
    identifier?: string | null;
    title?: string | null;
    status?: string | null;
    priority?: string | null;
  }>;
  repoRef: {
    repoUrl?: string | null;
    repoRef?: string | null;
    cwd?: string | null;
    workspaceId?: string | null;
  };
  authority: {
    companyId: string;
    assigneeAgentId?: string | null;
    responsibleUserId?: string | null;
    runId?: string | null;
  };
  verification?: {
    exactHeadSha?: string | null;
    cursor?: string | null;
    checks?: string[];
  };
  continuation?: {
    summary?: string | null;
    next?: string | null;
  };
  executionBudget?: unknown;
};

export type ExecutionTruthTransition = "ready" | "completed" | "retry" | "reroute" | "escalate";
export type ExecutionTruthGateDecision = {
  allowed: boolean;
  reason: null | "missing_receipt" | "invalid_receipt" | "work_mismatch" |
    "budget_exhausted" | "prohibited_provider_path" | "continuation_unbound" |
    "head_unverified" | "checks_incomplete" | "review_incomplete" |
    "human_authority_required" | "non_terminal_status";
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const GROK_API_PATH = /(^|[^a-z])(grok|xai|x\.ai)([^a-z]|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function canonicalSerialize(value: unknown) {
  return JSON.stringify(stable(value));
}

function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function packetBody(packet: Record<string, unknown>) {
  const { digest: _digest, metrics: _metrics, ...body } = packet;
  return body;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compactRecord(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
}

function boundedString(value: string | null | undefined, maxBytes: number) {
  const text = readString(value);
  if (!text) return null;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let output = "";
  for (const char of text) {
    const next = output + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes - 48) break;
    output = next;
  }
  return `${output}\n[truncated to ${maxBytes} bytes]`;
}

function digestPacketBody(body: Record<string, unknown>) {
  let serializedBytes = 1;
  let candidate: Record<string, unknown> = {};
  for (let index = 0; index < 16; index += 1) {
    candidate = {
      ...body,
      digest: digest(body),
      metrics: {
        serializedBytes,
        approximateTokens: Math.ceil(serializedBytes / 4),
      },
    };
    const nextSerializedBytes = Buffer.byteLength(canonicalSerialize(candidate), "utf8");
    if (nextSerializedBytes === serializedBytes) break;
    serializedBytes = nextSerializedBytes;
  }
  candidate = {
    ...body,
    digest: digest(body),
    metrics: {
      serializedBytes,
      approximateTokens: Math.ceil(serializedBytes / 4),
    },
  };
  return candidate;
}

export function buildCanonicalContinuationPacket(input: CanonicalContinuationPacketInput) {
  const issueLabel = readString(input.issue.identifier) ?? input.issue.id;
  const exactHeadSha = readString(input.verification?.exactHeadSha) ??
    (readString(input.repoRef.repoRef)?.match(SHA) ? readString(input.repoRef.repoRef) : null);
  const body = compactRecord({
    schemaVersion: CONTINUATION_PACKET_SCHEMA,
    work: compactRecord({
      id: issueLabel,
      issueId: input.issue.id,
      identifier: readString(input.issue.identifier),
      title: input.issue.title,
      objective: boundedString(input.issue.objective, 4_000),
      status: readString(input.issue.status),
      priority: readString(input.issue.priority),
      workMode: readString(input.issue.workMode),
    }),
    scope: compactRecord({
      companyId: input.authority.companyId,
      issueId: input.issue.id,
      projectId: readString(input.issue.projectId),
      goalId: readString(input.issue.goalId),
      parentId: readString(input.issue.parentId),
      ancestors: (input.ancestors ?? []).slice(0, 8).map((ancestor) => compactRecord({
        id: ancestor.id,
        identifier: readString(ancestor.identifier),
        title: readString(ancestor.title),
        status: readString(ancestor.status),
        priority: readString(ancestor.priority),
      })),
    }),
    repoRef: compactRecord({
      repoUrl: readString(input.repoRef.repoUrl),
      repoRef: readString(input.repoRef.repoRef),
      exactHeadSha,
      cwd: readString(input.repoRef.cwd),
      workspaceId: readString(input.repoRef.workspaceId),
    }),
    authority: compactRecord({
      companyId: input.authority.companyId,
      assigneeAgentId: readString(input.authority.assigneeAgentId),
      responsibleUserId: readString(input.authority.responsibleUserId),
      runId: readString(input.authority.runId),
      source: "paperclip-control-plane",
    }),
    verification: compactRecord({
      exactHeadSha,
      cursor: readString(input.verification?.cursor) ?? "run focused verification and record results before terminal disposition",
      checks: (input.verification?.checks ?? []).filter((entry) => readString(entry)).slice(0, 8),
    }),
    continuation: compactRecord({
      summary: boundedString(input.continuation?.summary, 6_000),
      next: boundedString(input.continuation?.next, 1_000) ?? "continue from the issue objective and verification cursor",
    }),
    executionBudget: isRecord(input.executionBudget) ? input.executionBudget : null,
  });
  const packet = digestPacketBody(body);
  const bound = buildBoundExecutionContext(packet);
  return bound.packet;
}

export function readBoundExecutionContext(value: unknown): BoundExecutionContext | null {
  if (!isRecord(value) || value.schemaVersion !== EXECUTION_CONTEXT_BINDING_SCHEMA) return null;
  if (!isRecord(value.packet) || value.packet.schemaVersion !== CONTINUATION_PACKET_SCHEMA) return null;
  if (!isRecord(value.packet.metrics)) return null;
  const packetDigest = value.packet.digest;
  const serializedBytes = value.packet.metrics.serializedBytes;
  const approximateTokens = value.packet.metrics.approximateTokens;
  if (typeof packetDigest !== "string" || !SHA256.test(packetDigest) ||
      !positiveInteger(serializedBytes) || serializedBytes > 16_000 ||
      !positiveInteger(approximateTokens) || approximateTokens !== Math.ceil(serializedBytes / 4)) return null;
  if (Buffer.byteLength(canonicalSerialize(value.packet)) !== serializedBytes) return null;
  if (digest(packetBody(value.packet)) !== packetDigest) return null;
  if (value.digest !== packetDigest || value.serializedBytes !== serializedBytes ||
      value.approximateTokens !== approximateTokens || value.cacheIdentity !== packetDigest) return null;
  if (!Array.isArray(value.excludedLegacyContext) ||
      !value.excludedLegacyContext.every((entry) => typeof entry === "string") ||
      new Set(value.excludedLegacyContext).size !== value.excludedLegacyContext.length) return null;
  return value as BoundExecutionContext;
}

export function buildBoundExecutionContext(packet: unknown): BoundExecutionContext {
  if (!isRecord(packet) || !isRecord(packet.metrics)) throw new Error("Continuation packet is missing required metrics");
  const candidate = {
    schemaVersion: EXECUTION_CONTEXT_BINDING_SCHEMA,
    packet,
    digest: packet.digest,
    serializedBytes: packet.metrics.serializedBytes,
    approximateTokens: packet.metrics.approximateTokens,
    cacheIdentity: packet.digest,
    excludedLegacyContext: ["paperclipTaskMarkdown", "paperclipContinuationSummary", "paperclipSessionHandoffMarkdown", "resumedSessionTranscript"],
  };
  const parsed = readBoundExecutionContext(candidate);
  if (!parsed) throw new Error("Continuation packet failed execution-context binding validation");
  return parsed;
}

export function renderBoundExecutionContext(binding: BoundExecutionContext): string {
  return [
    "# Bound continuation packet", "", `- Digest: ${binding.digest}`,
    `- Serialized bytes: ${binding.serializedBytes}`,
    `- Approximate tokens: ${binding.approximateTokens}`,
    `- Cache identity: ${binding.cacheIdentity}`,
    "- Legacy transcript/task context excluded: yes", "",
    "The JSON below is the sole recovery work body. Follow its authority, exact head, verification state, and next cursor.",
    "", "```json", canonicalSerialize(binding.packet), "```",
  ].join("\n");
}

export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(Buffer.byteLength(prompt, "utf8") / 4);
}

export function assertPromptFitsInvocationBudget(prompt: string, budget: ExecutionInvocationBudget | null | undefined) {
  if (!budget) return;
  const estimatedInputTokens = estimatePromptTokens(prompt);
  if (estimatedInputTokens <= budget.maxInputTokens) return;
  const error = new Error(`Provider invocation refused before dispatch: estimated input ${estimatedInputTokens} exceeds reserved ${budget.maxInputTokens}`) as Error & { code?: string };
  error.code = "execution_admission.input_reservation_exceeded";
  throw error;
}

function containsProviderRouteField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProviderRouteField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, entry]) => {
    const normalizedChildKey = childKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    return /(provider|model|baseurl|endpoint|transport|path|apikey|apiurl|credential|token|extraargs|cliargs|arguments)/.test(normalizedChildKey) ||
      containsProviderRouteField(entry);
  });
}

export function hasProhibitedGrokApiConfiguration(value: unknown, key = ""): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (typeof value === "string") {
    const normalizedValue = value.toLowerCase().replace(/[^a-z0-9.:/-]/g, "");
    const compactValue = normalizedValue.replace(/[^a-z0-9]/g, "");
    const routeField = /(provider|model|baseurl|endpoint|transport|path|apikey|apiurl|extraargs|cliargs|arguments)/.test(normalizedKey);
    return routeField && (
      compactValue.includes("grok") ||
      compactValue.includes("xai") ||
      normalizedValue.includes("api.x.ai")
    );
  }
  if (Array.isArray(value)) return value.some((entry) => hasProhibitedGrokApiConfiguration(entry, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([childKey, entry]) => {
    const normalizedChildKey = childKey.toLowerCase().replace(/[^a-z0-9]/g, "");
    if ((normalizedChildKey.includes("grok") || normalizedChildKey.includes("xai")) &&
        /(api|key|base|url|provider|model)/.test(normalizedChildKey)) return true;
    if ((normalizedChildKey === "grok" || normalizedChildKey === "xai") && containsProviderRouteField(entry)) return true;
    return hasProhibitedGrokApiConfiguration(entry, childKey);
  });
}

function readReceipt(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== OPERATOR_RECEIPT_SCHEMA) return null;
  if (!isRecord(value.work) || typeof value.work.id !== "string") return null;
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) return null;
  const { digest: _receiptDigest, ...body } = value;
  if (digest(body) !== value.digest) return null;
  if (!isRecord(value.budget) || !Array.isArray(value.budget.exhausted) ||
      !value.budget.exhausted.every((entry) => typeof entry === "string") ||
      !isRecord(value.route) || !Array.isArray(value.route.observedPathIds) ||
      value.route.observedPathIds.length === 0 ||
      !value.route.observedPathIds.every((entry) => typeof entry === "string" && entry.length > 0) ||
      new Set(value.route.observedPathIds).size !== value.route.observedPathIds.length ||
      typeof value.route.prohibitedPathObserved !== "boolean" ||
      !isRecord(value.continuation) || typeof value.continuation.required !== "boolean" ||
      (value.continuation.required === true && typeof value.continuation.valid !== "boolean") ||
      !isRecord(value.verification) || !isRecord(value.authority) ||
      typeof value.authority.humanRequired !== "boolean") return null;
  return value;
}

function hasAmbiguousGrokApiPath(route: Record<string, unknown>) {
  if (route.prohibitedPathObserved === true) return true;
  return (Array.isArray(route.observedPathIds) ? route.observedPathIds : []).some((path) =>
    typeof path !== "string" || (path !== "grok-build-cli" && GROK_API_PATH.test(path)),
  );
}

export function evaluateExecutionTruthTransition(input: { transition: ExecutionTruthTransition; workId: string; receipt: unknown }): ExecutionTruthGateDecision {
  if (input.receipt === null || input.receipt === undefined) return { allowed: false, reason: "missing_receipt" };
  const receipt = readReceipt(input.receipt);
  if (!receipt) return { allowed: false, reason: "invalid_receipt" };
  if ((receipt.work as Record<string, unknown>).id !== input.workId) return { allowed: false, reason: "work_mismatch" };
  if (((receipt.budget as Record<string, unknown>).exhausted as unknown[]).length > 0) return { allowed: false, reason: "budget_exhausted" };
  if (hasAmbiguousGrokApiPath(receipt.route as Record<string, unknown>)) return { allowed: false, reason: "prohibited_provider_path" };
  if ((receipt.continuation as Record<string, unknown>).required === true && (receipt.continuation as Record<string, unknown>).valid !== true) {
    return { allowed: false, reason: "continuation_unbound" };
  }
  if (input.transition === "ready" || input.transition === "completed") {
    const verification = receipt.verification as Record<string, unknown>;
    if (verification.exactHeadAligned !== true || typeof verification.exactHeadSha !== "string" || !SHA.test(verification.exactHeadSha)) {
      return { allowed: false, reason: "head_unverified" };
    }
    if (verification.allChecksPassed !== true) return { allowed: false, reason: "checks_incomplete" };
    const review = isRecord(verification.review) ? verification.review : {};
    if (review.status !== "accepted" || review.headSha !== verification.exactHeadSha || review.unresolvedThreads !== 0) {
      return { allowed: false, reason: "review_incomplete" };
    }
    if (receipt.status !== "built" && receipt.status !== "operational" && receipt.status !== "proven") {
      return { allowed: false, reason: "non_terminal_status" };
    }
  }
  if ((receipt.authority as Record<string, unknown>).humanRequired === true) return { allowed: false, reason: "human_authority_required" };
  return { allowed: true, reason: null };
}

export function buildExecutionRetryReceipt(input: {
  workId: string;
  routePathIds: string[];
  continuationValid: boolean;
  budgetExhausted?: string[];
}) {
  const body = {
    schemaVersion: OPERATOR_RECEIPT_SCHEMA,
    work: { id: input.workId },
    budget: { exhausted: input.budgetExhausted ?? [] },
    route: {
      observedPathIds: input.routePathIds,
      prohibitedPathObserved: input.routePathIds.some((path) => path !== "grok-build-cli" && GROK_API_PATH.test(path)),
    },
    continuation: { required: true, valid: input.continuationValid },
    verification: {},
    authority: { humanRequired: false },
    status: "built",
    projection: { source: "paperclip-control-plane", purpose: "bounded_retry" },
  };
  return { ...body, digest: digest(body) };
}
