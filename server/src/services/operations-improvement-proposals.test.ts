import { describe, expect, it } from "vitest";
import {
  buildOperationsImprovementStewardWake,
  buildOperationsImprovementProposal,
  classifyOperationsAnomaly,
  operationsImprovementOwnerForReason,
  operationsImprovementFingerprint,
  selectOperationsImprovementStewardAgentId,
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
    expect(proposal.workMode).toBe("ask");
    expect(proposal.executionWorkspacePreference).toBe("agent_default");
    expect(proposal.executionWorkspaceSettings).toMatchObject({ mode: "agent_default" });
    expect(proposal.assigneeAdapterOverrides).toMatchObject({
      useProjectWorkspace: false,
      adapterConfig: { worktreeMode: false },
    });
    expect(proposal.executionPolicy).toMatchObject({
      completionProfile: "direct",
      resourceBudget: {
        maxRunsPerTask: 1,
        maxRetriesPerTask: 0,
        maxInputTokensPerInvocation: 50_000,
        maxTurnsPerInvocation: 4,
        maxToolCallsPerInvocation: 5,
      },
    });
    expect(proposal.description).toContain("Use only the evidence in this issue");
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

  it("routes capacity failures and token-economics defects to distinct event owners", () => {
    expect(operationsImprovementOwnerForReason("work_preparation_denied")).toBe("capacity");
    expect(operationsImprovementOwnerForReason("provider_run_failed")).toBe("capacity");
    expect(operationsImprovementOwnerForReason("terminal_usage_missing")).toBe("token_economics");
    expect(operationsImprovementOwnerForReason("execution_budget_exhausted")).toBe("token_economics");

    expect(selectOperationsImprovementStewardAgentId({
      run: {
        id: "run-capacity",
        companyId: "company-1",
        status: "failed",
        errorCode: "work_preparation.denied",
      },
      capacityManagerAgentId: "capacity-manager",
      tokenEconomicsStewardAgentId: "token-steward",
      legacyStewardAgentId: "legacy-steward",
    })).toBe("capacity-manager");

    expect(selectOperationsImprovementStewardAgentId({
      run: {
        id: "run-token",
        companyId: "company-1",
        status: "failed",
        errorCode: "max_input_tokens_exceeded",
      },
      capacityManagerAgentId: "capacity-manager",
      tokenEconomicsStewardAgentId: "token-steward",
      legacyStewardAgentId: "legacy-steward",
    })).toBe("token-steward");
  });

  it("preserves the generic steward as a backwards-compatible fallback", () => {
    expect(selectOperationsImprovementStewardAgentId({
      run: {
        id: "run-legacy",
        companyId: "company-1",
        status: "failed",
        errorCode: "max_turns_exceeded",
      },
      legacyStewardAgentId: "legacy-steward",
    })).toBe("legacy-steward");
  });

  it("builds one stable steward wake only for a newly created assigned proposal", () => {
    const wake = buildOperationsImprovementStewardWake({
      proposalResult: { kind: "created", issueId: "proposal-1" },
      stewardAgentId: "steward-1",
    });

    expect(wake).toMatchObject({
      agentId: "steward-1",
      options: {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: "proposal-1" },
        idempotencyKey: "operations-improvement-proposal:proposal-1",
      },
    });
    expect(buildOperationsImprovementStewardWake({
      proposalResult: { kind: "existing", issueId: "proposal-1" },
      stewardAgentId: "steward-1",
    })).toBeNull();
    expect(buildOperationsImprovementStewardWake({
      proposalResult: { kind: "created", issueId: "proposal-1" },
      stewardAgentId: null,
    })).toBeNull();
  });
});
