import { describe, expect, it } from "vitest";
import {
  ISSUE_PACKET_REASON,
  evaluateIssuePacketReadiness,
  extractMarkdownSection,
  findDeclaredExactHeadShas,
  findExactHeadSha,
  getIssuePacketDorMode,
  isOpsPlaneResidualPacket,
  type IssuePacketReadinessInput,
} from "./issue-packet-readiness.js";

const GOOD_SHA = "a".repeat(40);
const GOOD_DIGEST = `sha256:${"b".repeat(64)}`;

describe("canonical exact-head declarations", () => {
  it("prefers the explicit Exact head and never mistakes Base SHA for the target", () => {
    const baseSha = "b".repeat(40);
    const exactHead = "a".repeat(40);
    const description = `Base SHA: \`${baseSha}\`\nExact head: \`${exactHead}\``;
    expect(findDeclaredExactHeadShas(description)).toEqual([exactHead]);
    expect(findExactHeadSha(description)).toBe(exactHead);
  });

  it("fails closed on conflicting explicit Exact head declarations", () => {
    const first = "a".repeat(40);
    const second = "c".repeat(40);
    const description = `Exact head: \`${first}\`\nExact head: \`${second}\``;
    expect(findDeclaredExactHeadShas(description)).toEqual([first, second]);
    expect(findExactHeadSha(description)).toBeNull();
  });

  it("does not reuse a lone Base SHA through the bare-SHA fallback", () => {
    expect(findExactHeadSha(`Base SHA: \`${"b".repeat(40)}\``)).toBeNull();
  });
});

function baseImplement(overrides: Partial<IssuePacketReadinessInput> = {}): IssuePacketReadinessInput {
  return {
    title: "Implement issue packet DoR preflight",
    description: [
      "## Scope",
      "Add pure evaluator and wire checkout fail-close for missing Scope/Acceptance.",
      "",
      "## Acceptance",
      "Unit tests green; checkout returns 422 when enforce and Scope is missing.",
    ].join("\n"),
    workMode: "standard",
    status: "todo",
    assigneeRole: "general",
    assigneeName: "Wren",
    repositoryBacked: true,
    ...overrides,
  };
}

const ENFORCE = { PAPERCLIP_ISSUE_PACKET_DOR: "enforce" };
const OBSERVE = { PAPERCLIP_ISSUE_PACKET_DOR: "observe" };
const OFF = { PAPERCLIP_ISSUE_PACKET_DOR: "off" };

describe("getIssuePacketDorMode", () => {
  it("defaults to off so packet structure remains guidance", () => {
    expect(getIssuePacketDorMode({})).toBe("off");
    expect(getIssuePacketDorMode({ PAPERCLIP_ISSUE_PACKET_DOR: "" })).toBe("off");
    expect(getIssuePacketDorMode({ PAPERCLIP_ISSUE_PACKET_DOR: "  " })).toBe("off");
  });

  it("defaults to off under vitest/test when unset", () => {
    expect(getIssuePacketDorMode({ VITEST: "true" })).toBe("off");
    expect(getIssuePacketDorMode({ NODE_ENV: "test" })).toBe("off");
    // explicit still wins
    expect(getIssuePacketDorMode({ VITEST: "true", PAPERCLIP_ISSUE_PACKET_DOR: "enforce" })).toBe("enforce");
  });

  it("parses off/observe/enforce case-insensitively", () => {
    expect(getIssuePacketDorMode({ PAPERCLIP_ISSUE_PACKET_DOR: "off" })).toBe("off");
    expect(getIssuePacketDorMode({ PAPERCLIP_ISSUE_PACKET_DOR: "OBSERVE" })).toBe("observe");
    expect(getIssuePacketDorMode({ PAPERCLIP_ISSUE_PACKET_DOR: "Enforce" })).toBe("enforce");
  });

  it("falls back to off on unknown values", () => {
    expect(getIssuePacketDorMode({ PAPERCLIP_ISSUE_PACKET_DOR: "maybe" })).toBe("off");
  });
});

describe("extractMarkdownSection", () => {
  it("extracts case-insensitive ## Heading bodies until next heading", () => {
    const md = [
      "# Title",
      "## scope",
      "Do the thing carefully.",
      "## Acceptance Criteria",
      "It works.",
    ].join("\n");
    expect(extractMarkdownSection(md, "Scope")).toBe("Do the thing carefully.");
    expect(extractMarkdownSection(md, "Acceptance Criteria")).toBe("It works.");
    expect(extractMarkdownSection(md, "Missing")).toBeNull();
  });
});

describe("evaluateIssuePacketReadiness — standard_implement", () => {
  it("ready when Scope + Acceptance present", () => {
    const result = evaluateIssuePacketReadiness(baseImplement(), ENFORCE);
    expect(result).toMatchObject({
      ready: true,
      mode: "enforce",
      profile: "standard_implement",
      reasonCodes: [],
    });
    expect(result.present).toEqual(expect.arrayContaining(["Scope", "Acceptance"]));
    expect(result.missing).toEqual([]);
  });

  it("not ready when Scope missing", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({
        description: [
          "## Acceptance",
          "Ship a working DoR gate with unit coverage.",
        ].join("\n"),
      }),
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.profile).toBe("standard_implement");
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.MISSING_SCOPE);
    expect(result.missing).toContain("Scope");
  });

  it("not ready when Acceptance missing", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({
        description: [
          "## Scope",
          "Wire evaluator into checkout and claim preflight.",
        ].join("\n"),
      }),
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.MISSING_ACCEPTANCE);
    expect(result.missing).toContain("Acceptance");
  });

  it("accepts Acceptance Criteria alias", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({
        description: [
          "## Scope",
          "Pure evaluator plus checkout wire for issue packets.",
          "",
          "## Acceptance Criteria",
          "Bad packets denied under enforce; good packets admitted.",
        ].join("\n"),
      }),
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.present).toContain("Acceptance");
  });

  it("treats TBD-only Scope as placeholder_only", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({
        description: [
          "## Scope",
          "TBD",
          "",
          "## Acceptance",
          "Unit tests cover missing Scope denial path.",
        ].join("\n"),
      }),
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.PLACEHOLDER_ONLY);
    expect(result.missing).toContain("Scope");
  });

  it("treats dash-only Acceptance as placeholder", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({
        description: [
          "## Scope",
          "Implement the pure readiness evaluator module.",
          "",
          "## Acceptance",
          "-",
        ].join("\n"),
      }),
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.PLACEHOLDER_ONLY);
  });

  it("does not fail when Grounding is missing (observe-only note)", () => {
    const result = evaluateIssuePacketReadiness(baseImplement(), ENFORCE);
    expect(result.ready).toBe(true);
    expect(result.details).toMatch(/Grounding/i);
    expect(result.reasonCodes).not.toContain(ISSUE_PACKET_REASON.MISSING_SCOPE);
  });
});

describe("evaluateIssuePacketReadiness — standard_review", () => {
  it("ready when SHA + Acceptance present for Argus", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Review DoR implementation",
        description: [
          `Exact head: ${GOOD_SHA}`,
          "",
          "## Acceptance",
          "Confirm Scope+Acceptance gate and reason codes are stable.",
        ].join("\n"),
        workMode: "standard",
        status: "in_review",
        assigneeName: "Argus",
        assigneeRole: "reviewer",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("standard_review");
    expect(result.present).toEqual(expect.arrayContaining(["exactHeadSha", "Acceptance"]));
  });

  it("ready when SHA + review terminal language (no Acceptance)", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "maw-implementation-review for packet DoR",
        description: [
          `headSha ${GOOD_SHA}`,
          "Review verdict: pass with evidence from unit suite.",
        ].join("\n"),
        workMode: null,
        status: "todo",
      },
      ENFORCE,
    );
    expect(result.profile).toBe("standard_review");
    expect(result.ready).toBe(true);
    expect(result.present).toContain("reviewTerminalLanguage");
  });

  it("not ready without exact head SHA", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "implementation review of DoR",
        description: [
          "## Acceptance",
          "Verify exact-head enforcement on review packets.",
        ].join("\n"),
        assigneeName: "Argus",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.MISSING_EXACT_HEAD);
    expect(result.missing).toContain("exactHeadSha");
  });
});

describe("evaluateIssuePacketReadiness — standard_release", () => {
  it("ready with Acceptance + sha256 digest for Harbor", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Promote paperclip image",
        description: [
          "## Acceptance",
          "Image pin published and health check green.",
          "",
          `Digest: ${GOOD_DIGEST}`,
        ].join("\n"),
        assigneeName: "Harbor",
        assigneeRole: "release",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("standard_release");
    expect(result.present).toEqual(expect.arrayContaining(["Acceptance", "releaseAnchor"]));
  });

  it("not ready without release anchor", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Promote paperclip image",
        description: [
          "## Acceptance",
          "Ship the release after canary passes.",
        ].join("\n"),
        assigneeName: "Harbor",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.MISSING_RELEASE_ANCHOR);
  });
});

describe("evaluateIssuePacketReadiness — coordination", () => {
  it("ready for Dispatch with title + Acceptance", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Coordinate packet DoR rollout",
        description: [
          "## Acceptance",
          "Canary bad packet denied; good packet admitted.",
        ].join("\n"),
        assigneeName: "Dispatch",
        assigneeRole: "dispatch",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("coordination");
  });

  it("ready with Objective + Decision/Outcome", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Short",
        description: [
          "## Objective",
          "Decide rollout order for DoR enforce mode.",
          "",
          "## Decision",
          "Start with observe soak then enforce on product host.",
        ].join("\n"),
        assigneeName: "Northstar",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("coordination");
    expect(result.present).toEqual(expect.arrayContaining(["Objective", "Decision/Outcome"]));
  });

  it("not ready without objective substance or long title", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Hi",
        description: [
          "## Acceptance",
          "Something measurable about coordination outcome.",
        ].join("\n"),
        assigneeName: "Dispatch",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(false);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.MISSING_OBJECTIVE);
  });
});

describe("evaluateIssuePacketReadiness — ops plane residual", () => {
  const opsDescription = [
    "## Plane residual (ops — not product code work)",
    "Restore Induct SDLC plane preflight to green without paging Zach.",
    "",
    "## Codes",
    "```json",
    '{"criticalCodes":["lease.dirty_or_missing"]}',
    "```",
    "",
    "## Recommended recipes",
    "- `induct-lease-refresh`",
    "",
    "## Bounds",
    "- Do not page Zach",
    "",
    "## Decision/Outcome",
    "Plane preflight green with empty criticalCodes and campaign hours ≥ 12.",
  ].join("\n");

  it("detects ops residual by title prefix and desc header", () => {
    expect(
      isOpsPlaneResidualPacket({
        title: "[Sentinel/Plane] induct lease dirty",
        description: "no marker body",
      }),
    ).toBe(true);
    expect(
      isOpsPlaneResidualPacket({
        title: "Some residual",
        description: opsDescription,
      }),
    ).toBe(true);
    expect(
      isOpsPlaneResidualPacket({
        title: "Implement product feature",
        description: "## Scope\n- a.ts\n## Acceptance\ndone",
      }),
    ).toBe(false);
  });

  it("classifies as coordination even when assignee is Harbor/release", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "[Sentinel/Plane] campaign deadline / epoch",
        description: opsDescription,
        assigneeName: "Harbor",
        assigneeRole: "devops",
      },
      ENFORCE,
    );
    expect(result.profile).toBe("coordination");
    expect(result.ready).toBe(true);
  });

  it("classifies as coordination for Sentinel engineer without implement packet", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "[Sentinel/Plane] induct lease dirty",
        description: opsDescription,
        assigneeName: "Sentinel",
        assigneeRole: "engineer",
      },
      ENFORCE,
    );
    expect(result.profile).toBe("coordination");
    expect(result.ready).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });
});

describe("evaluateIssuePacketReadiness — probe / exempt / modes", () => {
  it("skill_test is probe-exempt ready", () => {
    const result = evaluateIssuePacketReadiness(
      {
        title: "Skill probe",
        description: "no sections",
        workMode: "skill_test",
      },
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("probe");
    expect(result.reasonCodes).toEqual([]);
  });

  it("ask workMode is probe-exempt ready", () => {
    const result = evaluateIssuePacketReadiness(
      { title: "Quick ask", description: "", workMode: "ask" },
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("probe");
  });

  it("done status is exempt ready", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({ status: "done", description: "" }),
      ENFORCE,
    );
    expect(result.ready).toBe(true);
    expect(result.profile).toBe("exempt");
  });

  it("mode off always ready without evaluation", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({ description: "garbage" }),
      OFF,
    );
    expect(result.ready).toBe(true);
    expect(result.mode).toBe("off");
    expect(result.profile).toBe("exempt");
    expect(result.reasonCodes).toEqual([]);
  });

  it("mode observe evaluates but always ready", () => {
    const result = evaluateIssuePacketReadiness(
      baseImplement({
        description: "## Acceptance\nOnly acceptance, no scope section here.",
      }),
      OBSERVE,
    );
    expect(result.mode).toBe("observe");
    expect(result.ready).toBe(true);
    expect(result.reasonCodes).toContain(ISSUE_PACKET_REASON.MISSING_SCOPE);
    expect(result.details).toMatch(/\[observe\]/i);
  });
});
