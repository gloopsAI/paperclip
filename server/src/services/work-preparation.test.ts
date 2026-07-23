import { describe, expect, it } from "vitest";
import {
  buildBoundExecutionContext,
  buildCanonicalContinuationPacket,
  type ExecutionInvocationBudget,
} from "@paperclipai/adapter-utils/execution-envelope";
import { assessWorkPreparation } from "./work-preparation.js";

function context() {
  return buildBoundExecutionContext(buildCanonicalContinuationPacket({
    issue: { id: "issue-1", identifier: "GLO-1", title: "Implement a bounded change" },
    repoRef: { repoUrl: "https://github.com/gloopsAI/paperclip.git", repoRef: "abc123", cwd: "/workspace" },
    authority: { companyId: "company-1", assigneeAgentId: "agent-1", runId: "run-1" },
  }));
}

function budget(overrides: Partial<ExecutionInvocationBudget> = {}): ExecutionInvocationBudget {
  return {
    schemaVersion: "paperclip.provider-invocation-budget.v1",
    budgetId: "budget-1",
    reservationId: "reservation-1",
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
    maxTurns: 10,
    maxToolCalls: 20,
    maxWallMs: 300_000,
    fixedOverheadInputTokens: 2_000,
    discretionaryInputTokens: 18_000,
    ...overrides,
  };
}

describe("assessWorkPreparation", () => {
  it("admits a valid packet, exact repository workspace, and sufficient reservation", () => {
    const receipt = assessWorkPreparation({
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "GLO-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      model: "kimi-k2.7-code",
      executionContext: context(),
      invocationBudget: budget(),
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
      },
      evaluatedAt: new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(receipt.decision).toBe("ready");
    expect(receipt.fatalReasons).toEqual([]);
    expect(receipt.packet.valid).toBe(true);
    expect(receipt.workspace.ready).toBe(true);
    expect(receipt.reservation.ready).toBe(true);
    expect(receipt.skills).toEqual({
      required: [],
      available: [],
      missing: [],
      ready: true,
    });
  });

  it("denies before provider execution when packet, workspace, and reservation are invalid", () => {
    const receipt = assessWorkPreparation({
      runId: "run-2",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: { schemaVersion: "wrong" },
      invocationBudget: budget({ maxInputTokens: 1_000, discretionaryInputTokens: 500 }),
      workspace: { required: true, cwd: null, repoUrl: null, repoRef: null },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toEqual(expect.arrayContaining([
      "execution_context_packet_invalid",
      "workspace_cwd_missing",
      "workspace_repo_url_missing",
      "workspace_repo_ref_missing",
      "input_reservation_insufficient",
    ]));
  });

  it("does not turn an unscoped manual heartbeat into prepared task work", () => {
    const receipt = assessWorkPreparation({
      runId: "run-manual",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      required: false,
      executionContext: null,
      invocationBudget: null,
      workspace: { required: false, cwd: "/agent-home" },
    });

    expect(receipt.decision).toBe("ready");
    expect(receipt.required).toBe(false);
    expect(receipt.fatalReasons).toEqual([]);
  });

  it("admits explicitly required skills only when their runtime sources are available", () => {
    const receipt = assessWorkPreparation({
      runId: "run-skills-ready",
      issueId: "issue-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget(),
      workspace: { required: false, cwd: "/workspace" },
      skills: {
        mentionedKeys: ["company/git-ops", "company/sql-agent"],
        runtimeEntries: [
          { key: "company/git-ops", sourceStatus: "available" },
          { key: "company/sql-agent", sourceStatus: "available" },
        ],
      },
    });

    expect(receipt.decision).toBe("ready");
    expect(receipt.skills).toEqual({
      required: ["company/git-ops", "company/sql-agent"],
      available: ["company/git-ops", "company/sql-agent"],
      missing: [],
      ready: true,
    });
  });

  it("denies provider execution when an explicitly required skill is unavailable", () => {
    const receipt = assessWorkPreparation({
      runId: "run-skills-missing",
      issueId: "issue-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget(),
      workspace: { required: false, cwd: "/workspace" },
      skills: {
        mentionedKeys: ["company/git-ops", "company/sql-agent"],
        runtimeEntries: [
          { key: "company/git-ops", sourceStatus: "available" },
          { key: "company/sql-agent", sourceStatus: "missing" },
        ],
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("required_skill_unavailable");
    expect(receipt.skills).toEqual({
      required: ["company/git-ops", "company/sql-agent"],
      available: ["company/git-ops"],
      missing: ["company/sql-agent"],
      ready: false,
    });
  });
});
