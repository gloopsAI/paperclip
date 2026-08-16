/**
 * Implementation → Argus review handoff (MAW loop lane 2).
 *
 * When repository-backed standard work settles as implementation_ready /
 * in_review, create exactly one child review issue for the company reviewer
 * (Argus) with the exact head SHA. Does not open PRs (broker-owned) and does
 * not weaken verified_change.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { issueReviewProvenanceSchema, type IssueReviewProvenance } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { repositoryMutationReceiptService } from "./repository-mutation-receipts.js";

const SHA_RE = /^[0-9a-f]{40}$/i;
export const REVIEW_HANDOFF_MARKER = "maw-implementation-review";
export const MAX_IMPLEMENTATION_REVIEW_ROUNDS = 3;

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
        | "review_rounds_exhausted"
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
      exactBaseSha: string | null;
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
export function buildReviewExecutionWorkspaceSettings(
  exactHeadSha: string,
): {
  mode: "isolated_workspace";
  workspaceStrategy: {
    type: "git_worktree";
    baseRef: string;
    remoteRefreshPolicy: "local_only";
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
      remoteRefreshPolicy: "local_only",
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
  exactBaseSha?: string | null;
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
- Compare from exact base \`${isExactHeadSha(input.exactBaseSha) ? input.exactBaseSha.trim().toLowerCase() : "not recorded"}\`
- Read-only: diff, touched files, tests/CI evidence if present
- Local objects only; remote refresh is prohibited during review admission
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
  exactBaseSha?: string | null;
  exactHeadSha: string | null | undefined;
  implementerAgentId: string;
  reviewerAgentId: string | null | undefined;
  existingChildren: Array<{
    id: string;
    title?: string | null;
    status?: string | null;
    assigneeAgentId?: string | null;
    description?: string | null;
    executionWorkspaceSettings?: unknown;
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
  const canonicalReviewChildren = input.existingChildren.filter((child) => {
    const provenance = parseImplementationReviewProvenance(child.executionWorkspaceSettings);
    return (provenance?.kind === "implementation_exact_head"
      || provenance?.kind === "implementation_exact_head_v2")
      && provenance.parentIssueId === input.parent.id;
  });
  const duplicate = canonicalReviewChildren.some((child) => {
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
  const reviewRounds = canonicalReviewChildren.length;
  if (reviewRounds >= MAX_IMPLEMENTATION_REVIEW_ROUNDS) {
    return { action: "skip", reason: "review_rounds_exhausted" };
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
      exactBaseSha: input.exactBaseSha,
      exactHeadSha: head,
      implementerAgentId: input.implementerAgentId,
      draftPr: input.draftPr,
    }),
    parentId: input.parent.id,
    projectId: input.parent.projectId,
    assigneeAgentId: input.reviewerAgentId,
    exactBaseSha: isExactHeadSha(input.exactBaseSha)
      ? input.exactBaseSha.trim().toLowerCase()
      : null,
    exactHeadSha: head,
    draftPrUrl,
  };
}

export type ReviewerPickSource = "argus_name" | "reviewer_role" | "none";

export type ReviewerPick =
  | { id: string; source: Exclude<ReviewerPickSource, "none"> }
  | { source: "none" };

const HEALTHY_REVIEWER_STATUSES = new Set(["active", "idle", "running"]);
// Source-controlled durable review pool. Argus and Atlas are Luna/high;
// Mason is the Terra/medium provider-diverse reserve. The current implementer
// is always excluded, so a multi-role reserve can never self-review.
const DURABLE_REVIEWER_NAMES = new Set(["argus", "atlas", "mason"]);

export function pickCompanyReviewerCandidates(
  companyAgents: Array<{ id: string; name?: string | null; role?: string | null; status?: string | null }>,
  implementerAgentId?: string | null,
): Array<{ id: string; source: Exclude<ReviewerPickSource, "none"> }> {
  const qualified = companyAgents.filter((agent) => {
    if (agent.id === implementerAgentId) return false;
    if (!HEALTHY_REVIEWER_STATUSES.has(String(agent.status ?? "").trim().toLowerCase())) return false;
    const role = String(agent.role ?? "").trim().toLowerCase();
    const name = String(agent.name ?? "").trim().toLowerCase();
    return DURABLE_REVIEWER_NAMES.has(name)
      || role === "qa"
      || role === "reviewer"
      || role === "quality";
  });
  return qualified
    .map((agent) => ({
      id: agent.id,
      source: String(agent.name ?? "").trim().toLowerCase() === "argus"
        ? "argus_name" as const
        : "reviewer_role" as const,
    }))
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "argus_name" ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
}

export function pickCompanyReviewerAgent(
  companyAgents: Array<{ id: string; name?: string | null; role?: string | null; status?: string | null }>,
): string | null {
  const pick = pickCompanyReviewerAgentDetailed(companyAgents);
  return pick.source === "none" ? null : pick.id;
}

/**
 * Like {@link pickCompanyReviewerAgent} but also returns how the reviewer was
 * chosen. Used by reliability logging so fallback handoffs are visible
 * (GLO-2023 reviewer-fallback path).
 *
 * Tier order:
 *  1. agent named "argus"
 *  2. source-controlled durable review reserve or reviewer-style role
 * No generic live-agent fallback exists: only a designated reviewer can issue
 * a merge-authorizing verdict.
 */
export function pickCompanyReviewerAgentDetailed(
  companyAgents: Array<{ id: string; name?: string | null; role?: string | null; status?: string | null }>,
): ReviewerPick {
  return pickCompanyReviewerCandidates(companyAgents)[0] ?? { source: "none" };
}

export type ImplementationReviewHandoffResult =
  | { ok: true; action: "skipped"; reason: string; reviewerPickSource: ReviewerPickSource }
  | { ok: true; action: "created"; reviewIssueId: string; reviewIdentifier: string | null; reviewerPickSource: Exclude<ReviewerPickSource, "none"> }
  | { ok: false; error: string };

export type ReviewTerminalFailureInput = {
  runId: string;
  errorCode: string;
  error?: string;
  errorMessage?: string;
  exactBaseSha?: string | null;
  exactHeadSha?: string | null;
};

export const REVIEW_TERMINAL_FAILURE_MARKER = "REVIEW_TERMINAL_V1";
export const REVIEW_FAILOVER_MARKER = "REVIEW_FAILOVER_V1";

function isReviewerAvailabilityFailure(input: ReviewTerminalFailureInput): boolean {
  return /(?:provider_quota|provider_unavailable|workforce_capacity|subscription_route|timed_out|timeout)/i.test(
    `${input.errorCode} ${input.error ?? input.errorMessage ?? ""}`,
  );
}

export function remainingReviewerCandidateIds(
  provenance: Extract<IssueReviewProvenance, { kind: "implementation_exact_head_v2" }>,
  currentReviewerAgentId: string | null,
): string[] {
  const ordered = [provenance.reviewerAgentId, ...provenance.alternateReviewerAgentIds];
  const currentIndex = currentReviewerAgentId ? ordered.indexOf(currentReviewerAgentId) : -1;
  if (currentIndex < 0) return [];
  return ordered.slice(currentIndex + 1).filter((id) => id !== provenance.implementerAgentId);
}

export function parseImplementationReviewProvenance(
  executionWorkspaceSettings: unknown,
): IssueReviewProvenance | null {
  if (
    !executionWorkspaceSettings
    || typeof executionWorkspaceSettings !== "object"
    || Array.isArray(executionWorkspaceSettings)
  ) {
    return null;
  }
  const parsed = issueReviewProvenanceSchema.safeParse(
    (executionWorkspaceSettings as Record<string, unknown>).reviewProvenance,
  );
  return parsed.success ? parsed.data : null;
}

export function isImplementationReviewIssue(input: {
  executionWorkspaceSettings?: unknown;
  parentId?: string | null;
  authenticSourceRunId?: string | null;
}): boolean {
  const provenance = parseImplementationReviewProvenance(input.executionWorkspaceSettings);
  return provenance !== null
    && provenance.parentIssueId === input.parentId
    && provenance.sourceRunId === input.authenticSourceRunId;
}

export function buildReviewTerminalFailureComment(input: ReviewTerminalFailureInput): string {
  const exactBase = isExactHeadSha(input.exactBaseSha)
    ? input.exactBaseSha.trim().toLowerCase()
    : "unknown";
  const exactHead = isExactHeadSha(input.exactHeadSha)
    ? input.exactHeadSha.trim().toLowerCase()
    : "unknown";
  const terminalRecord = JSON.stringify({
    disposition: "REVIEW_NOT_RUN",
    owner: "platform_workspace",
    action: "materialize_exact_review_objects_and_retry",
    exactBaseSha: exactBase,
    exactHeadSha: exactHead,
    runId: input.runId,
    errorCode: input.errorCode,
  });
  return `## Review terminal disposition — REVIEW_NOT_RUN

- ${REVIEW_TERMINAL_FAILURE_MARKER}:${terminalRecord}
- Marker: \`${REVIEW_TERMINAL_FAILURE_MARKER}\`
- Disposition: \`REVIEW_NOT_RUN\`
- Owner: \`platform_workspace\`
- Required action: \`materialize_exact_review_objects_and_retry\`
- Exact base: \`${exactBase}\`
- Exact head: \`${exactHead}\`
- Run: \`${input.runId}\`
- Failure: \`${input.errorCode}\` — ${input.error ?? input.errorMessage ?? "No error message recorded"}

This is a terminal platform disposition for this attempt, not a code-review verdict. The review issue and its parent are blocked until the exact objects are locally available and a fresh review run is admitted.`;
}

function readDeclaredReviewSha(description: string | null | undefined, label: "base" | "head") {
  const match = String(description ?? "").match(
    new RegExp(`exact ${label}[^0-9a-f]+([0-9a-f]{40})`, "i"),
  );
  return match?.[1]?.toLowerCase() ?? null;
}

/** Persist a non-vacuous terminal review failure instead of leaving `in_review`. */
export async function persistImplementationReviewTerminalFailure(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
  } & ReviewTerminalFailureInput,
): Promise<{
  action: "recorded" | "duplicate" | "not_review_issue" | "stale_attempt" | "failed_over";
  parentBlocked: boolean;
  nextReviewerAgentId?: string;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select id from issues
      where id = ${input.issueId} and company_id = ${input.companyId}
      for update
    `);
    const issue = await tx
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    const provenance = issue
      ? parseImplementationReviewProvenance(issue.executionWorkspaceSettings)
      : null;
    const authenticParent = issue?.parentId && provenance?.parentIssueId === issue.parentId
      ? await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(
            eq(issues.id, issue.parentId),
            eq(issues.companyId, input.companyId),
          ))
          .then((rows) => rows[0] ?? null)
      : null;
    const authenticSourceRun = authenticParent && provenance
      ? await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.id, provenance.sourceRunId),
            eq(heartbeatRuns.companyId, input.companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue!.parentId!}`,
          ))
          .then((rows) => rows[0] ?? null)
      : null;
    if (
      !issue
      || !authenticParent
      || !isImplementationReviewIssue({
        ...issue,
        authenticSourceRunId: authenticSourceRun?.id ?? null,
      })
    ) {
      return { action: "not_review_issue" as const, parentBlocked: false };
    }
    if (
      issue.status === "done"
      || issue.status === "cancelled"
      || (issue.executionRunId !== input.runId && issue.checkoutRunId !== input.runId)
    ) {
      return { action: "stale_attempt" as const, parentBlocked: false };
    }

    if (provenance?.kind === "implementation_exact_head_v2" && isReviewerAvailabilityFailure(input)) {
      const candidateIds = remainingReviewerCandidateIds(provenance, issue.assigneeAgentId);
      const healthyCandidates = candidateIds.length > 0
        ? await tx
            .select({ id: agents.id })
            .from(agents)
            .where(and(
              eq(agents.companyId, input.companyId),
              inArray(agents.id, candidateIds),
              inArray(agents.status, ["active", "idle", "running"]),
            ))
        : [];
      const healthyIds = new Set(healthyCandidates.map((candidate) => candidate.id));
      const nextReviewerAgentId = candidateIds.find((id) => healthyIds.has(id)) ?? null;
      if (nextReviewerAgentId) {
        const updated = await tx
          .update(issues)
          .set({
            assigneeAgentId: nextReviewerAgentId,
            status: "todo",
            executionRunId: null,
            checkoutRunId: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issues.id, issue.id),
            eq(issues.companyId, input.companyId),
            eq(issues.assigneeAgentId, issue.assigneeAgentId!),
            or(eq(issues.executionRunId, input.runId), eq(issues.checkoutRunId, input.runId)),
          ))
          .returning({ id: issues.id });
        if (updated.length === 1) {
          await tx.insert(issueComments).values({
            companyId: input.companyId,
            issueId: issue.id,
            authorType: "system",
            createdByRunId: input.runId,
            body: `${REVIEW_FAILOVER_MARKER}: reviewer availability failed before a verdict; reassigned to the next independently designated reviewer.`,
          });
          return {
            action: "failed_over" as const,
            parentBlocked: false,
            nextReviewerAgentId,
          };
        }
      }
    }

    const body = buildReviewTerminalFailureComment({
      ...input,
      exactBaseSha: input.exactBaseSha ?? readDeclaredReviewSha(issue.description, "base"),
      exactHeadSha: input.exactHeadSha ?? readDeclaredReviewSha(issue.description, "head"),
    });
    const duplicate = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, input.runId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.body} like ${`%${REVIEW_TERMINAL_FAILURE_MARKER}:%`}`,
        sql`${issueComments.body} like ${`%"disposition":"REVIEW_NOT_RUN"%`}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!duplicate) {
      await tx.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorType: "system",
        createdByRunId: input.runId,
        body,
      });
    }
    await tx
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date() })
      .where(and(
        eq(issues.id, issue.id),
        eq(issues.companyId, input.companyId),
        or(eq(issues.executionRunId, input.runId), eq(issues.checkoutRunId, input.runId)),
      ));
    const parentBlocked = Boolean(issue.parentId) && (await tx
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date() })
      .where(and(
        eq(issues.id, issue.parentId!),
        eq(issues.companyId, input.companyId),
        eq(issues.status, "in_review"),
      ))
      .returning({ id: issues.id })).length === 1;
    return { action: duplicate ? "duplicate" as const : "recorded" as const, parentBlocked };
  });
}

async function persistImplementationReviewHandoffFailure(
  db: Db,
  input: {
    companyId: string;
    parentIssueId: string;
    runId: string;
    errorCode: string;
    error: string;
    exactBaseSha?: string | null;
    exactHeadSha?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select id from issues
      where id = ${input.parentIssueId} and company_id = ${input.companyId}
      for update
    `);
    const parent = await tx
      .select({
        id: issues.id,
        status: issues.status,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.parentIssueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (
      !parent
      || parent.status !== "in_review"
      || (parent.executionRunId !== input.runId && parent.checkoutRunId !== input.runId)
    ) return "stale_attempt" as const;

    const body = buildReviewTerminalFailureComment({
      runId: input.runId,
      errorCode: input.errorCode,
      error: input.error,
      exactBaseSha: input.exactBaseSha,
      exactHeadSha: input.exactHeadSha,
    });
    const existing = await tx
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, parent.id),
        eq(issueComments.createdByRunId, input.runId),
        eq(issueComments.authorType, "system"),
        sql`${issueComments.body} like ${`%${REVIEW_TERMINAL_FAILURE_MARKER}:%`}`,
        sql`${issueComments.body} like ${`%"disposition":"REVIEW_NOT_RUN"%`}`,
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!existing) {
      await tx.insert(issueComments).values({
        companyId: input.companyId,
        issueId: parent.id,
        authorType: "system",
        createdByRunId: input.runId,
        body,
      });
    }
    await tx.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(and(
      eq(issues.id, parent.id),
      eq(issues.companyId, input.companyId),
      eq(issues.status, "in_review"),
      or(eq(issues.executionRunId, input.runId), eq(issues.checkoutRunId, input.runId)),
    ));
    return existing ? "duplicate" as const : "recorded" as const;
  });
}

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
    sourceRunId: string;
    exactBaseSha?: string | null;
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
        projectWorkspaceId: issues.projectWorkspaceId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.parentIssueId), eq(issues.companyId, input.companyId)))
      .limit(1);
    if (!parent) {
      return { ok: false, error: "parent_issue_not_found" };
    }
    if (parent.executionRunId !== input.sourceRunId && parent.checkoutRunId !== input.sourceRunId) {
      return { ok: false, error: "source_run_not_bound_to_parent" };
    }
    const authenticSourceRun = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.sourceRunId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.implementerAgentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${parent.id}`,
      ))
      .then((rows) => rows[0] ?? null);
    if (!authenticSourceRun) {
      return { ok: false, error: "source_run_not_authentic" };
    }
    if (!parent.projectWorkspaceId || !isExactHeadSha(input.exactBaseSha) || !isExactHeadSha(input.exactHeadSha)) {
      await persistImplementationReviewHandoffFailure(db, {
        companyId: input.companyId,
        parentIssueId: input.parentIssueId,
        runId: input.sourceRunId,
        errorCode: "review_handoff_missing_authenticated_repository_binding",
        error: "Exact-head review requires the source issue workspace and exact base/head",
        exactBaseSha: input.exactBaseSha,
        exactHeadSha: input.exactHeadSha,
      });
      return { ok: false, error: "missing_authenticated_repository_binding" };
    }
    const reviewBinding = await repositoryMutationReceiptService(db)
      .getAuthenticatedImplementationReviewBinding({
        heartbeatRunId: authenticSourceRun.id,
        companyId: input.companyId,
        issueId: parent.id,
        projectWorkspaceId: parent.projectWorkspaceId,
        exactBaseSha: input.exactBaseSha.trim().toLowerCase(),
        exactHeadSha: input.exactHeadSha.trim().toLowerCase(),
      });
    if (!reviewBinding) {
      await persistImplementationReviewHandoffFailure(db, {
        companyId: input.companyId,
        parentIssueId: input.parentIssueId,
        runId: input.sourceRunId,
        errorCode: "review_handoff_pr_binding_not_authenticated",
        error: "No terminal broker receipt binds this run, workspace, repository, PR, base, and head",
        exactBaseSha: input.exactBaseSha,
        exactHeadSha: input.exactHeadSha,
      });
      return { ok: false, error: "review_pr_binding_not_authenticated" };
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

    const reviewerCandidates = pickCompanyReviewerCandidates(companyAgents, input.implementerAgentId);
    const reviewerPick: ReviewerPick = reviewerCandidates.length === 0
      ? { source: "none" }
      : reviewerCandidates[0]!;
    const reviewerAgentId = reviewerPick.source === "none" ? null : reviewerPick.id;

    const children = await db
      .select({
        id: issues.id,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        description: issues.description,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.parentId, parent.id),
        ),
      );

    const plan = planImplementationReviewHandoff({
      parent,
      exactBaseSha: input.exactBaseSha,
      exactHeadSha: input.exactHeadSha,
      implementerAgentId: input.implementerAgentId,
      reviewerAgentId,
      existingChildren: children,
      draftPr: {
        disposition: "created",
        prNumber: reviewBinding.pullRequestNumber,
        prUrl: reviewBinding.pullRequestUrl,
      },
    });

    if (plan.action === "skip") {
      if (plan.reason !== "duplicate_open_review" && plan.reason !== "probe_work_mode") {
        await persistImplementationReviewHandoffFailure(db, {
          companyId: input.companyId,
          parentIssueId: input.parentIssueId,
          runId: input.sourceRunId,
          errorCode: `review_handoff_${plan.reason}`,
          error: `Implementation review handoff could not be created: ${plan.reason}`,
          exactBaseSha: input.exactBaseSha,
          exactHeadSha: input.exactHeadSha,
        });
      }
      return {
        ok: true,
        action: "skipped",
        reason: plan.reason,
        reviewerPickSource: reviewerPick.source,
      };
    }

    const created = await issueService(db).create(input.companyId, {
      title: plan.title,
      description: plan.description,
      status: "todo",
      priority: "high",
      workMode: "standard",
      projectId: plan.projectId,
      projectWorkspaceId: reviewBinding.projectWorkspaceId,
      parentId: plan.parentId,
      assigneeAgentId: plan.assigneeAgentId,
      // Declared workspace head MUST be exact head for reviews (GLO-1940 / GLO-1941 / C2).
      // Never fall back to project pin / origin/gloops/stable here.
      executionWorkspaceSettings: buildReviewExecutionWorkspaceSettings(plan.exactHeadSha),
      serverReviewProvenance: {
        kind: "implementation_exact_head_v2",
        parentIssueId: plan.parentId,
        sourceRunId: authenticSourceRun.id,
        implementerAgentId: input.implementerAgentId,
        reviewerAgentId: plan.assigneeAgentId,
        alternateReviewerAgentIds: reviewerCandidates.slice(1, 5).map((candidate) => candidate.id),
        projectWorkspaceId: reviewBinding.projectWorkspaceId,
        repositoryId: reviewBinding.repositoryId,
        repositoryFullName: reviewBinding.repositoryFullName,
        baseRef: reviewBinding.baseRef,
        exactBaseSha: reviewBinding.exactBaseSha,
        exactHeadSha: reviewBinding.exactHeadSha,
        pullRequestNumber: reviewBinding.pullRequestNumber,
        pullRequestUrl: reviewBinding.pullRequestUrl,
      },
    });

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
          exactBaseSha: plan.exactBaseSha,
          exactHeadSha: plan.exactHeadSha,
          draftPrUrl: plan.draftPrUrl,
          reviewerPickSource: reviewerPick.source,
        },
      });
    }

    const logPayload: Record<string, unknown> = {
      parentIssueId: parent.id,
      reviewIssueId,
      reviewerAgentId: plan.assigneeAgentId,
      exactBaseSha: plan.exactBaseSha,
      exactHeadSha: plan.exactHeadSha,
      reviewerPickSource: reviewerPick.source,
    };
    logger.info(logPayload, "implementation review handoff created");

    return {
      ok: true,
      action: "created",
      reviewIssueId,
      reviewIdentifier,
      reviewerPickSource: reviewerPick.source as Exclude<ReviewerPickSource, "none">,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistImplementationReviewHandoffFailure(db, {
      companyId: input.companyId,
      parentIssueId: input.parentIssueId,
      runId: input.sourceRunId,
      errorCode: "review_handoff_failed",
      error: message,
      exactBaseSha: input.exactBaseSha,
      exactHeadSha: input.exactHeadSha,
    }).catch((persistError) => {
      logger.error(
        { err: persistError, parentIssueId: input.parentIssueId, runId: input.sourceRunId },
        "failed to persist implementation review handoff failure",
      );
    });
    logger.warn({ err: error, parentIssueId: input.parentIssueId }, "implementation review handoff failed");
    return { ok: false, error: message };
  }
}
