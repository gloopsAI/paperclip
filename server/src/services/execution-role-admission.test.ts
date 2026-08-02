import { describe, expect, it } from "vitest";
import {
  ADMISSION_REASON,
  buildRoleAdmissionInputFromAgent,
  evaluateIssueRunnableAdmission,
  evaluateRoleAdmission,
  extractModelFromAdapterConfig,
  resolveRoleAdmissionPolicy,
  type RoleAdmissionInput,
} from "./execution-role-admission.js";

const VALID_CHARTER = "A".repeat(120);

function baseInput(overrides: Partial<RoleAdmissionInput> = {}): RoleAdmissionInput {
  return {
    role: "Wren",
    status: "idle",
    model: "kimi-k2.7-code",
    instructions: VALID_CHARTER,
    attachedSkills: ["paperclip", "github-pr-workflow", "gloops-bounded-implementation"],
    desiredSkills: null,
    budgetMonthlyCents: 0,
    ...overrides,
  };
}

describe("resolveRoleAdmissionPolicy", () => {
  it("matches implementer roles case-insensitively", () => {
    expect(resolveRoleAdmissionPolicy("wren")?.key).toBe("implementer");
    expect(resolveRoleAdmissionPolicy("Mason")?.key).toBe("implementer");
    expect(resolveRoleAdmissionPolicy("IMPLEMENTER")?.key).toBe("implementer");
  });

  it("matches Argus, Dispatch, Scout, Harbor", () => {
    expect(resolveRoleAdmissionPolicy("Argus")?.key).toBe("reviewer");
    expect(resolveRoleAdmissionPolicy("dispatch")?.key).toBe("dispatch");
    expect(resolveRoleAdmissionPolicy("Scout")?.key).toBe("researcher");
    expect(resolveRoleAdmissionPolicy("Business Analyst Copilot")?.key).toBe("researcher");
    expect(resolveRoleAdmissionPolicy("Harbor")?.key).toBe("harbor");
  });

  it("returns null for unknown roles (fail-closed)", () => {
    expect(resolveRoleAdmissionPolicy("Northstar")).toBeNull();
    expect(resolveRoleAdmissionPolicy("")).toBeNull();
    expect(resolveRoleAdmissionPolicy("ceo")).toBeNull();
  });
});

describe("evaluateRoleAdmission", () => {
  it("admits a fully equipped implementer (Wren)", () => {
    const result = evaluateRoleAdmission(baseInput());
    expect(result).toMatchObject({
      admitted: true,
      reasonCodes: [],
      roleKey: "implementer",
    });
    expect(result.details).toMatch(/admitted/i);
  });

  it("denies unknown role with admission.role_unknown", () => {
    const result = evaluateRoleAdmission(baseInput({ role: "Northstar" }));
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(ADMISSION_REASON.ROLE_UNKNOWN);
    expect(result.roleKey).toBeNull();
  });

  it("denies paused agent with admission.agent_paused", () => {
    const result = evaluateRoleAdmission(baseInput({ status: "paused" }));
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(ADMISSION_REASON.AGENT_PAUSED);
  });

  it("allows paused when allowPaused is true", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        status: "paused",
        options: { allowPaused: true },
      }),
    );
    expect(result.admitted).toBe(true);
  });

  it("denies error status", () => {
    const result = evaluateRoleAdmission(baseInput({ status: "error" }));
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(ADMISSION_REASON.AGENT_STATUS);
  });

  it("denies missing model with admission.missing_model", () => {
    const result = evaluateRoleAdmission(baseInput({ model: "" }));
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(ADMISSION_REASON.MISSING_MODEL);

    const missing = evaluateRoleAdmission(baseInput({ model: null }));
    expect(missing.reasonCodes).toContain(ADMISSION_REASON.MISSING_MODEL);
  });

  it("denies invalid charter length with admission.charter_invalid", () => {
    const tooShort = evaluateRoleAdmission(baseInput({ instructions: "short" }));
    expect(tooShort.admitted).toBe(false);
    expect(tooShort.reasonCodes).toContain(ADMISSION_REASON.CHARTER_INVALID);

    const tooLong = evaluateRoleAdmission(baseInput({ instructions: "x".repeat(4001) }));
    expect(tooLong.admitted).toBe(false);
    expect(tooLong.reasonCodes).toContain(ADMISSION_REASON.CHARTER_INVALID);
  });

  it("respects configurable charter bounds", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        instructions: "ok",
        options: { minCharterLength: 2, maxCharterLength: 10 },
      }),
    );
    expect(result.admitted).toBe(true);
  });

  it("denies when desired skills are missing from attached", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        attachedSkills: ["paperclip"],
        desiredSkills: ["paperclip", "github-pr-workflow"],
      }),
    );
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(ADMISSION_REASON.SKILL_MISSING);
    expect(result.details).toMatch(/github-pr-workflow/);
  });

  it("admits when desired skills are all attached (slug-equivalent)", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        attachedSkills: ["paperclipai/paperclip/github-pr-workflow", "paperclip"],
        desiredSkills: ["github-pr-workflow", "paperclip"],
      }),
    );
    expect(result.admitted).toBe(true);
  });

  it("denies attached denylisted / non-allowlisted skills for role", () => {
    const implementerSocial = evaluateRoleAdmission(
      baseInput({
        attachedSkills: ["paperclip", "twitter-poster"],
      }),
    );
    expect(implementerSocial.admitted).toBe(false);
    expect(implementerSocial.reasonCodes).toContain(ADMISSION_REASON.SKILL_DENIED);

    const argusPush = evaluateRoleAdmission(
      baseInput({
        role: "Argus",
        attachedSkills: ["gloops-focused-review", "github-pr-workflow"],
      }),
    );
    expect(argusPush.admitted).toBe(false);
    expect(argusPush.reasonCodes).toContain(ADMISSION_REASON.SKILL_DENIED);
  });

  it("admits Argus with read-only review skills", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        role: "Argus",
        attachedSkills: ["gloops-focused-review", "gloops-evidence-lookup", "paperclip"],
      }),
    );
    expect(result).toMatchObject({
      admitted: true,
      roleKey: "reviewer",
    });
  });

  it("admits Dispatch with dispatch-only skills", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        role: "Dispatch",
        attachedSkills: ["issue-triage", "gloops-task-preparation", "paperclip"],
      }),
    );
    expect(result).toMatchObject({
      admitted: true,
      roleKey: "dispatch",
    });
  });

  it("admits Scout with research-only skills", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        role: "Scout",
        attachedSkills: ["gloops-evidence-lookup", "research", "paperclip"],
      }),
    );
    expect(result).toMatchObject({
      admitted: true,
      roleKey: "researcher",
    });
  });

  it("admits Harbor with release skills", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        role: "Harbor",
        attachedSkills: ["release", "changelog", "paperclip"],
      }),
    );
    expect(result).toMatchObject({
      admitted: true,
      roleKey: "harbor",
    });
  });

  it("admits WP-E role skill allowlists (B5)", () => {
    const wren = evaluateRoleAdmission(
      baseInput({
        role: "Wren",
        attachedSkills: [
          "gloops-bounded-implementation",
          "gloops-task-preparation",
          "software-development",
          "github",
          "gloops-evidence-lookup",
          "paperclip",
        ],
      }),
    );
    expect(wren).toMatchObject({ admitted: true, roleKey: "implementer" });

    const dispatch = evaluateRoleAdmission(
      baseInput({
        role: "Dispatch",
        attachedSkills: ["gloops-bounded-planning", "gloops-evidence-lookup", "paperclip"],
      }),
    );
    expect(dispatch).toMatchObject({ admitted: true, roleKey: "dispatch" });

    const argus = evaluateRoleAdmission(
      baseInput({
        role: "Argus",
        attachedSkills: [
          "gloops-focused-review",
          "gloops-evidence-lookup",
          "gloops-terminal-reconciliation",
          "paperclip",
        ],
      }),
    );
    expect(argus).toMatchObject({ admitted: true, roleKey: "reviewer" });

    const harbor = evaluateRoleAdmission(
      baseInput({
        role: "Harbor",
        attachedSkills: [
          "gloops-evidence-lookup",
          "gloops-terminal-reconciliation",
          "paperclip",
          "release",
          "deploy",
        ],
      }),
    );
    expect(harbor).toMatchObject({ admitted: true, roleKey: "harbor" });
  });

  it("denies WP-E default-deny packs on implementer (B5)", () => {
    for (const denied of ["social-media", "smart-home", "dogfood", "yuanbao"]) {
      const result = evaluateRoleAdmission(
        baseInput({
          role: "Wren",
          attachedSkills: ["paperclip", "gloops-bounded-implementation", denied],
        }),
      );
      expect(result.admitted).toBe(false);
      expect(result.reasonCodes).toContain(ADMISSION_REASON.SKILL_DENIED);
    }
  });

  it("enforces MVP charter length band via options (B5 ≤1200)", () => {
    const ok = evaluateRoleAdmission(
      baseInput({
        instructions: "A".repeat(1100),
        options: { minCharterLength: 100, maxCharterLength: 1200 },
      }),
    );
    expect(ok.admitted).toBe(true);

    const over = evaluateRoleAdmission(
      baseInput({
        instructions: "A".repeat(1201),
        options: { minCharterLength: 100, maxCharterLength: 1200 },
      }),
    );
    expect(over.admitted).toBe(false);
    expect(over.reasonCodes).toContain(ADMISSION_REASON.CHARTER_INVALID);
  });

  it("denies missing budget when requireBudget is true", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        budgetMonthlyCents: 0,
        budgetEnvelope: null,
        options: { requireBudget: true },
      }),
    );
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(ADMISSION_REASON.BUDGET_MISSING);
  });

  it("admits when requireBudget and budget envelope present", () => {
    const byCents = evaluateRoleAdmission(
      baseInput({
        budgetMonthlyCents: 5000,
        options: { requireBudget: true },
      }),
    );
    expect(byCents.admitted).toBe(true);

    const byEnvelope = evaluateRoleAdmission(
      baseInput({
        budgetMonthlyCents: 0,
        budgetEnvelope: { schemaVersion: "v1" },
        options: { requireBudget: true },
      }),
    );
    expect(byEnvelope.admitted).toBe(true);
  });

  it("accumulates multiple deny reason codes", () => {
    const result = evaluateRoleAdmission(
      baseInput({
        status: "paused",
        model: "",
        instructions: "x",
        attachedSkills: ["twitter"],
        desiredSkills: ["paperclip"],
      }),
    );
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        ADMISSION_REASON.AGENT_PAUSED,
        ADMISSION_REASON.MISSING_MODEL,
        ADMISSION_REASON.CHARTER_INVALID,
        ADMISSION_REASON.SKILL_MISSING,
        ADMISSION_REASON.SKILL_DENIED,
      ]),
    );
  });
});

describe("evaluateIssueRunnableAdmission (WG-PLAT-016)", () => {
  it("admits runnable issue statuses without requiring an explicit resume", () => {
    for (const status of ["todo", "in_progress", "in_review"]) {
      expect(evaluateIssueRunnableAdmission({ issueStatus: status, interactionWake: false, resumeIntent: false })).toEqual({
        admitted: true,
        reasonCode: null,
      });
    }
  });

  it("denies a blocked issue with admission.issue_blocked when there is no explicit resume", () => {
    const result = evaluateIssueRunnableAdmission({ issueStatus: "blocked", interactionWake: false, resumeIntent: false });
    expect(result).toEqual({ admitted: false, reasonCode: ADMISSION_REASON.ISSUE_BLOCKED });
  });

  it("denies terminal statuses unconditionally, including interaction and resume wakes", () => {
    for (const status of ["done", "cancelled"]) {
      expect(evaluateIssueRunnableAdmission({ issueStatus: status, interactionWake: true, resumeIntent: true })).toEqual({
        admitted: false,
        reasonCode: ADMISSION_REASON.ISSUE_TERMINAL,
      });
    }
  });

  it("admits blocked only for a verified interaction wake or a real resume intent", () => {
    expect(evaluateIssueRunnableAdmission({ issueStatus: "blocked", interactionWake: true, resumeIntent: false }))
      .toEqual({ admitted: true, reasonCode: null });
    expect(evaluateIssueRunnableAdmission({ issueStatus: "blocked", interactionWake: false, resumeIntent: true }))
      .toEqual({ admitted: true, reasonCode: null });
  });

  it("denies other non-runnable statuses with a truthful generic code", () => {
    expect(evaluateIssueRunnableAdmission({ issueStatus: "backlog", interactionWake: true, resumeIntent: true }))
      .toEqual({ admitted: false, reasonCode: ADMISSION_REASON.ISSUE_NOT_RUNNABLE });
  });
});

describe("extractModelFromAdapterConfig / buildRoleAdmissionInputFromAgent", () => {
  it("extracts model and route equivalents", () => {
    expect(extractModelFromAdapterConfig({ model: "gpt-5.4" })).toBe("gpt-5.4");
    expect(extractModelFromAdapterConfig({ apiBaseUrl: "http://hermes:8642" })).toBe(
      "http://hermes:8642",
    );
    expect(extractModelFromAdapterConfig({ command: "echo" })).toBe("echo");
    expect(extractModelFromAdapterConfig({})).toBeNull();
  });

  it("builds evaluation input from agent name and skill sync preference", () => {
    const input = buildRoleAdmissionInputFromAgent(
      {
        name: "Wren",
        role: "engineer",
        status: "idle",
        capabilities: null,
        budgetMonthlyCents: 1000,
        adapterConfig: {
          model: "kimi-k2.7-code",
          promptTemplate: VALID_CHARTER,
          paperclipSkillSync: {
            desiredSkills: ["paperclip", { key: "github-pr-workflow", versionId: null }],
          },
        },
      },
      { desiredSkills: ["paperclip"] },
    );

    expect(input.role).toBe("Wren");
    expect(input.model).toBe("kimi-k2.7-code");
    expect(input.instructions).toBe(VALID_CHARTER);
    expect(input.attachedSkills).toEqual(["paperclip", "github-pr-workflow"]);
    expect(input.desiredSkills).toEqual(["paperclip"]);
    expect(evaluateRoleAdmission(input).admitted).toBe(true);
  });
});
