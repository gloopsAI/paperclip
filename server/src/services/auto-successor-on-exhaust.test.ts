import { describe, expect, it } from "vitest";
import {
  AUTO_SUCCESSOR_ORIGIN_KIND,
  AUTO_SUCCESSOR_TITLE_MARKER,
  admissionExhaustReasonFromDenial,
  autoSuccessorFingerprint,
  buildAutoSuccessorDescription,
  buildAutoSuccessorParentComment,
  buildAutoSuccessorTitle,
  evaluateAutoSuccessorTitleFilters,
  isExecClassTitle,
  isExhaustSuccessorReason,
  isTerminalSucceededParentStatus,
  selectAutoSuccessorAssignee,
  titleContainsReviewMarker,
  titleContainsSuccessorMarker,
} from "./auto-successor-on-exhaust.js";

describe("auto-successor-on-exhaust filters", () => {
  it("accepts only known exhaust admission reasons", () => {
    expect(isExhaustSuccessorReason("retry_limit_exhausted")).toBe(true);
    expect(isExhaustSuccessorReason("run_limit_exhausted")).toBe(true);
    expect(isExhaustSuccessorReason("input_token_limit_exhausted")).toBe(true);
    expect(isExhaustSuccessorReason("output_token_limit_exhausted")).toBe(true);
    expect(isExhaustSuccessorReason("wall_time_limit_exhausted")).toBe(true);
    expect(isExhaustSuccessorReason("input_reservation_unavailable")).toBe(false);
    expect(isExhaustSuccessorReason("policy_locked")).toBe(false);
    expect(isExhaustSuccessorReason(null)).toBe(false);
  });

  it("parses exhaust reason from errorCode, envelope, or reason text", () => {
    expect(admissionExhaustReasonFromDenial({
      errorCode: "execution_admission.retry_limit_exhausted",
    })).toBe("retry_limit_exhausted");

    expect(admissionExhaustReasonFromDenial({
      envelope: { reason: "run_limit_exhausted" },
    })).toBe("run_limit_exhausted");

    expect(admissionExhaustReasonFromDenial({
      reasonText: "Cancelled because the task execution budget is exhausted (retry_limit_exhausted)",
    })).toBe("retry_limit_exhausted");

    expect(admissionExhaustReasonFromDenial({
      errorCode: "execution_admission.policy_locked",
    })).toBeNull();

    expect(admissionExhaustReasonFromDenial({
      errorCode: "budget_blocked",
    })).toBeNull();
  });

  it("only admits EXEC: titles", () => {
    expect(isExecClassTitle("EXEC: implement slice")).toBe(true);
    expect(isExecClassTitle("EXEC: SUCCESSOR after exhaust of GLO-1")).toBe(true);
    expect(isExecClassTitle("Review exact head of PR")).toBe(false);
    expect(isExecClassTitle("PLAN: strategy")).toBe(false);
    expect(isExecClassTitle(null)).toBe(false);
  });

  it("skips SUCCESSOR and review titles (anti-chain / anti-review thrash)", () => {
    expect(titleContainsSuccessorMarker(`EXEC: ${AUTO_SUCCESSOR_TITLE_MARKER} of GLO-1991`)).toBe(true);
    expect(titleContainsSuccessorMarker("EXEC: implement slice")).toBe(false);
    expect(titleContainsReviewMarker("Review exact head of PR #123")).toBe(true);
    expect(titleContainsReviewMarker("EXEC: implement slice")).toBe(false);
  });

  it("never multi-wakes done/cancelled parents", () => {
    expect(isTerminalSucceededParentStatus("done")).toBe(true);
    expect(isTerminalSucceededParentStatus("cancelled")).toBe(true);
    expect(isTerminalSucceededParentStatus("blocked")).toBe(false);
    expect(isTerminalSucceededParentStatus("todo")).toBe(false);
    expect(isTerminalSucceededParentStatus("in_progress")).toBe(false);
  });

  it("applies host poller title/status filters as pure eligibility", () => {
    expect(evaluateAutoSuccessorTitleFilters({
      title: "EXEC: B4 auto-successor canary",
      status: "blocked",
    })).toBeNull();

    expect(evaluateAutoSuccessorTitleFilters({
      title: "PLAN: not exec",
      status: "blocked",
    })).toEqual({ eligible: false, skip: "non_exec_title" });

    expect(evaluateAutoSuccessorTitleFilters({
      title: `EXEC: ${AUTO_SUCCESSOR_TITLE_MARKER} of GLO-1991`,
      status: "todo",
    })).toEqual({ eligible: false, skip: "successor_title" });

    expect(evaluateAutoSuccessorTitleFilters({
      title: "Review exact head of PR",
      status: "todo",
    })).toEqual({ eligible: false, skip: "non_exec_title" });

    expect(evaluateAutoSuccessorTitleFilters({
      title: "EXEC: Review exact head of PR",
      status: "todo",
    })).toEqual({ eligible: false, skip: "review_title" });

    expect(evaluateAutoSuccessorTitleFilters({
      title: "EXEC: finished work",
      status: "done",
    })).toEqual({ eligible: false, skip: "terminal_parent" });

    expect(evaluateAutoSuccessorTitleFilters({
      title: "EXEC: cancelled work",
      status: "cancelled",
    })).toEqual({ eligible: false, skip: "terminal_parent" });
  });
});

describe("auto-successor-on-exhaust idempotency + assignee policy", () => {
  it("builds a stable per-parent fingerprint (cap = one successor)", () => {
    const a = autoSuccessorFingerprint({
      companyId: "company-1",
      parentIssueId: "issue-1",
    });
    const b = autoSuccessorFingerprint({
      companyId: "company-1",
      parentIssueId: "issue-1",
    });
    const otherParent = autoSuccessorFingerprint({
      companyId: "company-1",
      parentIssueId: "issue-2",
    });
    expect(a).toBe(b);
    expect(a).toContain(AUTO_SUCCESSOR_ORIGIN_KIND);
    expect(a).not.toBe(otherParent);
  });

  it("builds SUCCESSOR title from parent identifier", () => {
    expect(buildAutoSuccessorTitle("GLO-1991", "uuid-1")).toBe(
      `EXEC: ${AUTO_SUCCESSOR_TITLE_MARKER} of GLO-1991`,
    );
    expect(buildAutoSuccessorTitle(null, "abcdef12-3456")).toBe(
      `EXEC: ${AUTO_SUCCESSOR_TITLE_MARKER} of abcdef12`,
    );
  });

  it("prefers parent assignee and falls back to Wren", () => {
    expect(selectAutoSuccessorAssignee({
      parentAssigneeAgentId: "parent-agent",
      wrenAgentId: "wren-agent",
    })).toBe("parent-agent");

    expect(selectAutoSuccessorAssignee({
      parentAssigneeAgentId: null,
      wrenAgentId: "wren-agent",
    })).toBe("wren-agent");

    expect(selectAutoSuccessorAssignee({
      parentAssigneeAgentId: "  ",
      wrenAgentId: null,
    })).toBeNull();
  });

  it("renders scoped packet description and parent pointer comment", () => {
    const description = buildAutoSuccessorDescription({
      parentIdentifier: "GLO-1991",
      parentId: "parent-uuid",
      parentTitle: "EXEC: B4 auto-successor canary",
      exhaustReason: "retry_limit_exhausted",
      runId: "run-1",
      errorCode: "execution_admission.retry_limit_exhausted",
      generatedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(description).toContain("product-native");
    expect(description).toContain("GLO-1991");
    expect(description).toContain("retry_limit_exhausted");
    expect(description).toContain("Do **not** rewake the parent");
    expect(description).toContain(AUTO_SUCCESSOR_ORIGIN_KIND);

    const comment = buildAutoSuccessorParentComment({
      successorIdentifier: "GLO-1992",
      successorId: "succ-uuid",
      exhaustReason: "retry_limit_exhausted",
    });
    expect(comment).toContain("GLO-1992");
    expect(comment).toContain("do not rewake");
    expect(comment).toContain(AUTO_SUCCESSOR_ORIGIN_KIND);
  });

  it("keeps origin kind constant for product attribution", () => {
    expect(AUTO_SUCCESSOR_ORIGIN_KIND).toBe("auto_successor_on_exhaust");
  });
});
