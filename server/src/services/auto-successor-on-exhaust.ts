/**
 * Product-native auto-successor when EXEC-class issues hit admission exhaust.
 *
 * Replaces host interim:
 *   paperclip-auto-successor-exhaust.timer
 *   auto-successor-on-exhaust-poller.py
 *
 * Policy (B4p / D-B4p-PRODUCT):
 * - EXEC titles only
 * - Terminal exhaust admission reasons only
 * - Exactly one successor per exhausted parent
 * - Skip SUCCESSOR / review titles (no infinite chain)
 * - Never multi-wake a done/cancelled parent
 * - Default assignee Wren when parent is unassigned
 */

import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { logger } from "../middleware/logger.js";
import type { ExecutionAdmissionEnvelope } from "./execution-admission.js";

export const AUTO_SUCCESSOR_ORIGIN_KIND = "auto_successor_on_exhaust" as const;
export const AUTO_SUCCESSOR_TITLE_MARKER = "SUCCESSOR after exhaust";
export const AUTO_SUCCESSOR_REVIEW_TITLE_MARKER = "Review exact head";
export const DEFAULT_WREN_AGENT_NAME = "Wren";

/** Admission reasons that mean the task budget is spent — no automatic recovery. */
export const EXHAUST_SUCCESSOR_REASONS = [
  "retry_limit_exhausted",
  "run_limit_exhausted",
  "input_token_limit_exhausted",
  "output_token_limit_exhausted",
  "wall_time_limit_exhausted",
] as const;

export type ExhaustSuccessorReason = (typeof EXHAUST_SUCCESSOR_REASONS)[number];

export type AutoSuccessorEligibility =
  | { eligible: true; reason: ExhaustSuccessorReason }
  | {
      eligible: false;
      skip:
        | "not_exhaust_reason"
        | "missing_issue"
        | "non_exec_title"
        | "successor_title"
        | "review_title"
        | "terminal_parent"
        | "already_handled";
    };

export type AutoSuccessorResult =
  | { kind: "created"; issueId: string; identifier: string | null; assigneeAgentId: string | null }
  | { kind: "existing"; issueId: string; identifier: string | null }
  | { kind: "skipped"; skip: AutoSuccessorEligibility extends { eligible: false } ? AutoSuccessorEligibility["skip"] : never }
  | { kind: "skipped"; skip: "no_assignee" | "create_failed" };

export function isExhaustSuccessorReason(reason: string | null | undefined): reason is ExhaustSuccessorReason {
  return typeof reason === "string" && (EXHAUST_SUCCESSOR_REASONS as readonly string[]).includes(reason);
}

/**
 * Extract exhaust reason from admission denial errorCode / envelope.
 * errorCode form: `execution_admission.retry_limit_exhausted`
 */
export function admissionExhaustReasonFromDenial(input: {
  errorCode?: string | null;
  envelope?: Pick<ExecutionAdmissionEnvelope, "reason"> | null;
  reasonText?: string | null;
}): ExhaustSuccessorReason | null {
  if (input.envelope?.reason && isExhaustSuccessorReason(input.envelope.reason)) {
    return input.envelope.reason;
  }
  const code = input.errorCode?.trim() ?? "";
  const prefix = "execution_admission.";
  if (code.startsWith(prefix)) {
    const reason = code.slice(prefix.length);
    if (isExhaustSuccessorReason(reason)) return reason;
  }
  const text = input.reasonText ?? "";
  for (const reason of EXHAUST_SUCCESSOR_REASONS) {
    if (text.includes(reason)) return reason;
  }
  return null;
}

export function isExecClassTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && title.startsWith("EXEC:");
}

export function titleContainsSuccessorMarker(title: string | null | undefined): boolean {
  return typeof title === "string" && title.includes(AUTO_SUCCESSOR_TITLE_MARKER);
}

export function titleContainsReviewMarker(title: string | null | undefined): boolean {
  return typeof title === "string" && title.includes(AUTO_SUCCESSOR_REVIEW_TITLE_MARKER);
}

export function isTerminalSucceededParentStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * Pure title/status filters preserved from host poller v2.
 * Does not check idempotency (needs DB).
 */
export function evaluateAutoSuccessorTitleFilters(input: {
  title: string | null | undefined;
  status: string | null | undefined;
}): Extract<AutoSuccessorEligibility, { eligible: false }> | null {
  if (isTerminalSucceededParentStatus(input.status)) {
    return { eligible: false, skip: "terminal_parent" };
  }
  if (!isExecClassTitle(input.title)) {
    return { eligible: false, skip: "non_exec_title" };
  }
  if (titleContainsSuccessorMarker(input.title)) {
    return { eligible: false, skip: "successor_title" };
  }
  if (titleContainsReviewMarker(input.title)) {
    return { eligible: false, skip: "review_title" };
  }
  return null;
}

export function buildAutoSuccessorTitle(
  parentIdentifier: string | null | undefined,
  parentId: string,
): string {
  const ident = (parentIdentifier?.trim() || parentId.slice(0, 8));
  return `EXEC: ${AUTO_SUCCESSOR_TITLE_MARKER} of ${ident}`;
}

export function autoSuccessorFingerprint(input: {
  companyId: string;
  parentIssueId: string;
}): string {
  // Exactly one successor per exhausted parent (cap = 1).
  return [AUTO_SUCCESSOR_ORIGIN_KIND, input.companyId, input.parentIssueId].join(":");
}

export function selectAutoSuccessorAssignee(input: {
  parentAssigneeAgentId: string | null | undefined;
  wrenAgentId: string | null | undefined;
}): string | null {
  const parent = input.parentAssigneeAgentId?.trim();
  if (parent) return parent;
  const wren = input.wrenAgentId?.trim();
  return wren || null;
}

export function buildAutoSuccessorDescription(input: {
  parentIdentifier: string | null | undefined;
  parentId: string;
  parentTitle: string;
  exhaustReason: string;
  runId: string | null;
  errorCode: string | null;
  generatedAt: string;
}): string {
  const ident = input.parentIdentifier?.trim() || input.parentId;
  return [
    "# Auto-successor (product-native)",
    "",
    `Parent exhausted: **${ident}** (\`${input.parentId}\`).`,
    `Parent title: ${input.parentTitle}`,
    `Exhaust reason: \`${input.exhaustReason}\``,
    input.errorCode ? `Error code: \`${input.errorCode}\`` : null,
    input.runId ? `Denied run: \`${input.runId}\`` : null,
    "",
    "Do **not** rewake the parent after admission exhaust.",
    "",
    "## Scope",
    "Continue the parent's unfinished acceptance criteria.",
    "",
    "## Acceptance",
    "Same as parent AC; post receipt on this issue.",
    "",
    `GeneratedAt: ${input.generatedAt}`,
    `Origin: ${AUTO_SUCCESSOR_ORIGIN_KIND}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildAutoSuccessorParentComment(input: {
  successorIdentifier: string | null | undefined;
  successorId: string;
  exhaustReason: string;
}): string {
  const label = input.successorIdentifier?.trim() || input.successorId;
  return [
    "## Successor spawned (product-native)",
    "",
    `- **Successor:** ${label} (\`${input.successorId}\`)`,
    `- **Exhaust reason:** \`${input.exhaustReason}\``,
    "- **Rule:** do not rewake this issue after `retry_limit_exhausted` / admission exhaust.",
    `- Origin: \`${AUTO_SUCCESSOR_ORIGIN_KIND}\``,
  ].join("\n");
}

type SourceIssueRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: "critical" | "high" | "medium" | "low" | null;
  parentId: string | null;
  projectId: string | null;
  goalId: string | null;
  billingCode: string | null;
  assigneeAgentId: string | null;
  originKind: string | null;
};

function asIssuePriority(
  value: string | null | undefined,
): "critical" | "high" | "medium" | "low" {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "high";
}

function parseIssueIdFromRunContext(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) {
    return null;
  }
  const ctx = contextSnapshot as Record<string, unknown>;
  for (const key of ["issueId", "taskId"] as const) {
    const value = ctx[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export async function resolveDefaultWrenAgentId(
  db: Db,
  companyId: string,
  preferredName = DEFAULT_WREN_AGENT_NAME,
): Promise<string | null> {
  const envOverride =
    process.env.PAPERCLIP_WREN_AGENT_ID?.trim() ||
    process.env.PAPERCLIP_DEFAULT_EXEC_ASSIGNEE_AGENT_ID?.trim() ||
    "";
  if (envOverride) return envOverride;

  const byName = await db
    .select({ id: agents.id, name: agents.name, status: agents.status })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      sql`lower(${agents.name}) = ${preferredName.toLowerCase()}`,
      notInArray(agents.status, ["terminated"]),
    ))
    .then((rows) => rows[0] ?? null);
  return byName?.id ?? null;
}

async function findExistingAutoSuccessor(
  db: Db,
  companyId: string,
  parentIssueId: string,
  parentIdentifier: string | null,
): Promise<{ id: string; identifier: string | null } | null> {
  const fingerprint = autoSuccessorFingerprint({ companyId, parentIssueId });
  const byOrigin = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, AUTO_SUCCESSOR_ORIGIN_KIND),
      eq(issues.originId, parentIssueId),
      isNull(issues.hiddenAt),
    ))
    .then((rows) => rows[0] ?? null);
  if (byOrigin) return byOrigin;

  // Also treat fingerprint match and host-interim title as already handled.
  const expectedTitle = buildAutoSuccessorTitle(parentIdentifier, parentIssueId);
  const byTitleOrFingerprint = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      isNull(issues.hiddenAt),
      or(
        eq(issues.originFingerprint, fingerprint),
        eq(issues.title, expectedTitle),
      ),
    ))
    .then((rows) => rows[0] ?? null);
  return byTitleOrFingerprint;
}

/**
 * Ensure exactly one EXEC successor exists for an admission-exhausted parent.
 * Safe to call multiple times (idempotent).
 */
export async function ensureAutoSuccessorOnExhaust(input: {
  db: Db;
  run: {
    id: string;
    companyId: string;
    contextSnapshot: unknown;
    errorCode?: string | null;
    error?: string | null;
  };
  errorCode?: string | null;
  envelope?: ExecutionAdmissionEnvelope | null;
  reasonText?: string | null;
}): Promise<AutoSuccessorResult> {
  const exhaustReason = admissionExhaustReasonFromDenial({
    errorCode: input.errorCode ?? input.run.errorCode,
    envelope: input.envelope,
    reasonText: input.reasonText ?? input.run.error ?? null,
  });
  if (!exhaustReason) {
    return { kind: "skipped", skip: "not_exhaust_reason" };
  }

  const issueId = parseIssueIdFromRunContext(input.run.contextSnapshot);
  if (!issueId) {
    return { kind: "skipped", skip: "missing_issue" };
  }

  const sourceIssue = await input.db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      parentId: issues.parentId,
      projectId: issues.projectId,
      goalId: issues.goalId,
      billingCode: issues.billingCode,
      assigneeAgentId: issues.assigneeAgentId,
      originKind: issues.originKind,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.run.companyId),
      or(eq(issues.id, issueId), eq(issues.identifier, issueId.toUpperCase())),
      visibleIssueCondition(),
    ))
    .then((rows) => (rows[0] ?? null) as SourceIssueRow | null);

  if (!sourceIssue) {
    return { kind: "skipped", skip: "missing_issue" };
  }

  const titleFilter = evaluateAutoSuccessorTitleFilters({
    title: sourceIssue.title,
    status: sourceIssue.status,
  });
  if (titleFilter) {
    return { kind: "skipped", skip: titleFilter.skip };
  }

  // Never chain from an auto-successor origin itself even if title was rewritten.
  if (sourceIssue.originKind === AUTO_SUCCESSOR_ORIGIN_KIND) {
    return { kind: "skipped", skip: "successor_title" };
  }

  const existing = await findExistingAutoSuccessor(
    input.db,
    sourceIssue.companyId,
    sourceIssue.id,
    sourceIssue.identifier,
  );
  if (existing) {
    return { kind: "existing", issueId: existing.id, identifier: existing.identifier };
  }

  const wrenAgentId = await resolveDefaultWrenAgentId(input.db, sourceIssue.companyId);
  const assigneeAgentId = selectAutoSuccessorAssignee({
    parentAssigneeAgentId: sourceIssue.assigneeAgentId,
    wrenAgentId,
  });
  if (!assigneeAgentId) {
    logger.warn(
      { companyId: sourceIssue.companyId, parentIssueId: sourceIssue.id },
      "auto-successor-on-exhaust: no assignee (parent unassigned and Wren not found)",
    );
    return { kind: "skipped", skip: "no_assignee" };
  }

  const fingerprint = autoSuccessorFingerprint({
    companyId: sourceIssue.companyId,
    parentIssueId: sourceIssue.id,
  });
  const generatedAt = new Date().toISOString();
  const title = buildAutoSuccessorTitle(sourceIssue.identifier, sourceIssue.id);
  const description = buildAutoSuccessorDescription({
    parentIdentifier: sourceIssue.identifier,
    parentId: sourceIssue.id,
    parentTitle: sourceIssue.title,
    exhaustReason,
    runId: input.run.id,
    errorCode: input.errorCode ?? input.run.errorCode ?? null,
    generatedAt,
  });

  const issuesSvc = issueService(input.db);
  let created: Awaited<ReturnType<typeof issuesSvc.create>>;
  try {
    created = await issuesSvc.create(sourceIssue.companyId, {
      title,
      description,
      status: "todo",
      priority: asIssuePriority(sourceIssue.priority),
      // Sibling of exhausted parent (same graph parent) — matches host spawn tool.
      parentId: sourceIssue.parentId ?? null,
      projectId: sourceIssue.projectId,
      goalId: sourceIssue.goalId,
      billingCode: sourceIssue.billingCode,
      assigneeAgentId,
      originKind: AUTO_SUCCESSOR_ORIGIN_KIND,
      originId: sourceIssue.id,
      originRunId: input.run.id,
      originFingerprint: fingerprint,
      inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
    });
  } catch (error) {
    // Race: another denial path created the successor first.
    const raced = await findExistingAutoSuccessor(
      input.db,
      sourceIssue.companyId,
      sourceIssue.id,
      sourceIssue.identifier,
    );
    if (raced) {
      return { kind: "existing", issueId: raced.id, identifier: raced.identifier };
    }
    logger.error(
      { err: error, parentIssueId: sourceIssue.id, runId: input.run.id },
      "auto-successor-on-exhaust: create failed",
    );
    return { kind: "skipped", skip: "create_failed" };
  }

  try {
    await issuesSvc.addComment(
      sourceIssue.id,
      buildAutoSuccessorParentComment({
        successorIdentifier: created.identifier,
        successorId: created.id,
        exhaustReason,
      }),
      { runId: input.run.id },
      { authorType: "system" },
    );
  } catch (error) {
    // Comment is best-effort; successor already exists.
    logger.warn(
      { err: error, parentIssueId: sourceIssue.id, successorIssueId: created.id },
      "auto-successor-on-exhaust: parent comment failed",
    );
  }

  logger.info(
    {
      parentIssueId: sourceIssue.id,
      parentIdentifier: sourceIssue.identifier,
      successorIssueId: created.id,
      successorIdentifier: created.identifier,
      exhaustReason,
      assigneeAgentId,
      runId: input.run.id,
    },
    "auto-successor-on-exhaust: spawned successor",
  );

  return {
    kind: "created",
    issueId: created.id,
    identifier: created.identifier ?? null,
    assigneeAgentId,
  };
}
