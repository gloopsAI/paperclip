import { createHash } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { issueService } from "./issues.js";

export const OPERATIONS_IMPROVEMENT_ORIGIN_KIND = "operations_improvement_proposal" as const;
export const OPERATIONS_IMPROVEMENT_WAKE_REASON = "issue_assigned" as const;

export type OperationsAnomalyReason =
  | "work_preparation_denied"
  | "provider_run_failed"
  | "terminal_usage_missing"
  | "execution_budget_exhausted";

export type OperationsImprovementCandidate = {
  reason: OperationsAnomalyReason;
  severity: "medium" | "high";
  summary: string;
};

type TerminalRunEvidence = {
  id: string;
  companyId: string;
  status: string;
  errorCode?: string | null;
  error?: string | null;
  usageJson?: unknown;
  resultJson?: unknown;
};

type SourceIssue = {
  id: string;
  identifier?: string | null;
  title: string;
  projectId?: string | null;
  goalId?: string | null;
  billingCode?: string | null;
  originKind?: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function providerInvocationAttempted(run: TerminalRunEvidence) {
  const result = record(run.resultJson);
  if (result.providerInvocationAttempted === true) return true;
  return record(result.provider_invocation).attempted === true;
}

export function classifyOperationsAnomaly(
  run: TerminalRunEvidence,
): OperationsImprovementCandidate | null {
  if (run.errorCode === "work_preparation.denied") {
    return {
      reason: "work_preparation_denied",
      severity: "high",
      summary: "Pre-dispatch preparation denied provider execution; inspect the typed preparation receipt.",
    };
  }
  if (/reservation_exceeded|max_(?:input_tokens|turns|tool_calls)|budget/i.test(run.errorCode ?? "")) {
    return {
      reason: "execution_budget_exhausted",
      severity: "high",
      summary: "Execution exhausted a bounded reservation before reaching a truthful terminal outcome.",
    };
  }
  if (run.status === "failed" && providerInvocationAttempted(run)) {
    return {
      reason: "provider_run_failed",
      severity: "high",
      summary: "A provider invocation was attempted and the run terminated as failed.",
    };
  }
  if (run.status === "succeeded" && providerInvocationAttempted(run) && Object.keys(record(run.usageJson)).length === 0) {
    return {
      reason: "terminal_usage_missing",
      severity: "medium",
      summary: "A successful provider-backed run has no terminal usage receipt.",
    };
  }
  return null;
}

export function operationsImprovementFingerprint(input: {
  companyId: string;
  sourceIssueId: string;
  reason: OperationsAnomalyReason;
}) {
  const digest = createHash("sha256")
    .update(`${input.companyId}:${input.sourceIssueId}:${input.reason}`)
    .digest("hex");
  return `operations-improvement:v1:${digest}`;
}

export function buildOperationsImprovementProposal(input: {
  sourceIssue: SourceIssue;
  run: TerminalRunEvidence;
  candidate: OperationsImprovementCandidate;
}) {
  const sourceLabel = input.sourceIssue.identifier ?? input.sourceIssue.id;
  return {
    title: `[Ops Proposal] ${input.candidate.reason} on ${sourceLabel}`,
    workMode: "ask" as const,
    description: [
      "Advisory-only operations improvement proposal generated from terminal execution evidence.",
      "",
      `Source issue: ${sourceLabel} — ${input.sourceIssue.title}`,
      `Source run: ${input.run.id}`,
      `Severity: ${input.candidate.severity}`,
      `Anomaly: ${input.candidate.reason}`,
      `Observed error code: ${input.run.errorCode ?? "none"}`,
      `Observed error: ${input.run.error ?? "none"}`,
      "",
      "## Evidence summary",
      input.candidate.summary,
      "",
      "## Required steward output",
      "- Verify the evidence and frequency before recommending work.",
      "- State user impact and the smallest useful correction.",
      "- Provide bounded acceptance criteria and a priority recommendation.",
      "- Do not modify code, dispatch implementation, or change platform authority.",
    ].join("\n"),
  };
}

export async function projectOperationsImprovementProposal(input: {
  db: Db;
  run: TerminalRunEvidence;
  sourceIssue: SourceIssue | null;
  assigneeAgentId?: string | null;
}) {
  if (!input.sourceIssue || input.sourceIssue.originKind === OPERATIONS_IMPROVEMENT_ORIGIN_KIND) {
    return { kind: "not_applicable" as const, issueId: null };
  }
  const candidate = classifyOperationsAnomaly(input.run);
  if (!candidate) return { kind: "clean" as const, issueId: null };

  const fingerprint = operationsImprovementFingerprint({
    companyId: input.run.companyId,
    sourceIssueId: input.sourceIssue.id,
    reason: candidate.reason,
  });
  const existing = await input.db
    .select({ id: issues.id })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.run.companyId),
      eq(issues.originKind, OPERATIONS_IMPROVEMENT_ORIGIN_KIND),
      eq(issues.originFingerprint, fingerprint),
      notInArray(issues.status, ["done", "cancelled"]),
    ))
    .then((rows) => rows[0] ?? null);
  if (existing) return { kind: "existing" as const, issueId: existing.id };

  const proposal = buildOperationsImprovementProposal({
    sourceIssue: input.sourceIssue,
    run: input.run,
    candidate,
  });
  const created = await issueService(input.db).create(input.run.companyId, {
    ...proposal,
    status: input.assigneeAgentId ? "todo" : "backlog",
    priority: candidate.severity === "high" ? "high" : "medium",
    // Keep advisory proposals out of the source issue's executable child tree.
    // The origin fields preserve attribution without changing completion truth.
    parentId: null,
    projectId: input.sourceIssue.projectId,
    goalId: input.sourceIssue.goalId,
    billingCode: input.sourceIssue.billingCode,
    assigneeAgentId: input.assigneeAgentId ?? null,
    originKind: OPERATIONS_IMPROVEMENT_ORIGIN_KIND,
    originId: input.run.id,
    originFingerprint: fingerprint,
  });
  return { kind: "created" as const, issueId: created.id };
}

export function buildOperationsImprovementStewardWake(input: {
  proposalResult: Awaited<ReturnType<typeof projectOperationsImprovementProposal>> | null;
  stewardAgentId: string | null;
}) {
  if (input.proposalResult?.kind !== "created" || !input.stewardAgentId) return null;
  const issueId = input.proposalResult.issueId;
  return {
    agentId: input.stewardAgentId,
    options: {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: OPERATIONS_IMPROVEMENT_WAKE_REASON,
      payload: {
        issueId,
        source: OPERATIONS_IMPROVEMENT_ORIGIN_KIND,
      },
      requestedByActorType: "system" as const,
      requestedByActorId: OPERATIONS_IMPROVEMENT_ORIGIN_KIND,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: OPERATIONS_IMPROVEMENT_WAKE_REASON,
        source: OPERATIONS_IMPROVEMENT_ORIGIN_KIND,
      },
      idempotencyKey: `operations-improvement-proposal:${issueId}`,
    },
  };
}
