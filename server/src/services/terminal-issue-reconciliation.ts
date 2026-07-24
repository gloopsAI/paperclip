import { createHash } from "node:crypto";
import type { IssueExecutionCompletionProfile } from "@paperclipai/shared";
import {
  PAPERCLIP_EXECUTION_RECEIPT_KEY,
  evaluateExecutionTruthTransition,
  readBoundExecutionContext,
} from "@paperclipai/adapter-utils/execution-envelope";
import type { GovernedTerminalLifecycleReceipt } from "./recovery/successful-run-handoff.js";

const SHA = /^[0-9a-f]{40}$/;
const GROK_API_PATH = /(^|[^a-z])(grok|xai|x\.ai)([^a-z]|$)/i;

type TerminalIssueStatus = "blocked" | "in_review" | "done";

export type TerminalIssueReconciliationDecision =
  | {
      kind: "project";
      status: TerminalIssueStatus;
      receipt: Record<string, unknown>;
      reason:
        | "agent_reported_blocker"
        | "direct_terminal_evidence"
        | "implementation_ready"
        | "review_accepted";
    }
  | {
      kind: "preserve";
      reason:
        | "unsupported_completion_profile"
        | "run_not_succeeded"
        | "missing_provider_terminal_evidence"
        | "workspace_not_finalized"
        | "budget_exhausted"
        | "invalid_context_binding"
        | "context_binding_mismatch"
        | "run_not_current"
        | "terminal_issue_cancelled"
        | "terminal_issue_blocked"
        | "missing_execution_truth"
        | "execution_truth_rejected";
    };

export type MergedPullRequestIssueDecision =
  | {
      kind: "project";
      status: "done";
      receipt: Record<string, unknown>;
      reason: "merged_exact_head";
    }
  | {
      kind: "preserve";
      reason:
        | "unsupported_completion_profile"
        | "issue_not_in_review"
        | "run_not_succeeded"
        | "run_not_current"
        | "pull_request_not_merged"
        | "missing_pull_request_head"
        | "missing_execution_truth"
        | "exact_head_mismatch"
        | "execution_truth_rejected";
    };

type IssueInput = {
  id: string;
  identifier: string | null;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  projectWorkspaceId: string | null;
  executionRunId: string | null;
  checkoutRunId: string | null;
};

type RunInput = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  contextSnapshot: Record<string, unknown> | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function buildDirectReceipt(input: {
  workId: string;
  issueId: string;
  runId: string;
  agentId: string;
  workspaceId: string | null;
  contextDigest: string;
  routePathIds: string[];
  exactHeadSha: string | null;
}) {
  const routePathIds = [...new Set(input.routePathIds.map((entry) => entry.trim()).filter(Boolean))];
  const body = {
    schemaVersion: "gloops.execution-truth.operator-receipt.v2",
    work: { id: input.workId },
    budget: { exhausted: [] },
    route: {
      observedPathIds: routePathIds,
      prohibitedPathObserved: routePathIds.some(
        (routePath) => routePath !== "grok-build-cli" && GROK_API_PATH.test(routePath),
      ),
    },
    continuation: { required: false, valid: true },
    verification: {
      mode: "direct",
      workspaceFinalized: true,
      ...(input.exactHeadSha && SHA.test(input.exactHeadSha)
        ? { exactHeadSha: input.exactHeadSha }
        : {}),
    },
    authority: { humanRequired: false },
    status: "built",
    projection: {
      source: "paperclip-control-plane",
      purpose: "terminal_issue_reconciliation",
      issueId: input.issueId,
      runId: input.runId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      contextDigest: input.contextDigest,
    },
  };
  return { ...body, digest: digest(body) };
}

function buildBlockedReceipt(input: {
  workId: string;
  issueId: string;
  runId: string;
  agentId: string;
  workspaceId: string | null;
  contextDigest: string;
  routePathIds: string[];
  budgetExceeded: string[];
  reason: string;
  exactHeadSha: string | null;
}) {
  const routePathIds = [...new Set(input.routePathIds.map((entry) => entry.trim()).filter(Boolean))];
  const body = {
    schemaVersion: "gloops.execution-truth.operator-receipt.v2",
    work: { id: input.workId },
    budget: { exhausted: [...input.budgetExceeded] },
    route: {
      observedPathIds: routePathIds,
      prohibitedPathObserved: routePathIds.some(
        (routePath) => routePath !== "grok-build-cli" && GROK_API_PATH.test(routePath),
      ),
    },
    continuation: { required: true, valid: true },
    verification: {
      mode: "blocked",
      workspaceFinalized: true,
      blockerReason: input.reason,
      ...(input.exactHeadSha && SHA.test(input.exactHeadSha)
        ? { exactHeadSha: input.exactHeadSha }
        : {}),
    },
    authority: { humanRequired: false },
    status: "blocked",
    projection: {
      source: "paperclip-control-plane",
      purpose: "terminal_issue_reconciliation",
      issueId: input.issueId,
      runId: input.runId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      contextDigest: input.contextDigest,
    },
  };
  return { ...body, digest: digest(body) };
}

function implementationReady(input: {
  workId: string;
  receipt: unknown;
  exactHeadSha: string | null;
}) {
  const common = evaluateExecutionTruthTransition({
    transition: "retry",
    workId: input.workId,
    receipt: input.receipt,
  });
  if (!common.allowed) return false;
  const receipt = record(input.receipt);
  const verification = record(receipt.verification);
  return verification.exactHeadAligned === true &&
    typeof verification.exactHeadSha === "string" &&
    SHA.test(verification.exactHeadSha) &&
    verification.exactHeadSha === input.exactHeadSha &&
    verification.allChecksPassed === true &&
    (receipt.status === "built" || receipt.status === "operational" || receipt.status === "proven");
}

function bindingMatches(input: {
  issue: IssueInput;
  run: RunInput;
  rawBinding: unknown;
  workspaceCwd: string | null;
  executionWorkspaceMode?: string | null;
}) {
  const binding = readBoundExecutionContext(input.rawBinding);
  if (!binding) return { binding: null, matches: false };

  const work = record(binding.packet.work);
  const scope = record(binding.packet.scope);
  const authority = record(binding.packet.authority);
  const repoRef = record(binding.packet.repoRef);
  const workId = input.issue.identifier ?? input.issue.id;
  const expectedWorkspaceId = input.issue.projectWorkspaceId;
  const boundWorkspaceId = string(repoRef.workspaceId);
  const boundCwd = string(repoRef.cwd);
  const matches =
    string(work.id) === workId &&
    string(work.issueId) === input.issue.id &&
    string(scope.companyId) === input.issue.companyId &&
    string(scope.issueId) === input.issue.id &&
    string(authority.companyId) === input.issue.companyId &&
    string(authority.assigneeAgentId) === input.run.agentId &&
    string(authority.runId) === input.run.id &&
    input.issue.assigneeAgentId === input.run.agentId &&
    input.run.companyId === input.issue.companyId &&
    (input.executionWorkspaceMode === "agent_default"
      ? boundWorkspaceId === null
      : (expectedWorkspaceId ? boundWorkspaceId === expectedWorkspaceId : boundWorkspaceId === null)) &&
    (input.workspaceCwd ? boundCwd === input.workspaceCwd : boundCwd === null);
  return { binding, matches };
}

export function decideTerminalIssueReconciliation(input: {
  completionProfile: IssueExecutionCompletionProfile | null | undefined;
  terminalReceipt?: GovernedTerminalLifecycleReceipt | null;
  issue: IssueInput;
  run: RunInput;
  providerTerminalEvidence: boolean;
  workspaceFinalized: boolean;
  workspaceCwd: string | null;
  workspaceHeadSha: string | null;
  executionWorkspaceMode?: string | null;
  budgetExceeded: string[];
  routePathIds: string[];
}): TerminalIssueReconciliationDecision {
  const terminalReceipt = input.terminalReceipt ?? null;
  const supportedCompletionProfile =
    input.completionProfile === "direct" || input.completionProfile === "verified_change";
  if (!supportedCompletionProfile && terminalReceipt === null) {
    return { kind: "preserve", reason: "unsupported_completion_profile" };
  }
  if (input.run.status !== "succeeded") {
    return { kind: "preserve", reason: "run_not_succeeded" };
  }
  if (!input.providerTerminalEvidence) {
    return { kind: "preserve", reason: "missing_provider_terminal_evidence" };
  }
  if (!input.workspaceFinalized) {
    return { kind: "preserve", reason: "workspace_not_finalized" };
  }
  if (input.issue.status === "cancelled") {
    return { kind: "preserve", reason: "terminal_issue_cancelled" };
  }
  if (input.issue.status === "blocked") {
    return { kind: "preserve", reason: "terminal_issue_blocked" };
  }
  if (
    input.issue.executionRunId !== input.run.id &&
    input.issue.checkoutRunId !== input.run.id
  ) {
    return { kind: "preserve", reason: "run_not_current" };
  }

  const context = input.run.contextSnapshot ?? {};
  const bindingResult = bindingMatches({
    issue: input.issue,
    run: input.run,
    rawBinding: context.paperclipExecutionContext,
    workspaceCwd: input.workspaceCwd,
    executionWorkspaceMode: input.executionWorkspaceMode,
  });
  if (!bindingResult.binding) {
    return { kind: "preserve", reason: "invalid_context_binding" };
  }
  if (!bindingResult.matches) {
    return { kind: "preserve", reason: "context_binding_mismatch" };
  }

  const workId = input.issue.identifier ?? input.issue.id;
  const existingReceipt = context[PAPERCLIP_EXECUTION_RECEIPT_KEY];
  if (
    !supportedCompletionProfile &&
    terminalReceipt?.action === "operations_complete" &&
    input.workspaceCwd !== null
  ) {
    const boundRepoRef = string(record(bindingResult.binding.packet.repoRef).repoRef);
    if (
      !boundRepoRef ||
      !SHA.test(boundRepoRef) ||
      !input.workspaceHeadSha ||
      !SHA.test(input.workspaceHeadSha) ||
      boundRepoRef !== input.workspaceHeadSha
    ) {
      return { kind: "preserve", reason: "execution_truth_rejected" };
    }
  }
  if (terminalReceipt?.action === "blocked") {
    return {
      kind: "project",
      status: "blocked",
      receipt: buildBlockedReceipt({
        workId,
        issueId: input.issue.id,
        runId: input.run.id,
        agentId: input.run.agentId,
        workspaceId: input.issue.projectWorkspaceId,
        contextDigest: bindingResult.binding.digest,
        routePathIds: input.routePathIds,
        budgetExceeded: input.budgetExceeded,
        reason: terminalReceipt.reason,
        exactHeadSha: input.workspaceHeadSha,
      }),
      reason: "agent_reported_blocker",
    };
  }
  if (input.completionProfile === "verified_change") {
    if (!existingReceipt) {
      return { kind: "preserve", reason: "missing_execution_truth" };
    }
    const completed = evaluateExecutionTruthTransition({
      transition: "completed",
      workId,
      receipt: existingReceipt,
    });
    const completedVerification = record(record(existingReceipt).verification);
    if (
      completed.allowed &&
      completedVerification.exactHeadSha === input.workspaceHeadSha
    ) {
      return {
        kind: "project",
        status: "done",
        receipt: existingReceipt as Record<string, unknown>,
        reason: "review_accepted",
      };
    }
    const ready = implementationReady({
      workId,
      receipt: existingReceipt,
      exactHeadSha: input.workspaceHeadSha,
    });
    if (ready) {
      if (input.issue.status === "done") {
        return { kind: "preserve", reason: "execution_truth_rejected" };
      }
      return {
        kind: "project",
        status: "in_review",
        receipt: existingReceipt as Record<string, unknown>,
        reason: "implementation_ready",
      };
    }
    return { kind: "preserve", reason: "execution_truth_rejected" };
  }

  if (input.budgetExceeded.length > 0) {
    return { kind: "preserve", reason: "budget_exhausted" };
  }
  if (input.routePathIds.length === 0) {
    return { kind: "preserve", reason: "execution_truth_rejected" };
  }
  const receipt = buildDirectReceipt({
    workId,
    issueId: input.issue.id,
    runId: input.run.id,
    agentId: input.run.agentId,
    workspaceId: input.issue.projectWorkspaceId,
    contextDigest: bindingResult.binding.digest,
    routePathIds: input.routePathIds,
    exactHeadSha: input.workspaceHeadSha,
  });
  const receiptDecision = evaluateExecutionTruthTransition({
    transition: "retry",
    workId,
    receipt,
  });
  if (!receiptDecision.allowed) {
    return { kind: "preserve", reason: "execution_truth_rejected" };
  }
  return {
    kind: "project",
    status: "done",
    receipt,
    reason: "direct_terminal_evidence",
  };
}

export function decideMergedPullRequestIssueReconciliation(input: {
  completionProfile: IssueExecutionCompletionProfile | null | undefined;
  issue: Pick<IssueInput, "id" | "identifier" | "status" | "executionRunId" | "checkoutRunId">;
  run: Pick<RunInput, "id" | "status" | "contextSnapshot">;
  pullRequest: {
    provider: string | null;
    merged: boolean;
    headSha: string | null;
  };
}): MergedPullRequestIssueDecision {
  if (input.completionProfile !== "verified_change") {
    return { kind: "preserve", reason: "unsupported_completion_profile" };
  }
  if (input.issue.status !== "in_review") {
    return { kind: "preserve", reason: "issue_not_in_review" };
  }
  if (input.run.status !== "succeeded") {
    return { kind: "preserve", reason: "run_not_succeeded" };
  }
  if (
    input.issue.executionRunId !== input.run.id &&
    input.issue.checkoutRunId !== input.run.id
  ) {
    return { kind: "preserve", reason: "run_not_current" };
  }
  if (input.pullRequest.provider !== "github" || !input.pullRequest.merged) {
    return { kind: "preserve", reason: "pull_request_not_merged" };
  }
  const headSha = input.pullRequest.headSha?.trim().toLowerCase() ?? null;
  if (!headSha || !SHA.test(headSha)) {
    return { kind: "preserve", reason: "missing_pull_request_head" };
  }

  const existingReceipt = record(
    (input.run.contextSnapshot ?? {})[PAPERCLIP_EXECUTION_RECEIPT_KEY],
  );
  if (Object.keys(existingReceipt).length === 0) {
    return { kind: "preserve", reason: "missing_execution_truth" };
  }
  const workId = input.issue.identifier ?? input.issue.id;
  const verification = record(existingReceipt.verification);
  const receiptHeadSha = string(verification.exactHeadSha)?.toLowerCase() ?? null;
  if (receiptHeadSha !== headSha) {
    return { kind: "preserve", reason: "exact_head_mismatch" };
  }
  if (!implementationReady({ workId, receipt: existingReceipt, exactHeadSha: headSha })) {
    return { kind: "preserve", reason: "execution_truth_rejected" };
  }

  const receiptBody = {
    ...existingReceipt,
    verification: {
      ...verification,
      review: {
        status: "accepted",
        headSha,
        unresolvedThreads: 0,
        source: "github_merge",
      },
    },
    status: "operational",
  };
  delete (receiptBody as Record<string, unknown>).digest;
  const receipt = {
    ...receiptBody,
    digest: digest(receiptBody),
  };
  const completed = evaluateExecutionTruthTransition({
    transition: "completed",
    workId,
    receipt,
  });
  if (!completed.allowed) {
    return { kind: "preserve", reason: "execution_truth_rejected" };
  }
  return {
    kind: "project",
    status: "done",
    receipt,
    reason: "merged_exact_head",
  };
}

export function buildTerminalIssueLifecyclePatch(input: {
  currentCompletedAt: Date | null;
  targetStatus: TerminalIssueStatus;
  now: Date;
}) {
  if (input.targetStatus === "done") {
    return {
      status: input.targetStatus,
      completedAt: input.currentCompletedAt ?? input.now,
      updatedAt: input.now,
    } as const;
  }
  return {
    status: input.targetStatus,
    updatedAt: input.now,
  } as const;
}

export function terminalIssueLifecycleNeedsUpdate(input: {
  currentStatus: string;
  currentCompletedAt: Date | null;
  targetStatus: TerminalIssueStatus;
}) {
  return input.currentStatus !== input.targetStatus ||
    (input.targetStatus === "done" && input.currentCompletedAt === null);
}
