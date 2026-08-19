import { describe, expect, it } from "vitest";
import {
  DISPATCH_ASSIGN_REASON,
  evaluateDispatchAssignment,
  evaluateDispatchWake,
  findExactHeadSha,
  getDispatchAssignMode,
  getThrashCooldownSec,
  getThrashMinFails,
  isDispatchActor,
  isThrashErrorCode,
  resolveThrashCooldownFromRuns,
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

  it("thrash blocked on implement after thrash fail signal", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Wren",
      thrashBlocked: true,
      thrashDetail: "recent admit fail",
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(DISPATCH_ASSIGN_REASON.THRASH_COOLDOWN);
    expect(d.details).toContain("recent admit fail");
  });

  it("thrash does NOT block pure review Argus assign when thrashBlocked true", () => {
    const d = evaluateDispatchAssignment({
      ...base,
      assigneeAgentName: "Argus",
      assigneeAgentRole: "qa",
      issueTitle: "Review implementation of foo",
      issueDescription: "Please review the implementation",
      thrashBlocked: true,
      thrashDetail: "recent admit fail",
    });
    expect(d.reasonCodes).not.toContain(DISPATCH_ASSIGN_REASON.THRASH_COOLDOWN);
    expect(d.allowed).toBe(true);
  });
});

describe("thrash env knobs", () => {
  it("getThrashCooldownSec defaults 900", () => {
    expect(getThrashCooldownSec({})).toBe(900);
  });
  it("getThrashCooldownSec respects env", () => {
    expect(getThrashCooldownSec({ PAPERCLIP_DISPATCH_THRASH_COOLDOWN_SEC: "120" })).toBe(120);
  });
  it("getThrashMinFails defaults 1", () => {
    expect(getThrashMinFails({})).toBe(1);
  });
  it("isThrashErrorCode defaults", () => {
    expect(isThrashErrorCode("workspace_validation_failed", {})).toBe(true);
    expect(isThrashErrorCode("workspace_preparation_failed", {})).toBe(true);
    expect(isThrashErrorCode("process_lost", {})).toBe(true);
    expect(isThrashErrorCode("github_push.preparation_thrash_suppressed", {})).toBe(true);
    expect(isThrashErrorCode("provider_quota", {})).toBe(false);
  });
  it("isThrashErrorCode override list", () => {
    const env = { PAPERCLIP_DISPATCH_THRASH_ERROR_CODES: "custom_a, custom_b" };
    expect(isThrashErrorCode("custom_a", env)).toBe(true);
    expect(isThrashErrorCode("process_lost", env)).toBe(false);
  });
});

describe("resolveThrashCooldownFromRuns", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");

  it("within window blocks", () => {
    const r = resolveThrashCooldownFromRuns({
      now,
      env: {},
      runs: [
        {
          status: "failed",
          errorCode: "workspace_validation_failed",
          finishedAt: new Date("2026-08-03T11:50:00.000Z"),
        },
      ],
    });
    expect(r.matchCount).toBe(1);
    expect(r.thrashBlocked).toBe(true);
    expect(r.thrashDetail).toContain("workspace_validation_failed");
  });

  it("outside window allows", () => {
    const r = resolveThrashCooldownFromRuns({
      now,
      env: { PAPERCLIP_DISPATCH_THRASH_COOLDOWN_SEC: "900" },
      runs: [
        {
          status: "failed",
          errorCode: "process_lost",
          // 30 minutes before now — outside 900s window
          finishedAt: new Date("2026-08-03T11:00:00.000Z"),
        },
      ],
    });
    expect(r.matchCount).toBe(0);
    expect(r.thrashBlocked).toBe(false);
    expect(r.thrashDetail).toBeNull();
  });

  it("wrong error code allows", () => {
    const r = resolveThrashCooldownFromRuns({
      now,
      env: {},
      runs: [
        {
          status: "failed",
          errorCode: "provider_quota",
          finishedAt: new Date("2026-08-03T11:59:00.000Z"),
        },
      ],
    });
    expect(r.matchCount).toBe(0);
    expect(r.thrashBlocked).toBe(false);
  });

  it("minFails=2 requires two fails", () => {
    const one = resolveThrashCooldownFromRuns({
      now,
      env: { PAPERCLIP_DISPATCH_THRASH_MIN_FAILS: "2" },
      runs: [
        {
          status: "failed",
          errorCode: "process_lost",
          finishedAt: new Date("2026-08-03T11:55:00.000Z"),
        },
      ],
    });
    expect(one.matchCount).toBe(1);
    expect(one.thrashBlocked).toBe(false);

    const two = resolveThrashCooldownFromRuns({
      now,
      env: { PAPERCLIP_DISPATCH_THRASH_MIN_FAILS: "2" },
      runs: [
        {
          status: "failed",
          errorCode: "process_lost",
          finishedAt: new Date("2026-08-03T11:55:00.000Z"),
        },
        {
          status: "failed",
          errorCode: "workspace_preparation_failed",
          createdAt: new Date("2026-08-03T11:58:00.000Z"),
        },
      ],
    });
    expect(two.matchCount).toBe(2);
    expect(two.thrashBlocked).toBe(true);
  });

  it("ignores non-failed status even with thrash error code", () => {
    const r = resolveThrashCooldownFromRuns({
      now,
      env: {},
      runs: [
        {
          status: "succeeded",
          errorCode: "process_lost",
          finishedAt: new Date("2026-08-03T11:59:00.000Z"),
        },
      ],
    });
    expect(r.matchCount).toBe(0);
    expect(r.thrashBlocked).toBe(false);
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

  it("does not promote Base SHA to an implementation target", () => {
    expect(findExactHeadSha(`Base SHA: \`${SHA}\``)).toBeNull();
  });
});
