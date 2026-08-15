import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  activityLog,
  issueWorkProducts,
  issues,
  projects,
  projectWorkspaces,
  repositoryMutationReceipts,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { executionWorkspaceService, readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { logActivity } from "./activity-log.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";
import { decideWorkspaceAutoCleanup } from "./workspace-auto-cleanup.js";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 10;
const ACTIVE_WORKSPACE_STATUSES = ["active", "idle", "in_review"];

type LifecycleOutcome = "archived" | "reconciled_absent" | "cleanup_failed";

function lifecycleReceipt(input: {
  workspaceId: string;
  sourceIssueId: string | null;
  outcome: LifecycleOutcome;
  warnings: string[];
  publicationReceipt: { state: string; expectedNewOid: string; remoteNewOid: string | null } | null;
  occurredAt: Date;
}) {
  const evidence = {
    schema: "gloops.execution-workspace-lifecycle-receipt.v1",
    workspaceId: input.workspaceId,
    sourceIssueId: input.sourceIssueId,
    outcome: input.outcome,
    warnings: [...input.warnings].sort(),
    publication: input.publicationReceipt,
    occurredAt: input.occurredAt.toISOString(),
  };
  return {
    ...evidence,
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
}

function cleanupReason(reason: string, detail: string) {
  return `auto_cleanup_blocked:${reason}:${detail}`;
}

export function workspaceAutoCleanupService(
  db: Db,
  opts: { pluginWorkerManager?: PluginWorkerManager } = {},
) {
  const workspaceSvc = executionWorkspaceService(db);
  const workspaceOperations = workspaceOperationService(db);
  const environmentRuntime = environmentRuntimeService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const inFlight = new Set<string>();

  async function recordBlocked(
    workspace: { id: string; companyId: string; cleanupReason: string | null },
    reason: string,
    detail: string,
  ) {
    const nextReason = cleanupReason(reason, detail);
    if (workspace.cleanupReason === nextReason) return;
    await workspaceSvc.update(workspace.id, { cleanupReason: nextReason });
    await logActivity(db, {
      companyId: workspace.companyId,
      actorType: "system",
      actorId: "workspace_auto_cleanup",
      action: "execution_workspace.auto_cleanup_blocked",
      entityType: "execution_workspace",
      entityId: workspace.id,
      details: { reason, detail },
    });
  }

  async function archiveWorkspace(input: {
    workspace: Awaited<ReturnType<typeof workspaceSvc.getById>> & {};
    now: Date;
    publicationReceipt: { state: string; expectedNewOid: string; remoteNewOid: string | null } | null;
  }) {
    const { workspace, now, publicationReceipt } = input;
    await environmentRuntime.destroyReusableSandboxLeases({
      companyId: workspace.companyId,
      executionWorkspaceId: workspace.id,
      failureReason: "execution_workspace_auto_cleanup",
    });
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: workspace.id,
      workspaceCwd: workspace.cwd,
    });

    const projectWorkspace = workspace.projectWorkspaceId
      ? await db
          .select({
            cwd: projectWorkspaces.cwd,
            cleanupCommand: projectWorkspaces.cleanupCommand,
          })
          .from(projectWorkspaces)
          .where(and(
            eq(projectWorkspaces.id, workspace.projectWorkspaceId),
            eq(projectWorkspaces.companyId, workspace.companyId),
          ))
          .then((rows) => rows[0] ?? null)
      : null;
    const projectPolicy = await db
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, workspace.companyId)))
      .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy));
    const config = readExecutionWorkspaceConfig(workspace.metadata ?? null);
    const result = await cleanupExecutionWorkspaceArtifacts({
      workspace,
      projectWorkspace,
      teardownCommand: config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
      cleanupCommand: config?.cleanupCommand ?? null,
      recorder: workspaceOperations.createRecorder({
        companyId: workspace.companyId,
        executionWorkspaceId: workspace.id,
      }),
    });
    const outcome: LifecycleOutcome = result.cleaned ? "archived" : "cleanup_failed";
    const receipt = lifecycleReceipt({
      workspaceId: workspace.id,
      sourceIssueId: workspace.sourceIssueId,
      outcome,
      warnings: result.warnings,
      publicationReceipt,
      occurredAt: now,
    });
    await db.transaction(async (tx) => {
      await tx.update(executionWorkspaces).set({
        status: result.cleaned ? "archived" : "cleanup_failed",
        closedAt: now,
        cleanupReason: result.warnings.length > 0 ? result.warnings.join(" | ") : null,
        updatedAt: now,
      }).where(and(
        eq(executionWorkspaces.id, workspace.id),
        eq(executionWorkspaces.companyId, workspace.companyId),
      ));
      await tx.insert(activityLog).values({
        companyId: workspace.companyId,
        actorType: "system",
        actorId: "workspace_auto_cleanup",
        action: result.cleaned
          ? "execution_workspace.auto_cleanup_completed"
          : "execution_workspace.auto_cleanup_failed",
        entityType: "execution_workspace",
        entityId: workspace.id,
        details: { ...receipt, cleaned: result.cleaned, salvagePrerequisite: "verified" },
      });
    });
    return result.cleaned;
  }

  async function reconcileAbsentWorkspace(input: {
    workspace: Awaited<ReturnType<typeof workspaceSvc.getById>> & {};
    now: Date;
    publicationReceipt: { state: string; expectedNewOid: string; remoteNewOid: string | null } | null;
  }) {
    await environmentRuntime.destroyReusableSandboxLeases({
      companyId: input.workspace.companyId,
      executionWorkspaceId: input.workspace.id,
      failureReason: "execution_workspace_auto_cleanup_reconcile_absent",
    });
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: input.workspace.id,
      workspaceCwd: input.workspace.cwd,
    });
    const receipt = lifecycleReceipt({
      workspaceId: input.workspace.id,
      sourceIssueId: input.workspace.sourceIssueId,
      outcome: "reconciled_absent",
      warnings: ["runtime-created workspace was already absent; no filesystem deletion was attempted"],
      publicationReceipt: input.publicationReceipt,
      occurredAt: input.now,
    });
    await db.transaction(async (tx) => {
      await tx.update(executionWorkspaces).set({
        status: "archived",
        closedAt: input.now,
        cleanupReason: "auto_cleanup_reconciled_absent",
        updatedAt: input.now,
      }).where(and(
        eq(executionWorkspaces.id, input.workspace.id),
        eq(executionWorkspaces.companyId, input.workspace.companyId),
      ));
      await tx.insert(activityLog).values({
        companyId: input.workspace.companyId,
        actorType: "system",
        actorId: "workspace_auto_cleanup",
        action: "execution_workspace.auto_cleanup_reconciled_absent",
        entityType: "execution_workspace",
        entityId: input.workspace.id,
        details: { ...receipt, filesystemDeletionAttempted: false },
      });
    });
  }

  async function recordExecutionFailure(input: {
    workspace: { id: string; companyId: string; sourceIssueId: string | null };
    now: Date;
    error: unknown;
  }) {
    const errorClass = input.error instanceof Error ? input.error.constructor.name : "UnknownError";
    const receipt = lifecycleReceipt({
      workspaceId: input.workspace.id,
      sourceIssueId: input.workspace.sourceIssueId,
      outcome: "cleanup_failed",
      warnings: [`automatic cleanup failed with ${errorClass}`],
      publicationReceipt: null,
      occurredAt: input.now,
    });
    await db.transaction(async (tx) => {
      await tx.update(executionWorkspaces).set({
        status: "cleanup_failed",
        closedAt: input.now,
        cleanupReason: cleanupReason("execution_failed", errorClass),
        updatedAt: input.now,
      }).where(and(
        eq(executionWorkspaces.id, input.workspace.id),
        eq(executionWorkspaces.companyId, input.workspace.companyId),
      ));
      await tx.insert(activityLog).values({
        companyId: input.workspace.companyId,
        actorType: "system",
        actorId: "workspace_auto_cleanup",
        action: "execution_workspace.auto_cleanup_failed",
        entityType: "execution_workspace",
        entityId: input.workspace.id,
        details: { ...receipt, errorClass },
      });
    });
  }

  return {
    runDue: async (now = new Date(), batchLimit = DEFAULT_BATCH_LIMIT) => {
      const candidates = await db
        .select({
          workspace: executionWorkspaces,
          issueStatus: issues.status,
        })
        .from(executionWorkspaces)
        .innerJoin(
          issues,
          and(
            eq(issues.id, executionWorkspaces.sourceIssueId),
            eq(issues.companyId, executionWorkspaces.companyId),
          ),
        )
        .where(and(
          inArray(executionWorkspaces.status, ACTIVE_WORKSPACE_STATUSES),
          inArray(issues.status, ["done", "cancelled"]),
        ))
        .orderBy(asc(executionWorkspaces.cleanupEligibleAt), asc(executionWorkspaces.updatedAt))
        .limit(Math.max(1, Math.min(50, batchLimit)));

      const result = { scheduled: 0, cleaned: 0, blocked: 0, failed: 0 };
      for (const candidate of candidates) {
        const row = candidate.workspace;
        if (inFlight.has(row.id)) continue;
        inFlight.add(row.id);
        try {
          const workspace = await workspaceSvc.getById(row.id);
          if (!workspace) continue;
          const readiness = await workspaceSvc.getCloseReadiness(row.id);
          if (!readiness) continue;

          // Automatic cleanup owns only isolated workspaces created by the
          // runtime. Manual, shared, and project-primary workspaces remain a
          // board-managed lifecycle and are not even scheduled.
          if (
            !readiness.git?.createdByRuntime
            || readiness.isSharedWorkspace
            || readiness.isProjectPrimaryWorkspace
          ) {
            continue;
          }

          if (!workspace.cleanupEligibleAt) {
            await workspaceSvc.update(workspace.id, {
              cleanupEligibleAt: new Date(now.getTime() + DEFAULT_RETENTION_MS),
              cleanupReason: "auto_cleanup_retention_window",
            });
            result.scheduled += 1;
            continue;
          }

          const workProducts = await db
            .select({
              provider: issueWorkProducts.provider,
              status: issueWorkProducts.status,
              metadata: issueWorkProducts.metadata,
            })
            .from(issueWorkProducts)
            .where(and(
              eq(issueWorkProducts.companyId, workspace.companyId),
              eq(issueWorkProducts.executionWorkspaceId, workspace.id),
            ));
          const publicationReceipt = workspace.branchName
            ? await db
                .select({
                  state: repositoryMutationReceipts.state,
                  expectedNewOid: repositoryMutationReceipts.expectedNewOid,
                  remoteNewOid: repositoryMutationReceipts.remoteNewOid,
                })
                .from(repositoryMutationReceipts)
                .where(and(
                  eq(repositoryMutationReceipts.companyId, workspace.companyId),
                  eq(repositoryMutationReceipts.issueId, workspace.sourceIssueId!),
                  eq(repositoryMutationReceipts.branchRef, workspace.branchName),
                ))
                .orderBy(desc(repositoryMutationReceipts.updatedAt))
                .limit(1)
                .then((rows) => rows[0] ?? null)
            : null;
          const decision = decideWorkspaceAutoCleanup({
            now,
            issueStatus: candidate.issueStatus,
            cleanupEligibleAt: workspace.cleanupEligibleAt,
            readiness,
            workProducts,
            requiresPublicationReceipt: workspace.providerType === "git_worktree",
            publicationReceipt,
          });
          if (decision.action === "wait") continue;
          if (decision.action === "block") {
            await recordBlocked(workspace, decision.reason, decision.detail);
            result.blocked += 1;
            continue;
          }
          if (decision.action === "reconcile") {
            await reconcileAbsentWorkspace({ workspace, now, publicationReceipt });
            result.cleaned += 1;
            continue;
          }
          if (await archiveWorkspace({ workspace, now, publicationReceipt })) result.cleaned += 1;
          else result.failed += 1;
        } catch (error) {
          result.failed += 1;
          await recordExecutionFailure({ workspace: row, now, error }).catch(() => undefined);
          logger.error({ err: error, executionWorkspaceId: row.id }, "automatic workspace cleanup failed");
        } finally {
          inFlight.delete(row.id);
        }
      }
      return result;
    },
  };
}
