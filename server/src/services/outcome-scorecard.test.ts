import { describe, expect, it } from "vitest";
import {
  buildOutcomeScorecard,
  classifyFailureClass,
  countHumanInterventions,
  extractUsageTokens,
  isAcceptedOrganizationalOutcome,
  isHumanInterventionActivity,
  isTerminalMismatch,
  resolveScorecardWindow,
  type ScorecardIssue,
  type ScorecardRun,
} from "./outcome-scorecard.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_DONE = "22222222-2222-4222-8222-222222222222";
const ISSUE_OPEN = "33333333-3333-4333-8333-333333333333";
const ISSUE_DONE_NO_RUN = "44444444-4444-4444-8444-444444444444";
const ISSUE_ASSIGNED = "55555555-5555-4555-8555-555555555555";

const WINDOW_SINCE = new Date("2026-07-01T00:00:00.000Z");
const WINDOW_UNTIL = new Date("2026-07-15T00:00:00.000Z");

function issue(partial: Partial<ScorecardIssue> & Pick<ScorecardIssue, "id" | "status">): ScorecardIssue {
  return {
    createdAt: "2026-07-05T12:00:00.000Z",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    ...partial,
  };
}

function run(partial: Partial<ScorecardRun> & Pick<ScorecardRun, "id" | "status">): ScorecardRun {
  return {
    createdAt: "2026-07-06T12:00:00.000Z",
    error: null,
    errorCode: null,
    usageJson: null,
    resultJson: null,
    contextSnapshot: null,
    issueId: null,
    ...partial,
  };
}

describe("classifyFailureClass", () => {
  it("classifies infrastructure keywords and codes", () => {
    expect(classifyFailureClass("workspace_preparation_failed")).toBe("infrastructure");
    expect(classifyFailureClass("execution_admission.run_limit_exhausted")).toBe("infrastructure");
    expect(classifyFailureClass(null, "gateway timeout connecting to hermes")).toBe("infrastructure");
    expect(classifyFailureClass(null, "EACCES permission denied on safe.directory")).toBe(
      "infrastructure",
    );
    expect(classifyFailureClass(null, "getaddrinfo ENOTFOUND api.example.com")).toBe(
      "infrastructure",
    );
    expect(classifyFailureClass(null, "provider transport error")).toBe("infrastructure");
    expect(classifyFailureClass(null, "authorization denied by authz policy")).toBe(
      "infrastructure",
    );
    expect(classifyFailureClass(null, "publication failed during admission")).toBe(
      "infrastructure",
    );
    expect(
      classifyFailureClass({
        errorCode: null,
        error: null,
        resultJson: { code: "workspace_not_writable", message: "cannot write" },
      }),
    ).toBe("infrastructure");
  });

  it("classifies non-infra failures as reasoning", () => {
    expect(classifyFailureClass("adapter_failed")).toBe("reasoning");
    expect(classifyFailureClass(null, "model produced invalid JSON")).toBe("reasoning");
    expect(classifyFailureClass(null, "logic error in plan")).toBe("reasoning");
    expect(classifyFailureClass(null, null, null)).toBe("reasoning");
  });
});

describe("extractUsageTokens", () => {
  it("reads camelCase and snake_case aliases", () => {
    expect(
      extractUsageTokens({
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
      }),
    ).toEqual({ input: 100, cached: 40, output: 20, uncached: 60 });

    expect(
      extractUsageTokens({
        input_tokens: 50,
        cache_read_input_tokens: 10,
        output_tokens: 5,
      }),
    ).toEqual({ input: 50, cached: 10, output: 5, uncached: 40 });
  });

  it("clamps uncached to max(0, input - cached) and tolerates missing usage", () => {
    expect(extractUsageTokens({ inputTokens: 5, cachedInputTokens: 20 })).toEqual({
      input: 5,
      cached: 20,
      output: 0,
      uncached: 0,
    });
    expect(extractUsageTokens(null)).toEqual({ input: 0, cached: 0, output: 0, uncached: 0 });
    expect(extractUsageTokens({ usage: { input_tokens: 3, output_tokens: 1 } })).toEqual({
      input: 3,
      cached: 0,
      output: 1,
      uncached: 3,
    });
  });
});

describe("isAcceptedOrganizationalOutcome", () => {
  it("requires done status", () => {
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "in_progress" },
        [run({ id: "r1", status: "succeeded", resultJson: { summary: "shipped feature" } })],
      ),
    ).toBe(false);
  });

  it("accepts done + succeeded run with non-empty non-infra summary", () => {
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done" },
        [run({ id: "r1", status: "succeeded", resultJson: { summary: "Merged PR #12" } })],
      ),
    ).toBe(true);
  });

  it("accepts done + explicit review accept marker even without summary", () => {
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done" },
        [run({ id: "r1", status: "succeeded", resultJson: { reviewStatus: "accepted" } })],
      ),
    ).toBe(true);
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done" },
        [
          run({
            id: "r1",
            status: "failed",
            resultJson: { review: { status: "accepted" } },
          }),
        ],
      ),
    ).toBe(true);
  });

  it("rejects done + success that is infra-only or empty", () => {
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done" },
        [run({ id: "r1", status: "succeeded", resultJson: { summary: "workspace prepared" } })],
      ),
    ).toBe(false);
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done" },
        [run({ id: "r1", status: "succeeded", resultJson: { infraOnly: true, summary: "ok" } })],
      ),
    ).toBe(false);
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done" },
        [run({ id: "r1", status: "succeeded", resultJson: {} })],
      ),
    ).toBe(false);
  });

  it("rejects skill_test/ask probe outcomes from accepted organizational outcomes", () => {
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done", workMode: "skill_test" },
        [run({ id: "r1", status: "succeeded", resultJson: { summary: "probe passed", reviewStatus: "accepted" } })],
      ),
    ).toBe(false);
    expect(
      isAcceptedOrganizationalOutcome(
        { status: "done", workMode: "ask" },
        [run({ id: "r1", status: "succeeded", resultJson: { summary: "answered question" } })],
      ),
    ).toBe(false);
  });
});

describe("isTerminalMismatch", () => {
  it("is true when run succeeded but issue is still open", () => {
    expect(isTerminalMismatch({ status: "succeeded" }, { status: "in_progress" })).toBe(true);
    expect(isTerminalMismatch({ status: "succeeded" }, { status: "todo" })).toBe(true);
  });

  it("is false for done/cancelled issues, failed runs, or missing issue", () => {
    expect(isTerminalMismatch({ status: "succeeded" }, { status: "done" })).toBe(false);
    expect(isTerminalMismatch({ status: "succeeded" }, { status: "cancelled" })).toBe(false);
    expect(isTerminalMismatch({ status: "failed" }, { status: "in_progress" })).toBe(false);
    expect(isTerminalMismatch({ status: "succeeded" }, null)).toBe(false);
  });
});

describe("resolveScorecardWindow", () => {
  it("defaults to last 14 days ending at now when since/until omitted", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const { since, until } = resolveScorecardWindow({ now });
    expect(until.toISOString()).toBe(now.toISOString());
    expect(since.toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("honors explicit since/until", () => {
    const { since, until } = resolveScorecardWindow({
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-10T00:00:00.000Z",
    });
    expect(since.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(until.toISOString()).toBe("2026-07-10T00:00:00.000Z");
  });
});

describe("buildOutcomeScorecard", () => {
  it("produces a full scorecard distinguishing runtime success from accepted outcomes", () => {
    const issues: ScorecardIssue[] = [
      issue({ id: ISSUE_DONE, status: "done", createdAt: "2026-07-02T00:00:00.000Z" }),
      issue({ id: ISSUE_OPEN, status: "in_progress", createdAt: "2026-07-03T00:00:00.000Z" }),
      issue({
        id: ISSUE_DONE_NO_RUN,
        status: "done",
        createdAt: "2026-07-04T00:00:00.000Z",
        assigneeAgentId: "agent-2",
      }),
      issue({
        id: ISSUE_ASSIGNED,
        status: "todo",
        createdAt: "2026-07-08T00:00:00.000Z",
        assigneeAgentId: "agent-3",
      }),
    ];

    const runs: ScorecardRun[] = [
      // Accepted organizational outcome: done + success with summary.
      run({
        id: "run-success-done",
        status: "succeeded",
        issueId: ISSUE_DONE,
        createdAt: "2026-07-06T10:00:00.000Z",
        resultJson: { summary: "Shipped the outcome scorecard API" },
        usageJson: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 },
      }),
      // Terminal mismatch: runtime success, issue not done.
      run({
        id: "run-success-open",
        status: "succeeded",
        issueId: ISSUE_OPEN,
        createdAt: "2026-07-07T10:00:00.000Z",
        resultJson: { summary: "partial work" },
        usageJson: { input_tokens: 500, cache_read_input_tokens: 100, output_tokens: 50 },
      }),
      // Infrastructure failure.
      run({
        id: "run-fail-infra",
        status: "failed",
        issueId: ISSUE_OPEN,
        createdAt: "2026-07-07T11:00:00.000Z",
        errorCode: "workspace_preparation_failed",
        error: "safe.directory not trusted",
        usageJson: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0 },
      }),
      // Reasoning failure.
      run({
        id: "run-fail-reason",
        status: "failed",
        issueId: ISSUE_OPEN,
        createdAt: "2026-07-07T12:00:00.000Z",
        errorCode: "adapter_failed",
        error: "model hallucinated invalid plan",
        usageJson: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 },
      }),
      // Cancelled run.
      run({
        id: "run-cancelled",
        status: "cancelled",
        issueId: ISSUE_OPEN,
        createdAt: "2026-07-07T13:00:00.000Z",
      }),
      // Outside window — ignored.
      run({
        id: "run-old",
        status: "succeeded",
        issueId: ISSUE_DONE,
        createdAt: "2026-06-01T00:00:00.000Z",
        resultJson: { summary: "old success" },
        usageJson: { inputTokens: 9999, cachedInputTokens: 0, outputTokens: 9999 },
      }),
    ];

    const scorecard = buildOutcomeScorecard({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      runs,
      issues,
    });

    // Example fixture JSON for WO return payload / docs.
    expect(scorecard).toEqual({
      window: {
        since: "2026-07-01T00:00:00.000Z",
        until: "2026-07-15T00:00:00.000Z",
      },
      companyId: COMPANY_ID,
      runs: {
        total: 5,
        succeeded: 2,
        failed: 2,
        cancelled: 1,
        other: 0,
        retries: 0,
        successfulNoModelRuns: 0,
        freshSessionRuns: 0,
        providerUnavailableRuns: 0,
      },
      outcomes: {
        // ISSUE_DONE (run), ISSUE_OPEN (run), ISSUE_DONE_NO_RUN (created+assigned),
        // ISSUE_ASSIGNED (created+assigned)
        admitted: 4,
        acceptedOutcomes: 1,
        probeOutcomes: 0,
        runtimeSuccessNotDone: 1,
        // ISSUE_DONE_NO_RUN is done with no success run in window
        doneWithoutSuccessRun: 1,
      },
      failures: {
        infrastructure: 1,
        reasoning: 1,
        infraFailureShare: 0.5,
      },
      economics: {
        totalInputTokens: 1530,
        totalCachedInputTokens: 305,
        totalUncachedInputTokens: 1225,
        totalOutputTokens: 160,
        totalModelTokens: 1690,
        cacheAdjustedTokens: 1385,
        uncachedInputTokensPerAcceptedOutcome: 1225,
        outputTokensPerAcceptedOutcome: 160,
        totalModelTokensPerAcceptedOutcome: 1690,
        cacheAdjustedTokensPerAcceptedOutcome: 1385,
      },
      workforce: {
        humanInterventions: 0,
        humanInterventionsPerAcceptedOutcome: 0,
      },
      delivery: {
        meanAcceptedLeadTimeSeconds: null,
        p50AcceptedLeadTimeSeconds: null,
      },
      rates: {
        runtimeSuccessRate: 2 / 5,
        admittedToAcceptedRate: 1 / 4,
        terminalMismatchRate: 1 / 2,
        retryRate: 0,
        successfulNoModelRunRate: 0,
        freshSessionRate: 0,
      },
    });
  });

  it("returns null rates and zeroed counters for an empty window", () => {
    const scorecard = buildOutcomeScorecard({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      runs: [],
      issues: [],
    });

    expect(scorecard.runs.total).toBe(0);
    expect(scorecard.outcomes.admitted).toBe(0);
    expect(scorecard.outcomes.acceptedOutcomes).toBe(0);
    expect(scorecard.failures.infraFailureShare).toBeNull();
    expect(scorecard.economics.uncachedInputTokensPerAcceptedOutcome).toBeNull();
    expect(scorecard.rates.runtimeSuccessRate).toBeNull();
    expect(scorecard.rates.admittedToAcceptedRate).toBeNull();
    expect(scorecard.rates.terminalMismatchRate).toBeNull();
    expect(scorecard.rates.retryRate).toBeNull();
    expect(scorecard.workforce.humanInterventionsPerAcceptedOutcome).toBeNull();
    expect(scorecard.delivery.p50AcceptedLeadTimeSeconds).toBeNull();
  });

  it("measures retries, no-model runs, fresh sessions, interventions, and accepted lead time", () => {
    const completedAt = "2026-07-06T00:00:00.000Z";
    const scorecard = buildOutcomeScorecard({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      humanInterventions: 2,
      issues: [issue({
        id: ISSUE_DONE,
        status: "done",
        createdAt: "2026-07-05T00:00:00.000Z",
        completedAt,
      })],
      runs: [
        run({
          id: "run-no-model",
          status: "succeeded",
          issueId: ISSUE_DONE,
          retryOfRunId: "prior-run",
          contextSnapshot: { wakeReason: "issue_assigned", issueId: ISSUE_DONE },
          sessionIdBefore: null,
          sessionIdAfter: "session-1",
          resultJson: {
            summary: "Merged accepted change",
            providerInvocationAttempted: false,
          },
          usageJson: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
        }),
        run({
          id: "run-provider-down",
          status: "failed",
          issueId: ISSUE_DONE,
          errorCode: "provider_unavailable",
        }),
      ],
    });

    expect(scorecard.runs).toMatchObject({
      total: 2,
      retries: 1,
      successfulNoModelRuns: 1,
      freshSessionRuns: 1,
      providerUnavailableRuns: 1,
    });
    expect(scorecard.economics).toMatchObject({
      totalModelTokens: 120,
      cacheAdjustedTokens: 80,
      totalModelTokensPerAcceptedOutcome: 120,
      cacheAdjustedTokensPerAcceptedOutcome: 80,
    });
    expect(scorecard.workforce).toEqual({
      humanInterventions: 2,
      humanInterventionsPerAcceptedOutcome: 2,
    });
    expect(scorecard.delivery).toEqual({
      meanAcceptedLeadTimeSeconds: 86_400,
      p50AcceptedLeadTimeSeconds: 86_400,
    });
    expect(scorecard.rates).toMatchObject({
      retryRate: 0.5,
      successfulNoModelRunRate: 0.5,
      freshSessionRate: 0.5,
    });
  });

  it("measures fresh sessions only from durable before/after session evidence", () => {
    const scorecard = buildOutcomeScorecard({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      issues: [],
      runs: [
        run({
          id: "wake-intent-only",
          status: "succeeded",
          contextSnapshot: { wakeReason: "issue_assigned", forceFreshSession: true },
          sessionIdBefore: null,
          sessionIdAfter: null,
        }),
        run({
          id: "reused-session",
          status: "succeeded",
          sessionIdBefore: "session-a",
          sessionIdAfter: "session-a",
        }),
        run({
          id: "observed-fresh-session",
          status: "succeeded",
          sessionIdBefore: "session-a",
          sessionIdAfter: "session-b",
        }),
      ],
    });

    expect(scorecard.runs.freshSessionRuns).toBe(1);
    expect(scorecard.rates.freshSessionRate).toBe(1 / 3);
  });

  it("classifies corrective human intervention without counting ordinary user activity", () => {
    expect(isHumanInterventionActivity({ action: "issue.created", details: {} })).toBe(false);
    expect(isHumanInterventionActivity({ action: "issue.comment_added", details: {} })).toBe(false);
    expect(isHumanInterventionActivity({
      action: "issue.updated",
      details: { title: "copy edit", _previous: { title: "old" } },
    })).toBe(false);
    expect(isHumanInterventionActivity({
      action: "issue.updated",
      details: { status: "todo", _previous: { status: "blocked" } },
    })).toBe(true);
    expect(isHumanInterventionActivity({ action: "issue.admin_force_release", details: {} })).toBe(true);
    expect(countHumanInterventions([
      {
        action: "issue.updated",
        details: {
          status: "todo",
          source: "recovery_action_resolution",
          recoveryActionId: "recovery-1",
          _previous: { status: "blocked" },
        },
      },
      {
        action: "issue.recovery_action_resolved",
        details: { recoveryActionId: "recovery-1" },
      },
    ])).toBe(1);
    expect(isHumanInterventionActivity({
      action: "issue.updated",
      details: { executionState: "ready", _previous: { executionState: "planning" } },
    })).toBe(true);
    expect(isHumanInterventionActivity({ action: "issue.thread_interaction_accepted", details: {} })).toBe(true);
  });

  it("counts created+assigned issues as admitted even without runs", () => {
    const scorecard = buildOutcomeScorecard({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      runs: [],
      issues: [
        issue({
          id: ISSUE_ASSIGNED,
          status: "todo",
          createdAt: "2026-07-08T00:00:00.000Z",
          assigneeAgentId: "agent-3",
        }),
        issue({
          id: "unassigned",
          status: "todo",
          createdAt: "2026-07-08T00:00:00.000Z",
          assigneeAgentId: null,
          assigneeUserId: null,
        }),
      ],
    });
    expect(scorecard.outcomes.admitted).toBe(1);
  });

  it("resolves issueId from contextSnapshot when issueId field is absent", () => {
    const scorecard = buildOutcomeScorecard({
      companyId: COMPANY_ID,
      since: WINDOW_SINCE,
      until: WINDOW_UNTIL,
      runs: [
        run({
          id: "run-ctx",
          status: "succeeded",
          createdAt: "2026-07-06T10:00:00.000Z",
          contextSnapshot: { issueId: ISSUE_OPEN },
          resultJson: { summary: "worked" },
        }),
      ],
      issues: [issue({ id: ISSUE_OPEN, status: "in_progress" })],
    });
    expect(scorecard.outcomes.admitted).toBe(1);
    expect(scorecard.outcomes.runtimeSuccessNotDone).toBe(1);
  });
});
