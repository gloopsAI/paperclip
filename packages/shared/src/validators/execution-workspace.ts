import { z } from "zod";
import {
  WORKSPACE_OVERVIEW_DEFAULT_LIMIT,
  WORKSPACE_OVERVIEW_MAX_LIMIT,
} from "../constants.js";

export const executionWorkspaceStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

const workspaceOverviewStatusFilterSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const statuses = rawValues.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    return entry.split(",").map((part) => part.trim()).filter(Boolean);
  });
  return statuses.length > 0 ? statuses : undefined;
}, z.array(executionWorkspaceStatusSchema).optional());

export const workspaceOverviewQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  status: workspaceOverviewStatusFilterSchema,
  limit: z.coerce.number().int().min(1).max(WORKSPACE_OVERVIEW_MAX_LIMIT).optional().default(WORKSPACE_OVERVIEW_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).optional().default(0),
}).strict();

export const executionWorkspaceConfigSchema = z.object({
  environmentId: z.string().uuid().optional().nullable(),
  provisionCommand: z.string().optional().nullable(),
  teardownCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

export const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
}).strict();

export const executionWorkspaceCloseReadinessStateSchema = z.enum([
  "ready",
  "ready_with_warnings",
  "blocked",
]);

export const executionWorkspaceCloseActionKindSchema = z.enum([
  "archive_record",
  "stop_runtime_services",
  "cleanup_command",
  "teardown_command",
  "git_worktree_remove",
  "git_branch_delete",
  "remove_local_directory",
]);

export const executionWorkspaceCloseActionSchema = z.object({
  kind: executionWorkspaceCloseActionKindSchema,
  label: z.string(),
  description: z.string(),
  command: z.string().nullable(),
}).strict();

export const executionWorkspaceCloseLinkedIssueSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  isTerminal: z.boolean(),
}).strict();

export const executionWorkspaceCloseGitReadinessSchema = z.object({
  repoRoot: z.string().nullable(),
  workspacePath: z.string().nullable(),
  branchName: z.string().nullable(),
  baseRef: z.string().nullable(),
  hasDirtyTrackedFiles: z.boolean(),
  hasUntrackedFiles: z.boolean(),
  dirtyEntryCount: z.number().int().nonnegative(),
  untrackedEntryCount: z.number().int().nonnegative(),
  aheadCount: z.number().int().nonnegative().nullable(),
  behindCount: z.number().int().nonnegative().nullable(),
  isMergedIntoBase: z.boolean().nullable(),
  createdByRuntime: z.boolean(),
}).strict();

export const workspaceRuntimeServiceSchema = z.object({
  id: z.string(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  projectWorkspaceId: z.string().uuid().nullable(),
  executionWorkspaceId: z.string().uuid().nullable(),
  issueId: z.string().uuid().nullable(),
  scopeType: z.enum(["project_workspace", "execution_workspace", "run", "agent"]),
  scopeId: z.string().nullable(),
  serviceName: z.string(),
  status: z.enum(["starting", "running", "stopped", "failed"]),
  lifecycle: z.enum(["shared", "ephemeral"]),
  reuseKey: z.string().nullable(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
  port: z.number().int().nullable(),
  url: z.string().nullable(),
  provider: z.enum(["local_process", "adapter_managed"]),
  providerRef: z.string().nullable(),
  ownerAgentId: z.string().uuid().nullable(),
  startedByRunId: z.string().uuid().nullable(),
  lastUsedAt: z.coerce.date(),
  startedAt: z.coerce.date(),
  stoppedAt: z.coerce.date().nullable(),
  stopPolicy: z.record(z.string(), z.unknown()).nullable(),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]),
  configIndex: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).strict();
export const executionWorkspaceCloseReadinessSchema = z.object({
  workspaceId: z.string().uuid(),
  state: executionWorkspaceCloseReadinessStateSchema,
  blockingReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  linkedIssues: z.array(executionWorkspaceCloseLinkedIssueSchema),
  plannedActions: z.array(executionWorkspaceCloseActionSchema),
  isDestructiveCloseAllowed: z.boolean(),
  isSharedWorkspace: z.boolean(),
  isProjectPrimaryWorkspace: z.boolean(),
  git: executionWorkspaceCloseGitReadinessSchema.nullable(),
  runtimeServices: z.array(workspaceRuntimeServiceSchema),
}).strict();

export const updateExecutionWorkspaceSchema = z.object({
  name: z.string().min(1).optional(),
  cwd: z.string().optional().nullable(),
  repoUrl: z.string().optional().nullable(),
  baseRef: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  providerRef: z.string().optional().nullable(),
  status: executionWorkspaceStatusSchema.optional(),
  cleanupEligibleAt: z.string().datetime().optional().nullable(),
  cleanupReason: z.string().optional().nullable(),
  config: executionWorkspaceConfigSchema.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
}).strict();

const branchReconcileReasonSchema = z.string().trim().min(1);

export const reconcileExecutionWorkspaceBranchSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("forward"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
  z.object({
    mode: z.literal("override"),
    reason: branchReconcileReasonSchema,
  }).strict(),
  z.object({
    mode: z.literal("quarantine_restore"),
    reason: branchReconcileReasonSchema.optional().nullable(),
  }).strict(),
]);

export type UpdateExecutionWorkspace = z.infer<typeof updateExecutionWorkspaceSchema>;
export type ReconcileExecutionWorkspaceBranch = z.infer<typeof reconcileExecutionWorkspaceBranchSchema>;
export type WorkspaceOverviewQuery = z.infer<typeof workspaceOverviewQuerySchema>;

// Variables `renderWorkspaceTemplate()` (server/src/services/workspace-runtime.ts)
// resolves in a `workspaceStrategy.branchTemplate` string. Kept as the single
// source of truth so both save-time validation (below) and admission-time
// rendering agree on what is supported.
export const SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES = [
  "issue.id",
  "issue.identifier",
  "issue.title",
  "agent.id",
  "agent.name",
  "project.id",
  "workspace.repoRef",
  "slug",
] as const;

// Same placeholder shape `renderTemplate()`
// (packages/adapter-utils/src/server-utils.ts) recognizes: a double-curly
// block wrapping a dotted variable name. Any other placeholder shape —
// single-brace `{identifier}`, angle-bracket `<slug>`, or a malformed
// `{{...}}` — is left as literal text by `renderTemplate()` instead of being
// expanded, so it must be flagged rather than silently sanitized away.
const WORKSPACE_BRANCH_TEMPLATE_PLACEHOLDER_PATTERN = /{{\s*([a-zA-Z0-9_.-]+)\s*}}/g;
const WORKSPACE_BRANCH_TEMPLATE_STRAY_PLACEHOLDER_CHAR_PATTERN = /[{}<>]/;

/**
 * Returns the `{{dotted.path}}` variable names referenced by `template` that
 * are not in `SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES`. These match
 * `renderTemplate()`'s placeholder regex, so they would otherwise silently
 * render to an empty string instead of failing.
 */
export function findUnsupportedWorkspaceBranchTemplateVariables(template: string): string[] {
  const supported = new Set<string>(SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES);
  const unsupported = new Set<string>();
  for (const match of template.matchAll(WORKSPACE_BRANCH_TEMPLATE_PLACEHOLDER_PATTERN)) {
    if (!supported.has(match[1])) unsupported.add(match[1]);
  }
  return Array.from(unsupported);
}

/**
 * True when `value` contains placeholder-shaped syntax (`{`, `}`, `<`, `>`)
 * outside of a recognized `{{dotted.path}}` block. Safe to call on either the
 * raw template (recognized blocks are stripped before checking) or on a
 * fully rendered branch name (which should contain no `{{...}}` blocks at
 * all, so any brace/angle-bracket character indicates a placeholder that was
 * never expanded).
 */
export function hasStrayWorkspaceBranchTemplatePlaceholderSyntax(value: string): boolean {
  const withoutRecognizedPlaceholders = value.replace(WORKSPACE_BRANCH_TEMPLATE_PLACEHOLDER_PATTERN, "");
  return WORKSPACE_BRANCH_TEMPLATE_STRAY_PLACEHOLDER_CHAR_PATTERN.test(withoutRecognizedPlaceholders);
}

export function describeSupportedWorkspaceBranchTemplateVariables(): string {
  return SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(", ");
}
