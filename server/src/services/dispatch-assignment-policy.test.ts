import { describe, expect, it } from "vitest";
import {
  DISPATCH_ASSIGN_REASON,
  evaluateDispatchAssignment,
  evaluateDispatchWake,
  findExactHeadSha,
  getDispatchAssignMode,
  isDispatchActor,
} from "./dispatch-assignment-policy.js";

const enforce = { PAPERCLIP_DISPATCH_ASSIGN_POLICY: "enforce" };
const SHA = "c2435bb0a88d26b73dc2b3d26abd0bc406076dd3";

describe("getDispatchAssignMode", () => {
  it("defaults enforce outside tests", () => {
    expect(getDispatchAssignMode({ PAPERCLIP_DISPATCH_ASSIGN_POLICY: "" })).toBe("enforce");
  });
  it("off under vitest when unset", () => {
    expect(getDispatchAssignMode({ VITEST: "true" })).toBe("off");
  });
});

describe("isDispatchActor", () => {
  it("matches name Dispatch", () => {
    expect(
      isDispatchActor({ actorType: "agent", actorAgentName: "Dispatch", env: enforce }),
    ).toBe(true);
  });
  it("does not match Northstar pm", () => {
    expect(
      isDispatchActor({
        actorType: "agent",
        actorAgentName: "Northstar",
        actorAgentRole: "pm",
        env: enforce,
      }),
    ).toBe(false);
  });
});

describe("evaluateDispatchAssignment", () => {
  const base = {
    actorType: "agent" as const,
    actorAgentName: "Dispatch",
    issueTitle: "Implement foo",
    issueDescription: `## Objective\nx\n\n## Scope\n- a.ts\n\n## Acceptance\ny\n\nExact head: \`${SHA}\`\n`,
    projectWorkspaceId: "452c8800-8270-4ca1-b384-8a677a39b826",
    env: enforce,
  };

  it("allows Wren implement", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Wren",
      assigneeAgentRole: "engineer",
    });
    expect(d.allowed).toBe(true);
    expect(d.reasonCodes).toEqual([]);
  });

  it("denies Fizz", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Fizz",
      assigneeAgentRole: "general",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(DISPATCH_ASSIGN_REASON.ASSIGNEE_NOT_ALLOWLISTED);
  });

  it("denies missing PWS for implement", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Wren",
      projectWorkspaceId: null,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(DISPATCH_ASSIGN_REASON.MISSING_PROJECT_WORKSPACE);
  });

  it("denies missing exact head", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Mason",
      issueDescription: "## Objective\nx\n\n## Scope\n- a.ts\n\n## Acceptance\ny\n",
      projectWorkspaceId: "452c8800-8270-4ca1-b384-8a677a39b826",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(DISPATCH_ASSIGN_REASON.MISSING_EXACT_HEAD);
  });

  it("observe allows but reports codes", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Fizz",
      env: { PAPERCLIP_DISPATCH_ASSIGN_POLICY: "observe" },
    });
    expect(d.allowed).toBe(true);
    expect(d.reasonCodes.length).toBeGreaterThan(0);
  });

  it("thrash cooldown", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Wren",
      thrashBlocked: true,
      thrashDetail: "recent admit fail",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(DISPATCH_ASSIGN_REASON.THRASH_COOLDOWN);
  });
});

describe("evaluateDispatchWake", () => {
  it("denies unbound", () => {
    const d = evaluateDispatchWake({
      actorType: "agent",
      actorAgentName: "Dispatch",
      env: enforce,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(DISPATCH_ASSIGN_REASON.ISSUE_UNBOUND_WAKE);
  });
  it("allows bound", () => {
    const d = evaluateDispatchWake({
      actorType: "agent",
      actorAgentName: "Dispatch",
      payloadIssueId: "a2b3db2c-9fbe-457f-96bd-bb6c643029b3",
      env: enforce,
    });
    expect(d.allowed).toBe(true);
  });
});

describe("findExactHeadSha", () => {
  it("finds line form", () => {
    expect(findExactHeadSha(`Exact head: \`${SHA}\``)).toBe(SHA);
  });
});
