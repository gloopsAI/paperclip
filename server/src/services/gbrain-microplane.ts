/**
 * GBrain micro-plane foundation (OK-09).
 *
 * Episodes → failure fingerprints → context compile v0 for implementer/reviewer.
 * Advisory only — cannot change authority or promote binding policy.
 *
 * Hard rules:
 * - ContextPacket is advisory (packet.advisory === true always).
 * - Never emit bindingPolicy / authorityGrant / policy-promotion fields.
 * - knownFailures capped at 3.
 * - tokenBudget enforced approximately by truncating advisory fields only.
 */

import { createHash, randomUUID } from "node:crypto";

export const WORK_EPISODE_SCHEMA = "gloops.work-episode.v1" as const;
export const FAILURE_FINGERPRINT_SCHEMA = "gloops.failure-fingerprint.v1" as const;
export const CONTEXT_PACKET_SCHEMA = "gloops.context-packet.v1" as const;

/** Max known failure fingerprints included in a compiled context packet. */
export const MAX_KNOWN_FAILURES = 3;

/** Default approximate token budget for context compile v0. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 4_000;

/**
 * Keys that must never appear on a ContextPacket (or nested objects).
 * Presence of any of these means the packet is no longer purely advisory.
 */
export const FORBIDDEN_AUTHORITY_KEYS = [
  "bindingPolicy",
  "authorityGrant",
  "authorityGrants",
  "policyPromotion",
  "promotePolicy",
  "promotedPolicy",
  "grantedAuthority",
  "grantAuthority",
  "bindingRules",
  "authorityMutation",
  "mutateAuthority",
  "policyOverride",
  "overridePolicy",
  "silentPromotion",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkEpisodeSubject = {
  companyId?: string | null;
  issueId?: string | null;
  runId?: string | null;
  workOrderId?: string | null;
  projectId?: string | null;
};

export type WorkEpisodeEvent = {
  kind: string;
  at?: string | null;
  summary?: string | null;
  tool?: string | null;
  errorCode?: string | null;
  meta?: Record<string, unknown> | null;
};

export type WorkEpisodeOutcome = {
  kind: string;
  summary?: string | null;
  artifactRef?: string | null;
};

export type WorkEpisodeTokens = {
  input?: number | null;
  output?: number | null;
  cachedInput?: number | null;
  uncachedInput?: number | null;
  total?: number | null;
};

/**
 * Envelope for one admitted work unit: start, terminal events, outcomes,
 * artifacts, failures, and human interventions.
 */
export type WorkEpisode = {
  schemaVersion: typeof WORK_EPISODE_SCHEMA;
  id: string;
  subject: WorkEpisodeSubject;
  role: string;
  modelRoute: string | null;
  events: WorkEpisodeEvent[];
  outcomes: WorkEpisodeOutcome[];
  tokens: WorkEpisodeTokens;
  startedAt: string | null;
  terminatedAt: string | null;
  createdAt: string;
  /** Episodes are observational; they never grant authority. */
  advisory: true;
};

/**
 * Stable, advisory failure identity used for clustering and context compile.
 * Never auto-promotes recovery into binding policy.
 */
export type FailureFingerprint = {
  schemaVersion: typeof FAILURE_FINGERPRINT_SCHEMA;
  key: string;
  errorCode: string;
  messageNorm: string;
  tool: string | null;
  stage: string | null;
  advisory: true;
  recoveryHint?: string | null;
};

export type ContextAnchor = {
  kind: string;
  ref: string;
  label?: string | null;
};

export type ContextAuthority = {
  companyId?: string | null;
  issueId?: string | null;
  runId?: string | null;
  assigneeAgentId?: string | null;
  /** implementer | reviewer | other — descriptive only, not a grant. */
  role?: string | null;
};

export type ContextContinuation = {
  cursor?: string | null;
  checkpointTurn?: number | null;
  next?: string | null;
};

/**
 * Caller-supplied compile request (goal + scope framing).
 * Additional memory inputs (facts/fingerprints/decisions) are passed separately.
 */
export type ContextCompileRequest = {
  goal: string;
  scope?: string[] | null;
  nonGoals?: string[] | null;
  acceptance?: string[] | null;
  anchors?: Array<ContextAnchor | string> | null;
  authority?: ContextAuthority | null;
  continuation?: ContextContinuation | null;
};

export type ContextPacketProvenance = {
  compiledAt: string;
  sources: string[];
  tokenBudget: number;
  estimatedTokens: number;
  truncated: boolean;
};

/**
 * Context compile v0 packet for implementer/reviewer.
 * Advisory only — never includes authority-change fields.
 */
export type ContextPacket = {
  schemaVersion: typeof CONTEXT_PACKET_SCHEMA;
  advisory: true;
  goal: string;
  scope: string[];
  nonGoals: string[];
  acceptance: string[];
  anchors: ContextAnchor[];
  /** Descriptive authority context (ids/roles) — not a grant. */
  authority: ContextAuthority;
  knownFailures: FailureFingerprint[];
  continuation: ContextContinuation;
  facts: string[];
  decisions: string[];
  provenance: ContextPacketProvenance;
};

// Compile-time guards: ContextPacket must not admit forbidden authority keys.
type AssertNeverKey<T, K extends string> = K extends keyof T ? never : true;
type _NoBindingPolicy = AssertNeverKey<ContextPacket, "bindingPolicy">;
type _NoAuthorityGrant = AssertNeverKey<ContextPacket, "authorityGrant">;
type _NoPolicyPromotion = AssertNeverKey<ContextPacket, "policyPromotion">;
const _typeGuards: [
  _NoBindingPolicy,
  _NoAuthorityGrant,
  _NoPolicyPromotion,
] = [true, true, true];
void _typeGuards;

export type BuildWorkEpisodeInput = {
  subject: WorkEpisodeSubject;
  role: string;
  modelRoute?: string | null;
  events?: WorkEpisodeEvent[] | null;
  outcomes?: WorkEpisodeOutcome[] | null;
  tokens?: WorkEpisodeTokens | null;
  id?: string | null;
  startedAt?: string | null;
  terminatedAt?: string | null;
  createdAt?: string | null;
};

export type NormalizeFailureFingerprintInput = {
  errorCode: string;
  message: string;
  tool?: string | null;
  stage?: string | null;
  recoveryHint?: string | null;
};

export type CompileContextSources = {
  facts?: string[] | null;
  fingerprints?: FailureFingerprint[] | null;
  decisions?: string[] | null;
  tokenBudget?: number | null;
  sources?: string[] | null;
  compiledAt?: string | null;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ContextPacketAuthorityError extends Error {
  readonly code = "gbrain.context.authority_forbidden" as const;
  readonly keys: string[];

  constructor(keys: string[]) {
    super(
      `Context packet must not include authority-change fields: ${keys.join(", ")}`,
    );
    this.name = "ContextPacketAuthorityError";
    this.keys = keys;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MAX_EVENTS = 64;
const MAX_OUTCOMES = 32;
const MAX_SCOPE = 24;
const MAX_NON_GOALS = 16;
const MAX_ACCEPTANCE = 16;
const MAX_ANCHORS = 16;
const MAX_FACTS = 24;
const MAX_DECISIONS = 16;
const MAX_SOURCES = 16;

const BOUND = {
  role: 128,
  modelRoute: 256,
  kind: 64,
  summary: 500,
  tool: 128,
  errorCode: 128,
  stage: 128,
  messageNorm: 400,
  recoveryHint: 300,
  artifactRef: 512,
  goal: 2_000,
  scopeItem: 400,
  nonGoal: 300,
  acceptance: 400,
  fact: 500,
  decision: 500,
  anchorKind: 64,
  anchorRef: 512,
  anchorLabel: 200,
  id: 128,
  cursor: 256,
  next: 1_000,
  source: 256,
} as const;

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function boundedString(value: unknown, maxChars: number): string | null {
  const text = nonEmpty(value);
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32))}\n[truncated]`;
}

function requiredBoundedString(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  const text = boundedString(value, maxChars);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function optionalNonNegativeInt(
  value: unknown,
  field: string,
): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function optionalId(value: unknown): string | null {
  return boundedString(value, BOUND.id);
}

function compactRecord<T extends Record<string, unknown>>(
  record: T,
): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Approximate token count: ~4 chars per token (industry-standard heuristic).
 * Used only for budget enforcement, not billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return estimateTokens(String(value));
  }
}

/**
 * Normalize free text for stable fingerprinting:
 * lower-case, collapse whitespace, strip UUIDs / long hex / absolute paths / numbers.
 */
export function normalizeMessageForFingerprint(message: string): string {
  let text = message.trim().toLowerCase();
  // UUIDs
  text = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>",
  );
  // Long hex digests
  text = text.replace(/\b[0-9a-f]{16,}\b/gi, "<hex>");
  // Absolute / home paths
  text = text.replace(/(?:\/[\w.-]+){2,}/g, "<path>");
  // Numbers (line numbers, ports, counts)
  text = text.replace(/\b\d+\b/g, "<n>");
  // Collapse whitespace + punctuation runs
  text = text.replace(/\s+/g, " ").replace(/[^\w\s<>._:-]+/g, " ").trim();
  text = text.replace(/\s+/g, " ");
  if (text.length > BOUND.messageNorm) {
    text = text.slice(0, BOUND.messageNorm);
  }
  return text;
}

function normalizeToken(value: unknown, maxChars: number): string | null {
  const text = nonEmpty(value);
  if (!text) return null;
  const norm = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxChars);
  return norm.length > 0 ? norm : null;
}

function requiredToken(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  const token = normalizeToken(value, maxChars);
  if (!token) {
    throw new Error(`${field} is required`);
  }
  return token;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function normalizeEvent(raw: WorkEpisodeEvent): WorkEpisodeEvent {
  const kind = requiredBoundedString(raw.kind, "events.kind", BOUND.kind);
  return compactRecord({
    kind,
    at: nonEmpty(raw.at) ?? null,
    summary: boundedString(raw.summary, BOUND.summary),
    tool: boundedString(raw.tool, BOUND.tool),
    errorCode: boundedString(raw.errorCode, BOUND.errorCode),
    meta:
      raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
        ? (raw.meta as Record<string, unknown>)
        : null,
  }) as WorkEpisodeEvent;
}

function normalizeOutcome(raw: WorkEpisodeOutcome): WorkEpisodeOutcome {
  const kind = requiredBoundedString(raw.kind, "outcomes.kind", BOUND.kind);
  return compactRecord({
    kind,
    summary: boundedString(raw.summary, BOUND.summary),
    artifactRef: boundedString(raw.artifactRef, BOUND.artifactRef),
  }) as WorkEpisodeOutcome;
}

function normalizeTokens(raw: WorkEpisodeTokens | null | undefined): WorkEpisodeTokens {
  if (!raw) return {};
  return compactRecord({
    input: optionalNonNegativeInt(raw.input, "tokens.input"),
    output: optionalNonNegativeInt(raw.output, "tokens.output"),
    cachedInput: optionalNonNegativeInt(raw.cachedInput, "tokens.cachedInput"),
    uncachedInput: optionalNonNegativeInt(
      raw.uncachedInput,
      "tokens.uncachedInput",
    ),
    total: optionalNonNegativeInt(raw.total, "tokens.total"),
  }) as WorkEpisodeTokens;
}

function normalizeAnchor(raw: ContextAnchor | string): ContextAnchor {
  if (typeof raw === "string") {
    const ref = requiredBoundedString(raw, "anchors.ref", BOUND.anchorRef);
    return { kind: "ref", ref };
  }
  const kind = requiredBoundedString(
    raw.kind,
    "anchors.kind",
    BOUND.anchorKind,
  );
  const ref = requiredBoundedString(raw.ref, "anchors.ref", BOUND.anchorRef);
  const label = boundedString(raw.label, BOUND.anchorLabel);
  return compactRecord({ kind, ref, label }) as ContextAnchor;
}

function stringList(
  values: unknown,
  field: string,
  maxItems: number,
  maxChars: number,
): string[] {
  if (values == null) return [];
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array`);
  }
  const out: string[] = [];
  for (const item of values) {
    if (out.length >= maxItems) break;
    const text = boundedString(item, maxChars);
    if (text) out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a WorkEpisode envelope for an admitted work unit.
 */
export function buildWorkEpisode(input: BuildWorkEpisodeInput): WorkEpisode {
  if (!input || typeof input !== "object") {
    throw new Error("buildWorkEpisode input is required");
  }
  const role = requiredBoundedString(input.role, "role", BOUND.role);
  const subject = input.subject ?? {};
  if (typeof subject !== "object" || Array.isArray(subject)) {
    throw new Error("subject must be an object");
  }

  const eventsRaw = input.events ?? [];
  if (!Array.isArray(eventsRaw)) {
    throw new Error("events must be an array");
  }
  const outcomesRaw = input.outcomes ?? [];
  if (!Array.isArray(outcomesRaw)) {
    throw new Error("outcomes must be an array");
  }

  const events = eventsRaw.slice(0, MAX_EVENTS).map(normalizeEvent);
  const outcomes = outcomesRaw.slice(0, MAX_OUTCOMES).map(normalizeOutcome);

  const startedAt =
    nonEmpty(input.startedAt) ??
    events.find((e) => e.at)?.at ??
    null;
  const terminatedAt = nonEmpty(input.terminatedAt) ?? null;
  const createdAt = nonEmpty(input.createdAt) ?? new Date().toISOString();

  return {
    schemaVersion: WORK_EPISODE_SCHEMA,
    id: nonEmpty(input.id) ?? randomUUID(),
    subject: compactRecord({
      companyId: optionalId(subject.companyId),
      issueId: optionalId(subject.issueId),
      runId: optionalId(subject.runId),
      workOrderId: optionalId(subject.workOrderId),
      projectId: optionalId(subject.projectId),
    }) as WorkEpisodeSubject,
    role,
    modelRoute: boundedString(input.modelRoute, BOUND.modelRoute),
    events,
    outcomes,
    tokens: normalizeTokens(input.tokens),
    startedAt,
    terminatedAt,
    createdAt,
    advisory: true,
  };
}

/**
 * Normalize a failure into a stable fingerprint key for clustering / context.
 * Returns a full FailureFingerprint record (advisory).
 */
export function normalizeFailureFingerprint(
  input: NormalizeFailureFingerprintInput,
): FailureFingerprint {
  if (!input || typeof input !== "object") {
    throw new Error("normalizeFailureFingerprint input is required");
  }
  const errorCode = requiredToken(input.errorCode, "errorCode", BOUND.errorCode);
  const messageRaw = nonEmpty(input.message);
  if (!messageRaw) {
    throw new Error("message is required");
  }
  const messageNorm = normalizeMessageForFingerprint(messageRaw);
  const tool = normalizeToken(input.tool, BOUND.tool);
  const stage = normalizeToken(input.stage, BOUND.stage);
  const recoveryHint = boundedString(input.recoveryHint, BOUND.recoveryHint);

  const msgHash = shortHash(messageNorm);
  // Stable, human-debuggable key. Same inputs → same key always.
  const key = [
    "v1",
    `error:${errorCode}`,
    `tool:${tool ?? "-"}`,
    `stage:${stage ?? "-"}`,
    `msg:${msgHash}`,
  ].join("|");

  return {
    schemaVersion: FAILURE_FINGERPRINT_SCHEMA,
    key,
    errorCode,
    messageNorm,
    tool,
    stage,
    advisory: true,
    ...(recoveryHint ? { recoveryHint } : {}),
  };
}

/**
 * Compile a budgeted ContextPacket for implementer/reviewer.
 *
 * Includes: goal, scope, nonGoals, acceptance, anchors, authority,
 * knownFailures (max 3), continuation, provenance.
 * Truncates advisory fields (facts, decisions, nonGoals, scope tails,
 * recovery hints) to approximately fit tokenBudget.
 * Never includes authority-change fields.
 */
export function compileContextPacket(
  req: ContextCompileRequest,
  sources: CompileContextSources = {},
): ContextPacket {
  if (!req || typeof req !== "object") {
    throw new Error("compileContextPacket request is required");
  }

  let goal = requiredBoundedString(req.goal, "goal", BOUND.goal);
  const tokenBudget =
    optionalNonNegativeInt(sources.tokenBudget, "tokenBudget") ??
    DEFAULT_CONTEXT_TOKEN_BUDGET;
  if (tokenBudget < 64) {
    throw new Error("tokenBudget must be at least 64");
  }

  let scope = stringList(req.scope, "scope", MAX_SCOPE, BOUND.scopeItem);
  let nonGoals = stringList(
    req.nonGoals,
    "nonGoals",
    MAX_NON_GOALS,
    BOUND.nonGoal,
  );
  const acceptance = stringList(
    req.acceptance,
    "acceptance",
    MAX_ACCEPTANCE,
    BOUND.acceptance,
  );

  const anchorsRaw = req.anchors ?? [];
  if (!Array.isArray(anchorsRaw)) {
    throw new Error("anchors must be an array");
  }
  const anchors = anchorsRaw
    .slice(0, MAX_ANCHORS)
    .map((a) => normalizeAnchor(a as ContextAnchor | string));

  const authorityIn = req.authority ?? {};
  if (typeof authorityIn !== "object" || Array.isArray(authorityIn)) {
    throw new Error("authority must be an object");
  }
  const authority: ContextAuthority = compactRecord({
    companyId: optionalId(authorityIn.companyId),
    issueId: optionalId(authorityIn.issueId),
    runId: optionalId(authorityIn.runId),
    assigneeAgentId: optionalId(authorityIn.assigneeAgentId),
    role: boundedString(authorityIn.role, BOUND.role),
  }) as ContextAuthority;

  const contIn = req.continuation ?? {};
  if (typeof contIn !== "object" || Array.isArray(contIn)) {
    throw new Error("continuation must be an object");
  }
  const continuation: ContextContinuation = compactRecord({
    cursor: boundedString(contIn.cursor, BOUND.cursor),
    checkpointTurn: optionalNonNegativeInt(
      contIn.checkpointTurn,
      "continuation.checkpointTurn",
    ),
    next: boundedString(contIn.next, BOUND.next),
  }) as ContextContinuation;

  // Fingerprints are advisory; cap at MAX_KNOWN_FAILURES.
  const fingerprintsRaw = sources.fingerprints ?? [];
  if (!Array.isArray(fingerprintsRaw)) {
    throw new Error("fingerprints must be an array");
  }
  let knownFailures: FailureFingerprint[] = fingerprintsRaw
    .slice(0, MAX_KNOWN_FAILURES)
    .map((fp) => {
      if (!fp || typeof fp !== "object") {
        throw new Error("fingerprint entries must be objects");
      }
      // Re-normalize to guarantee advisory + stable shape.
      return normalizeFailureFingerprint({
        errorCode: fp.errorCode,
        message: fp.messageNorm || fp.errorCode,
        tool: fp.tool,
        stage: fp.stage,
        recoveryHint: fp.recoveryHint,
      });
    });

  let facts = stringList(sources.facts, "facts", MAX_FACTS, BOUND.fact);
  let decisions = stringList(
    sources.decisions,
    "decisions",
    MAX_DECISIONS,
    BOUND.decision,
  );

  const provenanceSources = stringList(
    sources.sources ?? ["gbrain-microplane.v0"],
    "sources",
    MAX_SOURCES,
    BOUND.source,
  );
  const compiledAt =
    nonEmpty(sources.compiledAt) ?? new Date().toISOString();

  let truncated = false;

  const buildProbe = (): ContextPacket => ({
    schemaVersion: CONTEXT_PACKET_SCHEMA,
    advisory: true,
    goal,
    scope,
    nonGoals,
    acceptance,
    anchors,
    authority,
    knownFailures,
    continuation,
    facts,
    decisions,
    provenance: {
      compiledAt,
      sources: provenanceSources,
      tokenBudget,
      estimatedTokens: 0,
      truncated,
    },
  });

  const measure = () => estimateJsonTokens(buildProbe());

  // Truncate advisory fields until under budget (or nothing left to cut).
  // Order: recovery hints → facts → decisions → nonGoals tail → scope tail
  // → knownFailures tail → goal (last resort).
  let guard = 0;
  while (measure() > tokenBudget && guard < 200) {
    guard += 1;
    truncated = true;

    const withHint = knownFailures.findIndex((f) => f.recoveryHint);
    if (withHint >= 0) {
      const { recoveryHint: _drop, ...rest } = knownFailures[withHint]!;
      knownFailures = [
        ...knownFailures.slice(0, withHint),
        rest,
        ...knownFailures.slice(withHint + 1),
      ];
      continue;
    }

    if (facts.length > 0) {
      facts = facts.slice(0, -1);
      continue;
    }
    if (decisions.length > 0) {
      decisions = decisions.slice(0, -1);
      continue;
    }
    if (nonGoals.length > 0) {
      nonGoals = nonGoals.slice(0, -1);
      continue;
    }
    if (scope.length > 1) {
      scope = scope.slice(0, -1);
      continue;
    }
    if (knownFailures.length > 0) {
      knownFailures = knownFailures.slice(0, -1);
      continue;
    }
    if (goal.length > 64) {
      goal = `${goal.slice(0, Math.max(32, Math.floor(goal.length * 0.75)))}\n[truncated]`;
      continue;
    }
    break;
  }

  const packet = buildProbe();
  packet.provenance.estimatedTokens = estimateJsonTokens(packet);

  // Defense-in-depth: refuse any accidental authority-change fields.
  assertContextPacketIsAdvisory(packet);

  return packet;
}

/**
 * Ensure a context packet is purely advisory and contains no authority-change keys.
 * Throws ContextPacketAuthorityError if forbidden keys are present.
 */
export function assertContextPacketIsAdvisory(
  packet: unknown,
): asserts packet is ContextPacket {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("context packet must be an object");
  }

  const record = packet as Record<string, unknown>;
  if (record.advisory !== true) {
    throw new ContextPacketAuthorityError(["advisory!=true"]);
  }

  const found = findForbiddenKeys(packet);
  if (found.length > 0) {
    throw new ContextPacketAuthorityError(found);
  }
}

function findForbiddenKeys(
  value: unknown,
  path: string = "",
  found: string[] = [],
): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      findForbiddenKeys(value[i], `${path}[${i}]`, found);
    }
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      (FORBIDDEN_AUTHORITY_KEYS as readonly string[]).includes(key) ||
      /^(bindingPolicy|authorityGrant|policyPromotion|grantAuthority|promotePolicy)$/i.test(
        key,
      )
    ) {
      found.push(childPath);
    }
    findForbiddenKeys(child, childPath, found);
  }
  return found;
}
