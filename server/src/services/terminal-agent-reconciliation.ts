export type TerminalAgentTruthDecision =
  | { kind: "clear_error"; reason: "successful_terminal_run" | "terminal_work_superseded" }
  | {
      kind: "preserve";
      reason:
        | "agent_not_in_error"
        | "error_reason_present"
        | "active_run_present"
        | "active_assignment_present"
        | "missing_terminal_run"
        | "latest_failure_unresolved";
    };

export function decideTerminalAgentTruth(input: {
  agentStatus: string;
  errorReason: string | null;
  activeRunCount: number;
  activeAssignmentCount: number;
  latestRunStatus: string | null;
  latestRunIssueStatus: string | null;
}): TerminalAgentTruthDecision {
  if (input.agentStatus !== "error") {
    return { kind: "preserve", reason: "agent_not_in_error" };
  }
  if (input.errorReason?.trim()) {
    return { kind: "preserve", reason: "error_reason_present" };
  }
  if (input.activeRunCount > 0) {
    return { kind: "preserve", reason: "active_run_present" };
  }
  if (input.activeAssignmentCount > 0) {
    return { kind: "preserve", reason: "active_assignment_present" };
  }
  if (!input.latestRunStatus) {
    return { kind: "preserve", reason: "missing_terminal_run" };
  }
  if (["succeeded", "interrupted", "cancelled"].includes(input.latestRunStatus)) {
    return { kind: "clear_error", reason: "successful_terminal_run" };
  }
  if (
    ["failed", "timed_out"].includes(input.latestRunStatus) &&
    ["done", "cancelled"].includes(input.latestRunIssueStatus ?? "")
  ) {
    return { kind: "clear_error", reason: "terminal_work_superseded" };
  }
  return { kind: "preserve", reason: "latest_failure_unresolved" };
}
