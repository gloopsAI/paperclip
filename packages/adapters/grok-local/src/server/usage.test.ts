import { describe, expect, it } from "vitest";
import {
  GROK_TOKEN_EQUIVALENT_CONFIDENCE,
  GROK_TOKEN_EQUIVALENT_METHOD,
  resolveGrokLocalUsage,
  utf8ByteTokenEquivalents,
} from "./usage.js";

describe("utf8ByteTokenEquivalents", () => {
  it("returns 0 for empty text", () => {
    expect(utf8ByteTokenEquivalents("")).toBe(0);
  });

  it("ceil-divides UTF-8 bytes by 4 with a minimum of 1", () => {
    expect(utf8ByteTokenEquivalents("a")).toBe(1);
    expect(utf8ByteTokenEquivalents("abcd")).toBe(1);
    expect(utf8ByteTokenEquivalents("abcde")).toBe(2);
    // multi-byte: "é" is 2 bytes → 1 token-equivalent
    expect(utf8ByteTokenEquivalents("é")).toBe(1);
  });
});

describe("resolveGrokLocalUsage", () => {
  it("prefers positive measured counters and labels them measured", () => {
    expect(
      resolveGrokLocalUsage({
        measured: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 10 },
        prompt: "ignored when measured",
        outputText: "also ignored",
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cachedInputTokens: 10,
      provenance: "measured",
    });
  });

  it("does not treat all-zero measured counters as measured truth", () => {
    const prompt = "hello world prompt text for estimate";
    const outputText = "assistant reply text";
    const usage = resolveGrokLocalUsage({
      measured: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      prompt,
      outputText,
    });

    expect(usage).toEqual({
      inputTokens: utf8ByteTokenEquivalents(prompt),
      outputTokens: utf8ByteTokenEquivalents(outputText),
      cachedInputTokens: 0,
      provenance: "estimated",
      estimationMethod: GROK_TOKEN_EQUIVALENT_METHOD,
      estimationConfidence: GROK_TOKEN_EQUIVALENT_CONFIDENCE,
    });
    expect(usage!.inputTokens).toBeGreaterThan(0);
    expect(usage!.outputTokens).toBeGreaterThan(0);
  });

  it("estimates from prompt/output bytes when native usage is missing", () => {
    const usage = resolveGrokLocalUsage({
      measured: null,
      prompt: "x".repeat(40),
      outputText: "y".repeat(8),
    });
    expect(usage?.provenance).toBe("estimated");
    expect(usage?.estimationMethod).toBe(GROK_TOKEN_EQUIVALENT_METHOD);
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(2);
  });

  it("omits usage entirely when nothing can be measured or estimated", () => {
    expect(
      resolveGrokLocalUsage({
        measured: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        prompt: "",
        outputText: "",
      }),
    ).toBeUndefined();
  });
});
