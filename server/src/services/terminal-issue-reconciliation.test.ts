import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PAPERCLIP_EXECUTION_CONTEXT_KEY,
  PAPERCLIP_EXECUTION_RECEIPT_KEY,
  buildBoundExecutionContext,
  buildCanonicalContinuationPacket,
} from "@paperclipai/adapter-utils/execution-envelope";
import {
  buildTerminalIssueLifecyclePatch,
  decideMergedPullRequestIssueReconciliation,
  decideTerminalIssueReconciliation,
  terminalIssueLifecycleNeedsUpdate,
} from "./terminal-issue-reconciliation.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const projectWorkspaceId = "55555555-5555-4555-8555-555555555555";
const cwd = "/opt/data/workspace/paperclip/.paperclip/worktrees/GLO-1329";
const headSha = "a".repeat(40);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}

function verifiedReceipt(options: { reviewed?: boolean; checksPassed?: boolean; head?: string } = {}) {
  const exactHeadSha = options.head ?? headSha;
  const body = {
    schemaVersion: "gloops.execution-truth.operator-receipt.v2",
    work: { id: "GLO-1329" },
    budget: { exhausted: [] },
    route: { observedPathIds: ["ollama-cloud-cli"], prohibitedPathObserved: false },
    continuation: { required: false, valid: true },
    verification: {
      exactHeadAligned: true,
      exactHeadSha,
      allChecksPassed: options.checksPassed ?? true,
      ...(options.reviewed
        ? { review: { status: "accepted", headSha: exactHeadSha, unresolvedThreads: 0 } }
        : {}),
    },
    authority: { humanRequired: false },
    status: "built",
  };
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(stable(body))).digest("hex")}`;
  return { ...body, digest };
}

function boundContext() {
  return buildBoundExecutionContext(buildCanonicalContinuationPacket({
    issue: {
      id: issueId,
      identifier: "GLO-1329",
      title: "Bounded edit-test-commit completion",
    },
    repoRef: {
      repoRef: "b".repeat(40),
      cwd,
      workspaceId: projectWorkspaceId,
    },
    authority: {
      companyId,
      assigneeAgentId: agentId,
      runId,
    },
  }));
}

function input(overrides: Record<string, unknown> = {}) {
  const {
    issue: rawIssueOverrides,
    run: rawRunOverrides,
    contextSnapshot: rawContextOverrides,
    ...rootOverrides
  } = overrides;
  const issueOverrides = rawIssueOverrides as Record<string, unknown> | undefined;
  const runOverrides = rawRunOverrides as Record<string, unknown> | undefined;
  const contextOverrides = rawContextOverrides as Record<string, unknown> | undefined;
  const contextSnapshot = {
    [PAPERCLIP_EXECUTION_CONTEXT_KEY]: boundContext(),
    ...contextOverrides,
  };
  return {
    completionProfile: "direct" as const,
    issue: {
      id: issueId,
      identifier: "GLO-1329",
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
      projectWorkspaceId,
      executionRunId: runId,
      checkoutRunId: runId,
      ...issueOverrides,
    },
    run: {
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot,
      ...runOverrides,
    },
    providerTerminalEvidence: true,
    workspaceFinalized: true,
    workspaceCwd: cwd,
    workspaceHeadSha: headSha,
    budgetExceeded: [] as string[],
    routePathIds: ["ollama-cloud-cli"],
    ...rootOverrides,
  };
}

function boundContextAgentDefault() {
  return buildBoundExecutionContext(buildCanonicalContinuationPacket({
    issue: {
      id: issueId,
      identifier: "GLO-1329",
      title: "Bounded edit-test-commit completion",
    },
    repoRef: {
      repoRef: "b".repeat(40),
      cwd,
      workspaceId: undefined,
    },
    authority: {
      companyId,
      assigneeAgentId: agentId,
      runId,
    },
  }));
}

describe("decideTerminalIssueReconciliation", () => {
  it("projects the GLO-1329 direct pattern to done with one deterministic receipt", () => {
    const first = decideTerminalIssueReconciliation(input());
    const replay = decideTerminalIssueReconciliation(input());

    expect(first).toMatchObject({ kind: "project", status: "done", reason: "direct_terminal_evidence" });
    expect(replay).toEqual(first);
    expect(first.kind === "project" && first.receipt.digest).toBe(
      replay.kind === "project" ? replay.receipt.digest : null,
    );
  });

  it("lets an explicit operations receipt complete an otherwise unprofiled direct task", () => {
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: null,
      terminalReceipt: {
        action: "operations_complete",
        summary: "Read-only verification completed",
      },
      workspaceHeadSha: "b".repeat(40),
    }))).toMatchObject({
      kind: "project",
      status: "done",
      reason: "direct_terminal_evidence",
    });
  });

  it("does not let an unprofiled operations receipt hide a workspace head change", () => {
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: null,
      terminalReceipt: {
        action: "operations_complete",
        summary: "Implementation completed",
      },
    }))).toEqual({ kind: "preserve", reason: "execution_truth_rejected" });
  });

  it("does not let operations_complete self-accept verified-change to done", () => {
    // operations_complete alone never grants done; with a progress workspace head
    // the control plane may project implementation_ready → in_review for Argus.
    const decision = decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      terminalReceipt: {
        action: "operations_complete",
        summary: "Implementation completed",
      },
    }));
    expect(decision).toMatchObject({
      kind: "project",
      status: "in_review",
      reason: "implementation_ready",
    });
    expect(decision.kind === "project" ? decision.status : null).not.toBe("done");
  });

  it("projects a bound agent-reported blocker with an auditable receipt", () => {
    const decision = decideTerminalIssueReconciliation(input({
      completionProfile: null,
      terminalReceipt: {
        action: "blocked",
        reason: "Required repository credential is unavailable",
      },
    }));
    expect(decision).toMatchObject({
      kind: "project",
      status: "blocked",
      reason: "agent_reported_blocker",
      receipt: {
        status: "blocked",
        verification: {
          mode: "blocked",
          blockerReason: "Required repository credential is unavailable",
        },
      },
    });
  });

  it("requires trusted terminal gates before honoring agent terminal receipts", () => {
    const terminalReceipt = {
      action: "operations_complete" as const,
      summary: "Read-only verification completed",
    };
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: null,
      terminalReceipt,
      providerTerminalEvidence: false,
    }))).toEqual({ kind: "preserve", reason: "missing_provider_terminal_evidence" });
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: null,
      terminalReceipt,
      issue: { executionRunId: "stale-run", checkoutRunId: "stale-run" },
    }))).toEqual({ kind: "preserve", reason: "run_not_current" });
  });

  it("projects verified implementation evidence to in_review without self-accepting it", () => {
    const receipt = verifiedReceipt();
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      contextSnapshot: { [PAPERCLIP_EXECUTION_RECEIPT_KEY]: receipt },
    }))).toMatchObject({ kind: "project", status: "in_review", reason: "implementation_ready" });
  });


  it("synthesizes implementation-ready receipt from workspace progress head when missing", () => {
    const decision = decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      // no existing receipt — control plane must synthesize from measured head
      workspaceHeadSha: headSha,
    }));
    expect(decision).toMatchObject({
      kind: "project",
      status: "in_review",
      reason: "implementation_ready",
      receipt: {
        verification: {
          exactHeadAligned: true,
          exactHeadSha: headSha,
          allChecksPassed: true,
          mode: "implementation_ready",
        },
        projection: {
          purpose: "implementation_ready_from_workspace_head",
        },
      },
    });
  });

  it("does not synthesize when workspace head matches bound baseline (no progress)", () => {
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      workspaceHeadSha: "b".repeat(40), // matches boundContext repoRef
    }))).toEqual({ kind: "preserve", reason: "missing_execution_truth" });
  });

  it("preserves failure for missing checks and exact binding mismatches", () => {
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      contextSnapshot: { [PAPERCLIP_EXECUTION_RECEIPT_KEY]: verifiedReceipt({ checksPassed: false }) },
    }))).toEqual({ kind: "preserve", reason: "execution_truth_rejected" });

    expect(decideTerminalIssueReconciliation(input({
      issue: { assigneeAgentId: "66666666-6666-4666-8666-666666666666" },
    }))).toEqual({ kind: "preserve", reason: "context_binding_mismatch" });
  });

  it("requires accepted exact-head review before verified change reaches done", () => {
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      contextSnapshot: { [PAPERCLIP_EXECUTION_RECEIPT_KEY]: verifiedReceipt({ reviewed: true }) },
    }))).toMatchObject({ kind: "project", status: "done", reason: "review_accepted" });

    expect(decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      contextSnapshot: {
        [PAPERCLIP_EXECUTION_RECEIPT_KEY]: verifiedReceipt({ reviewed: true, head: "c".repeat(40) }),
      },
    }))).toEqual({ kind: "preserve", reason: "execution_truth_rejected" });
  });

  it("does not let late budget exhaustion erase already valid verified evidence", () => {
    expect(decideTerminalIssueReconciliation(input({
      completionProfile: "verified_change",
      contextSnapshot: { [PAPERCLIP_EXECUTION_RECEIPT_KEY]: verifiedReceipt() },
      budgetExceeded: ["turns"],
    }))).toMatchObject({ kind: "project", status: "in_review" });

    expect(decideTerminalIssueReconciliation(input({ budgetExceeded: ["turns"] })))
      .toEqual({ kind: "preserve", reason: "budget_exhausted" });
  });

  it("requires durable provider terminal evidence and preserves an explicit blocked state", () => {
    expect(decideTerminalIssueReconciliation(input({ providerTerminalEvidence: false })))
      .toEqual({ kind: "preserve", reason: "missing_provider_terminal_evidence" });

    expect(decideTerminalIssueReconciliation(input({ issue: { status: "blocked" } })))
      .toEqual({ kind: "preserve", reason: "terminal_issue_blocked" });
  });

  describe("agent_default workspace mode", () => {
    it("reconciles when mode is agent_default, issue has projectWorkspaceId, and bound workspaceId is null", () => {
      const agentDefaultContext = boundContextAgentDefault();
      expect(decideTerminalIssueReconciliation({
        ...input({
          issue: { projectWorkspaceId },
          run: {
            contextSnapshot: {
              [PAPERCLIP_EXECUTION_CONTEXT_KEY]: agentDefaultContext,
            },
          },
        }),
        executionWorkspaceMode: "agent_default",
      })).toMatchObject({ kind: "project", status: "done", reason: "direct_terminal_evidence" });
    });

    it("rejects the same mismatch when mode is not agent_default", () => {
      const agentDefaultContext = boundContextAgentDefault();
      expect(decideTerminalIssueReconciliation({
        ...input({
          issue: { projectWorkspaceId },
          run: {
            contextSnapshot: {
              [PAPERCLIP_EXECUTION_CONTEXT_KEY]: agentDefaultContext,
            },
          },
        }),
      })).toEqual({ kind: "preserve", reason: "context_binding_mismatch" });
    });
  });

  it("sets completion metadata exactly once when projecting done", () => {
    const now = new Date("2026-07-23T00:00:00.000Z");
    const completedAt = new Date("2026-07-22T23:00:00.000Z");
    expect(buildTerminalIssueLifecyclePatch({
      currentCompletedAt: null,
      targetStatus: "done",
      now,
    })).toEqual({ status: "done", completedAt: now, updatedAt: now });
    expect(buildTerminalIssueLifecyclePatch({
      currentCompletedAt: completedAt,
      targetStatus: "done",
      now,
    })).toEqual({ status: "done", completedAt, updatedAt: now });
    expect(terminalIssueLifecycleNeedsUpdate({
      currentStatus: "done",
      currentCompletedAt: null,
      targetStatus: "done",
    })).toBe(true);
    expect(terminalIssueLifecycleNeedsUpdate({
      currentStatus: "done",
      currentCompletedAt: completedAt,
      targetStatus: "done",
    })).toBe(false);
  });
});

describe("decideMergedPullRequestIssueReconciliation", () => {
  it("projects an implementation-ready issue to done only for its merged exact head", () => {
    const receipt = verifiedReceipt();
    const decision = decideMergedPullRequestIssueReconciliation({
      completionProfile: "verified_change",
      issue: {
        id: issueId,
        identifier: "GLO-1329",
        status: "in_review",
        executionRunId: runId,
        checkoutRunId: runId,
      },
      run: {
        id: runId,
        status: "succeeded",
        contextSnapshot: {
          [PAPERCLIP_EXECUTION_RECEIPT_KEY]: receipt,
        },
      },
      pullRequest: {
        provider: "github",
        merged: true,
        headSha,
      },
    });

    expect(decision).toMatchObject({
      kind: "project",
      status: "done",
      reason: "merged_exact_head",
      receipt: {
        status: "operational",
        verification: {
          review: {
            status: "accepted",
            headSha,
            unresolvedThreads: 0,
            source: "github_merge",
          },
        },
      },
    });
  });

  it("preserves state for a different PR head or a non-current run", () => {
    const base = {
      completionProfile: "verified_change" as const,
      issue: {
        id: issueId,
        identifier: "GLO-1329",
        status: "in_review",
        executionRunId: runId,
        checkoutRunId: runId,
      },
      run: {
        id: runId,
        status: "succeeded",
        contextSnapshot: {
          [PAPERCLIP_EXECUTION_RECEIPT_KEY]: verifiedReceipt(),
        },
      },
      pullRequest: {
        provider: "github",
        merged: true,
        headSha: "c".repeat(40),
      },
    };
    expect(decideMergedPullRequestIssueReconciliation(base))
      .toEqual({ kind: "preserve", reason: "exact_head_mismatch" });
    expect(decideMergedPullRequestIssueReconciliation({
      ...base,
      issue: {
        ...base.issue,
        executionRunId: "77777777-7777-4777-8777-777777777777",
        checkoutRunId: null,
      },
    })).toEqual({ kind: "preserve", reason: "run_not_current" });
  });
});
