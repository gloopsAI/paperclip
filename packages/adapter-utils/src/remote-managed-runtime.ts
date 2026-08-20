import { promises as fs } from "node:fs";
import path from "node:path";
import { readGitWorkspaceSnapshot } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  WorkspaceNotWritableError,
  prepareWorkspaceForSshExecution,
  normalizeSshWorkspaceWriteAccess,
  preflightSshWorkspaceWriteAccess,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  shellQuote,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  captureDirectorySnapshot,
  preflightDirectoryMergeLock,
} from "./workspace-restore-merge.js";
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

export const SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV = "PAPERCLIP_SSH_SHARED_WORKSPACE_LOCAL_ROOT";
export const SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV = "PAPERCLIP_SSH_SHARED_WORKSPACE_REMOTE_ROOT";

export async function resolveSharedSshWorkspaceMapping(input: {
  workspaceLocalDir: string;
  env?: Record<string, string | undefined>;
}): Promise<{ localDir: string; remoteDir: string } | null> {
  const env = input.env ?? process.env;
  const configuredLocalRoot = env[SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV]?.trim() ?? "";
  const configuredRemoteRoot = env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV]?.trim() ?? "";
  if (!configuredLocalRoot && !configuredRemoteRoot) return null;
  if (!configuredLocalRoot || !configuredRemoteRoot) {
    throw new Error(
      `${SSH_SHARED_WORKSPACE_LOCAL_ROOT_ENV} and ${SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV} must be configured together`,
    );
  }
  if (!path.isAbsolute(configuredLocalRoot) || !path.posix.isAbsolute(configuredRemoteRoot)) {
    throw new Error("Shared SSH workspace roots must be absolute paths");
  }

  const [localRoot, localDir] = await Promise.all([
    fs.realpath(configuredLocalRoot),
    fs.realpath(input.workspaceLocalDir),
  ]);
  const relative = path.relative(localRoot, localDir);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`SSH shared workspace must be a strict descendant of ${localRoot}`);
  }
  const remoteRoot = path.posix.normalize(configuredRemoteRoot);
  if (remoteRoot !== configuredRemoteRoot || remoteRoot === "/") {
    throw new Error(`${SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV} must be canonical and non-root`);
  }
  const remoteDir = path.posix.join(remoteRoot, ...relative.split(path.sep));
  return { localDir, remoteDir };
}

async function resolveSharedWorkspace(input: {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
}): Promise<{ localDir: string; remoteDir: string } | null> {
  const mapping = await resolveSharedSshWorkspaceMapping(input);
  if (!mapping) return null;
  const remoteRoot = process.env[SSH_SHARED_WORKSPACE_REMOTE_ROOT_ENV]!.trim();
  const { localDir, remoteDir } = mapping;
  const observed = await runSshCommand(
    input.spec,
    [
      `root=$(realpath -- ${shellQuote(remoteRoot)})`,
      `cwd=$(realpath -- ${shellQuote(remoteDir)})`,
      'case "$cwd" in "$root"/*) ;; *) exit 41 ;; esac',
      'test -d "$cwd" && test -w "$cwd"',
      'printf "%s\\n" "$cwd"',
    ].join("\n"),
  );
  if (observed.stdout.trim() !== remoteDir) {
    throw new Error(`SSH shared workspace identity mismatch: expected ${remoteDir}`);
  }
  return { localDir, remoteDir };
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
  const sharedWorkspace = await resolveSharedWorkspace({
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
  });
  if (sharedWorkspace) {
    await preflightDirectoryMergeLock(sharedWorkspace.localDir);
    await normalizeSshWorkspaceWriteAccess({
      spec: input.spec,
      remoteDir: sharedWorkspace.remoteDir,
    });
    await preflightSshWorkspaceWriteAccess({
      spec: input.spec,
      remoteDir: sharedWorkspace.remoteDir,
    });

    const runtimeRootDir = path.posix.join(
      path.posix.dirname(sharedWorkspace.remoteDir),
      ".paperclip-runtime",
      "runs",
      input.runId,
      input.adapterKey,
    );
    const assetDirs: Record<string, string> = {};
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
    return {
      spec: input.spec,
      workspaceLocalDir: sharedWorkspace.localDir,
      workspaceRemoteDir: sharedWorkspace.remoteDir,
      runtimeRootDir,
      assetDirs,
      restoreWorkspace: async () => {
        await runSshCommand(input.spec, `rm -rf -- ${shellQuote(runtimeRootDir)}`);
      },
    };
  }

  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const workspaceRemoteDir = path.posix.join(
    baseWorkspaceRemoteDir,
    ".paperclip-runtime",
    "runs",
    input.runId,
    "workspace",
  );
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  try {
    await preflightDirectoryMergeLock(input.workspaceLocalDir);
  } catch (error) {
    throw new WorkspaceNotWritableError(
      `Local workspace restore preflight failed for ${input.workspaceLocalDir}; provider invocation was not attempted.`,
      { cause: error },
    );
  }

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
