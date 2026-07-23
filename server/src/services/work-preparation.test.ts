import { describe, expect, it } from "vitest";
import {
  buildBoundExecutionContext,
  buildCanonicalContinuationPacket,
  buildExecutionPhaseBudgetPlan,
  type ExecutionInvocationBudget,
} from "@paperclipai/adapter-utils/execution-envelope";
import {
  assessWorkPreparation,
  resolveWorkPreparationCapabilities,
} from "./work-preparation.js";

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
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: true,
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
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
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
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
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

  // New tests for GLO-1368

  it("splits when packet + overhead exceeds model context but no fatal defects exist", () => {
    const receipt = assessWorkPreparation({
      runId: "run-split-capacity",
      issueId: "issue-1",
      issueIdentifier: "GLO-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: true,
      },
      capacity: {
        // totalRequired = packetTokens + overheadTokens + 4000 min discretionary
        // budget fixedOverheadInputTokens = 2000, so overheadTokens = 2000
        // set context window to something tiny so totalRequired > modelContextTokens
        modelContextTokens: 100,
      },
    });

    expect(receipt.decision).toBe("split");
    expect(receipt.fatalReasons).toEqual([]);
    expect(receipt.splitReasons).toContain("model_context_capacity_insufficient");
    expect(receipt.capacity.fits).toBe(false);
  });

  it("denies (not splits) when capacity is exceeded AND a required tool is missing", () => {
    const receipt = assessWorkPreparation({
      runId: "run-deny-over-split",
      issueId: "issue-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: true,
      },
      tools: {
        mentionedKeys: ["company/missing-tool"],
        runtimeEntries: [
          { key: "company/missing-tool", sourceStatus: "missing" },
        ],
      },
      capacity: {
        modelContextTokens: 100,
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("required_tool_unavailable");
    expect(receipt.splitReasons).toContain("model_context_capacity_insufficient");
  });

  it("denies when a required tool is not available", () => {
    const receipt = assessWorkPreparation({
      runId: "run-tool-missing",
      issueId: "issue-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      workspace: { required: false, cwd: "/workspace" },
      tools: {
        mentionedKeys: ["company/code-search", "company/browser"],
        runtimeEntries: [
          { key: "company/code-search", sourceStatus: "available" },
          { key: "company/browser", sourceStatus: "missing" },
        ],
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("required_tool_unavailable");
    expect(receipt.tools).toEqual({
      required: ["company/browser", "company/code-search"],
      available: ["company/code-search"],
      missing: ["company/browser"],
      ready: false,
    });
  });

  it("denies when workspace is explicitly marked not-writable and required", () => {
    const receipt = assessWorkPreparation({
      runId: "run-not-writable",
      issueId: "issue-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: false,
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("workspace_not_writable");
  });

  it("denies when phase budget plan is missing for an issue-backed run", () => {
    const receipt = assessWorkPreparation({
      runId: "run-no-phase-plan",
      issueId: "issue-1",
      issueIdentifier: "GLO-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget(), // no phasePlan
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: true,
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("phase_budget_plan_missing");
    expect(receipt.phaseBudget.present).toBe(false);
    expect(receipt.phaseBudget.ready).toBe(false);
  });

  it("denies when a phase budget has zero turns", () => {
    const receipt = assessWorkPreparation({
      runId: "run-zero-turns",
      issueId: "issue-1",
      issueIdentifier: "GLO-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 0, toolCalls: 20, wallMs: 300_000 }),
      }),
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: true,
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("phase_budget_insufficient");
    expect(receipt.phaseBudget.present).toBe(true);
    expect(receipt.phaseBudget.ready).toBe(false);
  });

  it("denies when packet exceeds configured byte limit", () => {
    const receipt = assessWorkPreparation({
      runId: "run-byte-limit",
      issueId: "issue-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      workspace: { required: false, cwd: "/workspace" },
      packetLimits: {
        maxBytes: 1, // impossibly small
      },
    });

    expect(receipt.decision).toBe("denied");
    expect(receipt.fatalReasons).toContain("packet_byte_limit_exceeded");
  });

  it("admits when phase plan is present and all phases are sufficient", () => {
    const receipt = assessWorkPreparation({
      runId: "run-phase-ok",
      issueId: "issue-1",
      issueIdentifier: "GLO-1",
      agentId: "agent-1",
      adapterType: "hermes_gateway",
      executionContext: context(),
      invocationBudget: budget({
        phasePlan: buildExecutionPhaseBudgetPlan({ inputTokens: 20_000, outputTokens: 4_000, turns: 10, toolCalls: 20, wallMs: 300_000 }),
      }),
      assignment: { implementation: true },
      workspace: {
        required: true,
        cwd: "/workspace",
        repoUrl: "https://github.com/gloopsAI/paperclip.git",
        repoRef: "abc123",
        writable: true,
      },
    });

    expect(receipt.decision).toBe("ready");
    expect(receipt.fatalReasons).toEqual([]);
    expect(receipt.phaseBudget.present).toBe(true);
    expect(receipt.phaseBudget.ready).toBe(true);
  });

  it("defaults implementation work to file and terminal tools on unrestricted Hermes", () => {
    expect(resolveWorkPreparationCapabilities({
      adapterType: "hermes_gateway",
      runtimeConfig: {},
      implementation: true,
    })).toEqual({
      requiredTools: ["file", "terminal"],
      availableTools: [
        "terminal",
        "file",
        "web",
        "browser",
        "code_execution",
        "vision",
        "mcp",
        "creative",
        "productivity",
      ],
      modelContextTokens: null,
      splitAllowed: true,
    });
  });

  it("detects a restricted Hermes toolset and explicit model context ceiling", () => {
    expect(resolveWorkPreparationCapabilities({
      adapterType: "hermes_gateway",
      runtimeConfig: {
        toolsets: "web,file",
        modelContextTokens: 16_000,
      },
      issueAdapterConfig: {
        paperclipRequiredToolsets: ["file", "terminal"],
        paperclipSplitOversizedAssignments: false,
      },
      implementation: true,
    })).toEqual({
      requiredTools: ["file", "terminal"],
      availableTools: ["file", "web"],
      modelContextTokens: 16_000,
      splitAllowed: false,
    });
  });
});
