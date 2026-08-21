import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const sshMocks = vi.hoisted(() => ({
  normalize: vi.fn(async () => undefined),
  prepare: vi.fn(async () => ({ gitBacked: false })),
  preflight: vi.fn(async () => undefined),
  restore: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  sync: vi.fn(async () => undefined),
}));

vi.mock("./ssh.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ssh.js")>();
  return {
    ...original,
    normalizeSshWorkspaceWriteAccess: sshMocks.normalize,
    prepareWorkspaceForSshExecution: sshMocks.prepare,
    preflightSshWorkspaceWriteAccess: sshMocks.preflight,
    restoreWorkspaceFromSshExecution: sshMocks.restore,
    runSshCommand: sshMocks.run,
    syncDirectoryToSsh: sshMocks.sync,
  };
});

import {
  prepareRemoteManagedRuntime,
  SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV,
  SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV,
} from "./remote-managed-runtime.js";
import type { SshRemoteExecutionSpec } from "./ssh.js";

describe("same-host shared SSH runtime", () => {
  const cleanupDirs: string[] = [];
  const priorLocalRoot = process.env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV];
  const priorRemoteRoot = process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV];

  afterEach(async () => {
    vi.clearAllMocks();
    if (priorLocalRoot === undefined) delete process.env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV];
    else process.env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV] = priorLocalRoot;
    if (priorRemoteRoot === undefined) delete process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV];
    else process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV] = priorRemoteRoot;
    while (cleanupDirs.length > 0) {
      await rm(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("prepares the mapped worktree in place and cleans only its run assets", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-orchestrator-"));
    cleanupDirs.push(localRoot);
    const workspace = path.join(localRoot, "induct-main", ".paperclip", "worktrees", "GLO-3000");
    const asset = path.join(localRoot, "rules");
    await mkdir(workspace, { recursive: true });
    await mkdir(asset);
    process.env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV] = localRoot;
    process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV] = "/opt/paperclip/hermes-execution-state/workspace";

    const spec: SshRemoteExecutionSpec = {
      host: "host",
      port: 22,
      username: "gloops-admin",
      remoteWorkspacePath: "/home/gloops-admin/paperclip-workspaces",
      remoteCwd: "/home/gloops-admin/paperclip-workspaces",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
      workspaceWritePolicy: null,
    };
    const mapped = "/opt/paperclip/hermes-execution-state/workspace/induct-main/.paperclip/worktrees/GLO-3000";
    sshMocks.run.mockResolvedValueOnce({ stdout: `${mapped}\n`, stderr: "", exitCode: 0 });

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-1",
      adapterKey: "grok",
      workspaceLocalDir: workspace,
      assets: [{ key: "grok-context", localDir: asset }],
    });

    expect(prepared.workspaceRemoteDir).toBe(mapped);
    expect(prepared.runtimeRootDir).toBe("/home/gloops-admin/paperclip-workspaces/.paperclip-runtime/runs/run-1/grok");
    expect(sshMocks.normalize).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: mapped,
      privilegedPathResolution: true,
      spec: expect.objectContaining({
        remoteWorkspacePath: "/opt/paperclip/hermes-execution-state/workspace",
        workspaceWritePolicy: expect.objectContaining({ executionUsername: "gloops-admin" }),
      }),
    }));
    expect(sshMocks.sync).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/home/gloops-admin/paperclip-workspaces/.paperclip-runtime/runs/run-1/grok/grok-context",
    }));

    await prepared.restoreWorkspace();
    expect(sshMocks.run).toHaveBeenLastCalledWith(
      spec,
      "rm -rf -- '/home/gloops-admin/paperclip-workspaces/.paperclip-runtime/runs/run-1/grok'",
    );
  });

  it("fails before preparation when shared access normalization or preflight fails", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-failure-"));
    cleanupDirs.push(localRoot);
    const workspace = path.join(localRoot, "repo", ".paperclip", "worktrees", "issue");
    await mkdir(workspace, { recursive: true });
    process.env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV] = localRoot;
    process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV] = "/shared";
    const spec: SshRemoteExecutionSpec = {
      host: "host", port: 22, username: "runner", remoteWorkspacePath: "/remote",
      remoteCwd: "/remote", privateKey: null, knownHosts: null,
      strictHostKeyChecking: true, workspaceWritePolicy: null,
    };

    sshMocks.normalize.mockRejectedValueOnce(new Error("acl denied"));
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-normalize", adapterKey: "grok", workspaceLocalDir: workspace,
    })).rejects.toThrow("acl denied");
    expect(sshMocks.preflight).not.toHaveBeenCalled();
    expect(sshMocks.sync).not.toHaveBeenCalled();

    const mapped = "/shared/repo/.paperclip/worktrees/issue";
    sshMocks.run.mockResolvedValueOnce({ stdout: `${mapped}\n`, stderr: "", exitCode: 0 });
    sshMocks.preflight.mockRejectedValueOnce(new Error("write denied"));
    await expect(prepareRemoteManagedRuntime({
      spec, runId: "run-preflight", adapterKey: "grok", workspaceLocalDir: workspace,
    })).rejects.toThrow("write denied");
    expect(sshMocks.sync).not.toHaveBeenCalled();
  });

  it("retains the ordinary transferred-workspace runtime when shared mapping is disabled", async () => {
    delete process.env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV];
    delete process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV];
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-ordinary-ssh-"));
    cleanupDirs.push(localRoot);
    const spec: SshRemoteExecutionSpec = {
      host: "host", port: 22, username: "runner", remoteWorkspacePath: "/remote",
      remoteCwd: "/remote", privateKey: null, knownHosts: null,
      strictHostKeyChecking: true, workspaceWritePolicy: null,
    };

    const prepared = await prepareRemoteManagedRuntime({
      spec, runId: "run-ordinary", adapterKey: "grok", workspaceLocalDir: localRoot,
    });

    expect(prepared.workspaceRemoteDir).toBe("/remote/.paperclip-runtime/runs/run-ordinary/workspace");
    expect(prepared.runtimeRootDir).toBe("/remote/.paperclip-runtime/runs/run-ordinary/workspace/.paperclip-runtime/grok");
    expect(sshMocks.normalize).toHaveBeenCalledWith({
      spec,
      remoteDir: "/remote/.paperclip-runtime/runs/run-ordinary/workspace",
    });
    expect(sshMocks.preflight).toHaveBeenCalledWith({
      spec,
      remoteDir: "/remote/.paperclip-runtime/runs/run-ordinary/workspace",
    });
  });
});
