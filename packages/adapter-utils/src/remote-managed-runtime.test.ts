import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareRemoteManagedRuntime,
  resolveSharedSshWorkspaceMapping,
  sharedSshWorkspaceSpec,
  SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV,
  SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV,
} from "./remote-managed-runtime.js";
import { WorkspaceNotWritableError, type SshRemoteExecutionSpec } from "./ssh.js";

describe("remote managed runtime local restore boundary", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("fails with typed zero-provider truth when the adjacent restore lock cannot be created", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-preflight-"));
    cleanupDirs.push(rootDir);
    const missingLocalWorkspace = path.join(rootDir, "missing-parent", "workspace");
    const spec: SshRemoteExecutionSpec = {
      host: "127.0.0.1",
      port: 1,
      username: "unused",
      remoteWorkspacePath: "/unused",
      remoteCwd: "/unused",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
      workspaceWritePolicy: null,
    };

    const result = prepareRemoteManagedRuntime({
      spec,
      runId: "never-invoked",
      adapterKey: "test",
      workspaceLocalDir: missingLocalWorkspace,
    });

    await expect(result).rejects.toBeInstanceOf(WorkspaceNotWritableError);
    await expect(result).rejects.toMatchObject({
      code: "workspace_not_writable",
      providerInvocationAttempted: false,
    });
  });

  it("maps an isolated worktree onto the same-host shared workspace without a transfer directory", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-workspace-"));
    cleanupDirs.push(localRoot);
    const workspace = path.join(localRoot, "induct-main", ".paperclip", "worktrees", "GLO-3000");
    await mkdir(workspace, { recursive: true });

    await expect(resolveSharedSshWorkspaceMapping({
      workspaceLocalDir: workspace,
      env: {
        [SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV]: localRoot,
        [SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV]: "/opt/paperclip/hermes-execution-state/workspace",
      },
    })).resolves.toEqual({
      localDir: await realpath(workspace),
      remoteDir: "/opt/paperclip/hermes-execution-state/workspace/induct-main/.paperclip/worktrees/GLO-3000",
    });
  });

  it("keeps ordinary SSH workspaces on the normal transfer path when shared roots are absent", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-unshared-workspace-"));
    cleanupDirs.push(localRoot);

    await expect(resolveSharedSshWorkspaceMapping({
      workspaceLocalDir: localRoot,
      env: {},
    })).resolves.toBeNull();
  });

  it("defaults same-host shared workspace access to the configured SSH identity", () => {
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

    expect(sharedSshWorkspaceSpec(spec, "/opt/paperclip/hermes-execution-state/workspace"))
      .toMatchObject({
        remoteWorkspacePath: "/opt/paperclip/hermes-execution-state/workspace",
        workspaceWritePolicy: {
          strategy: "acl",
          executionUsername: "gloops-admin",
          syncUsername: "gloops-admin",
          sharedGroup: null,
        },
      });
  });

  it("rejects a workspace outside the configured same-host root", async () => {
    const localRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-outside-"));
    cleanupDirs.push(localRoot, outside);

    await expect(resolveSharedSshWorkspaceMapping({
      workspaceLocalDir: outside,
      env: {
        [SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV]: localRoot,
        [SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV]: "/opt/paperclip/hermes-execution-state/workspace",
      },
    })).rejects.toThrow("strict descendant");
  });
});
