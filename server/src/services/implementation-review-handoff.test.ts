import { describe, expect, it } from "vitest";
import {
  REVIEW_HANDOFF_MARKER,
  buildReviewTerminalFailureComment,
  buildImplementationReviewTitle,
  buildReviewExecutionWorkspaceSettings,
  isImplementationReviewIssue,
  pickCompanyReviewerAgent,
  pickCompanyReviewerAgentDetailed,
  planImplementationReviewHandoff,
} from "./implementation-review-handoff.js";

const HEAD = "8df321b7e407fd38b0c8caddcc4c02b07ca2d642";
const PARENT = "4743ff82-8936-4a69-8e02-61b520a83da7";
const WREN = "3298054f-0fc5-4ff9-8c53-b1382b3046d3";
const ARGUS = "843c62bc-6f32-420e-9b62-7a2d6a34846f";
const PROJECT = "17a4f7f2-1efa-459a-9fc2-a6359a1ef798";
const BASE = "7f9b1f95a59a8b61dd61b9873be13c659e259873";

describe("planImplementationReviewHandoff", () => {
  it("creates a review draft for standard work with exact head and Argus", () => {
    const plan = planImplementationReviewHandoff({
      parent: {
        id: PARENT,
        identifier: "GLO-1854",
        projectId: PROJECT,
        workMode: "standard",
      },
      exactBaseSha: BASE,
      exactHeadSha: HEAD,
      implementerAgentId: WREN,
      reviewerAgentId: ARGUS,
      existingChildren: [],
      draftPr: { disposition: "created", prNumber: 199, prUrl: "https://github.com/gloopsAI/paperclip/pull/199" },
    });
    expect(plan.action).toBe("create");
    if (plan.action !== "create") return;
    expect(plan.assigneeAgentId).toBe(ARGUS);
    expect(plan.exactHeadSha).toBe(HEAD);
    expect(plan.exactBaseSha).toBe(BASE);
    expect(plan.title).toContain(REVIEW_HANDOFF_MARKER);
    expect(plan.title).toContain(HEAD.slice(0, 12));
    expect(plan.description).toContain(HEAD);
    expect(plan.description).toContain(BASE);
    expect(plan.description).toContain("#199");
    expect(plan.draftPrUrl).toContain("pull/199");
  });

  it("skips probe work modes", () => {
    expect(
      planImplementationReviewHandoff({
        parent: { id: PARENT, projectId: PROJECT, workMode: "skill_test" },
        exactHeadSha: HEAD,
        implementerAgentId: WREN,
        reviewerAgentId: ARGUS,
        existingChildren: [],
      }),
    ).toEqual({ action: "skip", reason: "probe_work_mode" });
  });

  it("skips missing head or reviewer", () => {
    expect(
      planImplementationReviewHandoff({
        parent: { id: PARENT, projectId: PROJECT, workMode: "standard" },
        exactHeadSha: null,
        implementerAgentId: WREN,
        reviewerAgentId: ARGUS,
        existingChildren: [],
      }).action,
    ).toBe("skip");
    expect(
      planImplementationReviewHandoff({
        parent: { id: PARENT, projectId: PROJECT, workMode: "standard" },
        exactHeadSha: HEAD,
        implementerAgentId: WREN,
        reviewerAgentId: null,
        existingChildren: [],
      }),
    ).toEqual({ action: "skip", reason: "missing_reviewer" });
  });

  it("skips when an open review child for the same head already exists", () => {
    const title = buildImplementationReviewTitle({
      parentIdentifier: "GLO-1854",
      exactHeadSha: HEAD,
    });
    const plan = planImplementationReviewHandoff({
      parent: { id: PARENT, projectId: PROJECT, workMode: "standard", identifier: "GLO-1854" },
      exactHeadSha: HEAD,
      implementerAgentId: WREN,
      reviewerAgentId: ARGUS,
      existingChildren: [
        {
          id: "child-1",
          title,
          status: "todo",
          description: `exact head \`${HEAD}\` ${REVIEW_HANDOFF_MARKER}`,
        },
      ],
    });
    expect(plan).toEqual({ action: "skip", reason: "duplicate_open_review" });
  });

  it("skips self-review", () => {
    expect(
      planImplementationReviewHandoff({
        parent: { id: PARENT, projectId: PROJECT, workMode: "standard" },
        exactHeadSha: HEAD,
        implementerAgentId: ARGUS,
        reviewerAgentId: ARGUS,
        existingChildren: [],
      }),
    ).toEqual({ action: "skip", reason: "same_agent_reviewer" });
  });
});

describe("pickCompanyReviewerAgent", () => {
  it("prefers Argus by name then qa role", () => {
    expect(
      pickCompanyReviewerAgent([
        { id: "1", name: "Wren", role: "engineer", status: "idle" },
        { id: ARGUS, name: "Argus", role: "qa", status: "idle" },
      ]),
    ).toBe(ARGUS);
    expect(
      pickCompanyReviewerAgent([
        { id: "2", name: "Review Bot", role: "qa", status: "idle" },
      ]),
    ).toBe("2");
  });
});

describe("pickCompanyReviewerAgentDetailed (GLO-2023 reviewer-fallback)", () => {
  it("reports argus_name when an agent is named Argus", () => {
    expect(
      pickCompanyReviewerAgentDetailed([
        { id: "wren", name: "Wren", role: "engineer", status: "idle" },
        { id: ARGUS, name: "Argus", role: "qa", status: "idle" },
      ]),
    ).toEqual({ id: ARGUS, source: "argus_name" });
  });

  it("reports reviewer_role when no Argus is present", () => {
    expect(
      pickCompanyReviewerAgentDetailed([
        { id: "wren", name: "Wren", role: "engineer", status: "idle" },
        { id: "review-bot", name: "Review Bot", role: "qa", status: "idle" },
      ]),
    ).toEqual({ id: "review-bot", source: "reviewer_role" });
  });

  it("falls back to any live agent when no reviewer exists (GLO-2023 reliability)", () => {
    const pick = pickCompanyReviewerAgentDetailed([
      { id: "wren", name: "Wren", role: "engineer", status: "idle" },
      { id: "northstar", name: "Northstar", role: "manager", status: "idle" },
    ]);
    expect(pick.source).toBe("any_live_fallback");
    if (pick.source === "any_live_fallback") {
      expect(["wren", "northstar"]).toContain(pick.id);
    }
  });

  it("skips terminated and pending_approval agents before falling back", () => {
    const pick = pickCompanyReviewerAgentDetailed([
      { id: "dead", name: "Zombie", role: "qa", status: "terminated" },
      { id: "pending", name: "Tbd", role: "qa", status: "pending_approval" },
      { id: "live", name: "Wren", role: "engineer", status: "idle" },
    ]);
    expect(pick).toEqual({ id: "live", source: "any_live_fallback" });
  });

  it("returns source none when no live agent exists", () => {
    expect(
      pickCompanyReviewerAgentDetailed([
        { id: "dead1", name: "A", role: "qa", status: "terminated" },
        { id: "dead2", name: "B", role: "qa", status: "pending_approval" },
      ]),
    ).toEqual({ source: "none" });
  });
});

describe("buildReviewExecutionWorkspaceSettings (C2 / GLO-1940)", () => {
  it("binds baseRef to exact head SHA and prohibits remote refresh", () => {
    const settings = buildReviewExecutionWorkspaceSettings(HEAD);
    expect(settings).toEqual({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: HEAD,
        remoteRefreshPolicy: "local_only",
      },
    });
    expect(settings.workspaceStrategy.baseRef).not.toMatch(/gloops\/stable|origin\//);
  });

  it("rejects non-SHA heads fail-closed", () => {
    expect(() => buildReviewExecutionWorkspaceSettings("origin/gloops/stable")).toThrow(
      /review_declared_head_missing/,
    );
    expect(() => buildReviewExecutionWorkspaceSettings("abc")).toThrow(/review_declared_head_missing/);
  });
});

describe("durable review terminal failure", () => {
  it("requires canonical provenance bound to the actual parent and authentic source run", () => {
    const sourceRunId = "11a4012e-6284-4df7-b7fb-106147c2a39a";
    const executionWorkspaceSettings = {
      reviewProvenance: {
        kind: "implementation_exact_head",
        parentIssueId: PARENT,
        sourceRunId,
      },
    };
    expect(isImplementationReviewIssue({
      executionWorkspaceSettings: null,
      parentId: PARENT,
      authenticSourceRunId: sourceRunId,
    })).toBe(false);
    expect(isImplementationReviewIssue({
      executionWorkspaceSettings,
      parentId: PARENT,
      authenticSourceRunId: sourceRunId,
    })).toBe(true);
    expect(isImplementationReviewIssue({
      executionWorkspaceSettings,
      parentId: "5743ff82-8936-4a69-8e02-61b520a83da7",
      authenticSourceRunId: sourceRunId,
    })).toBe(false);
    expect(isImplementationReviewIssue({
      executionWorkspaceSettings,
      parentId: PARENT,
      authenticSourceRunId: "21a4012e-6284-4df7-b7fb-106147c2a39a",
    })).toBe(false);
    expect(isImplementationReviewIssue({
      executionWorkspaceSettings: {
        reviewProvenance: { ...executionWorkspaceSettings.reviewProvenance, sourceRunId: "spoof" },
      },
      parentId: PARENT,
      authenticSourceRunId: "spoof",
    })).toBe(false);
  });

  it("records REVIEW_NOT_RUN with a typed platform owner and action", () => {
    const body = buildReviewTerminalFailureComment({
      runId: "run-1",
      errorCode: "workspace_preparation_failed",
      errorMessage: "base ref refresh was denied",
      exactBaseSha: BASE,
      exactHeadSha: HEAD,
    });

    expect(body).toContain("REVIEW_TERMINAL_V1:");
    expect(body).toContain('"disposition":"REVIEW_NOT_RUN"');
    expect(body).toContain('"owner":"platform_workspace"');
    expect(body).toContain('"action":"materialize_exact_review_objects_and_retry"');
    expect(body).toContain(BASE);
    expect(body).toContain(HEAD);
  });
});
