import type { UsageSummary } from "@paperclipai/adapter-utils";

/** Deterministic UTF-8 byte → token-equivalent estimate (≈4 bytes/token). */
export const GROK_TOKEN_EQUIVALENT_METHOD = "utf8_bytes_div_4";

/** Conservative confidence for the byte heuristic (not a tokenizer). */
export const GROK_TOKEN_EQUIVALENT_CONFIDENCE = 0.35;

export interface MeasuredGrokUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Convert captured UTF-8 text into token-equivalent units.
 * Empty text is 0; any non-empty text is at least 1 so successful CLI work is
 * never recorded as exact zero usage.
 */
export function utf8ByteTokenEquivalents(text: string): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= 0) return 0;
  return Math.max(1, Math.ceil(bytes / 4));
}

function hasPositiveMeasuredUsage(usage: MeasuredGrokUsage | null | undefined): boolean {
  if (!usage) return false;
  return (
    nonNegativeInt(usage.inputTokens) > 0
    || nonNegativeInt(usage.outputTokens) > 0
    || nonNegativeInt(usage.cachedInputTokens) > 0
  );
}

/**
 * Resolve grok_local usage for a run receipt.
 *
 * Preference order:
 * 1. Native measured counters when present and positive
 * 2. Deterministic token-equivalent estimate from already-captured prompt/output bytes
 * 3. Omit usage entirely (unknown) — never fabricate measured `{0,0,0}`
 */
export function resolveGrokLocalUsage(input: {
  measured?: MeasuredGrokUsage | null;
  prompt: string;
  outputText: string;
}): UsageSummary | undefined {
  const measured = input.measured;
  if (hasPositiveMeasuredUsage(measured)) {
    return {
      inputTokens: nonNegativeInt(measured!.inputTokens),
      outputTokens: nonNegativeInt(measured!.outputTokens),
      cachedInputTokens: nonNegativeInt(measured!.cachedInputTokens),
      provenance: "measured",
    };
  }

  const inputTokens = utf8ByteTokenEquivalents(input.prompt);
  const outputTokens = utf8ByteTokenEquivalents(input.outputText);
  if (inputTokens > 0 || outputTokens > 0) {
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      provenance: "estimated",
      estimationMethod: GROK_TOKEN_EQUIVALENT_METHOD,
      estimationConfidence: GROK_TOKEN_EQUIVALENT_CONFIDENCE,
    };
  }

  // No native counters and no captured bytes to estimate from.
  return undefined;
}
