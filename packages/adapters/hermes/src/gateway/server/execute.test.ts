import { describe, expect, it, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, mapFinalResultForTest, parseSseFramesForTest, resolveSessionKey } from "./execute.js";
import { testEnvironment } from "./test.js";
import { buildBoundExecutionContext } from "@paperclipai/adapter-utils/execution-envelope";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function compactPacket() {
  const stable = (value: unknown): unknown => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
      : value;
  const serialize = (value: unknown) => JSON.stringify(stable(value));
  const body = { schemaVersion: "gloops.continuation-packet.v1", work: { id: "GLO-999" }, cursor: { next: "verify" } };
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
    runId: "pc-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_gateway",
      adapterConfig: config,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: {
        issue: { identifier: "PAP-1", title: "Do the thing" },
      },
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  };
}

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveSessionKey", () => {
  it("derives issue-scoped session keys by default", () => {
    expect(
      resolveSessionKey({
        strategy: "issue",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("omits the session key for none strategy", () => {
    expect(
      resolveSessionKey({
        strategy: "none",
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: "issue-1",
      }),
    ).toBeNull();
  });
});

describe("parseSseFramesForTest", () => {
  it("parses event and data lines while preserving partial frames", () => {
    const parsed = parseSseFramesForTest("event: message.delta\ndata: {\"delta\":\"hi\"}\n\n:data\ndata: later");
    expect(parsed.frames).toEqual([{ event: "message.delta", data: "{\"delta\":\"hi\"}" }]);
    expect(parsed.rest).toBe(":data\ndata: later");
  });
});

describe("execute", () => {
  it("uses the bound compact packet as the sole work body with a fresh session and budget", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "bound-1" }), { status: 200 });
      if (url.endsWith("/events")) return new Response(sseStream("event: run.completed\ndata: {\"status\":\"completed\",\"output\":\"done\"}\n\n"), { status: 200 });
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    ctx.context.paperclipTaskMarkdown = "LEGACY TASK MUST NOT APPEAR";
    ctx.context.paperclipExecutionContext = buildBoundExecutionContext(compactPacket());
    ctx.executionBudget = {
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      budgetId: "budget-1",
      reservationId: "c".repeat(64),
      maxInputTokens: 2_000,
      maxOutputTokens: 500,
      maxTurns: 5,
      maxToolCalls: 20,
      maxWallMs: 60_000,
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    const createCall = (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>).find(([input]) => String(input).endsWith("/v1/runs"));
    const body = JSON.parse(String(createCall?.[1]?.body));
    expect(body.input).toContain("Bound continuation packet");
    expect(body.input).not.toContain("LEGACY TASK MUST NOT APPEAR");
    expect(body.session_id).toBeUndefined();
    expect(body.execution_budget.maxToolCalls).toBe(20);
    expect(createCall?.[1]?.headers).not.toMatchObject({ "X-Hermes-Session-Key": expect.anything() });
  });

  it("refuses invalid binding and oversized bound prompts before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalid = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    invalid.context.paperclipExecutionContext = { schemaVersion: "paperclip.execution-context-binding.v1" };
    const invalidResult = await execute(invalid);
    expect(invalidResult.errorCode).toBe("execution_context.invalid_binding");
    expect(invalidResult).toMatchObject({
      providerInvocationAttempted: false,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const oversized = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key" });
    oversized.context.paperclipExecutionContext = buildBoundExecutionContext(compactPacket());
    oversized.executionBudget = {
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      budgetId: "budget-1",
      reservationId: "d".repeat(64),
      maxInputTokens: 1,
      maxOutputTokens: 10,
      maxTurns: 1,
      maxToolCalls: 1,
      maxWallMs: 1_000,
    };
    expect((await execute(oversized)).errorCode).toBe("execution_admission.input_reservation_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { payloadTemplate: { provider: "xai", base_url: "https://api.x.ai/v1" } },
    { payloadTemplate: { xai: { apiKey: "redacted" } } },
    { payloadTemplate: { grok: { apiUrl: "https://example.invalid" } } },
    { extraArgs: ["--provider", "xai"] },
  ])("refuses Grok/xAI API routing configuration before fetch: %j", async (routeConfig) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      ...routeConfig,
    });
    expect((await execute(ctx)).errorCode).toBe("execution_route.prohibited_grok_api");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops the remote run when streamed tool usage exceeds the reservation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "budget-1" }), { status: 200 });
      if (url.endsWith("/events")) {
        return new Response(sseStream([
          "event: tool.started",
          "data: {\"tool_call_id\":\"call-1\"}",
          "",
          "event: tool.started",
          "data: {\"tool_call_id\":\"call-2\"}",
          "",
        ].join("\n")), { status: 200 });
      }
      if (url.endsWith("/stop")) return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.executionBudget = {
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      budgetId: "budget-1",
      reservationId: "e".repeat(64),
      maxInputTokens: 2_000,
      maxOutputTokens: 500,
      maxTurns: 5,
      maxToolCalls: 1,
      maxWallMs: 60_000,
    };
    const result = await execute(ctx);
    expect(result.errorCode).toBe("execution_admission.provider_budget_exceeded");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/budget-1/stop"))).toBe(true);
  });

  it("counts parallel tool calls as one model turn", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "parallel-turns" }), { status: 200 });
      if (url.endsWith("/events")) {
        return new Response(sseStream([
          "event: tool.started",
          "data: {\"tool_call_id\":\"call-1\"}",
          "",
          "event: tool.started",
          "data: {\"tool_call_id\":\"call-2\"}",
          "",
          "event: tool.completed",
          "data: {\"tool_call_id\":\"call-1\"}",
          "",
          "event: tool.completed",
          "data: {\"tool_call_id\":\"call-2\"}",
          "",
          "event: message.delta",
          "data: {\"delta\":\"done\"}",
          "",
          "event: run.completed",
          "data: {\"status\":\"completed\",\"output\":\"done\"}",
          "",
        ].join("\n")), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.executionBudget = {
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      budgetId: "budget-parallel",
      reservationId: "e".repeat(64),
      maxInputTokens: 2_000,
      maxOutputTokens: 500,
      maxTurns: 2,
      maxToolCalls: 2,
      maxWallMs: 60_000,
    };

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.execution_metrics).toEqual({ turns: 2, tool_calls: 2 });
  });

  it("stops the remote run when distinct model turns exceed the reservation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "too-many-turns" }), { status: 200 });
      if (url.endsWith("/events")) {
        return new Response(sseStream([
          "event: tool.started",
          "data: {\"tool_call_id\":\"call-1\"}",
          "",
          "event: tool.completed",
          "data: {\"tool_call_id\":\"call-1\"}",
          "",
          "event: tool.started",
          "data: {\"tool_call_id\":\"call-2\"}",
          "",
          "event: tool.completed",
          "data: {\"tool_call_id\":\"call-2\"}",
          "",
          "event: message.delta",
          "data: {\"delta\":\"third turn\"}",
          "",
        ].join("\n")), { status: 200 });
      }
      if (url.endsWith("/stop")) return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx({ apiBaseUrl: "http://127.0.0.1:8642", apiKey: "secret-key", timeoutSec: 5 });
    ctx.executionBudget = {
      schemaVersion: "paperclip.provider-invocation-budget.v1",
      budgetId: "budget-turns",
      reservationId: "e".repeat(64),
      maxInputTokens: 2_000,
      maxOutputTokens: 500,
      maxTurns: 2,
      maxToolCalls: 3,
      maxWallMs: 60_000,
    };

    const result = await execute(ctx);

    expect(result.errorCode).toBe("execution_admission.provider_budget_exceeded");
    expect(result.resultJson?.execution_metrics).toEqual({ turns: 3, tool_calls: 2 });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/too-many-turns/stop"))).toBe(true);
  });

  it("rejects remote plain HTTP unless the unsafe dev escape hatch is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "unexpected" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://192.168.1.25:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_plain_http_remote_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("constructs POST /v1/runs with auth, idempotency, and Hermes session headers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"done\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\",\"session_id\":\"session-1\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2},\"model\":\"hermes-agent\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find(([input]) => String(input).endsWith("/v1/runs"));
    expect(createCall).toBeTruthy();
    const init = createCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
      "Idempotency-Key": "pc-run-1",
      "X-Hermes-Session-Key": "paperclip:company:company-1:agent:agent-1:issue:issue-1",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input).toContain("Do the thing");
    expect(body.session_id).toBe("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("reconciles usage and route from final status when the terminal event is sparse", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run-reconcile" }), { status: 200 });
      if (url.endsWith("/events")) {
        return new Response(sseStream("event: run.completed\ndata: {\"status\":\"completed\",\"output\":\"done\"}\n\n"), { status: 200 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "done",
        model: "ollama/qwen3-coder",
        usage: { input_tokens: 17, output_tokens: 5 },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      subscriptionClass: "ollama-max",
      routingReason: "controlled-swarm-quality-pilot",
      fallbackOccurred: false,
      executionProfile: "execution-only",
    }));

    expect(result).toMatchObject({
      exitCode: 0,
      providerInvocationAttempted: true,
      usage: { inputTokens: 17, outputTokens: 5 },
      usageBasis: "per_run",
      model: "ollama/qwen3-coder",
    });
    expect(result.resultJson).toMatchObject({
      final_status_reconciled: true,
      execution_route: {
        provider_id: "ollama",
        transport: "api",
        path_id: "ollama-cloud",
        runner: "hermes_gateway",
        subscription_class: "ollama-max",
        routing_reason: "controlled-swarm-quality-pilot",
        fallback_occurred: false,
        execution_profile: "execution-only",
      },
    });
  });

  it("bounds final-status reconciliation when Hermes never responds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hung-reconcile" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream("event: run.completed\ndata: {\"status\":\"completed\",\"output\":\"done\"}\n\n"),
          { status: 200 },
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = Date.now();
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result).toMatchObject({
      exitCode: 0,
      providerInvocationAttempted: true,
    });
    expect(result.usage).toBeUndefined();
    expect(result.resultJson).not.toMatchObject({ final_status_reconciled: true });
  }, 5_000);

  it("refuses a stale or dirty declared workspace before provider dispatch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "paperclip-hermes-workspace-"));
    try {
      await execFileAsync("git", ["init", "-q"], { cwd });
      await execFileAsync("git", ["config", "user.email", "paperclip@example.invalid"], { cwd });
      await execFileAsync("git", ["config", "user.name", "Paperclip Test"], { cwd });
      await writeFile(join(cwd, "README.md"), "one\n");
      await execFileAsync("git", ["add", "README.md"], { cwd });
      await execFileAsync("git", ["commit", "-qm", "initial"], { cwd });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
      const head = stdout.trim();
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const stale = makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "secret-key",
        expectedWorkspaceHeadSha: "f".repeat(40),
      });
      stale.context.paperclipWorkspace = { cwd };
      expect(await execute(stale)).toMatchObject({
        errorCode: "workspace_validation_failed",
        providerInvocationAttempted: false,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      });

      await writeFile(join(cwd, "untracked.txt"), "dirty\n");
      const dirty = makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "secret-key",
        expectedWorkspaceHeadSha: head,
      });
      dirty.context.paperclipWorkspace = { cwd };
      expect(await execute(dirty)).toMatchObject({
        errorCode: "workspace_validation_failed",
        errorMessage: "Workspace contains uncommitted or untracked changes.",
        providerInvocationAttempted: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();

      await rm(join(cwd, "untracked.txt"));
      fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "workspace-ok" }), { status: 200 });
        if (url.endsWith("/events")) {
          return new Response(sseStream("event: run.completed\ndata: {\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}\n\n"), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
      });
      const clean = makeCtx({
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "secret-key",
        expectedWorkspaceHeadSha: head,
      });
      clean.context.paperclipWorkspace = { cwd };
      const cleanResult = await execute(clean);
      expect(cleanResult.exitCode).toBe(0);
      expect(cleanResult.resultJson).toMatchObject({
        workspace: { expected: head, actual: head, clean: true },
      });
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs"))).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect((ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n"))
      .toContain("creating run at http://127.0.0.1:9119/api/v1/runs");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-1/events",
      ]),
    );
  });

  it("routes the default Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "http://127.0.0.1:9119/api/v1/runs") {
        return new Response(JSON.stringify({ run_id: "run-hermes-chat", status: "started" }), { status: 200 });
      }
      if (url === "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events") {
        return new Response(
          sseStream(
            [
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"done\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:9119/chat",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(ctx.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: ["http://127.0.0.1:9119/api/v1/runs"],
      }),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        "http://127.0.0.1:9119/api/v1/runs",
        "http://127.0.0.1:9119/api/v1/runs/run-hermes-chat/events",
      ]),
    );
  });

  it("redacts echoed auth material from stream logs and summaries", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              "data: {\"delta\":\"Authorization: Bearer secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
              "event: run.completed",
              "data: {\"status\":\"completed\",\"output\":\"Authorization: Bearer secret-key\\nraw key secret-key\\nX-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1\"}",
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Bearer [redacted]");
    expect(result.summary).toContain("raw key [redacted len=10]");
    expect(result.summary).toContain("X-Hermes-Session-Key: [redacted]");
    expect(result.summary).not.toContain("secret-key");
    expect(result.summary).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
    expect(result.resultJson?.output).toBe(result.summary);
    expect(logText).toContain("Bearer [redacted]");
    expect(logText).toContain("X-Hermes-Session-Key: [redacted]");
    expect(logText).not.toContain("secret-key");
    expect(logText).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("redacts agent-scoped Paperclip session keys from logs and public result metadata", async () => {
    const ctx = makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      sessionKeyStrategy: "agent",
      timeoutSec: 5,
    });
    const agentSessionKey = "paperclip:company:company-1:agent:agent-1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response(
          sseStream(
            [
              "event: message.delta",
              `data: {"delta":"session ${agentSessionKey}"}`,
              "",
              "event: run.completed",
              `data: {"status":"completed","output":"session ${agentSessionKey}","session_id":"${agentSessionKey}"}`,
              "",
            ].join("\n"),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx);
    const logText = (ctx.onLog as ReturnType<typeof vi.fn>).mock.calls.map(([, line]) => String(line)).join("\n");

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("session [redacted-session-key]");
    expect(result.sessionId).toBe("[redacted-session-key]");
    expect(result.sessionDisplayId).toBe("[redacted-session-key]");
    expect(result.resultJson?.session_id).toBe("[redacted-session-key]");
    expect(result.sessionParams).toEqual({
      hermesRunId: "run-hermes-1",
      strategy: "agent",
    });
    expect(logText).toContain("[redacted-session-key]");
    expect(logText).not.toContain(agentSessionKey);
  });

  it("falls back to polling when SSE is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-hermes-1", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Response("no stream", { status: 503 });
      }
      return new Response(JSON.stringify({
        status: "completed",
        output: "polled done",
        session_id: "session-polled",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 5,
      pollIntervalMs: 250,
    }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("polled done");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/v1/runs/run-hermes-1"))).toBe(true);
  });

  it("maps HTTP auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 })));
    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMessage).toContain("Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY");
  });

  it("includes network causes in connection failure messages", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await execute(makeCtx({
      apiBaseUrl: "http://host.docker.internal:8642",
      apiKey: "secret-key",
      dangerouslyAllowInsecureRemoteHttp: true,
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_connect_failed");
    expect(result.errorMessage).toContain("ENOTFOUND");
    expect(result.errorMessage).toContain("host.docker.internal");
  });

  it("redacts echoed auth material from HTTP error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            message: "Authorization rejected: Bearer secret-key raw secret-key",
            detail: "X-Hermes-Session-Key: paperclip:company:company-1:agent:agent-1:issue:issue-1",
            nested: {
              note: "session paperclip:company:company-1:agent:agent-1",
            },
          }),
          { status: 401 },
        )),
    );

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
    }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_auth_failed");
    expect(result.errorMeta?.body).toEqual({
      message: "Authorization rejected: Bearer [redacted] raw [redacted len=10]",
      detail: "X-Hermes-Session-Key: [redacted]",
      nested: {
        note: "session [redacted-session-key]",
      },
    });
    expect(result.errorMessage).not.toContain("secret-key");
    expect(result.errorMessage).not.toContain("paperclip:company:company-1:agent:agent-1:issue:issue-1");
  });

  it("calls stop on timeout", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run-slow", status: "started" }), { status: 200 });
      }
      if (url.endsWith("/events")) {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/stop")) {
        return new Response(JSON.stringify({ status: "stopping" }), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "cancelled", last_event: "run.cancelled" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeCtx({
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: "secret-key",
      timeoutSec: 0.001,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("hermes_gateway_timeout");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/stop"))).toBe(true);
  });
});

describe("testEnvironment", () => {
  it("fails remote plain HTTP before probing health", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
          level: "error",
        }),
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows remote plain HTTP only with the unsafe dev escape hatch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://hermes.example:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
          level: "warn",
        }),
        expect.objectContaining({
          code: "hermes_gateway_health_ok",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalled();
  });

  it("fails test environment checks when Hermes health is unreachable", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND host.docker.internal"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("fetch failed"), { cause });
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://host.docker.internal:8642",
        apiKey: "secret-key",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_unreachable",
          level: "error",
          detail: expect.stringContaining("ENOTFOUND"),
        }),
      ]),
    );
  });

  it("fails test environment checks when Hermes health returns a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: "wrong-key",
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_health_failed",
          level: "error",
          message: "Hermes Gateway health endpoint returned HTTP 401.",
        }),
      ]),
    );
  });

  it("tests a bare Hermes dashboard URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("tests a Hermes dashboard chat URL on port 9119 through the API prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_gateway",
      config: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "secret-key",
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          message: "Default Hermes dashboard root mapped to API base http://127.0.0.1:9119/api.",
        }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9119/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("mapFinalResultForTest", () => {
  it("persists independently consumable metrics without inventing unconfigured route facts", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "completed",
        payload: {
          status: "completed",
          model: "ollama/qwen3-coder",
          usage: { input_tokens: 1200, output_tokens: 300 },
        },
      },
      outputChunks: ["done"],
      sessionKey: "session-key",
      strategy: "issue",
      turnCount: 3,
      toolCallCount: 7,
    });

    expect(result.resultJson?.execution_metrics).toEqual({ turns: 3, tool_calls: 7 });
    expect(result.resultJson?.execution_route).toEqual({
      provider_id: "ollama",
      model_id: "ollama/qwen3-coder",
      transport: "api",
      path_id: "ollama-cloud",
      runner: "hermes_gateway",
    });
  });

  it("maps failed statuses into adapter errors", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-1",
        status: "failed",
        payload: { status: "failed", error: "boom" },
      },
      outputChunks: [],
      sessionKey: "session-key",
      strategy: "issue",
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorMessage).toBe("boom");
  });
});
