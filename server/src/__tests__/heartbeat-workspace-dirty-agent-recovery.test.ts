import { describe, expect, it } from "vitest";
import {
  isStaleDirtyWorkspaceAgentErrorReason,
  resolveFinalizedAgentStatus,
} from "../services/heartbeat.js";

describe("isStaleDirtyWorkspaceAgentErrorReason (WG-PLAT-005)", () => {
  it("classifies representative dirty-workspace failure messages", () => {
    expect(isStaleDirtyWorkspaceAgentErrorReason("Workspace contains uncommitted or untracked changes."))
      .toBe(true);
    expect(isStaleDirtyWorkspaceAgentErrorReason("workspace contains uncommitted or untracked changes"))
      .toBe(true);
    expect(
      isStaleDirtyWorkspaceAgentErrorReason(
        "Workspace validation failed for issue PAP-1: workspace has dirty/uncommitted changes",
      ),
    ).toBe(true);
  });

  it("does not classify unrelated or other workspace-validation failures as the dirty family", () => {
    expect(isStaleDirtyWorkspaceAgentErrorReason(null)).toBe(false);
    expect(isStaleDirtyWorkspaceAgentErrorReason("")).toBe(false);
    expect(isStaleDirtyWorkspaceAgentErrorReason("adapter crashed with exit code 1")).toBe(false);
    expect(
      isStaleDirtyWorkspaceAgentErrorReason(
        "Workspace validation failed: base workspace is not a git checkout.",
      ),
    ).toBe(false);
  });
});

describe("resolveFinalizedAgentStatus (WG-PLAT-005)", () => {
  it("keeps the agent idle on failure when keepIdleOnFailure is set (issue-scoped dirty-workspace family)", () => {
    expect(
      resolveFinalizedAgentStatus({
        outcome: "failed",
        runningCount: 0,
        keepIdleOnFailure: true,
      }),
    ).toBe("idle");
  });

  it("errors the agent on failure when keepIdleOnFailure is not set, so the guard is not weakened for other failures", () => {
    expect(
      resolveFinalizedAgentStatus({
        outcome: "failed",
        runningCount: 0,
        keepIdleOnFailure: false,
      }),
    ).toBe("error");
    expect(
      resolveFinalizedAgentStatus({
        outcome: "failed",
        runningCount: 0,
      }),
    ).toBe("error");
  });

  it("running takes priority over any failure outcome", () => {
    expect(
      resolveFinalizedAgentStatus({
        outcome: "failed",
        runningCount: 1,
        keepIdleOnFailure: true,
      }),
    ).toBe("running");
  });

  it("preserves existing succeeded/interrupted/cancelled -> idle behavior", () => {
    for (const outcome of ["succeeded", "interrupted", "cancelled"] as const) {
      expect(resolveFinalizedAgentStatus({ outcome, runningCount: 0 })).toBe("idle");
    }
  });

  it("preserves existing timed_out -> error behavior (not part of the dirty-workspace carve-out)", () => {
    expect(
      resolveFinalizedAgentStatus({
        outcome: "timed_out",
        runningCount: 0,
        keepIdleOnFailure: true,
      }),
    ).toBe("error");
  });
});
