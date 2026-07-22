import { describe, expect, it } from "vitest";
import { compileExecutionVerification } from "./execution-context-verification.js";

describe("compileExecutionVerification", () => {
  it("does not invent repository verification for direct tasks", () => {
    expect(compileExecutionVerification({ completionProfile: "direct", exactHeadSha: "abc123" }))
      .toEqual({
        cursor: "complete only the declared task, report the result, and record terminal disposition; do not invent code, git, test, review, or exact-head work",
      });
  });

  it("retains exact-head verification for change tasks and legacy policies", () => {
    expect(compileExecutionVerification({ completionProfile: "verified_change", exactHeadSha: "abc123" }))
      .toEqual({
        exactHeadSha: "abc123",
        cursor: "verify exact head, run focused checks, and record terminal disposition before completion",
      });
    expect(compileExecutionVerification({ exactHeadSha: "legacy" }).exactHeadSha).toBe("legacy");
  });
});
