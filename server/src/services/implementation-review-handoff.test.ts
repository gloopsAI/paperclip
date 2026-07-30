import { describe, expect, it } from "vitest";
import {
  REVIEW_HANDOFF_MARKER,
  buildImplementationReviewTitle,
  buildReviewExecutionWorkspaceSettings,
  planImplementationReviewHandoff,
  pickCompanyReviewerAgent,
} from "./implementation-review-handoff.js";

const HEAD = "8df321b7e407fd38b0c8caddcc4c02b07ca2d642";
const PARENT = "4743ff82-8936-4a69-8e02-61b520a83da7";
const WREN = "3298054f-0fc5-4ff9-8c53-b1382b3046d3";
const ARGUS = "843c62bc-6f32-420e-9b62-7a2d6a34846f";
const PROJECT = "17a4f7f2-1efa-459a-9fc2-a6359a1ef798";

describe("planImplementationReviewHandoff", () => {
  it("creates a review draft for standard work with exact head and Argus", () => {
    const plan = planImplementationReviewHandoff({
      parent: {
        id: PARENT,
        identifier: "GLO-1854",
        projectId: PROJECT,
        workMode: "standard",
      },
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
    expect(plan.title).toContain(REVIEW_HANDOFF_MARKER);
    expect(plan.title).toContain(HEAD.slice(0, 12));
    expect(plan.description).toContain(HEAD);
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

describe("buildReviewExecutionWorkspaceSettings (C2 / GLO-1940)", () => {
  it("binds baseRef to exact head SHA (never project pin)", () => {
    const settings = buildReviewExecutionWorkspaceSettings(HEAD);
    expect(settings).toEqual({
      mode: "isolated_workspace",
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: HEAD,
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
