/**
 * Terminal / work-state reconciliation (OK-03).
 *
 * Safety net for the highest-value terminal mismatch class:
 *   runtime `succeeded` while the linked issue remains open / in_progress.
 *
 * Complements the stricter execution-truth path in
 * `terminal-issue-reconciliation.ts`. This module only auto-closes when
 * completion evidence is present; empty infrastructure successes become
 * attention candidates instead of silent closes.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { PAPERCLIP_EXECUTION_RECEIPT_KEY } from "@paperclipai/adapter-utils/execution-envelope";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { resolveIssueExecutionCompletionProfile } from "./issue-execution-policy.js";
import {
  buildTerminalIssueLifecyclePatch,
  terminalIssueLifecycleNeedsUpdate,
} from "./terminal-issue-reconciliation.js";
import { parseFinalGovernedLifecycleReceipt } from "./recovery/successful-run-handoff.js";

/** Issue statuses eligible for auto-close on evidenced run success. */
const OPEN_AUTO_CLOSE_STATUSES = new Set(["todo", "in_progress"]);

/** in_review only closes when review-accept evidence is present. */
const REVIEW_STATUS = "in_review";

/** Conservative DONE markers in free-text result bodies. */
const DONE_PATTERN = /(?:^|\n)\s*(?:DONE\b|\[DONE\]|##\s*DONE\b)/i;

export type CompletionEvidenceKind =
  | "summary"
  | "result"
  | "terminal_marker"
  | "review_accept"
  | "done_pattern";

export type CompletionEvidence = {
  kind: CompletionEvidenceKind;
  detail: string;
};

export type AutoCloseDecision = {
  action: "close" | "attention" | "noop";
  reason: string;
};

export type TerminalReconciliationReceipt = {
  schemaVersion: "paperclip.terminal-reconciliation.v1";
  action: "close" | "attention" | "noop";
  reason: string;
  companyId: string;
  runId: string;
  issueId: string | null;
  runStatus: string | null;
  issueStatusBefore: string | null;
  issueStatusAfter: string | null;
  evidence: CompletionEvidence | null;
  applied: boolean;
  at: string;
};

export type ShouldAutoCloseInput = {
  runStatus: string;
  /** False when the run has no bound issue id. */
  hasBoundIssue: boolean;
  /** Null when the issue row is missing. */
  issueStatus: string | null;
  /**
   * True when the issue's executionRunId or checkoutRunId points at this run.
   * Fail closed when the issue is bound to a different run.
   */
  runIsCurrentForIssue: boolean;
  evidence: CompletionEvidence | null;
  /**
   * When `verified_change`, only review-accept evidence may auto-close.
   * Other evidence becomes attention so we do not skip review gates.
   */
  completionProfile?: string | null;
};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function excerpt(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

/**
 * Detect completion evidence from a succeeded run's result / context.
 * Empty infrastructure successes intentionally return null.
 */
export function detectCompletionEvidence(input: {
  resultJson: Record<string, unknown> | null | undefined;
  contextSnapshot?: Record<string, unknown> | null | undefined;
}): CompletionEvidence | null {
  const resultJson = readRecord(input.resultJson);
  const contextSnapshot = readRecord(input.contextSnapshot);

  // 1. Governed lifecycle markers (review accept / operations complete).
  const lifecycle = parseFinalGovernedLifecycleReceipt({
    resultJson: Object.keys(resultJson).length > 0 ? resultJson : null,
  });
  if (lifecycle?.action === "accepted") {
    return {
      kind: "review_accept",
      detail: nonEmptyString((lifecycle as { summary?: string }).summary) ?? "lifecycle:accepted",
    };
  }
  if (lifecycle?.action === "operations_complete") {
    return {
      kind: "terminal_marker",
      detail: nonEmptyString((lifecycle as { summary?: string }).summary) ?? "lifecycle:operations_complete",
    };
  }

  // 2. Execution-truth receipt with accepted review.
  const receipt = readRecord(contextSnapshot[PAPERCLIP_EXECUTION_RECEIPT_KEY]);
  const verification = readRecord(receipt.verification);
  const review = readRecord(verification.review);
  if (nonEmptyString(review.status)?.toLowerCase() === "accepted") {
    return {
      kind: "review_accept",
      detail: nonEmptyString(review.headSha) ?? "execution_receipt:review_accepted",
    };
  }

  // 3. Explicit disposition / status fields on the result payload.
  const disposition = nonEmptyString(resultJson.disposition)?.toLowerCase();
  if (disposition === "done" || disposition === "completed" || disposition === "accepted") {
    return { kind: "terminal_marker", detail: `disposition:${disposition}` };
  }
  const resultStatus = nonEmptyString(resultJson.status)?.toLowerCase();
  if (resultStatus === "done" || resultStatus === "completed") {
    return { kind: "terminal_marker", detail: `status:${resultStatus}` };
  }

  // 4. Free-text summary / result / message with DONE pattern or non-empty body.
  const summary = nonEmptyString(resultJson.summary);
  const result = nonEmptyString(resultJson.result);
  const message = nonEmptyString(resultJson.message);
  const output = nonEmptyString(resultJson.output);

  for (const text of [summary, result, message]) {
    if (!text) continue;
    if (DONE_PATTERN.test(text)) {
      return { kind: "done_pattern", detail: excerpt(text) };
    }
  }
  if (output && DONE_PATTERN.test(output)) {
    return { kind: "done_pattern", detail: excerpt(output) };
  }

  if (summary) return { kind: "summary", detail: excerpt(summary) };
  if (result) return { kind: "result", detail: excerpt(result) };

  return null;
}

/**
 * Pure decision: whether a succeeded run should auto-close its bound issue.
 *
 * Fail closed on missing issue, non-succeeded run, non-open statuses, and
 * empty infrastructure successes (attention, not close).
 */
export function shouldAutoCloseIssueOnRunSuccess(input: ShouldAutoCloseInput): AutoCloseDecision {
  if (input.runStatus !== "succeeded") {
    return { action: "noop", reason: "run_not_succeeded" };
  }
  if (!input.hasBoundIssue) {
    return { action: "noop", reason: "missing_bound_issue" };
  }
  if (input.issueStatus === null) {
    return { action: "noop", reason: "issue_not_found" };
  }
  if (!input.runIsCurrentForIssue) {
    return { action: "noop", reason: "run_not_current" };
  }
  if (input.issueStatus === "done") {
    return { action: "noop", reason: "already_done" };
  }
  if (input.issueStatus === "cancelled") {
    return { action: "noop", reason: "terminal_cancelled" };
  }
  if (input.issueStatus === "blocked") {
    return { action: "noop", reason: "terminal_blocked" };
  }

  const isOpen = OPEN_AUTO_CLOSE_STATUSES.has(input.issueStatus);
  const isInReview = input.issueStatus === REVIEW_STATUS;
  if (!isOpen && !isInReview) {
    // backlog and any unknown status: do not auto-close
    return { action: "noop", reason: "status_not_auto_closeable" };
  }

  const evidence = input.evidence;
  if (!evidence) {
    if (isOpen) {
      return { action: "attention", reason: "succeeded_without_completion_evidence" };
    }
    return { action: "noop", reason: "in_review_without_accept" };
  }

  // verified_change requires review-accept; other evidence is attention only.
  if (
    input.completionProfile === "verified_change" &&
    evidence.kind !== "review_accept"
  ) {
    return {
      action: "attention",
      reason: "verified_change_requires_review_accept",
    };
  }

  if (isInReview) {
    if (evidence.kind === "review_accept") {
      return { action: "close", reason: "review_accept_while_in_review" };
    }
    // Already in review with non-accept evidence — leave for human/review flow.
    return { action: "noop", reason: "in_review_awaiting_accept" };
  }

  // todo / in_progress + any completion evidence → close
  return {
    action: "close",
    reason: `evidenced_success:${evidence.kind}`,
  };
}

export function buildReconciliationReceipt(input: {
  action: AutoCloseDecision["action"];
  reason: string;
  companyId: string;
  runId: string;
  issueId: string | null;
  runStatus: string | null;
  issueStatusBefore: string | null;
  issueStatusAfter: string | null;
  evidence: CompletionEvidence | null;
  applied: boolean;
  at?: Date;
}): TerminalReconciliationReceipt {
  return {
    schemaVersion: "paperclip.terminal-reconciliation.v1",
    action: input.action,
    reason: input.reason,
    companyId: input.companyId,
    runId: input.runId,
    issueId: input.issueId,
    runStatus: input.runStatus,
    issueStatusBefore: input.issueStatusBefore,
    issueStatusAfter: input.issueStatusAfter,
    evidence: input.evidence,
    applied: input.applied,
    at: (input.at ?? new Date()).toISOString(),
  };
}

function readIssueIdFromContext(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string | null {
  const context = readRecord(contextSnapshot);
  return nonEmptyString(context.issueId) ?? nonEmptyString(context.taskId);
}

function runIsCurrentForIssue(
  issue: { executionRunId: string | null; checkoutRunId: string | null },
  runId: string,
): boolean {
  return issue.executionRunId === runId || issue.checkoutRunId === runId;
}

function receiptOf(input: {
  action: AutoCloseDecision["action"];
  reason: string;
  companyId: string;
  runId: string;
  issueId: string | null;
  runStatus: string | null;
  issueStatusBefore: string | null;
  issueStatusAfter: string | null;
  evidence: CompletionEvidence | null;
  applied: boolean;
  at?: Date;
}): TerminalReconciliationReceipt {
  return buildReconciliationReceipt(input);
}

/**
 * Service entrypoint: load run + issue, apply pure decision, optionally close.
 * Always returns a receipt for logging / attention.
 */
export function terminalReconciliationService(db: Db) {
  return {
    async reconcileSucceededRun(input: {
      companyId: string;
      runId: string;
    }): Promise<TerminalReconciliationReceipt> {
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, input.runId),
            eq(heartbeatRuns.companyId, input.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!run) {
        return receiptOf({
          action: "noop",
          reason: "run_not_found",
          companyId: input.companyId,
          runId: input.runId,
          issueId: null,
          runStatus: null,
          issueStatusBefore: null,
          issueStatusAfter: null,
          evidence: null,
          applied: false,
        });
      }

      const issueId = readIssueIdFromContext(run.contextSnapshot);
      const evidence = detectCompletionEvidence({
        resultJson: run.resultJson,
        contextSnapshot: run.contextSnapshot,
      });

      if (!issueId) {
        const decision = shouldAutoCloseIssueOnRunSuccess({
          runStatus: run.status,
          hasBoundIssue: false,
          issueStatus: null,
          runIsCurrentForIssue: false,
          evidence,
        });
        return receiptOf({
          action: decision.action,
          reason: decision.reason,
          companyId: input.companyId,
          runId: run.id,
          issueId: null,
          runStatus: run.status,
          issueStatusBefore: null,
          issueStatusAfter: null,
          evidence,
          applied: false,
        });
      }

      const issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          completedAt: issues.completedAt,
          executionRunId: issues.executionRunId,
          checkoutRunId: issues.checkoutRunId,
          executionPolicy: issues.executionPolicy,
          workMode: issues.workMode,
          projectWorkspaceId: issues.projectWorkspaceId,
          executionWorkspaceId: issues.executionWorkspaceId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);

      if (!issue) {
        const decision = shouldAutoCloseIssueOnRunSuccess({
          runStatus: run.status,
          hasBoundIssue: true,
          issueStatus: null,
          runIsCurrentForIssue: false,
          evidence,
        });
        return receiptOf({
          action: decision.action,
          reason: decision.reason,
          companyId: input.companyId,
          runId: run.id,
          issueId,
          runStatus: run.status,
          issueStatusBefore: null,
          issueStatusAfter: null,
          evidence,
          applied: false,
        });
      }

      const completionProfile = resolveIssueExecutionCompletionProfile({
        executionPolicy: issue.executionPolicy,
        workMode: issue.workMode,
        repositoryBacked: Boolean(issue.projectWorkspaceId || issue.executionWorkspaceId),
      });

      const decision = shouldAutoCloseIssueOnRunSuccess({
        runStatus: run.status,
        hasBoundIssue: true,
        issueStatus: issue.status,
        runIsCurrentForIssue: runIsCurrentForIssue(issue, run.id),
        evidence,
        completionProfile,
      });

      if (decision.action === "attention") {
        const receipt = receiptOf({
          action: "attention",
          reason: decision.reason,
          companyId: input.companyId,
          runId: run.id,
          issueId: issue.id,
          runStatus: run.status,
          issueStatusBefore: issue.status,
          issueStatusAfter: issue.status,
          evidence,
          applied: false,
        });
        logger.info(
          { ...receipt },
          "terminal reconciliation attention candidate (succeeded run, open issue, no safe close)",
        );
        return receipt;
      }

      if (decision.action !== "close") {
        return receiptOf({
          action: decision.action,
          reason: decision.reason,
          companyId: input.companyId,
          runId: run.id,
          issueId: issue.id,
          runStatus: run.status,
          issueStatusBefore: issue.status,
          issueStatusAfter: issue.status,
          evidence,
          applied: false,
        });
      }

      if (
        !terminalIssueLifecycleNeedsUpdate({
          currentStatus: issue.status,
          currentCompletedAt: issue.completedAt,
          targetStatus: "done",
        })
      ) {
        return receiptOf({
          action: "noop",
          reason: "already_done",
          companyId: input.companyId,
          runId: run.id,
          issueId: issue.id,
          runStatus: run.status,
          issueStatusBefore: issue.status,
          issueStatusAfter: issue.status,
          evidence,
          applied: false,
        });
      }

      const now = new Date();
      const updated = await db
        .update(issues)
        .set(
          buildTerminalIssueLifecyclePatch({
            currentCompletedAt: issue.completedAt,
            targetStatus: "done",
            now,
          }),
        )
        .where(
          and(
            eq(issues.id, issue.id),
            eq(issues.companyId, input.companyId),
            inArray(issues.status, ["todo", "in_progress", "in_review"]),
            or(
              eq(issues.executionRunId, run.id),
              eq(issues.checkoutRunId, run.id),
            ),
          ),
        )
        .returning({ id: issues.id });

      if (updated.length !== 1) {
        return receiptOf({
          action: "noop",
          reason: "issue_status_or_ownership_raced",
          companyId: input.companyId,
          runId: run.id,
          issueId: issue.id,
          runStatus: run.status,
          issueStatusBefore: issue.status,
          issueStatusAfter: issue.status,
          evidence,
          applied: false,
          at: now,
        });
      }

      const receipt = receiptOf({
        action: "close",
        reason: decision.reason,
        companyId: input.companyId,
        runId: run.id,
        issueId: issue.id,
        runStatus: run.status,
        issueStatusBefore: issue.status,
        issueStatusAfter: "done",
        evidence,
        applied: true,
        at: now,
      });

      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "terminal_reconciliation",
        agentId: run.agentId,
        runId: run.id,
        action: "issue.terminal_reconciled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          reason: decision.reason,
          fromStatus: issue.status,
          toStatus: "done",
          evidence,
          source: "terminal_reconciliation.ok03",
        },
      }).catch((err) => {
        logger.warn(
          { err, issueId: issue.id, runId: run.id },
          "failed to log terminal reconciliation activity",
        );
      });

      logger.info(
        {
          issueId: issue.id,
          runId: run.id,
          fromStatus: issue.status,
          reason: decision.reason,
        },
        "terminal reconciliation auto-closed issue on evidenced run success",
      );

      return receipt;
    },
  };
}

