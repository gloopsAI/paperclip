import { describe, expect, it } from "vitest";
import {
  buildReviewPathSlo,
  classifyReviewVerdict,
  isIdleHealthyStatus,
  isReviewerAgent,
  percentileNearestRank,
  resolveImplementerAgentId,
  resolveReviewPathSloWindow,
  reviewRunLatencyMs,
  type ReviewPathSloAgent,
  type ReviewPathSloIssue,
  type ReviewPathSloRun,
} from "./review-path-slo.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ARGUS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEWER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const IMPLEMENTER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const WINDOW_SINCE = new Date("2026-07-01T00:00:00.000Z");
const WINDOW_UNTIL = new Date("2026-07-15T00:00:00.000Z");

function agent(partial: Partial<ReviewPathSloAgent> & Pick<ReviewPathSloAgent, "id" | "name">): ReviewPathSloAgent {
  return {
    role: "general",
    status: "idle",
    ...partial,
  };
}

function run(
  partial: Partial<ReviewPathSloRun> & Pick<ReviewPathSloRun, "id" | "agentId" | "status">,
): ReviewPathSloRun {
  return {
    createdAt: "2026-07-06T12:00:00.000Z",
    updatedAt: "2026-07-06T12:05:00.000Z",
    finishedAt: "2026-07-06T12:05:00.000Z",
    error: null,
    errorCode: null,
    resultJson: null,
    contextSnapshot: { issueId: ISSUE_ID },
    issueId: ISSUE_ID,
    ...partial,
  };
}

function issue(partial: Partial<ReviewPathSloIssue> = {}): ReviewPathSloIssue {
  return {
    id: ISSUE_ID,
    status: "in_review",
    assigneeAgentId: ARGUS_ID,
    createdByAgentId: IMPLEMENTER_ID,
    executionState: null,
    ...partial,
  };
}

describe("isReviewerAgent", () => {
  it("matches Argus by name (case-insensitive) or role=reviewer", () => {
    expect(isReviewerAgent({ name: "Argus", role: "quality" })).toBe(true);
    expect(isReviewerAgent({ name: "ARGUS", role: "general" })).toBe(true);
    expect(isReviewerAgent({ name: "Casey", role: "reviewer" })).toBe(true);
    expect(isReviewerAgent({ name: "Casey", role: "Reviewer" })).toBe(true);
    expect(isReviewerAgent({ name: "Mason", role: "engineer" })).toBe(false);
  });
});

describe("isIdleHealthyStatus", () => {
  it("treats idle and running as healthy", () => {
    expect(isIdleHealthyStatus("idle")).toBe(true);
    expect(isIdleHealthyStatus("running")).toBe(true);
    expect(isIdleHealthyStatus("error")).toBe(false);
    expect(isIdleHealthyStatus("paused")).toBe(false);
    expect(isIdleHealthyStatus("queued")).toBe(false);
  });
});

describe("classifyReviewVerdict", () => {
  it("classifies accepted markers", () => {
    expect(classifyReviewVerdict({ reviewStatus: "accepted" })).toBe("accepted");
    expect(classifyReviewVerdict({ review_status: "approved" })).toBe("accepted");
    expect(classifyReviewVerdict({ review: { status: "accepted" } })).toBe("accepted");
    expect(classifyReviewVerdict({ reviewAccepted: true })).toBe("accepted");
    expect(classifyReviewVerdict({ decision: { outcome: "approved" } })).toBe("accepted");
    expect(classifyReviewVerdict({ outcome: "done_accepted" })).toBe("accepted");
  });

  it("classifies rejected / changes_requested markers", () => {
    expect(classifyReviewVerdict({ reviewStatus: "rejected" })).toBe("rejected");
    expect(classifyReviewVerdict({ reviewStatus: "changes_requested" })).toBe("rejected");
    expect(classifyReviewVerdict({ review: { status: "changes_requested" } })).toBe("rejected");
    expect(classifyReviewVerdict({ decision: { outcome: "changes_requested" } })).toBe("rejected");
    expect(classifyReviewVerdict({ summary: "Request changes on exact-head" })).toBe("rejected");
  });

  it("classifies escalations with precedence over accept/reject text", () => {
    expect(classifyReviewVerdict({ escalated: true, reviewStatus: "accepted" })).toBe("escalated");
    expect(classifyReviewVerdict({ outcome: "escalate_to_board" })).toBe("escalated");
    expect(classifyReviewVerdict({ summary: "escalated to board for authority" })).toBe("escalated");
  });

  it("returns unknown when no verdict markers exist", () => {
    expect(classifyReviewVerdict(null)).toBe("unknown");
    expect(classifyReviewVerdict({})).toBe("unknown");
    expect(classifyReviewVerdict({ summary: "still looking at the PR" })).toBe("unknown");
  });
});

describe("reviewRunLatencyMs + percentileNearestRank", () => {
  it("computes createdAt → updatedAt latency", () => {
    expect(
      reviewRunLatencyMs({
        createdAt: "2026-07-06T12:00:00.000Z",
        updatedAt: "2026-07-06T12:00:10.000Z",
      }),
    ).toBe(10_000);
  });

  it("falls back to finishedAt and returns null for missing/invalid", () => {
    expect(
      reviewRunLatencyMs({
        createdAt: "2026-07-06T12:00:00.000Z",
        updatedAt: null,
        finishedAt: "2026-07-06T12:00:05.000Z",
      }),
    ).toBe(5_000);
    expect(reviewRunLatencyMs({ createdAt: "2026-07-06T12:00:00.000Z", updatedAt: null })).toBeNull();
    expect(
      reviewRunLatencyMs({
        createdAt: "2026-07-06T12:00:10.000Z",
        updatedAt: "2026-07-06T12:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("computes median and p95 via nearest-rank", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentileNearestRank(samples, 0.5)).toBe(50);
    expect(percentileNearestRank(samples, 0.95)).toBe(100);
    expect(percentileNearestRank([], 0.5)).toBeNull();
    expect(percentileNearestRank([42], 0.95)).toBe(42);
  });
});

describe("resolveImplementerAgentId", () => {
  const reviewerIds = new Set([ARGUS_ID, REVIEWER_ID]);

  it("prefers context implementer markers", () => {
    expect(
      resolveImplementerAgentId({
        run: run({
          id: "r1",
          agentId: ARGUS_ID,
          status: "succeeded",
          contextSnapshot: { issueId: ISSUE_ID, implementerAgentId: IMPLEMENTER_ID },
        }),
        issue: issue(),
        reviewerAgentIds: reviewerIds,
      }),
    ).toBe(IMPLEMENTER_ID);
  });

  it("reads executionState.returnAssignee agent principal", () => {
    expect(
      resolveImplementerAgentId({
        run: run({ id: "r1", agentId: ARGUS_ID, status: "succeeded", contextSnapshot: { issueId: ISSUE_ID } }),
        issue: issue({
          executionState: {
            returnAssignee: { type: "agent", agentId: IMPLEMENTER_ID },
          },
        }),
        reviewerAgentIds: reviewerIds,
      }),
    ).toBe(IMPLEMENTER_ID);
  });

  it("uses sole non-reviewer peer run agent as implementer", () => {
    expect(
      resolveImplementerAgentId({
        run: run({ id: "r1", agentId: ARGUS_ID, status: "succeeded" }),
        issue: issue({ createdByAgentId: null }),
        peerRunsOnIssue: [
          run({ id: "p1", agentId: IMPLEMENTER_ID, status: "succeeded" }),
          run({ id: "p2", agentId: IMPLEMENTER_ID, status: "failed" }),
        ],
        reviewerAgentIds: reviewerIds,
      }),
    ).toBe(IMPLEMENTER_ID);
  });

  it("returns null when implementer is not detectable", () => {
    expect(
      resolveImplementerAgentId({
        run: run({ id: "r1", agentId: ARGUS_ID, status: "succeeded", contextSnapshot: { issueId: ISSUE_ID } }),
        issue: issue({ createdByAgentId: null, executionState: null }),
        peerRunsOnIssue: [],
        reviewerAgentIds: reviewerIds,
      }),
    ).toBeNull();
  });
});

describe("resolveReviewPathSloWindow", () => {
  it("defaults to last 14 days ending at now", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const { since, until } = resolveReviewPathSloWindow({ now });
    expect(until.toISOString()).toBe(now.toISOString());
    expect(since.toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("honors explicit since/until", () => {
    const { since, until } = resolveReviewPathSloWindow({
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-10T00:00:00.000Z",
    });
    expect(since.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("buildReviewPathSlo", () => {
  it("aggregates verdicts, latency, errorRate, idleHealthy, and independence", () => {
    const report = buildReviewPathSlo({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      reviewerAgents: [
        agent({ id: ARGUS_ID, name: "Argus", role: "quality", status: "idle" }),
        agent({ id: REVIEWER_ID, name: "Casey", role: "reviewer", status: "running" }),
      ],
      issues: [issue({ executionState: { returnAssignee: { type: "agent", agentId: ARGUS_ID } } })],
      runs: [
        run({
          id: "r-accept",
          agentId: ARGUS_ID,
          status: "succeeded",
          createdAt: "2026-07-06T12:00:00.000Z",
          updatedAt: "2026-07-06T12:01:00.000Z",
          resultJson: { reviewStatus: "accepted" },
          // Self-review: implementer resolved from executionState returnAssignee = Argus
        }),
        run({
          id: "r-reject",
          agentId: REVIEWER_ID,
          status: "succeeded",
          createdAt: "2026-07-07T12:00:00.000Z",
          updatedAt: "2026-07-07T12:02:00.000Z",
          resultJson: { reviewStatus: "changes_requested" },
          contextSnapshot: { issueId: ISSUE_ID, implementerAgentId: IMPLEMENTER_ID },
        }),
        run({
          id: "r-escalate",
          agentId: ARGUS_ID,
          status: "succeeded",
          createdAt: "2026-07-08T12:00:00.000Z",
          updatedAt: "2026-07-08T12:10:00.000Z",
          resultJson: { outcome: "escalated" },
          contextSnapshot: { issueId: ISSUE_ID, implementerAgentId: IMPLEMENTER_ID },
        }),
        run({
          id: "r-fail",
          agentId: ARGUS_ID,
          status: "failed",
          createdAt: "2026-07-09T12:00:00.000Z",
          updatedAt: "2026-07-09T12:00:30.000Z",
          resultJson: null,
          contextSnapshot: { issueId: ISSUE_ID, implementerAgentId: IMPLEMENTER_ID },
        }),
        // Outside window — ignored
        run({
          id: "r-old",
          agentId: ARGUS_ID,
          status: "succeeded",
          createdAt: "2026-06-01T12:00:00.000Z",
          updatedAt: "2026-06-01T12:01:00.000Z",
          resultJson: { reviewStatus: "accepted" },
        }),
        // Non-reviewer agent run in input.runs — ignored for reviewRuns count
        run({
          id: "r-impl",
          agentId: IMPLEMENTER_ID,
          status: "succeeded",
          createdAt: "2026-07-06T11:00:00.000Z",
          resultJson: { summary: "implemented" },
        }),
      ],
    });

    expect(report.companyId).toBe(COMPANY_ID);
    expect(report.window).toEqual({
      since: WINDOW_SINCE.toISOString(),
      until: WINDOW_UNTIL.toISOString(),
    });
    expect(report.reviewerAgents).toHaveLength(2);
    // latencies: 60s, 120s, 600s, 30s → sorted 30k, 60k, 120k, 600k
    // p50 nearest-rank: ceil(0.5*4)-1 = 1 → 60_000
    // p95 nearest-rank: ceil(0.95*4)-1 = 3 → 600_000
    expect(report.metrics).toEqual({
      reviewRuns: 4,
      acceptedVerdicts: 1,
      rejectedVerdicts: 1,
      escalations: 1,
      medianLatencyMs: 60_000,
      p95LatencyMs: 600_000,
      errorRate: 0.25,
      idleHealthy: true,
      independenceViolations: 1,
    });
  });

  it("reports idleHealthy=false when any reviewer is in error and null rates with no runs", () => {
    const report = buildReviewPathSlo({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      reviewerAgents: [agent({ id: ARGUS_ID, name: "Argus", role: "quality", status: "error" })],
      runs: [],
    });
    expect(report.metrics.reviewRuns).toBe(0);
    expect(report.metrics.errorRate).toBeNull();
    expect(report.metrics.medianLatencyMs).toBeNull();
    expect(report.metrics.p95LatencyMs).toBeNull();
    expect(report.metrics.idleHealthy).toBe(false);
    expect(report.metrics.independenceViolations).toBe(0);
  });

  it("reports idleHealthy=false when no reviewer agents are configured", () => {
    const report = buildReviewPathSlo({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      reviewerAgents: [],
      runs: [],
    });
    expect(report.metrics.idleHealthy).toBe(false);
  });

  it("counts independence violation via peer implementer matching reviewer", () => {
    const report = buildReviewPathSlo({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      reviewerAgents: [agent({ id: ARGUS_ID, name: "Argus", role: "quality", status: "idle" })],
      issues: [issue({ createdByAgentId: null, executionState: null })],
      runs: [
        run({
          id: "r1",
          agentId: ARGUS_ID,
          status: "succeeded",
          resultJson: { reviewStatus: "accepted" },
          contextSnapshot: { issueId: ISSUE_ID },
        }),
      ],
      // Only peer is also Argus → not counted as non-reviewer peer.
      // With no implementer signal, no violation.
      peerRuns: [],
    });
    expect(report.metrics.independenceViolations).toBe(0);

    const selfReview = buildReviewPathSlo({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      reviewerAgents: [agent({ id: ARGUS_ID, name: "Argus", role: "quality", status: "idle" })],
      issues: [issue({ createdByAgentId: ARGUS_ID })],
      runs: [
        run({
          id: "r1",
          agentId: ARGUS_ID,
          status: "succeeded",
          resultJson: { reviewStatus: "accepted" },
          // createdByAgentId is Argus but createdBy is skipped when it is a reviewer;
          // force via context implementer marker equal to reviewer.
          contextSnapshot: { issueId: ISSUE_ID, implementerAgentId: ARGUS_ID },
        }),
      ],
    });
    expect(selfReview.metrics.independenceViolations).toBe(1);
  });
});
