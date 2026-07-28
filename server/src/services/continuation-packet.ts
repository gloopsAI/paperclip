/**
 * Structured continuation + escalation reset (OK-07).
 *
 * Goal: stop multi-million-token transcript resend on escalation.
 * Checkpoints capture structured state every N turns; escalations carry a
 * compact failure packet (intent, state, fingerprint, budget remainder) and
 * never the full conversation.
 *
 * Hard rules:
 * - EscalationPacket must not include transcript/messages/history fields.
 * - Packet size is gated by assertEscalationPacketSize (default 12_000 chars).
 * - Force-stop on turn cap, two-strike identical tool failures, or uncached
 *   token envelope exhaustion.
 */

export const CONTINUATION_CHECKPOINT_SCHEMA =
  "gloops.continuation-checkpoint.v1" as const;
export const ESCALATION_PACKET_SCHEMA =
  "gloops.escalation-packet.v1" as const;

/** Default hard cap for serialized escalation packets (characters). */
export const DEFAULT_ESCALATION_PACKET_MAX_CHARS = 12_000;

/** Two identical tool failures forces a stop / escalate. */
export const TWO_STRIKE_TOOL_FAILURES = 2;

/** Top-level keys that must never appear on an escalation packet. */
export const FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS = [
  "messages",
  "transcript",
  "conversation",
  "fullTranscript",
  "history",
  "chatHistory",
  "sessionTranscript",
  "resumedSessionTranscript",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContinuationUsage = {
  turns: number;
  uncachedTokens: number;
  cachedTokens?: number;
  totalTokens?: number;
  identicalToolFailures?: number;
};

export type ContinuationAnchor = {
  kind: string;
  ref: string;
  label?: string | null;
};

export type ContinuationCheckpoint = {
  schemaVersion: typeof CONTINUATION_CHECKPOINT_SCHEMA;
  turn: number;
  completed: string[];
  next: string | null;
  blocked: string | null;
  anchors: ContinuationAnchor[];
  usage: ContinuationUsage;
  createdAt: string;
};

export type EscalationAttempt = {
  /** Turn number when the attempt occurred, if known. */
  turn?: number | null;
  /** Compact summary of what was tried — never a transcript. */
  summary: string;
  tool?: string | null;
  errorCode?: string | null;
  at?: string | null;
};

export type EscalationAuthority = {
  companyId: string;
  issueId?: string | null;
  runId?: string | null;
  assigneeAgentId?: string | null;
  responsibleUserId?: string | null;
};

export type EscalationRemainingBudget = {
  turnsRemaining?: number | null;
  maxTurns?: number | null;
  uncachedTokensRemaining?: number | null;
  maxUncachedTokens?: number | null;
};

/**
 * Compact escalation packet. Intentionally excludes transcript fields
 * (`messages`, `transcript`, `conversation`, `history`, …). Callers must
 * escalate structured failure context only — never the full conversation.
 */
export type EscalationPacket = {
  schemaVersion: typeof ESCALATION_PACKET_SCHEMA;
  intent: string;
  currentState: string;
  attempts: EscalationAttempt[];
  failureFingerprint: string;
  nonGoals: string[];
  authority: EscalationAuthority;
  remainingBudget: EscalationRemainingBudget;
  requiredTerminalArtifact: string;
  createdAt: string;
};

// Compile-time guards: EscalationPacket must not admit transcript fields.
type AssertNeverKey<T, K extends string> = K extends keyof T ? never : true;
type _NoMessages = AssertNeverKey<EscalationPacket, "messages">;
type _NoTranscript = AssertNeverKey<EscalationPacket, "transcript">;
type _NoConversation = AssertNeverKey<EscalationPacket, "conversation">;
type _NoHistory = AssertNeverKey<EscalationPacket, "history">;
const _typeGuards: [
  _NoMessages,
  _NoTranscript,
  _NoConversation,
  _NoHistory,
] = [true, true, true, true];
void _typeGuards;

export type ForceStopReason =
  | "turn_cap"
  | "two_strike_tools"
  | "uncached_token_envelope";

export type ForceStopDecision = {
  stop: boolean;
  reasons: ForceStopReason[];
};

export type EscalationPacketSizeOk = {
  ok: true;
  chars: number;
  maxChars: number;
};

export type EscalationPacketSizeFail = {
  ok: false;
  error: string;
  chars: number;
  maxChars: number;
};

export type EscalationPacketSizeResult =
  | EscalationPacketSizeOk
  | EscalationPacketSizeFail;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EscalationPacketSizeError extends Error {
  readonly code = "escalation_packet.size_exceeded" as const;
  readonly chars: number;
  readonly maxChars: number;

  constructor(chars: number, maxChars: number) {
    super(
      `Escalation packet exceeds size cap: ${chars} > ${maxChars} chars`,
    );
    this.name = "EscalationPacketSizeError";
    this.chars = chars;
    this.maxChars = maxChars;
  }
}

export class EscalationPacketTranscriptError extends Error {
  readonly code = "escalation_packet.transcript_forbidden" as const;
  readonly keys: string[];

  constructor(keys: string[]) {
    super(
      `Escalation packet must not include transcript fields: ${keys.join(", ")}`,
    );
    this.name = "EscalationPacketTranscriptError";
    this.keys = keys;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MAX_COMPLETED = 32;
const MAX_ANCHORS = 16;
const MAX_ATTEMPTS = 8;
const MAX_NON_GOALS = 16;

const BOUND = {
  completed: 500,
  next: 1_000,
  blocked: 1_000,
  anchorKind: 64,
  anchorRef: 512,
  anchorLabel: 200,
  intent: 2_000,
  currentState: 4_000,
  attemptSummary: 500,
  attemptTool: 128,
  attemptErrorCode: 128,
  failureFingerprint: 256,
  nonGoal: 300,
  requiredTerminalArtifact: 500,
  companyId: 128,
  id: 128,
} as const;

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function boundedString(
  value: unknown,
  maxChars: number,
): string | null {
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

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function optionalNonNegativeInt(
  value: unknown,
  field: string,
): number | null {
  if (value == null) return null;
  return nonNegativeInt(value, field);
}

function compactRecord<T extends Record<string, unknown>>(
  value: T,
): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export type BuildContinuationCheckpointInput = {
  turn: number;
  completed: string[];
  next: string | null;
  blocked: string | null;
  anchors: Array<ContinuationAnchor | string>;
  usage: ContinuationUsage;
  /** Optional fixed clock for tests. Defaults to now. */
  createdAt?: string | Date;
};

/**
 * Build a structured continuation checkpoint (not a transcript dump).
 * Captures turn progress, anchors, and usage so a later wake can resume
 * without replaying the full conversation.
 */
export function buildContinuationCheckpoint(
  input: BuildContinuationCheckpointInput,
): ContinuationCheckpoint {
  const turn = nonNegativeInt(input.turn, "turn");
  if (!Array.isArray(input.completed)) {
    throw new Error("completed must be an array of strings");
  }
  if (!Array.isArray(input.anchors)) {
    throw new Error("anchors must be an array");
  }
  if (!input.usage || typeof input.usage !== "object") {
    throw new Error("usage is required");
  }

  const completed = input.completed
    .map((entry) => boundedString(entry, BOUND.completed))
    .filter((entry): entry is string => entry != null)
    .slice(0, MAX_COMPLETED);

  const anchors: ContinuationAnchor[] = input.anchors
    .slice(0, MAX_ANCHORS)
    .map((entry): ContinuationAnchor | null => {
      if (typeof entry === "string") {
        const ref = boundedString(entry, BOUND.anchorRef);
        if (!ref) return null;
        return { kind: "ref", ref };
      }
      if (!entry || typeof entry !== "object") return null;
      const kind =
        boundedString(entry.kind, BOUND.anchorKind) ?? "ref";
      const ref = boundedString(entry.ref, BOUND.anchorRef);
      if (!ref) return null;
      const label = boundedString(entry.label, BOUND.anchorLabel);
      return compactRecord({
        kind,
        ref,
        label: label ?? null,
      }) as ContinuationAnchor;
    })
    .filter((entry): entry is ContinuationAnchor => entry != null);

  const createdAt =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : nonEmpty(input.createdAt) ?? new Date().toISOString();

  return {
    schemaVersion: CONTINUATION_CHECKPOINT_SCHEMA,
    turn,
    completed,
    next: boundedString(input.next, BOUND.next),
    blocked: boundedString(input.blocked, BOUND.blocked),
    anchors,
    usage: {
      turns: nonNegativeInt(input.usage.turns, "usage.turns"),
      uncachedTokens: nonNegativeInt(
        input.usage.uncachedTokens,
        "usage.uncachedTokens",
      ),
      ...(input.usage.cachedTokens != null
        ? {
            cachedTokens: nonNegativeInt(
              input.usage.cachedTokens,
              "usage.cachedTokens",
            ),
          }
        : {}),
      ...(input.usage.totalTokens != null
        ? {
            totalTokens: nonNegativeInt(
              input.usage.totalTokens,
              "usage.totalTokens",
            ),
          }
        : {}),
      ...(input.usage.identicalToolFailures != null
        ? {
            identicalToolFailures: nonNegativeInt(
              input.usage.identicalToolFailures,
              "usage.identicalToolFailures",
            ),
          }
        : {}),
    },
    createdAt,
  };
}

export type BuildEscalationPacketInput = {
  intent: string;
  currentState: string;
  attempts: EscalationAttempt[];
  failureFingerprint: string;
  nonGoals: string[];
  authority: EscalationAuthority;
  remainingBudget: EscalationRemainingBudget;
  requiredTerminalArtifact: string;
  /** Optional fixed clock for tests. Defaults to now. */
  createdAt?: string | Date;
};

/**
 * Build a compact escalation packet.
 *
 * Never accepts or emits full-transcript fields. Adapters must pass only
 * structured failure context; assertEscalationPacketSize enforces the cap.
 */
export function buildEscalationPacket(
  input: BuildEscalationPacketInput,
): EscalationPacket {
  if (!input || typeof input !== "object") {
    throw new Error("escalation packet input is required");
  }

  // Reject any accidental transcript payload on the input object.
  const forbidden = FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(input, key) &&
      (input as Record<string, unknown>)[key] != null,
  );
  if (forbidden.length > 0) {
    throw new EscalationPacketTranscriptError([...forbidden]);
  }

  if (!input.authority || typeof input.authority !== "object") {
    throw new Error("authority is required");
  }
  const companyId = requiredBoundedString(
    input.authority.companyId,
    "authority.companyId",
    BOUND.companyId,
  );

  if (!Array.isArray(input.attempts)) {
    throw new Error("attempts must be an array");
  }
  if (!Array.isArray(input.nonGoals)) {
    throw new Error("nonGoals must be an array");
  }

  const attempts: EscalationAttempt[] = input.attempts
    .slice(0, MAX_ATTEMPTS)
    .map((attempt) => {
      if (!attempt || typeof attempt !== "object") {
        throw new Error("each attempt must be an object");
      }
      // Reject transcript dumps nested in attempts.
      const attemptForbidden = FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS.filter(
        (key) =>
          Object.prototype.hasOwnProperty.call(attempt, key) &&
          (attempt as Record<string, unknown>)[key] != null,
      );
      if (attemptForbidden.length > 0) {
        throw new EscalationPacketTranscriptError([...attemptForbidden]);
      }
      return compactRecord({
        turn: optionalNonNegativeInt(attempt.turn, "attempt.turn"),
        summary: requiredBoundedString(
          attempt.summary,
          "attempt.summary",
          BOUND.attemptSummary,
        ),
        tool: boundedString(attempt.tool, BOUND.attemptTool),
        errorCode: boundedString(
          attempt.errorCode,
          BOUND.attemptErrorCode,
        ),
        at: nonEmpty(attempt.at),
      }) as EscalationAttempt;
    });

  const nonGoals = input.nonGoals
    .map((entry) => boundedString(entry, BOUND.nonGoal))
    .filter((entry): entry is string => entry != null)
    .slice(0, MAX_NON_GOALS);

  const budget = input.remainingBudget ?? {};
  if (typeof budget !== "object") {
    throw new Error("remainingBudget must be an object");
  }

  const createdAt =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : nonEmpty(input.createdAt) ?? new Date().toISOString();

  const packet: EscalationPacket = {
    schemaVersion: ESCALATION_PACKET_SCHEMA,
    intent: requiredBoundedString(input.intent, "intent", BOUND.intent),
    currentState: requiredBoundedString(
      input.currentState,
      "currentState",
      BOUND.currentState,
    ),
    attempts,
    failureFingerprint: requiredBoundedString(
      input.failureFingerprint,
      "failureFingerprint",
      BOUND.failureFingerprint,
    ),
    nonGoals,
    authority: compactRecord({
      companyId,
      issueId: boundedString(input.authority.issueId, BOUND.id),
      runId: boundedString(input.authority.runId, BOUND.id),
      assigneeAgentId: boundedString(
        input.authority.assigneeAgentId,
        BOUND.id,
      ),
      responsibleUserId: boundedString(
        input.authority.responsibleUserId,
        BOUND.id,
      ),
    }) as EscalationAuthority,
    remainingBudget: compactRecord({
      turnsRemaining: optionalNonNegativeInt(
        budget.turnsRemaining,
        "remainingBudget.turnsRemaining",
      ),
      maxTurns: optionalNonNegativeInt(
        budget.maxTurns,
        "remainingBudget.maxTurns",
      ),
      uncachedTokensRemaining: optionalNonNegativeInt(
        budget.uncachedTokensRemaining,
        "remainingBudget.uncachedTokensRemaining",
      ),
      maxUncachedTokens: optionalNonNegativeInt(
        budget.maxUncachedTokens,
        "remainingBudget.maxUncachedTokens",
      ),
    }) as EscalationRemainingBudget,
    requiredTerminalArtifact: requiredBoundedString(
      input.requiredTerminalArtifact,
      "requiredTerminalArtifact",
      BOUND.requiredTerminalArtifact,
    ),
    createdAt,
  };

  // Defense-in-depth: re-scan the assembled packet for forbidden keys.
  assertNoTranscriptFields(packet);
  return packet;
}

/**
 * Measure serialized escalation packet size in characters
 * (JSON.stringify length). Characters match the maxChars contract.
 */
export function measureEscalationPacketChars(
  packet: EscalationPacket,
): number {
  return JSON.stringify(packet).length;
}

/**
 * Return size validation without throwing.
 * Prefer this when adapters want a soft gate before dispatch.
 */
export function checkEscalationPacketSize(
  packet: EscalationPacket,
  maxChars: number = DEFAULT_ESCALATION_PACKET_MAX_CHARS,
): EscalationPacketSizeResult {
  if (
    typeof maxChars !== "number" ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 1
  ) {
    throw new Error("maxChars must be a positive integer");
  }
  assertNoTranscriptFields(packet);
  const chars = measureEscalationPacketChars(packet);
  if (chars > maxChars) {
    return {
      ok: false,
      error: `Escalation packet exceeds size cap: ${chars} > ${maxChars} chars`,
      chars,
      maxChars,
    };
  }
  return { ok: true, chars, maxChars };
}

/**
 * Hard size gate. Throws EscalationPacketSizeError when the packet is too
 * large. Returns size metadata on success.
 */
export function assertEscalationPacketSize(
  packet: EscalationPacket,
  maxChars: number = DEFAULT_ESCALATION_PACKET_MAX_CHARS,
): EscalationPacketSizeOk {
  const result = checkEscalationPacketSize(packet, maxChars);
  if (!result.ok) {
    throw new EscalationPacketSizeError(result.chars, result.maxChars);
  }
  return result;
}

/**
 * Decide whether the run must force-stop (no further model turns).
 *
 * Triggers (any one is sufficient):
 * - turn cap: turns >= maxTurns
 * - two-strike tools: identicalToolFailures >= 2
 * - uncached token envelope: uncachedTokens >= maxUncached
 */
export function shouldForceStop(input: {
  turns: number;
  maxTurns: number;
  identicalToolFailures: number;
  uncachedTokens: number;
  maxUncached: number;
}): ForceStopDecision {
  const turns = nonNegativeInt(input.turns, "turns");
  const maxTurns = nonNegativeInt(input.maxTurns, "maxTurns");
  const identicalToolFailures = nonNegativeInt(
    input.identicalToolFailures,
    "identicalToolFailures",
  );
  const uncachedTokens = nonNegativeInt(
    input.uncachedTokens,
    "uncachedTokens",
  );
  const maxUncached = nonNegativeInt(input.maxUncached, "maxUncached");

  const reasons: ForceStopReason[] = [];
  if (turns >= maxTurns) reasons.push("turn_cap");
  if (identicalToolFailures >= TWO_STRIKE_TOOL_FAILURES) {
    reasons.push("two_strike_tools");
  }
  if (uncachedTokens >= maxUncached) {
    reasons.push("uncached_token_envelope");
  }
  return { stop: reasons.length > 0, reasons };
}

/**
 * Runtime guard that an object has no full-transcript fields.
 * Used by builders and size asserts so there is no escalate-with-transcript path.
 */
export function assertNoTranscriptFields(
  value: unknown,
  path: string = "packet",
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const hits = FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS.filter(
    (key) =>
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] != null,
  );
  if (hits.length > 0) {
    throw new EscalationPacketTranscriptError(
      hits.map((key) => `${path}.${key}`),
    );
  }
}
