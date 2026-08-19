import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async (): Promise<{
  workspaceRemoteDir: string | null;
  runtimeRootDir?: string | null;
  restoreWorkspace: () => Promise<void>;
}> => ({
  workspaceRemoteDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "grok"));
const runProcessMock = vi.hoisted(() => vi.fn());
const executionTargetIsRemoteMock = vi.hoisted(() => vi.fn(() => false));
const executionTargetUsesBridgeMock = vi.hoisted(() => vi.fn(() => false));
const bridgeStopMock = vi.hoisted(() => vi.fn(async () => {}));
const startBridgeMock = vi.hoisted(() => vi.fn(async () => ({
  env: {
    PAPERCLIP_TERMINAL_CALLBACK_URL: "http://127.0.0.1:43123",
    PAPERCLIP_TERMINAL_CALLBACK_TOKEN: "terminal-token",
    PAPERCLIP_TERMINAL_CALLBACK_IDEMPOTENCY_KEY: "terminal-key",
  },
  stop: bridgeStopMock,
})));

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: executionTargetIsRemoteMock,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesPaperclipBridge: executionTargetUsesBridgeMock,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
  startAdapterExecutionTargetPaperclipBridge: startBridgeMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-grok-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

describe("grok_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
    executionTargetIsRemoteMock.mockReset().mockReturnValue(false);
    executionTargetUsesBridgeMock.mockReset().mockReturnValue(false);
    startBridgeMock.mockClear();
    bridgeStopMock.mockClear();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("fails closed before invocation when Grok API credentials are present", async () => {
    const root = await makeTempRoot();
    const result = await execute({
      runId: "run-api-denied",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, env: { XAI_API_KEY: "must-not-be-used" } },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "execution_route.grok_api_forbidden",
      providerInvocationAttempted: false,
    });
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("fails closed before invocation when Paperclip execution identity is missing", async () => {
    const root = await makeTempRoot();
    const result = await execute({
      runId: "run-identity-missing",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, env: {} },
      context: {},
      authToken: "",
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "execution_identity.paperclip_missing",
      providerInvocationAttempted: false,
    });
    expect(runProcessMock).not.toHaveBeenCalled();
  });

  it("refuses shared project-primary workspaces before staging native Grok context", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");

    const result = await execute({
      runId: "run-shared-workspace-denied",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, instructionsFilePath: instructionsPath },
      context: {
        paperclipWorkspace: {
          cwd: root,
          source: "project_primary",
          strategy: "project_primary",
        },
      },
      authToken: "run-token",
      onLog: async () => {},
    });

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "execution_workspace.grok_isolation_required",
      providerInvocationAttempted: false,
    });
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude"))).toBe(false);
  });

  it("stages Grok-native instructions and skills into the workspace for the run and cleans them up afterward", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");

    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "streaming-json",
          "--always-approve",
          "--permission-mode",
          "dontAsk",
        ]),
      );
      expect(await fs.readFile(path.join(root, "Agents.md"), "utf8")).toContain("You are Grok.");
      expect(await pathExists(path.join(root, ".claude", "skills", "paperclip", "SKILL.md"))).toBe(true);
      await options.onLog?.("stdout", '{"type":"text","data":"done"}\n');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-1",
      sessionDisplayId: "sess-1",
      costUsd: null,
      usageBasis: "per_run",
    });
    // Successful CLI work without native counters must not be measured zeros.
    expect(result.usage).toBeDefined();
    expect(result.usage?.provenance).toBe("estimated");
    expect(result.usage?.estimationMethod).toBe("utf8_bytes_div_4");
    expect((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)).toBeGreaterThan(0);
    expect(result.usage).not.toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      provenance: "measured",
    });
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
    expect(logs.map((entry) => entry.chunk)).not.toEqual([]);
  });

  it("labels native CLI token counters as measured when present", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", data: "done" }),
        JSON.stringify({
          type: "end",
          stopReason: "EndTurn",
          sessionId: "sess-measured",
          usage: { input_tokens: 50, output_tokens: 12 },
        }),
      ].join("\n"),
      stderr: "",
    }));

    const ctx: AdapterExecutionContext = {
      runId: "run-measured",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    const result = await execute(ctx);
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 12,
      cachedInputTokens: 0,
      provenance: "measured",
    });
    expect(result.costUsd).toBeNull();
  });

  it("injects and tears down the run-scoped terminal callback bridge for remote Grok runs", async () => {
    const root = await makeTempRoot();
    const remoteTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      spec: {
        host: "host",
        port: 22,
        username: "runner",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    } as const;
    executionTargetIsRemoteMock.mockReturnValue(true);
    executionTargetUsesBridgeMock.mockReturnValue(true);
    prepareRuntimeMock.mockResolvedValueOnce({
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/runtime",
      restoreWorkspace: async () => {},
    });
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      expect(options.env).toMatchObject({
        PAPERCLIP_TERMINAL_CALLBACK_URL: "http://127.0.0.1:43123",
        PAPERCLIP_TERMINAL_CALLBACK_TOKEN: "terminal-token",
        PAPERCLIP_TERMINAL_CALLBACK_IDEMPOTENCY_KEY: "terminal-key",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-bridge" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-bridge",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root },
      context: { taskId: "issue-1" },
      authToken: "run-token",
      executionTarget: remoteTarget,
      onLog: async () => {},
    };

    await expect(execute(ctx)).resolves.toMatchObject({ exitCode: 0, errorMessage: null });
    expect(startBridgeMock).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-bridge",
      target: remoteTarget,
      adapterKey: "grok",
      hostApiToken: "run-token",
      paperclipScope: {
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
    }));
    expect(bridgeStopMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up staged assets when setup fails before the Grok process starts", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");
    ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed"));

    const ctx: AdapterExecutionContext = {
      runId: "run-setup-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await expect(execute(ctx)).rejects.toThrow("grok not installed");
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
  });
});
