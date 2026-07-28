import { describe, expect, it } from "vitest";
import {
  CONTEXT_PACKET_SCHEMA,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  FAILURE_FINGERPRINT_SCHEMA,
  FORBIDDEN_AUTHORITY_KEYS,
  MAX_KNOWN_FAILURES,
  WORK_EPISODE_SCHEMA,
  assertContextPacketIsAdvisory,
  buildWorkEpisode,
  compileContextPacket,
  ContextPacketAuthorityError,
  estimateJsonTokens,
  estimateTokens,
  normalizeFailureFingerprint,
  normalizeMessageForFingerprint,
  type ContextPacket,
  type FailureFingerprint,
} from "./gbrain-microplane.js";

const FIXED_AT = "2026-07-28T15:00:00.000Z";

function sampleFingerprint(
  overrides: Partial<Parameters<typeof normalizeFailureFingerprint>[0]> = {},
): FailureFingerprint {
  return normalizeFailureFingerprint({
    errorCode: "package_not_found",
    message: "apt package foo-bar not found on host",
    tool: "shell",
    stage: "workspace_prep",
    recoveryHint: "install via hermes image layer, not apt at runtime",
    ...overrides,
  });
}

describe("buildWorkEpisode", () => {
  it("builds an advisory episode envelope with schema, subject, role, and events", () => {
    const episode = buildWorkEpisode({
      subject: {
        companyId: "company-1",
        issueId: "issue-1",
        runId: "run-1",
      },
      role: "implementer",
      modelRoute: "gpt-5.5/medium",
      events: [
        {
          kind: "started",
          at: "2026-07-28T14:00:00.000Z",
          summary: "Admitted work unit started",
        },
        {
          kind: "tool_failure",
          at: "2026-07-28T14:05:00.000Z",
          tool: "shell",
          errorCode: "package_not_found",
          summary: "apt install failed",
        },
        {
          kind: "human_intervention",
          at: "2026-07-28T14:10:00.000Z",
          summary: "Operator pinned runtime image",
        },
      ],
      outcomes: [
        {
          kind: "artifact",
          summary: "candidate commit",
          artifactRef: "sha:abc123",
        },
        { kind: "accepted", summary: "merged to gloops/stable" },
      ],
      tokens: {
        input: 12_000,
        output: 3_000,
        cachedInput: 8_000,
        uncachedInput: 4_000,
        total: 15_000,
      },
      id: "ep-1",
      startedAt: "2026-07-28T14:00:00.000Z",
      terminatedAt: "2026-07-28T14:30:00.000Z",
      createdAt: FIXED_AT,
    });

    expect(episode.schemaVersion).toBe(WORK_EPISODE_SCHEMA);
    expect(episode.advisory).toBe(true);
    expect(episode.id).toBe("ep-1");
    expect(episode.role).toBe("implementer");
    expect(episode.modelRoute).toBe("gpt-5.5/medium");
    expect(episode.subject).toEqual({
      companyId: "company-1",
      issueId: "issue-1",
      runId: "run-1",
    });
    expect(episode.events).toHaveLength(3);
    expect(episode.outcomes).toHaveLength(2);
    expect(episode.tokens.total).toBe(15_000);
    expect(episode.startedAt).toBe("2026-07-28T14:00:00.000Z");
    expect(episode.terminatedAt).toBe("2026-07-28T14:30:00.000Z");
    expect(episode.createdAt).toBe(FIXED_AT);
  });

  it("generates an id and defaults empty collections when omitted", () => {
    const episode = buildWorkEpisode({
      subject: { companyId: "c1" },
      role: "reviewer",
      createdAt: FIXED_AT,
    });

    expect(episode.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(episode.events).toEqual([]);
    expect(episode.outcomes).toEqual([]);
    expect(episode.tokens).toEqual({});
    expect(episode.modelRoute).toBeNull();
    expect(episode.advisory).toBe(true);
  });

  it("derives startedAt from the first event timestamp when not provided", () => {
    const episode = buildWorkEpisode({
      subject: {},
      role: "implementer",
      events: [
        { kind: "started", at: "2026-07-28T10:00:00.000Z" },
        { kind: "progress", at: "2026-07-28T10:05:00.000Z" },
      ],
      createdAt: FIXED_AT,
    });
    expect(episode.startedAt).toBe("2026-07-28T10:00:00.000Z");
  });

  it("requires role and rejects invalid token counts", () => {
    expect(() =>
      buildWorkEpisode({ subject: {}, role: "   " }),
    ).toThrow("role is required");

    expect(() =>
      buildWorkEpisode({
        subject: {},
        role: "implementer",
        tokens: { input: -1 },
      }),
    ).toThrow("tokens.input must be a non-negative integer");
  });

  it("caps oversized event and outcome lists", () => {
    const episode = buildWorkEpisode({
      subject: {},
      role: "implementer",
      events: Array.from({ length: 100 }, (_, i) => ({ kind: `e-${i}` })),
      outcomes: Array.from({ length: 50 }, (_, i) => ({ kind: `o-${i}` })),
      createdAt: FIXED_AT,
    });
    expect(episode.events).toHaveLength(64);
    expect(episode.outcomes).toHaveLength(32);
  });
});

describe("normalizeFailureFingerprint", () => {
  it("produces a stable key for identical semantic inputs", () => {
    const a = normalizeFailureFingerprint({
      errorCode: "Package_Not_Found",
      message: "apt package foo-bar not found on host",
      tool: "Shell",
      stage: "workspace_prep",
    });
    const b = normalizeFailureFingerprint({
      errorCode: "package_not_found",
      message: "apt package foo-bar not found on host",
      tool: "shell",
      stage: "workspace_prep",
    });

    expect(a.key).toBe(b.key);
    expect(a.schemaVersion).toBe(FAILURE_FINGERPRINT_SCHEMA);
    expect(a.advisory).toBe(true);
    expect(a.errorCode).toBe("package_not_found");
    expect(a.tool).toBe("shell");
    expect(a.stage).toBe("workspace_prep");
    expect(a.key).toMatch(
      /^v1\|error:package_not_found\|tool:shell\|stage:workspace_prep\|msg:[0-9a-f]{12}$/,
    );
  });

  it("is stable across volatile message noise (uuids, paths, numbers)", () => {
    const a = normalizeFailureFingerprint({
      errorCode: "eacces",
      message:
        "EACCES /Users/zach/Code/repo/file.ts:42 permission denied for 7f3a9c2b-1111-2222-3333-444455556666",
      tool: "fs",
      stage: "write",
    });
    const b = normalizeFailureFingerprint({
      errorCode: "EACCES",
      message:
        "EACCES /tmp/other/path/file.ts:99 permission denied for aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      tool: "fs",
      stage: "write",
    });
    expect(a.key).toBe(b.key);
    expect(a.messageNorm).toContain("<path>");
    expect(a.messageNorm).toContain("<id>");
    expect(a.messageNorm).toContain("<n>");
  });

  it("changes key when errorCode or tool differs", () => {
    const base = sampleFingerprint();
    const otherCode = sampleFingerprint({ errorCode: "timeout" });
    const otherTool = sampleFingerprint({ tool: "git" });
    expect(base.key).not.toBe(otherCode.key);
    expect(base.key).not.toBe(otherTool.key);
  });

  it("allows omitted tool/stage and still yields a stable key", () => {
    const fp = normalizeFailureFingerprint({
      errorCode: "unknown",
      message: "something broke",
    });
    expect(fp.tool).toBeNull();
    expect(fp.stage).toBeNull();
    expect(fp.key).toContain("tool:-");
    expect(fp.key).toContain("stage:-");
  });

  it("requires errorCode and message", () => {
    expect(() =>
      normalizeFailureFingerprint({ errorCode: "", message: "x" }),
    ).toThrow("errorCode is required");
    expect(() =>
      normalizeFailureFingerprint({ errorCode: "e", message: "  " }),
    ).toThrow("message is required");
  });

  it("preserves recoveryHint as advisory only", () => {
    const fp = sampleFingerprint({ recoveryHint: "retry with backoff" });
    expect(fp.recoveryHint).toBe("retry with backoff");
    expect(fp.advisory).toBe(true);
  });
});

describe("normalizeMessageForFingerprint", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeMessageForFingerprint("  Hello   World  ")).toBe(
      "hello world",
    );
  });
});

describe("compileContextPacket", () => {
  it("compiles a full advisory packet with goal, scope, failures, and provenance", () => {
    const fps = [
      sampleFingerprint(),
      sampleFingerprint({
        errorCode: "gateway_timeout",
        message: "gateway timed out after 30s",
        tool: "hermes",
        stage: "connect",
      }),
      sampleFingerprint({
        errorCode: "authz_denied",
        message: "agent key cannot access company",
        tool: "authz",
        stage: "admission",
      }),
    ];

    const packet = compileContextPacket(
      {
        goal: "Land GBrain micro-plane context compile v0",
        scope: ["episodes", "fingerprints", "context compile"],
        nonGoals: ["full GBrain v2 graph DB", "auto-promote policy"],
        acceptance: [
          "budgeted packet with provenance",
          "cannot change authority",
        ],
        anchors: [
          { kind: "file", ref: "server/src/services/gbrain-microplane.ts" },
          "docs/work-orders/organization-kernel/WO-OK-09-gbrain-microplane.md",
        ],
        authority: {
          companyId: "company-1",
          issueId: "issue-9",
          role: "implementer",
        },
        continuation: {
          cursor: "ckpt-4",
          checkpointTurn: 4,
          next: "write unit tests",
        },
      },
      {
        facts: ["OK-07 continuation packets already land compact escalations"],
        fingerprints: fps,
        decisions: ["advisory only; no binding policy"],
        tokenBudget: 8_000,
        sources: ["episode-store", "fingerprint-store"],
        compiledAt: FIXED_AT,
      },
    );

    expect(packet.schemaVersion).toBe(CONTEXT_PACKET_SCHEMA);
    expect(packet.advisory).toBe(true);
    expect(packet.goal).toContain("GBrain");
    expect(packet.scope).toEqual([
      "episodes",
      "fingerprints",
      "context compile",
    ]);
    expect(packet.nonGoals).toHaveLength(2);
    expect(packet.acceptance).toHaveLength(2);
    expect(packet.anchors).toHaveLength(2);
    expect(packet.anchors[1]).toEqual({
      kind: "ref",
      ref: "docs/work-orders/organization-kernel/WO-OK-09-gbrain-microplane.md",
    });
    expect(packet.authority).toEqual({
      companyId: "company-1",
      issueId: "issue-9",
      role: "implementer",
    });
    expect(packet.knownFailures).toHaveLength(3);
    expect(packet.continuation).toEqual({
      cursor: "ckpt-4",
      checkpointTurn: 4,
      next: "write unit tests",
    });
    expect(packet.facts).toHaveLength(1);
    expect(packet.decisions).toEqual(["advisory only; no binding policy"]);
    expect(packet.provenance).toMatchObject({
      compiledAt: FIXED_AT,
      sources: ["episode-store", "fingerprint-store"],
      tokenBudget: 8_000,
      truncated: false,
    });
    expect(packet.provenance.estimatedTokens).toBeGreaterThan(0);
    expect(packet).not.toHaveProperty("bindingPolicy");
    expect(packet).not.toHaveProperty("authorityGrant");
  });

  it("caps knownFailures at MAX_KNOWN_FAILURES (3)", () => {
    const fingerprints = Array.from({ length: 8 }, (_, i) =>
      sampleFingerprint({
        errorCode: `err_${i}`,
        message: `failure number ${i} with unique text`,
      }),
    );
    const packet = compileContextPacket(
      { goal: "cap failures" },
      { fingerprints, tokenBudget: 8_000, compiledAt: FIXED_AT },
    );
    expect(MAX_KNOWN_FAILURES).toBe(3);
    expect(packet.knownFailures).toHaveLength(3);
  });

  it("enforces tokenBudget by truncating advisory fields", () => {
    const longFacts = Array.from(
      { length: 20 },
      (_, i) => `fact-${i}: ${"x".repeat(200)}`,
    );
    const longDecisions = Array.from(
      { length: 10 },
      (_, i) => `decision-${i}: ${"y".repeat(200)}`,
    );
    const fingerprints = Array.from({ length: 3 }, (_, i) =>
      sampleFingerprint({
        errorCode: `err_${i}`,
        message: `unique failure ${i} ${"z".repeat(100)}`,
        recoveryHint: `hint ${i} ${"h".repeat(100)}`,
      }),
    );

    const packet = compileContextPacket(
      {
        goal: "tight budget compile",
        scope: Array.from(
          { length: 10 },
          (_, i) => `scope-${i}-${"s".repeat(80)}`,
        ),
        nonGoals: Array.from(
          { length: 10 },
          (_, i) => `nongoal-${i}-${"n".repeat(80)}`,
        ),
        acceptance: ["done"],
      },
      {
        facts: longFacts,
        decisions: longDecisions,
        fingerprints,
        tokenBudget: 400,
        compiledAt: FIXED_AT,
      },
    );

    expect(packet.provenance.truncated).toBe(true);
    expect(packet.provenance.tokenBudget).toBe(400);
    expect(packet.provenance.estimatedTokens).toBeLessThanOrEqual(400 + 40);
    expect(packet.goal).toBeTruthy();
    expect(packet.advisory).toBe(true);
    expect(
      packet.facts.length +
        packet.decisions.length +
        packet.knownFailures.length,
    ).toBeLessThan(20 + 10 + 3);
  });

  it("uses DEFAULT_CONTEXT_TOKEN_BUDGET when tokenBudget omitted", () => {
    const packet = compileContextPacket(
      { goal: "default budget" },
      { compiledAt: FIXED_AT },
    );
    expect(packet.provenance.tokenBudget).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);
  });

  it("requires goal and rejects tiny budgets", () => {
    expect(() => compileContextPacket({ goal: "" })).toThrow("goal is required");
    expect(() =>
      compileContextPacket({ goal: "x" }, { tokenBudget: 10 }),
    ).toThrow("tokenBudget must be at least 64");
  });

  it("never includes authority-change fields on a valid packet", () => {
    const packet = compileContextPacket(
      {
        goal: "safe packet",
        authority: { companyId: "c1", role: "reviewer" },
      },
      { compiledAt: FIXED_AT },
    );
    for (const key of FORBIDDEN_AUTHORITY_KEYS) {
      expect(packet).not.toHaveProperty(key);
    }
    expect(() => assertContextPacketIsAdvisory(packet)).not.toThrow();
  });
});

describe("assertContextPacketIsAdvisory", () => {
  function basePacket(): ContextPacket {
    return compileContextPacket({ goal: "base" }, { compiledAt: FIXED_AT });
  }

  it("accepts a clean advisory packet", () => {
    expect(() => assertContextPacketIsAdvisory(basePacket())).not.toThrow();
  });

  it("rejects packets with advisory !== true", () => {
    const bad = { ...basePacket(), advisory: false };
    expect(() => assertContextPacketIsAdvisory(bad)).toThrow(
      ContextPacketAuthorityError,
    );
  });

  it("rejects top-level bindingPolicy / authorityGrant keys", () => {
    const withBinding = {
      ...basePacket(),
      bindingPolicy: { allow: true },
    };
    expect(() => assertContextPacketIsAdvisory(withBinding)).toThrow(
      /bindingPolicy/,
    );

    const withGrant = {
      ...basePacket(),
      authorityGrant: { role: "admin" },
    };
    expect(() => assertContextPacketIsAdvisory(withGrant)).toThrow(
      /authorityGrant/,
    );
  });

  it("rejects nested forbidden keys", () => {
    const smuggled = {
      ...basePacket(),
      continuation: {
        cursor: "x",
        policyPromotion: { promote: true },
      } as unknown as ContextPacket["continuation"],
    };
    expect(() => assertContextPacketIsAdvisory(smuggled)).toThrow(
      ContextPacketAuthorityError,
    );
  });

  it("rejects non-object packets", () => {
    expect(() => assertContextPacketIsAdvisory(null)).toThrow(
      "context packet must be an object",
    );
    expect(() => assertContextPacketIsAdvisory("nope")).toThrow(
      "context packet must be an object",
    );
  });
});

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateJsonTokens({ a: 1 })).toBeGreaterThan(0);
  });
});
