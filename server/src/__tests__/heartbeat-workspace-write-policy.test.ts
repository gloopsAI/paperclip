import { describe, expect, it } from "vitest";
import {
  isRetryableInteractionContinuationInfrastructureFailure,
  isWorkspaceNotWritableFailedRun,
  isWorkspaceNotWritableFailure,
} from "../services/heartbeat.ts";

describe("workspace write policy failure routing", () => {
  it("recognizes only a typed pre-provider workspace failure", () => {
    expect(isWorkspaceNotWritableFailure({
      code: "workspace_not_writable",
      providerInvocationAttempted: false,
    })).toBe(true);
    expect(isWorkspaceNotWritableFailure({
      code: "workspace_not_writable",
      providerInvocationAttempted: true,
    })).toBe(false);
    expect(isWorkspaceNotWritableFailure({
      code: "workspace_not_writable",
    })).toBe(false);
  });

  it("routes the terminal run as blocked and never as an automatic infrastructure retry", () => {
    const run = {
      error: "workspace preflight failed",
      errorCode: "workspace_not_writable",
      resultJson: {
        provider_invocation: { attempted: false },
        workspaceWritePreflight: { status: "failed", code: "workspace_not_writable" },
      },
    };
    expect(isWorkspaceNotWritableFailedRun(run)).toBe(true);
    expect(isRetryableInteractionContinuationInfrastructureFailure(run)).toBe(false);
  });
});
