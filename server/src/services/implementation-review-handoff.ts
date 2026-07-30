/**
 * Implementation → Argus review handoff (MAW loop lane 2).
 *
 * When repository-backed standard work settles as implementation_ready /
 * in_review, create exactly one child review issue for the company reviewer
 * (Argus) with the exact head SHA. Does not open PRs (broker-owned) and does
 * not weaken verified_change.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";

const SHA_RE = /^[0-9a-f]{40}$/i;
export const REVIEW_HANDOFF_MARKER = "maw-implementation-review";

export type DraftPullRequestEvidence =
  | { disposition: "created"; prNumber: number; prUrl: string }
  | { disposition: "none" }
  | null
  | undefined;

export type ImplementationReviewHandoffPlan =
  | {
      action: "skip";
      reason:
        | "missing_exact_head"
        | "missing_reviewer"
        | "missing_project"
        | "duplicate_open_review"
        | "probe_work_mode"
        | "same_agent_reviewer";
    }
  | {
      action: "create";
      title: string;
      description: string;
      parentId: string;
      projectId: string;
      assigneeAgentId: string;
      exactHeadSha: string;
      draftPrUrl: string | null;
    };

export function isExactHeadSha(value: string | null | undefined): value is string {
  return typeof value === "string" && SHA_RE.test(value.trim());
}

/**
 * Declared workspace head for maw-implementation-review children (GLO-1940 / C2).
 * Always bind baseRef to the exact implement head — never project pin / gloops/stable.
 */
export function buildReviewExecutionWorkspaceSettings(exactHeadSha: string): {
  mode: "isolated_workspace";
  workspaceStrategy: {
    type: "git_worktree";
    baseRef: string;
  };
} {
  if (!isExactHeadSha(exactHeadSha)) {
    throw new Error("review_declared_head_missing: exactHeadSha must be a full 40-char SHA");
  }
  return {
    mode: "isolated_workspace",
    workspaceStrategy: {
      type: "git_worktree",
      baseRef: exactHeadSha.trim().toLowerCase(),
    },
  };
}

export function buildImplementationReviewTitle(input: {
  parentIdentifier: string | null | undefined;
  exactHeadSha: string;
}): string {
  const parent = input.parentIdentifier?.trim() || "implementation";
  const short = input.exactHeadSha.slice(0, 12);
  return `Review exact head ${short} (${parent}) [${REVIEW_HANDOFF_MARKER}]`;
}

export function buildImplementationReviewDescription(input: {
  parentIdentifier: string | null | undefined;
  parentId: string;
  exactHeadSha: string;
  implementerAgentId: string;
  draftPr: DraftPullRequestEvidence;
}): string {
  const parentLabel = input.parentIdentifier?.trim() || input.parentId;
  const prLine =
    input.draftPr && input.draftPr.disposition === "created"
      ? `- Draft PR: #${input.draftPr.prNumber} ${input.draftPr.prUrl}`
      : `- Draft PR: none yet (broker-owned; review exact head even if PR pending)`;

  return `## Objective
Independent exact-head review of implementation for ${parentLabel}.

## Scope
- Review **exact head** \`${input.exactHeadSha}\`
- Read-only: diff, touched files, tests/CI evidence if present
- Verdict: APPROVE or CHANGES_REQUESTED (≤3 findings)

## Grounding
- Parent issue: ${parentLabel} (\`${input.parentId}\`)
- Implementer agent: \`${input.implementerAgentId}\`
${prLine}
- Marker: \`${REVIEW_HANDOFF_MARKER}\`

## Non-goals
- No code edits, push, merge, or deploy

## Acceptance
One verdict comment naming the exact head SHA accepted or the must-fix P0/P1 list.

## Forbidden
Soft-approve without evidence; self-implement.
`;
}

export function planImplementationReviewHandoff(input: {
  parent: {
    id: string;
    identifier?: string | null;
    projectId?: string | null;
    workMode?: string | null;
    title?: string | null;
  };
  exactHeadSha: string | null | undefined;
  implementerAgentId: string;
  reviewerAgentId: string | null | undefined;
  existingChildren: Array<{
    id: string;
    title?: string | null;
    status?: string | null;
    assigneeAgentId?: string | null;
    description?: string | null;
  }>;
  draftPr?: DraftPullRequestEvidence;
}): ImplementationReviewHandoffPlan {
  const mode = typeof input.parent.workMode === "string" ? input.parent.workMode.trim().toLowerCase() : "";
  if (mode === "skill_test" || mode === "ask" || mode === "planning") {
    return { action: "skip", reason: "probe_work_mode" };
  }
  if (!isExactHeadSha(input.exactHeadSha)) {
    return { action: "skip", reason: "missing_exact_head" };
  }
  const head = input.exactHeadSha.trim().toLowerCase();
  if (!input.reviewerAgentId) {
    return { action: "skip", reason: "missing_reviewer" };
  }
  if (input.reviewerAgentId === input.implementerAgentId) {
    return { action: "skip", reason: "same_agent_reviewer" };
  }
  if (!input.parent.projectId) {
    return { action: "skip", reason: "missing_project" };
  }

  const openStatuses = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
  const duplicate = input.existingChildren.some((child) => {
    if (!openStatuses.has(String(child.status ?? ""))) return false;
    const title = String(child.title ?? "");
    const description = String(child.description ?? "");
    const hasMarker =
      title.includes(REVIEW_HANDOFF_MARKER) || description.includes(REVIEW_HANDOFF_MARKER);
    const hasHead =
      title.includes(head.slice(0, 12)) ||
      description.includes(head) ||
      description.includes(`\`${head}\``);
    return hasMarker && hasHead;
  });
  if (duplicate) {
    return { action: "skip", reason: "duplicate_open_review" };
  }

  const draftPrUrl =
    input.draftPr && input.draftPr.disposition === "created" ? input.draftPr.prUrl : null;

  return {
    action: "create",
    title: buildImplementationReviewTitle({
      parentIdentifier: input.parent.identifier,
      exactHeadSha: head,
    }),
    description: buildImplementationReviewDescription({
      parentIdentifier: input.parent.identifier,
      parentId: input.parent.id,
      exactHeadSha: head,
      implementerAgentId: input.implementerAgentId,
      draftPr: input.draftPr,
    }),
    parentId: input.parent.id,
    projectId: input.parent.projectId,
    assigneeAgentId: input.reviewerAgentId,
    exactHeadSha: head,
    draftPrUrl,
  };
}

export function pickCompanyReviewerAgent(
  companyAgents: Array<{ id: string; name?: string | null; role?: string | null; status?: string | null }>,
): string | null {
  const live = companyAgents.filter((a) => a.status !== "terminated" && a.status !== "pending_approval");
  const byName = live.find((a) => String(a.name ?? "").trim().toLowerCase() === "argus");
  if (byName) return byName.id;
  const byRole = live.find((a) => {
    const role = String(a.role ?? "").trim().toLowerCase();
    return role === "qa" || role === "reviewer" || role === "quality";
  });
  return byRole?.id ?? null;
}

export type ImplementationReviewHandoffResult =
  | { ok: true; action: "skipped"; reason: string }
  | { ok: true; action: "created"; reviewIssueId: string; reviewIdentifier: string | null }
  | { ok: false; error: string };

/**
 * Best-effort: create Argus review child after implementation_ready.
 * Never throws into the settlement path — callers should catch/log.
 */
export async function ensureImplementationReviewHandoff(
  db: Db,
  input: {
    companyId: string;
    parentIssueId: string;
    implementerAgentId: string;
    exactHeadSha: string | null | undefined;
    draftPr?: DraftPullRequestEvidence;
    enqueueWakeup?: (agentId: string, payload: {
      source: string;
      triggerDetail?: string;
      reason?: string;
      payload?: Record<string, unknown>;
    }) => Promise<unknown>;
  },
): Promise<ImplementationReviewHandoffResult> {
  try {
    const [parent] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        projectId: issues.projectId,
        workMode: issues.workMode,
        title: issues.title,
        companyId: issues.companyId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.parentIssueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    if (!parent) {
      return { ok: false, error: "parent_issue_not_found" };
    }

    const companyAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, input.companyId));

    const reviewerAgentId = pickCompanyReviewerAgent(companyAgents);

    const children = await db
      .select({
        id: issues.id,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        description: issues.description,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.parentId, parent.id),
          ne(issues.status, "cancelled"),
        ),
      );

    const plan = planImplementationReviewHandoff({
      parent,
      exactHeadSha: input.exactHeadSha,
      implementerAgentId: input.implementerAgentId,
      reviewerAgentId,
      existingChildren: children,
      draftPr: input.draftPr,
    });

    if (plan.action === "skip") {
      return { ok: true, action: "skipped", reason: plan.reason };
    }

    const created = await issueService(db).create(input.companyId, {
      title: plan.title,
      description: plan.description,
      status: "todo",
      priority: "high",
      workMode: "standard",
      projectId: plan.projectId,
      parentId: plan.parentId,
      assigneeAgentId: plan.assigneeAgentId,
      // Declared workspace head MUST be exact head for reviews (GLO-1940 / GLO-1941 / C2).
      // Never fall back to project pin / origin/gloops/stable here.
      executionWorkspaceSettings: buildReviewExecutionWorkspaceSettings(plan.exactHeadSha),
    } as never);

    const reviewIssueId = (created as { id?: string })?.id;
    const reviewIdentifier = (created as { identifier?: string | null })?.identifier ?? null;
    if (!reviewIssueId) {
      return { ok: false, error: "create_returned_no_id" };
    }

    if (input.enqueueWakeup) {
      await input.enqueueWakeup(plan.assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "implementation_review_handoff",
        payload: {
          issueId: reviewIssueId,
          parentIssueId: parent.id,
          exactHeadSha: plan.exactHeadSha,
          draftPrUrl: plan.draftPrUrl,
        },
      });
    }

    logger.info(
      {
        parentIssueId: parent.id,
        reviewIssueId,
        reviewerAgentId: plan.assigneeAgentId,
        exactHeadSha: plan.exactHeadSha,
      },
      "implementation review handoff created",
    );

    return {
      ok: true,
      action: "created",
      reviewIssueId,
      reviewIdentifier,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, parentIssueId: input.parentIssueId }, "implementation review handoff failed");
    return { ok: false, error: message };
  }
}
