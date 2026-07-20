import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";

/**
 * Directory basenames that are dependency/build/tooling caches and must never
 * ride SSH/sandbox workspace tar transport. Expanded to root + nested forms so
 * monorepo layouts (packages/<pkg>/node_modules) are covered by tar --exclude.
 */
export const WORKSPACE_HEAVY_DIR_NAMES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
] as const;

export function expandWorkspaceHeavyDirExcludes(
  names: readonly string[] = WORKSPACE_HEAVY_DIR_NAMES,
): string[] {
  return names.flatMap((entry) => [
    entry,
    `${entry}/*`,
    `*/${entry}`,
    `*/${entry}/*`,
  ]);
}

export const WORKSPACE_HEAVY_DIR_EXCLUDES = expandWorkspaceHeavyDirExcludes();

export function mergeWorkspaceArchiveExcludes(
  ...groups: Array<readonly string[] | string[] | undefined | null>
): string[] {
  return [...new Set(groups.flatMap((group) => (group ? [...group] : [])))];
}

/**
 * Compose the tar/snapshot exclude list for managed workspace import/export.
 * Heavy dirs are always included; git internals and `.paperclip-runtime` are
 * optional via flags; callers may add `workspaceExclude` and gitignored paths.
 */
export function buildManagedWorkspaceArchiveExclude(input: {
  gitBacked?: boolean;
  includePaperclipRuntime?: boolean;
  workspaceExclude?: readonly string[] | string[] | null;
  gitIgnoredPaths?: readonly string[] | string[] | null;
  extra?: readonly string[] | string[] | null;
}): string[] {
  return mergeWorkspaceArchiveExcludes(
    WORKSPACE_HEAVY_DIR_EXCLUDES,
    input.gitBacked ? GIT_ARCHIVE_EXCLUDES : undefined,
    input.includePaperclipRuntime === false ? undefined : [".paperclip-runtime"],
    input.workspaceExclude,
    input.gitIgnoredPaths,
    input.extra,
  );
}
