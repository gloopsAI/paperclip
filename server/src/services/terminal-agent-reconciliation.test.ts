import { describe, expect, it } from "vitest";
import { decideTerminalAgentTruth } from "./terminal-agent-reconciliation.js";

describe("decideTerminalAgentTruth", () => {
  it("clears a reasonless stale error after a successful terminal run", () => {
    expect(decideTerminalAgentTruth({
      agentStatus: "error",
      errorReason: null,
      activeRunCount: 0,
      activeAssignmentCount: 0,
      latestRunStatus: "succeeded",
      latestRunIssueStatus: "done",
    })).toEqual({ kind: "clear_error", reason: "successful_terminal_run" });
  });

  it("clears a failed run only after its work was terminally superseded", () => {
    expect(decideTerminalAgentTruth({
      agentStatus: "error",
      errorReason: null,
      activeRunCount: 0,
      activeAssignmentCount: 0,
      latestRunStatus: "failed",
      latestRunIssueStatus: "cancelled",
    })).toEqual({ kind: "clear_error", reason: "terminal_work_superseded" });
  });

  it("preserves a current failure, active work, or an actionable error reason", () => {
    expect(decideTerminalAgentTruth({
      agentStatus: "error",
      errorReason: null,
      activeRunCount: 0,
      activeAssignmentCount: 0,
      latestRunStatus: "failed",
      latestRunIssueStatus: "in_progress",
    })).toEqual({ kind: "preserve", reason: "latest_failure_unresolved" });
    expect(decideTerminalAgentTruth({
      agentStatus: "error",
      errorReason: null,
      activeRunCount: 1,
      activeAssignmentCount: 0,
      latestRunStatus: "succeeded",
      latestRunIssueStatus: "done",
    })).toEqual({ kind: "preserve", reason: "active_run_present" });
    expect(decideTerminalAgentTruth({
      agentStatus: "error",
      errorReason: "OAuth expired",
      activeRunCount: 0,
      activeAssignmentCount: 0,
      latestRunStatus: "succeeded",
      latestRunIssueStatus: "done",
    })).toEqual({ kind: "preserve", reason: "error_reason_present" });
  });
});
