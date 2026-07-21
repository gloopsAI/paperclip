import { asString, asNumber, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { applyTurnBoundary, createTurnBoundaryState } from "../shared/turn-boundary.js";
import type { MeasuredGrokUsage } from "./usage.js";

export interface ParsedGrokJsonl {
  sessionId: string | null;
  summary: string;
  thought: string;
  errorMessage: string | null;
  stopReason: string | null;
  requestId: string | null;
  /** Native counters when Grok CLI emits them; all-zero means absent. */
  usage: MeasuredGrokUsage | null;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message =
    asString(rec.message, "").trim() ||
    asString(rec.error, "").trim() ||
    asString(rec.detail, "").trim() ||
    asString(rec.code, "").trim();
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function readTokenField(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = asNumber(source[key], Number.NaN);
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}

/**
 * Best-effort extraction of native Grok CLI usage counters from a JSONL event.
 * Returns null when the event has no token fields (the common case today).
 */
export function readGrokUsageFromEvent(event: Record<string, unknown>): MeasuredGrokUsage | null {
  const nested = parseObject(event.usage ?? event.token_usage ?? event.tokenUsage ?? event.tokens);
  const sources = [nested, event];
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cachedInputTokens: number | null = null;

  for (const source of sources) {
    if (Object.keys(source).length === 0) continue;
    inputTokens ??= readTokenField(
      source,
      "inputTokens",
      "input_tokens",
      "prompt_tokens",
      "promptTokens",
    );
    outputTokens ??= readTokenField(
      source,
      "outputTokens",
      "output_tokens",
      "completion_tokens",
      "completionTokens",
    );
    cachedInputTokens ??= readTokenField(
      source,
      "cachedInputTokens",
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cacheReadInputTokens",
    );
  }

  if (inputTokens == null && outputTokens == null && cachedInputTokens == null) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
  };
}

function mergeMeasuredUsage(
  current: MeasuredGrokUsage | null,
  next: MeasuredGrokUsage | null,
): MeasuredGrokUsage | null {
  if (!next) return current;
  if (!current) return next;
  // Prefer the latest non-zero totals; Grok may emit partial then final usage.
  return {
    inputTokens: next.inputTokens > 0 ? next.inputTokens : current.inputTokens,
    outputTokens: next.outputTokens > 0 ? next.outputTokens : current.outputTokens,
    cachedInputTokens: next.cachedInputTokens > 0 ? next.cachedInputTokens : current.cachedInputTokens,
  };
}

export function parseGrokJsonl(stdout: string): ParsedGrokJsonl {
  let sessionId: string | null = null;
  let stopReason: string | null = null;
  let requestId: string | null = null;
  let errorMessage: string | null = null;
  let usage: MeasuredGrokUsage | null = null;
  const thoughtParts: string[] = [];
  const textParts: string[] = [];
  const thoughtBoundary = createTurnBoundaryState();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "").trim();
    usage = mergeMeasuredUsage(usage, readGrokUsageFromEvent(event));

    if (type === "thought") {
      const text = asString(event.data, "");
      if (text) thoughtParts.push(applyTurnBoundary(thoughtBoundary, text));
      continue;
    }

    if (type === "text") {
      const text = asString(event.data, "");
      if (text) textParts.push(text);
      continue;
    }

    if (type === "end") {
      sessionId = asString(event.sessionId, "").trim() || sessionId;
      stopReason = asString(event.stopReason, "").trim() || stopReason;
      requestId = asString(event.requestId, "").trim() || requestId;
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message ?? event.detail ?? event.data).trim();
      if (text) errorMessage = text;
    }
  }

  return {
    sessionId,
    summary: textParts.join("").trim(),
    thought: thoughtParts.join("").trim(),
    errorMessage,
    stopReason,
    requestId,
    usage,
  };
}

export function isGrokUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session(?:\s+.*)?\s+not\s+found|resume\s+.*\s+not\s+found|invalid\s+session/i.test(haystack);
}
