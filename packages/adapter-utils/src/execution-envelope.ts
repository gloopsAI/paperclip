import { createHash } from "node:crypto";

export const EXECUTION_CONTEXT_BINDING_SCHEMA = "paperclip.execution-context-binding.v1" as const;
export const CONTINUATION_PACKET_SCHEMA = "gloops.continuation-packet.v1" as const;
export const OPERATOR_RECEIPT_SCHEMA = "gloops.execution-truth.operator-receipt.v2" as const;
export const PAPERCLIP_EXECUTION_CONTEXT_KEY = "paperclipExecutionContext" as const;
export const PAPERCLIP_EXECUTION_RECEIPT_KEY = "paperclipExecutionTruthReceipt" as const;

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
};

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
