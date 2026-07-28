import { describe, expect, it } from "vitest";
import {
  CONTINUATION_CHECKPOINT_SCHEMA,
  DEFAULT_ESCALATION_PACKET_MAX_CHARS,
  ESCALATION_PACKET_SCHEMA,
  FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS,
  TWO_STRIKE_TOOL_FAILURES,
  assertEscalationPacketSize,
  assertNoTranscriptFields,
  buildContinuationCheckpoint,
  buildEscalationPacket,
  checkEscalationPacketSize,
  EscalationPacketSizeError,
  EscalationPacketTranscriptError,
  measureEscalationPacketChars,
  shouldForceStop,
  type EscalationPacket,
} from "./continuation-packet.js";

const FIXED_AT = "2026-07-28T12:00:00.000Z";

function baseEscalationInput(
  overrides: Partial<Parameters<typeof buildEscalationPacket>[0]> = {},
) {
  return {
    intent: "Land compact continuation protocol without transcript resend",
    currentState:
      "Checkpoint turn 6 complete; two identical shell failures on missing binary",
    attempts: [
      {
        turn: 5,
        summary: "Tried install via apt; package not found",
        tool: "shell",
        errorCode: "package_not_found",
        at: "2026-07-28T11:58:00.000Z",
      },
      {
        turn: 6,
        summary: "Retried identical apt install; same package_not_found",
        tool: "shell",
        errorCode: "package_not_found",
        at: "2026-07-28T11:59:00.000Z",
      },
    ],
    failureFingerprint: "tool:shell|error:package_not_found|v1",
    nonGoals: ["do not rewrite the runtime", "do not escalate full transcript"],
    authority: {
      companyId: "company-1",
      issueId: "issue-1",
      runId: "run-1",
      assigneeAgentId: "agent-1",
    },
    remainingBudget: {
      turnsRemaining: 2,
      maxTurns: 12,
      uncachedTokensRemaining: 40_000,
      maxUncachedTokens: 200_000,
    },
    requiredTerminalArtifact: "escalation packet + force-stop decision receipt",
    createdAt: FIXED_AT,
    ...overrides,
  };
}

describe("buildContinuationCheckpoint", () => {
  it("builds a structured checkpoint with schema, turn progress, and usage", () => {
    const checkpoint = buildContinuationCheckpoint({
      turn: 4,
      completed: ["read work order", "draft types"],
      next: "write unit tests",
      blocked: null,
      anchors: [
        { kind: "file", ref: "server/src/services/continuation-packet.ts" },
        "docs/work-orders/organization-kernel/WO-OK-07-continuation.md",
      ],
      usage: {
        turns: 4,
        uncachedTokens: 12_500,
        cachedTokens: 80_000,
        totalTokens: 92_500,
        identicalToolFailures: 0,
      },
      createdAt: FIXED_AT,
    });

    expect(checkpoint).toEqual({
      schemaVersion: CONTINUATION_CHECKPOINT_SCHEMA,
      turn: 4,
      completed: ["read work order", "draft types"],
      next: "write unit tests",
      blocked: null,
      anchors: [
        {
          kind: "file",
          ref: "server/src/services/continuation-packet.ts",
          label: null,
        },
        {
          kind: "ref",
          ref: "docs/work-orders/organization-kernel/WO-OK-07-continuation.md",
        },
      ],
      usage: {
        turns: 4,
        uncachedTokens: 12_500,
        cachedTokens: 80_000,
        totalTokens: 92_500,
        identicalToolFailures: 0,
      },
      createdAt: FIXED_AT,
    });
  });

  it("bounds oversized completed/next/blocked entries and caps list sizes", () => {
    const long = "x".repeat(2_000);
    const checkpoint = buildContinuationCheckpoint({
      turn: 1,
      completed: Array.from({ length: 50 }, (_, i) => `step-${i}-${long}`),
      next: long,
      blocked: long,
      anchors: Array.from({ length: 40 }, (_, i) => ({
        kind: "file",
        ref: `file-${i}.ts`,
      })),
      usage: { turns: 1, uncachedTokens: 0 },
      createdAt: FIXED_AT,
    });

    expect(checkpoint.completed).toHaveLength(32);
    expect(checkpoint.completed[0]!.endsWith("[truncated]")).toBe(true);
    expect(checkpoint.next!.endsWith("[truncated]")).toBe(true);
    expect(checkpoint.blocked!.endsWith("[truncated]")).toBe(true);
    expect(checkpoint.anchors).toHaveLength(16);
  });

  it("rejects invalid turn/usage values", () => {
    expect(() =>
      buildContinuationCheckpoint({
        turn: -1,
        completed: [],
        next: null,
        blocked: null,
        anchors: [],
        usage: { turns: 0, uncachedTokens: 0 },
      }),
    ).toThrow("turn must be a non-negative integer");

    expect(() =>
      buildContinuationCheckpoint({
        turn: 1,
        completed: [],
        next: null,
        blocked: null,
        anchors: [],
        usage: { turns: 1.5, uncachedTokens: 0 },
      }),
    ).toThrow("usage.turns must be a non-negative integer");
  });
});

describe("buildEscalationPacket", () => {
  it("builds a compact packet without transcript fields", () => {
    const packet = buildEscalationPacket(baseEscalationInput());

    expect(packet.schemaVersion).toBe(ESCALATION_PACKET_SCHEMA);
    expect(packet.intent).toContain("compact continuation");
    expect(packet.attempts).toHaveLength(2);
    expect(packet.failureFingerprint).toBe(
      "tool:shell|error:package_not_found|v1",
    );
    expect(packet.authority.companyId).toBe("company-1");
    expect(packet.remainingBudget.maxUncachedTokens).toBe(200_000);
    expect(packet.createdAt).toBe(FIXED_AT);

    for (const key of FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(packet, key)).toBe(false);
      expect((packet as Record<string, unknown>)[key]).toBeUndefined();
    }

    // Serialized form must also omit transcript keys.
    const serialized = JSON.stringify(packet);
    for (const key of FORBIDDEN_ESCALATION_TRANSCRIPT_KEYS) {
      expect(serialized.includes(`"${key}"`)).toBe(false);
    }
  });

  it("rejects input that carries full-transcript fields", () => {
    expect(() =>
      buildEscalationPacket({
        ...baseEscalationInput(),
        // @ts-expect-error intentional forbidden field
        messages: [{ role: "user", content: "huge transcript" }],
      }),
    ).toThrow(EscalationPacketTranscriptError);

    expect(() =>
      buildEscalationPacket({
        ...baseEscalationInput(),
        // @ts-expect-error intentional forbidden field
        transcript: "full conversation dump",
      }),
    ).toThrow(/transcript fields/);

    expect(() =>
      buildEscalationPacket(
        baseEscalationInput({
          attempts: [
            {
              summary: "ok",
              // @ts-expect-error intentional forbidden nested field
              messages: [{ role: "assistant", content: "nope" }],
            },
          ],
        }),
      ),
    ).toThrow(EscalationPacketTranscriptError);
  });

  it("requires intent, currentState, fingerprint, authority, and terminal artifact", () => {
    expect(() =>
      buildEscalationPacket(baseEscalationInput({ intent: "   " })),
    ).toThrow("intent is required");
    expect(() =>
      buildEscalationPacket(baseEscalationInput({ currentState: "" })),
    ).toThrow("currentState is required");
    expect(() =>
      buildEscalationPacket(baseEscalationInput({ failureFingerprint: "" })),
    ).toThrow("failureFingerprint is required");
    expect(() =>
      buildEscalationPacket(
        baseEscalationInput({ requiredTerminalArtifact: "" }),
      ),
    ).toThrow("requiredTerminalArtifact is required");
    expect(() =>
      buildEscalationPacket(
        baseEscalationInput({
          authority: { companyId: "" },
        }),
      ),
    ).toThrow("authority.companyId is required");
  });

  it("caps attempts and nonGoals and bounds long summaries", () => {
    const packet = buildEscalationPacket(
      baseEscalationInput({
        attempts: Array.from({ length: 20 }, (_, i) => ({
          turn: i,
          summary: `attempt ${i} ${"y".repeat(1_000)}`,
        })),
        nonGoals: Array.from({ length: 30 }, (_, i) => `non-goal-${i}`),
      }),
    );
    expect(packet.attempts).toHaveLength(8);
    expect(packet.attempts[0]!.summary.endsWith("[truncated]")).toBe(true);
    expect(packet.nonGoals).toHaveLength(16);
  });
});

describe("assertEscalationPacketSize / checkEscalationPacketSize", () => {
  it("accepts compact packets under the default 12k char cap", () => {
    const packet = buildEscalationPacket(baseEscalationInput());
    const chars = measureEscalationPacketChars(packet);
    expect(chars).toBeLessThan(DEFAULT_ESCALATION_PACKET_MAX_CHARS);

    const checked = checkEscalationPacketSize(packet);
    expect(checked).toEqual({
      ok: true,
      chars,
      maxChars: DEFAULT_ESCALATION_PACKET_MAX_CHARS,
    });

    expect(assertEscalationPacketSize(packet)).toEqual({
      ok: true,
      chars,
      maxChars: DEFAULT_ESCALATION_PACKET_MAX_CHARS,
    });
  });

  it("returns an error result when over the soft check cap", () => {
    const packet = buildEscalationPacket(baseEscalationInput());
    const chars = measureEscalationPacketChars(packet);
    const result = checkEscalationPacketSize(packet, 10);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected size failure");
    expect(result.chars).toBe(chars);
    expect(result.maxChars).toBe(10);
    expect(result.error).toContain("exceeds size cap");
  });

  it("throws EscalationPacketSizeError when hard assert fails", () => {
    const packet = buildEscalationPacket(baseEscalationInput());
    expect(() => assertEscalationPacketSize(packet, 50)).toThrow(
      EscalationPacketSizeError,
    );
    try {
      assertEscalationPacketSize(packet, 50);
    } catch (error) {
      expect(error).toBeInstanceOf(EscalationPacketSizeError);
      const sizeError = error as EscalationPacketSizeError;
      expect(sizeError.code).toBe("escalation_packet.size_exceeded");
      expect(sizeError.maxChars).toBe(50);
      expect(sizeError.chars).toBeGreaterThan(50);
    }
  });

  it("refuses packets that smuggle transcript keys at assert time", () => {
    const packet = buildEscalationPacket(baseEscalationInput());
    const smuggled = {
      ...packet,
      messages: [{ role: "user", content: "should never escalate" }],
    } as EscalationPacket;

    expect(() => assertEscalationPacketSize(smuggled)).toThrow(
      EscalationPacketTranscriptError,
    );
    expect(() => assertNoTranscriptFields(smuggled)).toThrow(
      /transcript fields/,
    );
  });
});

describe("shouldForceStop", () => {
  it("continues when under all envelopes", () => {
    expect(
      shouldForceStop({
        turns: 3,
        maxTurns: 12,
        identicalToolFailures: 1,
        uncachedTokens: 10_000,
        maxUncached: 200_000,
      }),
    ).toEqual({ stop: false, reasons: [] });
  });

  it("stops on turn cap", () => {
    expect(
      shouldForceStop({
        turns: 12,
        maxTurns: 12,
        identicalToolFailures: 0,
        uncachedTokens: 1,
        maxUncached: 200_000,
      }),
    ).toEqual({ stop: true, reasons: ["turn_cap"] });
  });

  it("stops on two-strike identical tool failures", () => {
    expect(TWO_STRIKE_TOOL_FAILURES).toBe(2);
    expect(
      shouldForceStop({
        turns: 4,
        maxTurns: 12,
        identicalToolFailures: 2,
        uncachedTokens: 1,
        maxUncached: 200_000,
      }),
    ).toEqual({ stop: true, reasons: ["two_strike_tools"] });

    expect(
      shouldForceStop({
        turns: 4,
        maxTurns: 12,
        identicalToolFailures: 1,
        uncachedTokens: 1,
        maxUncached: 200_000,
      }).stop,
    ).toBe(false);
  });

  it("stops on uncached token envelope exhaustion", () => {
    expect(
      shouldForceStop({
        turns: 2,
        maxTurns: 12,
        identicalToolFailures: 0,
        uncachedTokens: 200_000,
        maxUncached: 200_000,
      }),
    ).toEqual({ stop: true, reasons: ["uncached_token_envelope"] });
  });

  it("aggregates multiple stop reasons", () => {
    expect(
      shouldForceStop({
        turns: 20,
        maxTurns: 10,
        identicalToolFailures: 3,
        uncachedTokens: 500_000,
        maxUncached: 100_000,
      }),
    ).toEqual({
      stop: true,
      reasons: ["turn_cap", "two_strike_tools", "uncached_token_envelope"],
    });
  });

  it("rejects malformed counters", () => {
    expect(() =>
      shouldForceStop({
        turns: -1,
        maxTurns: 10,
        identicalToolFailures: 0,
        uncachedTokens: 0,
        maxUncached: 1,
      }),
    ).toThrow("turns must be a non-negative integer");
  });
});

describe("escalation packet size realism", () => {
  it("keeps a realistic multi-attempt escalate well under 12k chars", () => {
    const packet = buildEscalationPacket(
      baseEscalationInput({
        attempts: Array.from({ length: 8 }, (_, i) => ({
          turn: i + 1,
          summary: `Attempt ${i + 1}: bounded tool failure with fingerprint detail`,
          tool: "shell",
          errorCode: "package_not_found",
        })),
        nonGoals: [
          "no full transcript",
          "no multi-million token resend",
          "no authority rewrite",
        ],
      }),
    );
    const chars = measureEscalationPacketChars(packet);
    expect(chars).toBeLessThan(4_000);
    expect(assertEscalationPacketSize(packet).ok).toBe(true);
  });
});
