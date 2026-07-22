import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPromptFitsInvocationBudget,
  buildExecutionPhaseBudgetPlan,
  buildSubscriptionRouteAttemptEvidence,
  buildBoundExecutionContext,
  buildCanonicalContinuationPacket,
  buildExecutionRetryReceipt,
  evaluateExecutionTruthTransition,
  evaluateSubscriptionRouteAdmission,
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

  function canonicalInput(overrides: {
    objective?: string | null;
  } = {}) {
    return {
      issue: {
        id: "issue-1",
        identifier: "GLO-1074",
        title: "Implement compact packets",
        objective: overrides.objective === undefined
          ? "Ship objective-bearing compact packets without legacy bodies"
          : overrides.objective,
        status: "in_progress",
        priority: "critical",
        workMode: "standard",
        projectId: "project-1",
        goalId: "goal-1",
        parentId: "issue-parent",
      },
      ancestors: [
        { id: "issue-parent", identifier: "GLO-1049", title: "Parent", status: "blocked", priority: "critical" },
      ],
      repoRef: {
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "a".repeat(40),
        cwd: "/opt/data/workspace/paperclip",
        workspaceId: "workspace-1",
      },
      authority: {
        companyId: "company-1",
        assigneeAgentId: "agent-1",
        responsibleUserId: "user-1",
        runId: "run-1",
      },
      verification: {
        cursor: "run focused tests",
      },
      continuation: {
        summary: [
          "bounded continuation",
          "resumedSessionTranscript should remain only prose here, not a legacy field",
        ].join("\n"),
        next: "continue",
      },
      executionBudget: {
        maxInputTokens: 4000,
        maxOutputTokens: 1000,
      },
    };
  }

  it("builds a deterministic canonical compact packet without legacy bodies", () => {
    const built = buildCanonicalContinuationPacket(canonicalInput());
    const rebuilt = buildCanonicalContinuationPacket(canonicalInput());
    const binding = buildBoundExecutionContext(built);
    const serialized = serialize(built);
    expect(built).toEqual(rebuilt);
    expect(binding.serializedBytes).toBeLessThanOrEqual(16_000);
    expect(binding.approximateTokens).toBe(Math.ceil(binding.serializedBytes / 4));
    expect(serialized).toContain("GLO-1074");
    expect(serialized).toContain("GLO-1049");
    expect(serialized).toContain("workspace-1");
    expect(serialized).toContain("run focused tests");
    expect((built.work as Record<string, unknown>).objective)
      .toBe("Ship objective-bearing compact packets without legacy bodies");
    expect(serialized).not.toContain("paperclipTaskMarkdown");
    expect(serialized).not.toContain("paperclipSessionHandoffMarkdown");
    expect(serialized).not.toContain("paperclipContinuationSummary");
    expect(serialized).not.toContain("rawMemory");
    expect((built.repoRef as Record<string, unknown>).exactHeadSha).toBe("a".repeat(40));
  });

  it("includes work.objective when present and remains null-safe when absent", () => {
    const present = buildCanonicalContinuationPacket(canonicalInput({
      objective: "Acceptance: keep objective under four thousand bytes",
    }));
    expect((present.work as Record<string, unknown>).objective)
      .toBe("Acceptance: keep objective under four thousand bytes");
    expect(renderBoundExecutionContext(buildBoundExecutionContext(present)))
      .toContain("Acceptance: keep objective under four thousand bytes");

    const absent = buildCanonicalContinuationPacket(canonicalInput({ objective: null }));
    expect((absent.work as Record<string, unknown>).objective).toBeUndefined();
    expect(serialize(absent)).not.toContain("\"objective\"");

    const blank = buildCanonicalContinuationPacket(canonicalInput({ objective: "   " }));
    expect((blank.work as Record<string, unknown>).objective).toBeUndefined();

    const oversized = "x".repeat(5_000);
    const truncated = buildCanonicalContinuationPacket(canonicalInput({ objective: oversized }));
    const objective = (truncated.work as Record<string, unknown>).objective as string;
    expect(Buffer.byteLength(objective, "utf8")).toBeLessThanOrEqual(4_000);
    expect(objective).toContain("[truncated to 4000 bytes]");
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

  it("reserves ten percent of the provider envelope for deterministic closeout", () => {
    const plan = buildExecutionPhaseBudgetPlan({
      inputTokens: 24_000,
      outputTokens: 8_000,
      turns: 20,
      toolCalls: 40,
      wallMs: 1_200_000,
    });
    expect(plan.closeout).toEqual({
      inputTokens: 2_400,
      outputTokens: 800,
      turns: 2,
      toolCalls: 4,
      wallMs: 120_000,
    });
    expect(Object.values(plan).reduce((sum, phase) => sum + phase.inputTokens, 0)).toBe(24_000);
    expect(Object.values(plan).reduce((sum, phase) => sum + phase.toolCalls, 0)).toBe(40);
  });

  it("denies Grok and Codex until lower-cost subscription routes have typed receipts", () => {
    const ollama = buildSubscriptionRouteAttemptEvidence({
      provider: "ollama",
      transport: "cli",
      disposition: "attempted_failed",
      reason: "quality_failure",
      runId: "run-ollama",
      issueId: "issue-1",
      observedAt: "2026-07-22T10:00:00Z",
    });
    const grok = buildSubscriptionRouteAttemptEvidence({
      provider: "grok",
      transport: "cli",
      disposition: "attempted_failed",
      reason: "provider_unavailable",
      runId: "run-grok",
      issueId: "issue-1",
      observedAt: "2026-07-22T10:01:00Z",
    });
    expect(evaluateSubscriptionRouteAdmission("hermes_gateway", {})).toMatchObject({ allowed: true, provider: "ollama" });
    expect(evaluateSubscriptionRouteAdmission("process", {})).toMatchObject({ allowed: true, provider: null });
    expect(evaluateSubscriptionRouteAdmission("claude_local", {})).toMatchObject({ allowed: false, provider: null });
    expect(evaluateSubscriptionRouteAdmission("grok_local_v2", {})).toMatchObject({ allowed: false, provider: null });
    expect(evaluateSubscriptionRouteAdmission("grok_local", {})).toMatchObject({ allowed: false, provider: "grok" });
    expect(evaluateSubscriptionRouteAdmission("grok_local", {
      gloopsProviderRouteEvidence: { schemaVersion: "gloops.subscription-route-evidence.v1", attempts: [ollama] },
    }, "2026-07-22T10:02:00Z")).toMatchObject({ allowed: true, provider: "grok" });
    expect(evaluateSubscriptionRouteAdmission("codex_local", {
      gloopsProviderRouteEvidence: { schemaVersion: "gloops.subscription-route-evidence.v1", attempts: [ollama] },
    })).toMatchObject({ allowed: false, provider: "codex" });
    expect(evaluateSubscriptionRouteAdmission("codex_local", {
      gloopsProviderRouteEvidence: { schemaVersion: "gloops.subscription-route-evidence.v1", attempts: [ollama, grok] },
    }, "2026-07-22T10:02:00Z")).toMatchObject({ allowed: true, provider: "codex" });
    for (const observedAt of ["2026-07-22T03:59:59Z", "2026-07-22T10:08:00Z"]) {
      const attempt = buildSubscriptionRouteAttemptEvidence({
        provider: "ollama",
        transport: "cli",
        disposition: "attempted_failed",
        reason: "quality_failure",
        runId: "run-ollama",
        issueId: "issue-1",
        observedAt,
      });
      expect(evaluateSubscriptionRouteAdmission("grok_local", {
        gloopsProviderRouteEvidence: {
          schemaVersion: "gloops.subscription-route-evidence.v1",
          attempts: [attempt],
        },
      }, "2026-07-22T10:02:00Z")).toMatchObject({ allowed: false, provider: "grok" });
    }
    expect(evaluateSubscriptionRouteAdmission("grok_local", {
      gloopsProviderRouteEvidence: {
        schemaVersion: "gloops.subscription-route-evidence.v1",
        attempts: [{ ...ollama, receiptDigest: `sha256:${"0".repeat(64)}` }],
      },
    }, "2026-07-22T10:02:00Z")).toMatchObject({ allowed: false, provider: "grok" });
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
