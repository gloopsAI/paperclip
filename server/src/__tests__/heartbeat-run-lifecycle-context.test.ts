import { describe, expect, it } from "vitest";
import { runLifecycleContextCoordinates } from "../services/heartbeat.js";

describe("run lifecycle plugin-event context coordinates", () => {
  it("carries issue and runtime execution-workspace identity", () => {
    expect(
      runLifecycleContextCoordinates({
        issueId: "issue-1",
        executionWorkspaceId: "workspace-1",
        unrelated: "ignored",
      }),
    ).toEqual({
      issueId: "issue-1",
      executionWorkspaceId: "workspace-1",
    });
  });

  it.each([
    null,
    undefined,
    "not-an-object",
    {},
    { issueId: "" },
    { issueId: 1, executionWorkspaceId: false },
  ])("fails closed for absent or invalid coordinates: %j", (contextSnapshot) => {
    expect(runLifecycleContextCoordinates(contextSnapshot)).toEqual({
      issueId: null,
      executionWorkspaceId: null,
    });
  });

  it("preserves a valid coordinate when the other is invalid", () => {
    expect(
      runLifecycleContextCoordinates({
        issueId: "issue-1",
        executionWorkspaceId: " ",
      }),
    ).toEqual({
      issueId: "issue-1",
      executionWorkspaceId: null,
    });
  });
});
