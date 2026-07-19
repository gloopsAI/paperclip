import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EventStreamEvidenceAccumulator,
  canonicalJsonBytes,
  parseJsonEntityBytes,
  reconcileProviderIoEvidence,
} from "./provider-evidence.js";

const requestBody = JSON.stringify({ input: "test" });
const requestSha256 = createHash("sha256").update(requestBody).digest("hex");

function terminalEnvelope(overrides: Record<string, unknown> = {}) {
  const projection = {
    schemaVersion: "gloops.hermes-terminal-evidence.v1",
    hermesRunId: "run-1",
    requestByteLength: Buffer.byteLength(requestBody),
    requestSha256,
    resolvedProvider: "ollama-cloud",
    resolvedModel: "qwen3-coder",
    transportClass: "openai_chat_completions",
    billingClass: "subscription_included",
    fallbackPath: [{
      provider: "ollama-cloud",
      model: "qwen3-coder",
      transportClass: "openai_chat_completions",
      billingClass: "subscription_included",
    }],
    inputUsage: { present: true, value: 3 },
    outputUsage: { present: true, value: 2 },
    cachedUsage: { present: true, value: 0 },
    usageSource: "provider_response_aggregate",
    turnTotal: 1,
    toolCallTotal: 0,
    terminalStatus: "completed",
    ...overrides,
  };
  const terminalEvidenceDigest = createHash("sha256")
    .update(Buffer.from("gloops.hermes-terminal-evidence.v1\0"))
    .update(canonicalJsonBytes(projection))
    .digest("hex");
  return { terminalEvidence: projection, terminalEvidenceDigest };
}

function fixture(overrides: {
  envelope?: ReturnType<typeof terminalEnvelope>;
  terminal?: Record<string, unknown>;
  final?: Record<string, unknown>;
} = {}) {
  const envelope = overrides.envelope ?? terminalEnvelope();
  const terminal = {
    event: "run.completed",
    run_id: "run-1",
    status: "completed",
    usage: { input_tokens: 3, output_tokens: 2 },
    ...envelope,
    ...overrides.terminal,
  };
  const final = {
    run_id: "run-1",
    status: "completed",
    usage: { input_tokens: 3, output_tokens: 2 },
    ...envelope,
    ...overrides.final,
  };
  const stream = new EventStreamEvidenceAccumulator();
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`);
  stream.recordRawChunk(bytes);
  stream.recordEvent("run.completed", terminal);
  return {
    preparedRequest: {
      requestByteLength: Buffer.byteLength(requestBody),
      requestSha256: `sha256:${requestSha256}`,
    },
    hermesRunId: "run-1",
    createResponse: parseJsonEntityBytes(
      new TextEncoder().encode(JSON.stringify({ run_id: "run-1" })),
    ),
    eventStream: stream.finalize(),
    terminalEvent: terminal,
    finalStatusResponse: parseJsonEntityBytes(
      new TextEncoder().encode(JSON.stringify(final)),
    ),
  };
}

describe("terminal provider evidence", () => {
  it("reconciles exact transport bytes with one semantic terminal projection", () => {
    const receipt = reconcileProviderIoEvidence(fixture());
    expect(receipt).toMatchObject({
      schemaVersion: "gloops.provider-io-terminal.v1",
      hermesRunId: "run-1",
      rawPayloadDisposition: "not_retained",
      terminalEvidence: {
        resolvedProvider: "ollama-cloud",
        inputUsage: { present: true, value: 3 },
      },
    });
    expect(receipt.createResponse.rawSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.eventStream.canonicalEventSequenceSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("makes raw stream evidence independent of network chunk boundaries", () => {
    const bytes = new TextEncoder().encode("one complete byte stream");
    const whole = new EventStreamEvidenceAccumulator();
    whole.recordRawChunk(bytes);
    whole.recordEvent("message", { value: 1 });
    const split = new EventStreamEvidenceAccumulator();
    split.recordRawChunk(bytes.slice(0, 3));
    split.recordRawChunk(bytes.slice(3, 11));
    split.recordRawChunk(bytes.slice(11));
    split.recordEvent("message", { value: 1 });
    expect(split.finalize()).toEqual(whole.finalize());
  });

  it("rejects terminal-event and final-status semantic contradictions", () => {
    const contradictory = terminalEnvelope({ resolvedModel: "other-model" });
    expect(() => reconcileProviderIoEvidence(fixture({
      final: contradictory,
    }))).toThrow("SSE and final terminal evidence contradict");
  });

  it("retains a failed terminal receipt without inventing route or usage facts", () => {
    const envelope = terminalEnvelope({
      resolvedProvider: "",
      resolvedModel: "",
      transportClass: "",
      billingClass: "",
      fallbackPath: [],
      inputUsage: { present: false, value: 0 },
      outputUsage: { present: false, value: 0 },
      cachedUsage: { present: false, value: 0 },
      usageSource: "unavailable",
      turnTotal: 0,
      terminalStatus: "failed",
    });
    const receipt = reconcileProviderIoEvidence(fixture({
      envelope,
      terminal: { event: "run.failed", status: "failed", usage: {} },
      final: { status: "failed", usage: {} },
    }));
    expect(receipt.terminalEvidence).toMatchObject({
      terminalStatus: "failed",
      resolvedProvider: "",
      inputUsage: { present: false, value: 0 },
    });
  });

  it("distinguishes changed raw encoding from unchanged canonical semantics", () => {
    const compact = parseJsonEntityBytes(new TextEncoder().encode('{"run_id":"run-1"}'));
    const spaced = parseJsonEntityBytes(new TextEncoder().encode('{ "run_id": "run-1" }'));
    expect(compact.evidence.rawSha256).not.toBe(spaced.evidence.rawSha256);
    expect(compact.evidence.canonicalSha256).toBe(spaced.evidence.canonicalSha256);
  });
});
