import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterProviderIoTerminalEvidence } from "@paperclipai/adapter-utils";
import { createHash } from "node:crypto";
import { buildBoundExecutionContext } from "@paperclipai/adapter-utils/execution-envelope";
import {
  buildEmptyResumeLedger,
  buildPreDispatchReadinessReport,
  buildPreflightSummary,
  buildReleasedReservation,
  evaluateRepairLadder,
  hasCompletedSideEffect,
  prepareWorkspaceBeforeDispatch,
  readResumeLedger,
  recordResumeSideEffect,
  reconcileTerminalAcrossProjections,
  ZERO_USAGE,
} from "./preflight.js";

function compactPacket() {
  const stable = (value: unknown): unknown => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
      : value;
  const serialize = (value: unknown) => JSON.stringify(stable(value));
  const body = { schemaVersion: "gloops.continuation-packet.v1", work: { id: "GLO-1649" }, cursor: { next: "verify" } };
  const digest = `sha256:${createHash("sha256").update(serialize(body)).digest("hex")}`;
  let serializedBytes = 1;
  let result: Record<string, unknown> = {};
  for (let i = 0; i < 10; i += 1) {
    result = { ...body, digest, metrics: { serializedBytes, approximateTokens: Math.ceil(serializedBytes / 4) } };
    const next = Buffer.byteLength(serialize(result));
    if (next === serializedBytes) break;
    serializedBytes = next;
  }
  result.metrics = { serializedBytes, approximateTokens: Math.ceil(serializedBytes / 4) };
  return result;
}

function makeCtx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "pc-run-preflight",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {
      issueId: "issue-preflight",
      wakeReason: "manual",
      paperclipWake: { issue: { identifier: "GLO-1649", title: "Closure" } },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onProviderRequestPrepared: vi.fn(async (evidence) => ({
      schemaVersion: "gloops.provider-request-prepared-ack.v1" as const,
      evidenceId: "evidence-1",
      requestSha256: evidence.requestSha256,
      acknowledgedAt: new Date().toISOString(),
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildPreDispatchReadinessReport", () => {
  it("reports ready when every capability probe passes", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const report = await buildPreDispatchReadinessReport(ctx, {
      fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
      gitHead: async () => ({ head: "a".repeat(40), error: null }),
      probeHermesWrite: async () => ({ ok: true, reason: "ok" }),
      probeTestRuntime: async () => ({ ok: true, reason: "ok" }),
    });
    expect(report.ready).toBe(true);
    expect(report.level).toBe("ready");
    const capabilities = report.checks.map((c) => c.capability);
    expect(capabilities).toEqual(
      expect.arrayContaining([
        "workspace_present",
        "workspace_writable",
        "workspace_aligned",
        "git_tooling",
        "hermes_write_capability",
        "test_runtime",
        "binding_valid",
      ]),
    );
    expect(report.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("blocks when the workspace is missing", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/does/not/exist" };
    const report = await buildPreDispatchReadinessReport(ctx, {
      fsStat: async () => ({ exists: false, writable: false, isDirectory: false }),
      gitHead: async () => ({ head: null, error: "no such file" }),
      probeHermesWrite: async () => ({ ok: true, reason: "ok" }),
      probeTestRuntime: async () => ({ ok: true, reason: "ok" }),
    });
    expect(report.ready).toBe(false);
    expect(report.level).toBe("blocked");
    const aligned = report.checks.find((c) => c.capability === "workspace_present");
    expect(aligned?.passed).toBe(false);
  });

  it("blocks when the workspace HEAD does not match the declared head", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      expectedWorkspaceHeadSha: "0".repeat(40),
    });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const report = await buildPreDispatchReadinessReport(ctx, {
      fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
      gitHead: async () => ({ head: "f".repeat(40), error: null }),
      probeHermesWrite: async () => ({ ok: true, reason: "ok" }),
      probeTestRuntime: async () => ({ ok: true, reason: "ok" }),
    });
    const aligned = report.checks.find((c) => c.capability === "workspace_aligned");
    expect(aligned?.passed).toBe(false);
    expect(report.level).toBe("blocked");
  });

  it("marks degraded (not blocked) when only the optional test runtime is missing", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const report = await buildPreDispatchReadinessReport(ctx, {
      fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
      gitHead: async () => ({ head: "a".repeat(40), error: null }),
      probeHermesWrite: async () => ({ ok: true, reason: "ok" }),
      probeTestRuntime: async () => ({ ok: false, reason: "no focused_test" }),
    });
    expect(report.level).toBe("degraded");
    expect(report.ready).toBe(false);
  });

  it("produces a stable digest for identical inputs (idempotency)", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const probe = {
      fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
      gitHead: async () => ({ head: "a".repeat(40), error: null }),
      probeHermesWrite: async () => ({ ok: true, reason: "ok" }),
      probeTestRuntime: async () => ({ ok: true, reason: "ok" }),
    };
    const a = await buildPreDispatchReadinessReport(ctx, probe);
    const b = await buildPreDispatchReadinessReport(ctx, probe);
    expect(a.digest).toEqual(b.digest);
  });

  it("rejects malformed expected head and surfaces a blocking failure", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      expectedWorkspaceHeadSha: "not-a-sha",
    });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const report = await buildPreDispatchReadinessReport(ctx, {
      fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
      gitHead: async () => ({ head: "a".repeat(40), error: null }),
      probeHermesWrite: async () => ({ ok: true, reason: "ok" }),
      probeTestRuntime: async () => ({ ok: true, reason: "ok" }),
    });
    const aligned = report.checks.find((c) => c.capability === "workspace_aligned");
    expect(aligned?.passed).toBe(false);
    expect(report.level).toBe("blocked");
  });
});

describe("reconcileTerminalAcrossProjections", () => {
  function buildRunEvidence(): AdapterProviderIoTerminalEvidence {
    const projection = {
      schemaVersion: "gloops.hermes-terminal-evidence.v1" as const,
      hermesRunId: "run-1",
      requestByteLength: 100,
      requestSha256: "0".repeat(64),
      resolvedProvider: "ollama-cloud",
      resolvedModel: "qwen3-coder",
      transportClass: "openai_chat_completions",
      billingClass: "subscription_included",
      fallbackPath: [],
      inputUsage: { present: true, value: 10 },
      outputUsage: { present: true, value: 5 },
      cachedUsage: { present: false, value: 0 },
      usageSource: "provider_response_aggregate",
      turnTotal: 1,
      toolCallTotal: 0,
      terminalStatus: "completed" as const,
    };
    const terminalEvidenceDigest = `sha256:${createHash("sha256").update(Buffer.from("gloops.hermes-terminal-evidence.v1\0", "utf8")).update(Buffer.from(JSON.stringify({
      ...projection,
      fallbackPath: projection.fallbackPath,
      inputUsage: projection.inputUsage,
      outputUsage: projection.outputUsage,
      cachedUsage: projection.cachedUsage,
    }))).digest("hex")}`;
    return {
      schemaVersion: "gloops.provider-io-terminal.v1",
      preparedRequest: { requestByteLength: 100, requestSha256: "sha256:" + "0".repeat(64) },
      hermesRunId: "run-1",
      createResponse: { rawByteLength: 0, rawSha256: "sha256:" + "0".repeat(64), canonicalSha256: "sha256:" + "0".repeat(64) },
      eventStream: { rawByteLength: 0, rawSha256: "sha256:" + "0".repeat(64), canonicalEventSequenceSha256: "sha256:" + "0".repeat(64), eventCount: 1 },
      finalStatusResponse: { rawByteLength: 0, rawSha256: "sha256:" + "0".repeat(64), canonicalSha256: "sha256:" + "0".repeat(64) },
      terminalEvidence: projection,
      terminalEvidenceDigest,
      rawPayloadDisposition: "not_retained",
      reconciledAt: "2026-07-26T12:00:00.000Z",
    };
  }

  it("returns matched disposition when run/issue/projection all agree", () => {
    const run = buildRunEvidence();
    const report = reconcileTerminalAcrossProjections({
      runTerminalEvidence: run,
      issueProjection: {
        issueId: "issue-1",
        terminalEvidenceDigest: run.terminalEvidenceDigest,
        terminalStatus: "completed",
        hermesRunId: "run-1",
      },
      prProjection: {
        prNumber: 1,
        terminalEvidenceDigest: run.terminalEvidenceDigest,
        terminalStatus: "completed",
      },
    });
    expect(report.disposition).toBe("matched");
    expect(report.mismatches).toEqual([]);
  });

  it("returns diverged_run_vs_issue when only issue projection disagrees", () => {
    const run = buildRunEvidence();
    const report = reconcileTerminalAcrossProjections({
      runTerminalEvidence: run,
      issueProjection: {
        issueId: "issue-1",
        terminalEvidenceDigest: "sha256:" + "f".repeat(64),
        terminalStatus: "completed",
        hermesRunId: "run-1",
      },
      prProjection: null,
    });
    expect(report.disposition).toBe("diverged_run_vs_issue");
    expect(report.mismatches).toContain("run evidence digest diverges from issue projection");
  });

  it("returns missing_run_evidence when run evidence is absent", () => {
    const report = reconcileTerminalAcrossProjections({
      runTerminalEvidence: null,
      issueProjection: null,
      prProjection: null,
    });
    expect(report.disposition).toBe("missing_run_evidence");
  });

  it("returns unreconciled when both issue and pr projections are null", () => {
    const run = buildRunEvidence();
    const report = reconcileTerminalAcrossProjections({
      runTerminalEvidence: run,
      issueProjection: null,
      prProjection: null,
    });
    expect(report.disposition).toBe("unreconciled");
    expect(report.mismatches).toEqual([]);
  });

  it("digest is stable across replays even when observedAt differs", () => {
    const run = buildRunEvidence();
    const input = {
      runTerminalEvidence: run,
      issueProjection: {
        issueId: "issue-1",
        terminalEvidenceDigest: run.terminalEvidenceDigest,
        terminalStatus: "completed",
        hermesRunId: "run-1",
      },
      prProjection: null,
    } as const;
    const a = reconcileTerminalAcrossProjections(input);
    const b = reconcileTerminalAcrossProjections(input);
    expect(a.digest).toEqual(b.digest);
  });

  it("is idempotent for the same canonicalized inputs", () => {
    const run = buildRunEvidence();
    const a = reconcileTerminalAcrossProjections({
      runTerminalEvidence: run,
      issueProjection: {
        issueId: "issue-1",
        terminalEvidenceDigest: run.terminalEvidenceDigest,
        terminalStatus: "completed",
        hermesRunId: "run-1",
      },
      prProjection: null,
    });
    const b = reconcileTerminalAcrossProjections({
      runTerminalEvidence: run,
      issueProjection: {
        issueId: "issue-1",
        terminalEvidenceDigest: run.terminalEvidenceDigest,
        terminalStatus: "completed",
        hermesRunId: "run-1",
      },
      prProjection: null,
    });
    expect(a.digest).toEqual(b.digest);
    expect(a.disposition).toEqual(b.disposition);
  });
});

describe("prepareWorkspaceBeforeDispatch", () => {
  it("returns error when cwd is missing", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    const result = await prepareWorkspaceBeforeDispatch(ctx, null);
    expect(result.error).toMatch(/cwd is missing/);
    expect(result.writable).toBeNull();
  });

  it("returns success when everything is in order", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const result = await prepareWorkspaceBeforeDispatch(ctx, null, {
      probe: {
        fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
        runProcess: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      applyPatchPath: "/opt/data/bin/apply_patch",
      focusedTestPath: "/opt/data/bin/focused_test",
    });
    expect(result.error).toBeNull();
    expect(result.clean).toBe(true);
    expect(result.writable).toBe(true);
    expect(result.applyPatchOk).toBe(true);
    expect(result.testRuntimeOk).toBe(true);
  });

  it("passes workspace cwd to the default git probe", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "key-1" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const result = await prepareWorkspaceBeforeDispatch(ctx, null, {
      probe: {
        fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
        runProcess: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      applyPatchPath: "/opt/data/bin/apply_patch",
      focusedTestPath: "/opt/data/bin/focused_test",
    });
    expect(result.error).toBeNull();
    expect(result.actual).toBe("a".repeat(40));
  });

  it("returns error when HEAD does not match the declared head", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "k",
      expectedWorkspaceHeadSha: "0".repeat(40),
    });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const result = await prepareWorkspaceBeforeDispatch(ctx, null, {
      probe: {
        fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
        runProcess: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { exitCode: 0, stdout: "f".repeat(40) + "\n", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      applyPatchPath: "/opt/data/bin/apply_patch",
      focusedTestPath: "/opt/data/bin/focused_test",
    });
    expect(result.error).toMatch(/does not match declared head/);
    expect(result.clean).toBe(false);
  });

  it("returns error when the test runtime is missing", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const result = await prepareWorkspaceBeforeDispatch(ctx, null, {
      probe: {
        fsStat: async (path) => {
          if (path.endsWith("apply_patch")) return { exists: true, writable: true, isDirectory: false };
          if (path.endsWith("focused_test")) return { exists: false, writable: false, isDirectory: false };
          return { exists: true, writable: true, isDirectory: true };
        },
        runProcess: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      applyPatchPath: "/opt/data/bin/apply_patch",
      focusedTestPath: "/opt/data/bin/focused_test",
    });
    expect(result.error).toMatch(/test_runtime=false/);
    expect(result.testRuntimeOk).toBe(false);
  });

  it("returns error when the workspace is dirty", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "k" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const result = await prepareWorkspaceBeforeDispatch(ctx, null, {
      probe: {
        fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
        runProcess: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { exitCode: 0, stdout: " M README.md\n", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      applyPatchPath: "/opt/data/bin/apply_patch",
      focusedTestPath: "/opt/data/bin/focused_test",
    });
    expect(result.error).toMatch(/uncommitted/);
  });

  it("runs on exact-head path even when legacy verifyWorkspaceBeforeDispatch was skipped", async () => {
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "key-1" });
    ctx.context.paperclipWorkspace = { cwd: "/workspace/paperclip" };
    const result = await prepareWorkspaceBeforeDispatch(ctx, null, {
      probe: {
        fsStat: async () => ({ exists: true, writable: true, isDirectory: true }),
        runProcess: async (command, args) => {
          if (command === "git" && args[0] === "rev-parse") {
            return { exitCode: 0, stdout: "a".repeat(40) + "\n", stderr: "" };
          }
          if (command === "git" && args[0] === "status") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      applyPatchPath: "/opt/data/bin/apply_patch",
      focusedTestPath: "/opt/data/bin/focused_test",
    });
    expect(result.error).toBeNull();
    expect(result.actual).toBe("a".repeat(40));
    expect(result.clean).toBe(true);
  });
});

describe("resume ledger", () => {
  it("records each side effect once and is idempotent on replay", () => {
    const ledger = buildEmptyResumeLedger("run-1", "cache-1");
    const ack1 = recordResumeSideEffect(ledger, "prepared_request_acknowledged", "evidence-1");
    const ack2 = recordResumeSideEffect(ack1, "prepared_request_acknowledged", "evidence-1");
    expect(ack2.entries).toHaveLength(1);
    expect(hasCompletedSideEffect(ack2, "prepared_request_acknowledged", "evidence-1")).toBe(true);
  });

  it("rejects an empty ref", () => {
    const ledger = buildEmptyResumeLedger("run-1", "cache-1");
    const next = recordResumeSideEffect(ledger, "hermes_run_created", "");
    expect(next).toBe(ledger);
  });

  it("rejects ledger with mismatched cacheIdentity when reading", () => {
    const ctx = makeCtx({});
    ctx.context.paperclipExecutionContext = buildBoundExecutionContext(compactPacket());
    ctx.context.paperclipResumeLedger = {
      schemaVersion: "gloops.hermes.resume-ledger.v1",
      runId: "pc-run-preflight",
      cacheIdentity: "different-cache",
      entries: [],
    };
    const ledger = readResumeLedger(ctx, "pc-run-preflight");
    expect(ledger.entries).toEqual([]);
  });

  it("reads ledger when runId and cacheIdentity match", () => {
    const binding = buildBoundExecutionContext(compactPacket());
    const ctx = makeCtx({});
    ctx.context.paperclipExecutionContext = binding;
    ctx.context.paperclipResumeLedger = {
      schemaVersion: "gloops.hermes.resume-ledger.v1",
      runId: "pc-run-preflight",
      cacheIdentity: binding.cacheIdentity,
      entries: [
        { effect: "prepared_request_acknowledged", ref: "evidence-1", observedAt: "2026-07-26T12:00:00.000Z" },
      ],
    };
    const ledger = readResumeLedger(ctx, "pc-run-preflight");
    expect(ledger.entries).toHaveLength(1);
    expect(hasCompletedSideEffect(ledger, "prepared_request_acknowledged", "evidence-1")).toBe(true);
  });
});

describe("evaluateRepairLadder", () => {
  const observedAt = "2026-07-26T12:00:00.000Z";

  it("maps stale lease codes to refresh", () => {
    const decision = evaluateRepairLadder({
      errorCode: "execution_admission.stale_lease",
      attempt: 1,
      observedAt,
    });
    expect(decision.action).toBe("stale_lease_refresh");
    expect(decision.nextAttemptDeadline).toBeNull();
  });

  it("maps missing terminal projection to bounded poll with backoff", () => {
    const decision = evaluateRepairLadder({
      errorCode: "provider_evidence.terminal_projection_missing",
      attempt: 2,
      observedAt,
    });
    expect(decision.action).toBe("missing_terminal_projection_poll");
    expect(decision.nextAttemptDeadline).toBe("2026-07-26T12:00:01.000Z");
  });

  it("maps provider exhaustion to exponential backoff", () => {
    const decision = evaluateRepairLadder({
      errorCode: "execution_admission.provider_budget_exceeded",
      attempt: 3,
      observedAt,
    });
    expect(decision.action).toBe("provider_exhaustion_backoff");
    expect(decision.nextAttemptDeadline).toBe("2026-07-26T12:00:08.000Z");
  });

  it("maps campaign expiry codes to recheck", () => {
    const decision = evaluateRepairLadder({
      errorCode: "controlled_swarm.campaign_expired",
      attempt: 1,
      observedAt,
    });
    expect(decision.action).toBe("campaign_expiry_recheck");
  });

  it("maps duplicate recovery to no-op", () => {
    const decision = evaluateRepairLadder({
      errorCode: "controlled_swarm.duplicate_delivery",
      attempt: 1,
      observedAt,
    });
    expect(decision.action).toBe("duplicate_recovery_noop");
  });

  it("falls back to no_repair for unknown codes", () => {
    const decision = evaluateRepairLadder({
      errorCode: "unknown.error.code",
      attempt: 1,
      observedAt,
    });
    expect(decision.action).toBe("no_repair");
  });

  it("produces a stable digest for identical code+attempt even when observedAt differs (deadlines may differ)", () => {
    const base = {
      errorCode: "execution_admission.provider_budget_exceeded",
      attempt: 2,
    } as const;
    const a = evaluateRepairLadder({ ...base, observedAt: "2026-07-26T12:00:00.000Z" });
    const b = evaluateRepairLadder({ ...base, observedAt: "2026-07-26T13:45:00.000Z" });
    expect(a.digest).toEqual(b.digest);
    expect(a.action).toEqual(b.action);
    expect(a.nextAttemptDeadline).not.toEqual(b.nextAttemptDeadline);
  });

  it("clamps backoff growth for high attempt counts", () => {
    const decision = evaluateRepairLadder({
      errorCode: "execution_admission.provider_budget_exceeded",
      attempt: 20,
      observedAt,
    });
    expect(decision.action).toBe("provider_exhaustion_backoff");
    expect(decision.nextAttemptDeadline).toBe("2026-07-26T12:00:15.000Z");
  });
});

describe("buildReleasedReservation", () => {
  const budget = {
    schemaVersion: "paperclip.provider-invocation-budget.v1" as const,
    budgetId: "budget-1",
    reservationId: "r".repeat(64),
    maxInputTokens: 2_000,
    maxOutputTokens: 500,
    maxTurns: 5,
    maxToolCalls: 20,
    maxWallMs: 60_000,
  };

  it("returns null when there is no budget", () => {
    expect(buildReleasedReservation(null, ZERO_USAGE, { turnCount: 0, toolCallCount: 0, wallMs: 0 }, "x")).toBeNull();
  });

  it("returns null when the run consumed any token", () => {
    const released = buildReleasedReservation(
      budget,
      { inputTokens: 1, outputTokens: 0 },
      { turnCount: 0, toolCallCount: 0, wallMs: 0 },
      "setup_failure",
    );
    expect(released).toBeNull();
  });

  it("returns full release for a setup/pre-model failure with zero usage", () => {
    const released = buildReleasedReservation(
      budget,
      ZERO_USAGE,
      { turnCount: 0, toolCallCount: 0, wallMs: 0 },
      "workspace_validation_failed",
    );
    expect(released).toEqual({
      schemaVersion: "gloops.hermes.budget-release.v1",
      budgetId: "budget-1",
      reservationId: "r".repeat(64),
      releasedInputTokens: 2_000,
      releasedOutputTokens: 500,
      releasedTurns: 5,
      releasedToolCalls: 20,
      releasedWallMs: 60_000,
      reason: "workspace_validation_failed",
    });
  });

  it("releases only the unused remainder when a partial run already happened", () => {
    const released = buildReleasedReservation(
      budget,
      ZERO_USAGE,
      { turnCount: 2, toolCallCount: 4, wallMs: 5_000 },
      "terminal_reconciliation_failed",
    );
    expect(released).toEqual({
      schemaVersion: "gloops.hermes.budget-release.v1",
      budgetId: "budget-1",
      reservationId: "r".repeat(64),
      releasedInputTokens: 2_000,
      releasedOutputTokens: 500,
      releasedTurns: 3,
      releasedToolCalls: 16,
      releasedWallMs: 55_000,
      reason: "terminal_reconciliation_failed",
    });
  });
});

describe("buildPreflightSummary", () => {
  it("composes a single record from the preflight primitives", () => {
    const ledger = buildEmptyResumeLedger("run-1", "cache-1");
    const summary = buildPreflightSummary({
      runId: "run-1",
      readiness: null,
      workspacePreparation: null,
      resumeLedger: ledger,
      releasedReservation: null,
    });
    expect(summary.schemaVersion).toBe("gloops.hermes.preflight-summary.v1");
    expect(summary.resumeLedger).toBe(ledger);
    expect(summary.releasedReservation).toBeNull();
  });
});
