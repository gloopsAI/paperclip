import { describe, expect, it } from "vitest";
import type { ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";
import { decideWorkspaceAutoCleanup } from "./workspace-auto-cleanup.js";

function readiness(overrides: Partial<ExecutionWorkspaceCloseReadiness> = {}): ExecutionWorkspaceCloseReadiness {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: {
      repoRoot: "/tmp/repo",
      workspacePath: "/tmp/worktree",
      branchName: "paperclip/work",
      baseRef: "gloops/stable",
      hasDirtyTrackedFiles: false,
      hasUntrackedFiles: false,
      dirtyEntryCount: 0,
      untrackedEntryCount: 0,
      aheadCount: 1,
      behindCount: 0,
      isMergedIntoBase: true,
      createdByRuntime: true,
    },
    runtimeServices: [],
    ...overrides,
  };
}

const terminalReceipt = {
  state: "reconciled_success",
  expectedNewOid: "b".repeat(40),
  remoteNewOid: "b".repeat(40),
};

describe("decideWorkspaceAutoCleanup", () => {
  it("admits automatic cleanup only after terminal exact-head publication and salvage", () => {
    expect(decideWorkspaceAutoCleanup({
      now: new Date("2026-08-13T12:00:00Z"),
      issueStatus: "done",
      cleanupEligibleAt: "2026-08-13T11:00:00Z",
      readiness: readiness(),
      workProducts: [{ provider: "paperclip", status: "ready", metadata: { attachmentId: "attachment-1" } }],
      requiresPublicationReceipt: true,
      publicationReceipt: terminalReceipt,
    })).toEqual({ action: "cleanup", reason: "eligible_after_verified_salvage" });
  });

  it.each([
    ["dirty tracked files", readiness({ git: { ...readiness().git!, hasDirtyTrackedFiles: true, dirtyEntryCount: 1 } }), [], "tracked_changes_unsalvaged"],
    ["untracked files", readiness({ git: { ...readiness().git!, hasUntrackedFiles: true, untrackedEntryCount: 1 } }), [], "untracked_files_unsalvaged"],
    ["unmerged branch", readiness({ git: { ...readiness().git!, isMergedIntoBase: false } }), [], "branch_not_merged"],
    ["shared workspace", readiness({ isSharedWorkspace: true }), [], "shared_or_primary_workspace"],
    [
      "missing workspace path",
      readiness({
        warnings: ["Workspace path does not exist"],
        git: { ...readiness().git!, repoRoot: null },
      }),
      [],
      "workspace_inspection_incomplete",
    ],
    [
      "uninspectable repository",
      readiness({ git: { ...readiness().git!, repoRoot: null } }),
      [],
      "workspace_inspection_incomplete",
    ],
    [
      "workspace-only artifact",
      readiness(),
      [{ provider: "workspace", status: "ready", metadata: { resourceRef: { kind: "workspace_file" } } }],
      "workspace_artifact_unsalvaged",
    ],
  ])("blocks %s before destructive cleanup", (_name, closeReadiness, workProducts, reason) => {
    expect(decideWorkspaceAutoCleanup({
      now: new Date("2026-08-13T12:00:00Z"),
      issueStatus: "done",
      cleanupEligibleAt: "2026-08-13T11:00:00Z",
      readiness: closeReadiness as ExecutionWorkspaceCloseReadiness,
      workProducts: workProducts as never,
      requiresPublicationReceipt: true,
      publicationReceipt: terminalReceipt,
    })).toMatchObject({ action: "block", reason });
  });

  it("rejects a publication receipt whose remote head does not equal the expected head", () => {
    expect(decideWorkspaceAutoCleanup({
      now: new Date("2026-08-13T12:00:00Z"),
      issueStatus: "done",
      cleanupEligibleAt: "2026-08-13T11:00:00Z",
      readiness: readiness(),
      workProducts: [],
      requiresPublicationReceipt: true,
      publicationReceipt: { ...terminalReceipt, remoteNewOid: "c".repeat(40) },
    })).toMatchObject({ action: "block", reason: "publication_receipt_not_terminal" });
  });
});
