import type { ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";

export type WorkspaceAutoCleanupDecision =
  | { action: "cleanup"; reason: "eligible_after_verified_salvage" }
  | { action: "wait"; reason: "not_scheduled" | "retention_window" | "issue_not_terminal" }
  | {
      action: "block";
      reason:
        | "close_readiness_blocked"
        | "workspace_not_runtime_created"
        | "workspace_inspection_incomplete"
        | "shared_or_primary_workspace"
        | "tracked_changes_unsalvaged"
        | "untracked_files_unsalvaged"
        | "branch_not_merged"
        | "publication_receipt_missing"
        | "publication_receipt_not_terminal"
        | "workspace_artifact_unsalvaged";
      detail: string;
    };

export interface WorkspaceCleanupWorkProduct {
  provider: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isUnsalvagedWorkspaceReference(product: WorkspaceCleanupWorkProduct) {
  const ref = asRecord(product.metadata?.resourceRef);
  if (ref?.kind !== "workspace_file") return false;
  return typeof product.metadata?.salvagedAttachmentId !== "string"
    && typeof product.metadata?.salvagedArtifactId !== "string";
}

/**
 * Fail-closed admission for destructive automatic cleanup after separately
 * recorded salvage. This gate never claims to perform salvage itself. Manual
 * workspace close remains a separate board action and this gate is stricter.
 */
export function decideWorkspaceAutoCleanup(input: {
  now: Date;
  issueStatus: string;
  cleanupEligibleAt: Date | string | null;
  readiness: ExecutionWorkspaceCloseReadiness;
  workProducts: WorkspaceCleanupWorkProduct[];
  requiresPublicationReceipt: boolean;
  publicationReceipt: {
    state: string;
    expectedNewOid: string;
    remoteNewOid: string | null;
  } | null;
}): WorkspaceAutoCleanupDecision {
  if (!input.cleanupEligibleAt) return { action: "wait", reason: "not_scheduled" };
  const eligibleAt = new Date(input.cleanupEligibleAt);
  if (!Number.isFinite(eligibleAt.getTime()) || eligibleAt.getTime() > input.now.getTime()) {
    return { action: "wait", reason: "retention_window" };
  }
  if (input.issueStatus !== "done" && input.issueStatus !== "cancelled") {
    return { action: "wait", reason: "issue_not_terminal" };
  }
  if (!input.readiness.isDestructiveCloseAllowed || input.readiness.state === "blocked") {
    return {
      action: "block",
      reason: "close_readiness_blocked",
      detail: input.readiness.blockingReasons.join(" | ") || "Workspace close readiness is blocked",
    };
  }
  if (input.readiness.isSharedWorkspace || input.readiness.isProjectPrimaryWorkspace) {
    return {
      action: "block",
      reason: "shared_or_primary_workspace",
      detail: "Automatic cleanup is limited to isolated execution workspaces",
    };
  }

  const git = input.readiness.git;
  if (!git?.createdByRuntime) {
    return {
      action: "block",
      reason: "workspace_not_runtime_created",
      detail: "Automatic cleanup cannot remove a workspace Paperclip did not create",
    };
  }
  if (
    input.readiness.warnings.length > 0
    || !git.repoRoot
    || !git.workspacePath
  ) {
    return {
      action: "block",
      reason: "workspace_inspection_incomplete",
      detail: input.readiness.warnings.join(" | ")
        || "Automatic cleanup requires a verified repository root and existing workspace path",
    };
  }
  if (git?.hasDirtyTrackedFiles) {
    return { action: "block", reason: "tracked_changes_unsalvaged", detail: "Tracked changes remain in the workspace" };
  }
  if (git?.hasUntrackedFiles) {
    return { action: "block", reason: "untracked_files_unsalvaged", detail: "Untracked files remain in the workspace" };
  }
  if (git && git.aheadCount && git.aheadCount > 0 && git.isMergedIntoBase !== true) {
    return { action: "block", reason: "branch_not_merged", detail: "Workspace branch is not merged into its exact base" };
  }
  const unsalvagedCount = input.workProducts.filter(isUnsalvagedWorkspaceReference).length;
  if (unsalvagedCount > 0) {
    return {
      action: "block",
      reason: "workspace_artifact_unsalvaged",
      detail: `${unsalvagedCount} workspace-only artifact${unsalvagedCount === 1 ? "" : "s"} lack attachment-backed salvage`,
    };
  }
  if (input.requiresPublicationReceipt && !input.publicationReceipt) {
    return { action: "block", reason: "publication_receipt_missing", detail: "No exact-head publication receipt exists" };
  }
  if (
    input.requiresPublicationReceipt
    && input.publicationReceipt
    && (
      input.publicationReceipt.state !== "reconciled_success"
      || input.publicationReceipt.remoteNewOid !== input.publicationReceipt.expectedNewOid
    )
  ) {
    return {
      action: "block",
      reason: "publication_receipt_not_terminal",
      detail: "Publication receipt does not prove the expected exact head",
    };
  }
  return { action: "cleanup", reason: "eligible_after_verified_salvage" };
}
