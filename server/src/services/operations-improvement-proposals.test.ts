import { describe, expect, it } from "vitest";
import {
  buildOperationsImprovementProposal,
  classifyOperationsAnomaly,
  operationsImprovementFingerprint,
} from "./operations-improvement-proposals.js";

describe("operations improvement proposals", () => {
  it("stays silent for a clean provider-backed success with usage", () => {
    expect(classifyOperationsAnomaly({
      id: "run-1",
      companyId: "company-1",
      status: "succeeded",
      usageJson: { inputTokens: 100, outputTokens: 20 },
      resultJson: { providerInvocationAttempted: true },
    })).toBeNull();
  });

  it("classifies preparation denial and renders an advisory-only proposal", () => {
    const run = {
      id: "run-2",
      companyId: "company-1",
      status: "failed",
      errorCode: "work_preparation.denied",
      error: "workspace_repo_ref_missing",
      resultJson: { providerInvocationAttempted: false },
    };
    const candidate = classifyOperationsAnomaly(run);
    expect(candidate).toMatchObject({ reason: "work_preparation_denied", severity: "high" });

    const proposal = buildOperationsImprovementProposal({
      sourceIssue: { id: "issue-1", identifier: "GLO-1", title: "Test work" },
      run,
      candidate: candidate!,
    });
    expect(proposal.title).toContain("work_preparation_denied");
    expect(proposal.description).toContain("Do not modify code");
  });

  it("uses a stable source-and-reason fingerprint for deduplication", () => {
    const input = {
      companyId: "company-1",
      sourceIssueId: "issue-1",
      reason: "provider_run_failed" as const,
    };
    expect(operationsImprovementFingerprint(input)).toBe(operationsImprovementFingerprint(input));
    expect(operationsImprovementFingerprint(input)).not.toBe(operationsImprovementFingerprint({
      ...input,
      reason: "execution_budget_exhausted",
    }));
  });
});

