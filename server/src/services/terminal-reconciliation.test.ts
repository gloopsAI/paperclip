import { describe, expect, it } from "vitest";
import { PAPERCLIP_EXECUTION_RECEIPT_KEY } from "@paperclipai/adapter-utils/execution-envelope";
import {
  buildReconciliationReceipt,
  detectCompletionEvidence,
  shouldAutoCloseIssueOnRunSuccess,
  type CompletionEvidence,
  type ShouldAutoCloseInput,
} from "./terminal-reconciliation.js";

const base = (overrides: Partial<ShouldAutoCloseInput> = {}): ShouldAutoCloseInput => ({
  runStatus: "succeeded",
  hasBoundIssue: true,
  issueStatus: "in_progress",
  runIsCurrentForIssue: true,
  evidence: { kind: "summary", detail: "Implemented the fix and verified tests" },
  completionProfile: null,
  ...overrides,
});

const evidence = (kind: CompletionEvidence["kind"], detail = "ok"): CompletionEvidence => ({
  kind,
  detail,
});

describe("shouldAutoCloseIssueOnRunSuccess", () => {
  describe("close", () => {
    it("closes in_progress issues with non-empty summary evidence", () => {
      expect(shouldAutoCloseIssueOnRunSuccess(base())).toEqual({
        action: "close",
        reason: "evidenced_success:summary",
      });
    });

    it("closes todo issues with result evidence", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            issueStatus: "todo",
            evidence: evidence("result", "All checks green"),
          }),
        ),
      ).toEqual({
        action: "close",
        reason: "evidenced_success:result",
      });
    });

    it("closes open issues on terminal marker evidence", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({ evidence: evidence("terminal_marker", "operations_complete") }),
        ),
      ).toEqual({
        action: "close",
        reason: "evidenced_success:terminal_marker",
      });
    });

    it("closes open issues on DONE pattern evidence", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({ evidence: evidence("done_pattern", "DONE: shipped") }),
        ),
      ).toEqual({
        action: "close",
        reason: "evidenced_success:done_pattern",
      });
    });

    it("closes in_review issues when review-accept evidence is present", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            issueStatus: "in_review",
            evidence: evidence("review_accept", "head accepted"),
          }),
        ),
      ).toEqual({
        action: "close",
        reason: "review_accept_while_in_review",
      });
    });

    it("closes verified_change work only with review-accept evidence", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            completionProfile: "verified_change",
            evidence: evidence("review_accept", "accepted"),
          }),
        ),
      ).toEqual({
        action: "close",
        reason: "evidenced_success:review_accept",
      });
    });
  });

  describe("attention", () => {
    it("emits attention for empty infrastructure success on open issues", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            evidence: null,
          }),
        ),
      ).toEqual({
        action: "attention",
        reason: "succeeded_without_completion_evidence",
      });
    });

    it("emits attention for todo without evidence", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            issueStatus: "todo",
            evidence: null,
          }),
        ),
      ).toEqual({
        action: "attention",
        reason: "succeeded_without_completion_evidence",
      });
    });

    it("does not auto-close verified_change without review-accept (attention)", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            completionProfile: "verified_change",
            evidence: evidence("summary", "looks done"),
          }),
        ),
      ).toEqual({
        action: "attention",
        reason: "verified_change_requires_review_accept",
      });
    });
  });

  describe("noop", () => {
    it("noops when run is not succeeded", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ runStatus: "failed" })),
      ).toEqual({ action: "noop", reason: "run_not_succeeded" });
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ runStatus: "running" })),
      ).toEqual({ action: "noop", reason: "run_not_succeeded" });
    });

    it("noops when issue is not bound", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({ hasBoundIssue: false, issueStatus: null }),
        ),
      ).toEqual({ action: "noop", reason: "missing_bound_issue" });
    });

    it("noops when issue row is missing", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ issueStatus: null })),
      ).toEqual({ action: "noop", reason: "issue_not_found" });
    });

    it("noops when run is not current for the issue", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ runIsCurrentForIssue: false })),
      ).toEqual({ action: "noop", reason: "run_not_current" });
    });

    it("does not close blocked, cancelled, or already done", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ issueStatus: "blocked" })),
      ).toEqual({ action: "noop", reason: "terminal_blocked" });
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ issueStatus: "cancelled" })),
      ).toEqual({ action: "noop", reason: "terminal_cancelled" });
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ issueStatus: "done" })),
      ).toEqual({ action: "noop", reason: "already_done" });
    });

    it("does not close backlog", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(base({ issueStatus: "backlog" })),
      ).toEqual({ action: "noop", reason: "status_not_auto_closeable" });
    });

    it("does not close in_review without review-accept", () => {
      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            issueStatus: "in_review",
            evidence: evidence("summary", "ready for review"),
          }),
        ),
      ).toEqual({ action: "noop", reason: "in_review_awaiting_accept" });

      expect(
        shouldAutoCloseIssueOnRunSuccess(
          base({
            issueStatus: "in_review",
            evidence: null,
          }),
        ),
      ).toEqual({ action: "noop", reason: "in_review_without_accept" });
    });
  });
});

describe("detectCompletionEvidence", () => {
  it("returns null for empty infrastructure success", () => {
    expect(detectCompletionEvidence({ resultJson: null })).toBeNull();
    expect(detectCompletionEvidence({ resultJson: {} })).toBeNull();
    expect(detectCompletionEvidence({ resultJson: { exitCode: 0 } })).toBeNull();
  });

  it("detects non-empty summary and result", () => {
    expect(
      detectCompletionEvidence({ resultJson: { summary: "  shipped the fix  " } }),
    ).toEqual({ kind: "summary", detail: "shipped the fix" });

    expect(
      detectCompletionEvidence({ resultJson: { result: "All green" } }),
    ).toEqual({ kind: "result", detail: "All green" });
  });

  it("detects DONE pattern over plain summary", () => {
    expect(
      detectCompletionEvidence({ resultJson: { summary: "DONE: merged and verified" } }),
    ).toMatchObject({ kind: "done_pattern" });

    expect(
      detectCompletionEvidence({
        resultJson: { output: "work finished\n[DONE] ready" },
      }),
    ).toMatchObject({ kind: "done_pattern" });
  });

  it("detects disposition/status terminal markers", () => {
    expect(
      detectCompletionEvidence({ resultJson: { disposition: "done" } }),
    ).toEqual({ kind: "terminal_marker", detail: "disposition:done" });
  });

  it("detects operations_complete lifecycle marker", () => {
    const marker = JSON.stringify({
      action: "operations_complete",
      summary: "Verified six native skills",
    });
    expect(
      detectCompletionEvidence({
        resultJson: {
          output: `some log\nPAPERCLIP_SWARM_V1:${marker}`,
        },
      }),
    ).toEqual({
      kind: "terminal_marker",
      detail: "Verified six native skills",
    });
  });

  it("detects accepted lifecycle marker as review_accept", () => {
    const headSha = "a".repeat(40);
    const marker = JSON.stringify({
      action: "accepted",
      headSha,
      summary: "LGTM",
    });
    expect(
      detectCompletionEvidence({
        resultJson: {
          output: `PAPERCLIP_SWARM_V1:${marker}`,
        },
      }),
    ).toEqual({
      kind: "review_accept",
      detail: "LGTM",
    });
  });

  it("detects review-accept on execution receipt", () => {
    expect(
      detectCompletionEvidence({
        resultJson: {},
        contextSnapshot: {
          [PAPERCLIP_EXECUTION_RECEIPT_KEY]: {
            verification: {
              review: { status: "accepted", headSha: "b".repeat(40) },
            },
          },
        },
      }),
    ).toEqual({
      kind: "review_accept",
      detail: "b".repeat(40),
    });
  });
});

describe("buildReconciliationReceipt", () => {
  it("builds a stable receipt shape", () => {
    const at = new Date("2026-07-28T12:00:00.000Z");
    expect(
      buildReconciliationReceipt({
        action: "close",
        reason: "evidenced_success:summary",
        companyId: "c1",
        runId: "r1",
        issueId: "i1",
        runStatus: "succeeded",
        issueStatusBefore: "in_progress",
        issueStatusAfter: "done",
        evidence: evidence("summary", "done"),
        applied: true,
        at,
      }),
    ).toEqual({
      schemaVersion: "paperclip.terminal-reconciliation.v1",
      action: "close",
      reason: "evidenced_success:summary",
      companyId: "c1",
      runId: "r1",
      issueId: "i1",
      runStatus: "succeeded",
      issueStatusBefore: "in_progress",
      issueStatusAfter: "done",
      evidence: { kind: "summary", detail: "done" },
      applied: true,
      at: "2026-07-28T12:00:00.000Z",
    });
  });
});
