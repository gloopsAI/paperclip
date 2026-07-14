import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPromptFitsInvocationBudget,
  buildBoundExecutionContext,
  buildExecutionRetryReceipt,
  evaluateExecutionTruthTransition,
  hasProhibitedGrokApiConfiguration,
  readBoundExecutionContext,
  renderBoundExecutionContext,
} from "./execution-envelope.js";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, stable(entry)]));
}

function serialize(value: unknown) {
  return JSON.stringify(stable(value));
}

function sha(value: unknown) {
  return `sha256:${createHash("sha256").update(serialize(value)).digest("hex")}`;
}

function packet() {
  const body = {
    schemaVersion: "gloops.continuation-packet.v1",
    work: { id: "GLO-999", objective: "finish the exact-head change" },
    authority: { owner: "Mason", allowed: ["edit", "test"], prohibited: ["merge"] },
    cursor: { next: "run focused verification" },
    verification: { exactHeadSha: "a".repeat(40), checks: ["unit"] },
  };
  const digest = sha(body);
  let serializedBytes = 1;
  let candidate: Record<string, unknown> = {};
  for (let i = 0; i < 10; i += 1) {
    candidate = {
      ...body,
      digest,
      metrics: { serializedBytes, approximateTokens: Math.ceil(serializedBytes / 4) },
    };
    const next = Buffer.byteLength(serialize(candidate));
    if (next === serializedBytes) break;
    serializedBytes = next;
  }
  candidate.metrics = { serializedBytes, approximateTokens: Math.ceil(serializedBytes / 4) };
  expect(Buffer.byteLength(serialize(candidate))).toBe(serializedBytes);
  return candidate;
}

function receipt(overrides: Record<string, unknown> = {}) {
  const body = {
    schemaVersion: "gloops.execution-truth.operator-receipt.v2",
    work: { id: "GLO-999" },
    budget: { exhausted: [] },
    route: { observedPathIds: ["ollama-cloud-cli"], prohibitedPathObserved: false },
    continuation: { required: true, valid: true },
    verification: {
      exactHeadAligned: true,
      exactHeadSha: "a".repeat(40),
      allChecksPassed: true,
      review: { status: "accepted", headSha: "a".repeat(40), unresolvedThreads: 0 },
    },
    authority: { humanRequired: false },
    status: "operational",
    ...overrides,
  };
  return { ...body, digest: sha(body) };
}

describe("execution envelope", () => {
  it("binds a content-addressed packet and rejects tampering", () => {
    const binding = buildBoundExecutionContext(packet());
    expect(readBoundExecutionContext(binding)).toEqual(binding);
    expect(renderBoundExecutionContext(binding)).toContain(binding.digest);
    expect(readBoundExecutionContext({ ...binding, approximateTokens: binding.approximateTokens + 1 })).toBeNull();
  });

  it("refuses oversized input before provider dispatch", () => {
    expect(() => assertPromptFitsInvocationBudget("x".repeat(4_000_000), {
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      budgetId: "budget-1",
      reservationId: "b".repeat(64),
      maxInputTokens: 30_000,
      maxOutputTokens: 100,
      maxTurns: 4,
      maxToolCalls: 10,
      maxWallMs: 60_000,
    })).toThrow("refused before dispatch");
  });

  it("detects prohibited Grok/xAI routing configuration without scanning prose", () => {
    expect(hasProhibitedGrokApiConfiguration({ provider: "xai", baseUrl: "https://api.x.ai/v1" })).toBe(true);
    expect(hasProhibitedGrokApiConfiguration({ provider: "x.ai" })).toBe(true);
    expect(hasProhibitedGrokApiConfiguration({ env: { XAI_API_KEY: "redacted" } })).toBe(true);
    expect(hasProhibitedGrokApiConfiguration({ payloadTemplate: { xai: { apiKey: "redacted" } } })).toBe(true);
    expect(hasProhibitedGrokApiConfiguration({ payloadTemplate: { grok: { baseUrl: "https://example.invalid" } } })).toBe(true);
    expect(hasProhibitedGrokApiConfiguration({ extraArgs: ["--provider", "xai"] })).toBe(true);
    expect(hasProhibitedGrokApiConfiguration({ instructions: "Discuss why the Grok API is forbidden." })).toBe(false);
    expect(hasProhibitedGrokApiConfiguration({ payloadTemplate: { instructions: "Discuss why the Grok API is forbidden." } })).toBe(false);
  });

  it("fails closed on stale review, exhausted budget, and ambiguous Grok paths", () => {
    expect(evaluateExecutionTruthTransition({ transition: "ready", workId: "GLO-999", receipt: receipt() }))
      .toEqual({ allowed: true, reason: null });
    expect(evaluateExecutionTruthTransition({ transition: "ready", workId: "GLO-999", receipt: receipt({
      route: { observedPathIds: ["grok-build-cli"], prohibitedPathObserved: false },
    }) })).toEqual({ allowed: true, reason: null });
    expect(evaluateExecutionTruthTransition({ transition: "ready", workId: "GLO-999", receipt: receipt({
      route: { observedPathIds: ["xai-api"], prohibitedPathObserved: false },
    }) })).toEqual({ allowed: false, reason: "prohibited_provider_path" });
    expect(evaluateExecutionTruthTransition({ transition: "ready", workId: "GLO-999", receipt: receipt({
      budget: { exhausted: ["input_tokens"] },
    }) })).toEqual({ allowed: false, reason: "budget_exhausted" });
    expect(evaluateExecutionTruthTransition({ transition: "ready", workId: "GLO-999", receipt: receipt({
      verification: {
        exactHeadAligned: true,
        exactHeadSha: "a".repeat(40),
        allChecksPassed: true,
        review: { status: "accepted", headSha: "b".repeat(40), unresolvedThreads: 0 },
      },
    }) })).toEqual({ allowed: false, reason: "review_incomplete" });
  });

  it("projects a deterministic control-plane retry receipt", () => {
    const projected = buildExecutionRetryReceipt({
      workId: "GLO-999",
      routePathIds: ["ollama-cloud-cli"],
      continuationValid: true,
    });
    expect(evaluateExecutionTruthTransition({ transition: "retry", workId: "GLO-999", receipt: projected }))
      .toEqual({ allowed: true, reason: null });
  });
});
