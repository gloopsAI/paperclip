import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
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
});
