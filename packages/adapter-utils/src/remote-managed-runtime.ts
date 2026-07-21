import path from "node:path";
import { readGitWorkspaceSnapshot } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  normalizeSshWorkspaceWriteAccess,
  preflightSshWorkspaceWriteAccess,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";
import {
  buildManagedWorkspaceArchiveExclude,
  mergeWorkspaceArchiveExcludes,
} from "./workspace-archive-excludes.js";

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

/**
 * Extra excludes applied to both SSH prepare (local→remote overlay) and
 * restore baseline/tar (remote→local). Heavy dirs are applied inside
 * prepareWorkspaceForSshExecution / buildManagedWorkspaceArchiveExclude.
 */
export function buildRemoteManagedWorkspaceExclude(input: {
  workspaceExclude?: string[];
  gitIgnoredPaths?: string[];
}): string[] {
  return mergeWorkspaceArchiveExcludes(input.workspaceExclude, input.gitIgnoredPaths);
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  /**
   * Caller-supplied excludes (e.g. run-created skill homes). Merged with gitignored
   * paths and always-on heavy dependency/build cache excludes.
   */
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const workspaceRemoteDir = path.posix.join(
    baseWorkspaceRemoteDir,
    ".paperclip-runtime",
    "runs",
    input.runId,
    "workspace",
  );
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  const gitSnapshot = await readGitWorkspaceSnapshot(input.workspaceLocalDir);
  const prepareExclude = buildRemoteManagedWorkspaceExclude({
    workspaceExclude: input.workspaceExclude,
    gitIgnoredPaths: gitSnapshot?.ignoredPaths,
  });

  const preparedWorkspace = await prepareWorkspaceForSshExecution({
    spec: input.spec,
    localDir: input.workspaceLocalDir,
    remoteDir: workspaceRemoteDir,
    exclude: prepareExclude,
    onProgress: input.onProgress,
  });
  const restoreExclude = buildManagedWorkspaceArchiveExclude({
    gitBacked: preparedWorkspace.gitBacked,
    workspaceExclude: prepareExclude,
  });
  const baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
    exclude: restoreExclude,
  });

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      });
    }
    await normalizeSshWorkspaceWriteAccess({
      spec: input.spec,
      remoteDir: workspaceRemoteDir,
    });
    await preflightSshWorkspaceWriteAccess({
      spec: input.spec,
      remoteDir: workspaceRemoteDir,
    });
  } catch (error) {
    await restoreWorkspaceFromSshExecution({
      spec: input.spec,
      localDir: input.workspaceLocalDir,
      remoteDir: workspaceRemoteDir,
      baselineSnapshot,
      restoreGitHistory: preparedWorkspace.gitBacked,
      exclude: prepareExclude,
      onProgress: input.onProgress,
    });
    throw error;
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        exclude: prepareExclude,
        onProgress,
      });
    },
  };
}
