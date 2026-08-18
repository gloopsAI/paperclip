import { lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_ADMIT_REASON,
  evaluateWorkspaceAdmitCreateRequirements,
  evaluateWorkspaceAdmitFilesystem,
  extractScopePathHints,
  formatWorkspaceAdmitFailureComment,
  getWorkspaceAdmitCreateMode,
  getWorkspaceAdmitMode,
  issueRequiresWorkspaceAdmit,
  primaryWorkspaceAdmitErrorCode,
  resolveExpectedHeadFromIssueAndWorkspace,
  shouldInheritProjectWorkspace,
  type WorkspaceAdmitPreflightResult,
} from "./workspace-admit-preflight.js";

const GOOD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const tempDirs: string[] = [];

function makeTempGitRepo(opts?: { dirty?: boolean; commitMessage?: string }): {
  cwd: string;
  head: string;
} {
  const cwd = mkdtempSync(path.join(tmpdir(), "workspace-admit-"));
  tempDirs.push(cwd);
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return (result.stdout ?? "").trim();
  };
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Workspace Admit Test"]);
  writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src", "index.ts"), "export const ok = true;\n");
  run(["add", "."]);
  run(["commit", "-m", opts?.commitMessage ?? "init"]);
  const head = run(["rev-parse", "HEAD"]).toLowerCase();
  if (opts?.dirty) {
    writeFileSync(path.join(cwd, "dirty.txt"), "uncommitted\n");
  }
  return { cwd, head };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("getWorkspaceAdmitMode", () => {
  it("defaults to enforce outside tests", () => {
    expect(getWorkspaceAdmitMode({})).toBe("enforce");
    expect(getWorkspaceAdmitMode({ PAPERCLIP_WORKSPACE_ADMIT: "" })).toBe("enforce");
  });

  it("defaults to off under vitest/test when unset", () => {
    expect(getWorkspaceAdmitMode({ VITEST: "true" })).toBe("off");
    expect(getWorkspaceAdmitMode({ NODE_ENV: "test" })).toBe("off");
    expect(
      getWorkspaceAdmitMode({ VITEST: "true", PAPERCLIP_WORKSPACE_ADMIT: "enforce" }),
    ).toBe("enforce");
  });

  it("parses off/observe/enforce case-insensitively", () => {
    expect(getWorkspaceAdmitMode({ PAPERCLIP_WORKSPACE_ADMIT: "off" })).toBe("off");
    expect(getWorkspaceAdmitMode({ PAPERCLIP_WORKSPACE_ADMIT: "OBSERVE" })).toBe("observe");
    expect(getWorkspaceAdmitMode({ PAPERCLIP_WORKSPACE_ADMIT: "Enforce" })).toBe("enforce");
  });

  it("falls back to enforce on unknown values", () => {
    expect(getWorkspaceAdmitMode({ PAPERCLIP_WORKSPACE_ADMIT: "maybe" })).toBe("enforce");
  });
});

describe("getWorkspaceAdmitCreateMode", () => {
  it("mirrors workspace admit mode when create env unset", () => {
    expect(getWorkspaceAdmitCreateMode({ PAPERCLIP_WORKSPACE_ADMIT: "observe" })).toBe("observe");
    expect(getWorkspaceAdmitCreateMode({ VITEST: "true" })).toBe("off");
  });

  it("allows create env override", () => {
    expect(
      getWorkspaceAdmitCreateMode({
        PAPERCLIP_WORKSPACE_ADMIT: "off",
        PAPERCLIP_WORKSPACE_ADMIT_CREATE: "enforce",
      }),
    ).toBe("enforce");
  });
});

describe("extractScopePathHints", () => {
  it("extracts backtick paths from Scope section", () => {
    const description = [
      "## Scope",
      "- touch `src/index.ts`",
      "- maybe `packages/foo/bar.tsx`",
      "## Acceptance",
      "done",
    ].join("\n");
    expect(extractScopePathHints(description)).toEqual(
      expect.arrayContaining(["src/index.ts", "packages/foo/bar.tsx"]),
    );
  });

  it("returns empty for null/empty", () => {
    expect(extractScopePathHints(null)).toEqual([]);
    expect(extractScopePathHints("")).toEqual([]);
  });
});

describe("evaluateWorkspaceAdmitFilesystem", () => {
  it("passes clean repo at expected head with scope path present", () => {
    const { cwd, head } = makeTempGitRepo();
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd,
      expectedHeadSha: head,
      scopePathHints: ["src/index.ts"],
    });
    expect(result.observedHeadSha).toBe(head);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("fails dirty tree", () => {
    const { cwd, head } = makeTempGitRepo({ dirty: true });
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd,
      expectedHeadSha: head,
    });
    const dirty = result.checks.find((c) => c.id === "clean_tree");
    expect(dirty?.ok).toBe(false);
    expect(dirty?.reasonCode).toBe(WORKSPACE_ADMIT_REASON.DIRTY_TREE);
  });

  it("fails head mismatch", () => {
    const { cwd } = makeTempGitRepo();
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd,
      expectedHeadSha: OTHER_SHA,
    });
    const expected = result.checks.find((c) => c.id === "expected_head");
    expect(expected?.ok).toBe(false);
    expect(expected?.reasonCode).toBe(WORKSPACE_ADMIT_REASON.HEAD_MISMATCH);
  });

  it("fails missing cwd", () => {
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd: null,
      expectedHeadSha: GOOD_SHA,
    });
    expect(result.checks[0]?.reasonCode).toBe(WORKSPACE_ADMIT_REASON.CWD_MISSING);
    expect(result.checks.some((check) =>
      check.reasonCode === WORKSPACE_ADMIT_REASON.EXPECTED_HEAD_NOT_FULL_SHA
    )).toBe(false);
  });

  it("reports every independently knowable fault when both path and declared head are missing", () => {
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd: null,
      expectedHeadSha: null,
    });
    expect(result.checks.filter((check) => !check.ok).map((check) => check.reasonCode)).toEqual([
      WORKSPACE_ADMIT_REASON.EXPECTED_HEAD_NOT_FULL_SHA,
      WORKSPACE_ADMIT_REASON.CWD_MISSING,
    ]);
  });

  it("fails a workspace owned by a different service uid before git invocation", () => {
    const { cwd, head } = makeTempGitRepo();
    const actualUid = lstatSync(cwd).uid;
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd,
      expectedHeadSha: head,
      expectedOwnerUid: actualUid + 1,
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "cwd_owner",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.CWD_OWNER_MISMATCH,
    }));
  });

  it("fails non-git directory", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "workspace-admit-nongit-"));
    tempDirs.push(cwd);
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd,
      expectedHeadSha: GOOD_SHA,
    });
    expect(result.checks.some((c) => c.reasonCode === WORKSPACE_ADMIT_REASON.CWD_NOT_GIT)).toBe(
      true,
    );
  });

  it("fails when expected head is not full sha", () => {
    const { cwd } = makeTempGitRepo();
    const result = evaluateWorkspaceAdmitFilesystem({
      cwd,
      expectedHeadSha: "main",
    });
    expect(
      result.checks.some((c) => c.reasonCode === WORKSPACE_ADMIT_REASON.EXPECTED_HEAD_NOT_FULL_SHA),
    ).toBe(true);
  });
});

describe("resolveExpectedHeadFromIssueAndWorkspace", () => {
  it("prefers description Exact head over workspace refs", () => {
    const sha = resolveExpectedHeadFromIssueAndWorkspace({
      description: `## Exact Head\nExact head: \`${GOOD_SHA}\``,
      workspaceRepoRef: OTHER_SHA,
    });
    expect(sha).toBe(GOOD_SHA);
  });

  it("accepts full-sha workspace repoRef when description lacks head", () => {
    expect(
      resolveExpectedHeadFromIssueAndWorkspace({
        description: "## Scope\nwork",
        workspaceRepoRef: GOOD_SHA,
      }),
    ).toBe(GOOD_SHA);
  });

  it("rejects branch names", () => {
    expect(
      resolveExpectedHeadFromIssueAndWorkspace({
        description: null,
        workspaceRepoRef: "main",
        workspaceDefaultRef: "origin/main",
      }),
    ).toBeNull();
  });

  it("fails closed on conflicting explicit heads instead of falling back to workspace metadata", () => {
    expect(
      resolveExpectedHeadFromIssueAndWorkspace({
        description: `Exact head: \`${GOOD_SHA}\`\nExact head: \`${OTHER_SHA}\``,
        workspaceRepoRef: GOOD_SHA,
      }),
    ).toBeNull();
  });
});

describe("shouldInheritProjectWorkspace (C3)", () => {
  it("never inherits when caller set explicit projectWorkspaceId", () => {
    expect(
      shouldInheritProjectWorkspace({
        explicitProjectWorkspaceId: "pws-explicit",
        sourceProjectWorkspaceId: "pws-parent",
        sameProjectId: true,
      }),
    ).toBe(false);
  });

  it("blocks cross-project inheritance", () => {
    expect(
      shouldInheritProjectWorkspace({
        sourceProjectWorkspaceId: "pws-gym",
        sameProjectId: false,
        sourceRepoUrl: "https://github.com/gloopsAI/paperclip-gym.git",
      }),
    ).toBe(false);
  });

  it("allows same-project inheritance", () => {
    expect(
      shouldInheritProjectWorkspace({
        sourceProjectWorkspaceId: "pws-ui",
        sameProjectId: true,
        sourceRepoUrl: "https://github.com/gloopsAI/gloops-ui.git",
      }),
    ).toBe(true);
  });

  it("blocks mismatched intended repo", () => {
    expect(
      shouldInheritProjectWorkspace({
        sourceProjectWorkspaceId: "pws-gym",
        sameProjectId: true,
        sourceRepoUrl: "https://github.com/gloopsAI/paperclip-gym.git",
        intendedRepoUrl: "https://github.com/gloopsAI/gloops-ui.git",
      }),
    ).toBe(false);
  });

  it("fail-closed when sameProjectId unknown and no intended repo", () => {
    expect(
      shouldInheritProjectWorkspace({
        sourceProjectWorkspaceId: "pws-unknown",
        sourceRepoUrl: "https://github.com/gloopsAI/paperclip-gym.git",
      }),
    ).toBe(false);
  });
});

describe("issueRequiresWorkspaceAdmit", () => {
  it("requires admit for standard implement packets", () => {
    expect(
      issueRequiresWorkspaceAdmit({
        title: "Implement workspace admit hard gate for product work",
        description: [
          "## Scope",
          "Wire checkout and claim to workspace admit preflight.",
          "## Acceptance",
          "Checkout returns 422 when lease is dirty or wrong head.",
        ].join("\n"),
        repositoryBacked: true,
      }),
    ).toBe(true);
  });

  it("skips probe workMode (skill_test/ask)", () => {
    expect(
      issueRequiresWorkspaceAdmit({
        title: "ping",
        description: "hi",
        workMode: "skill_test",
      }),
    ).toBe(false);
    expect(
      issueRequiresWorkspaceAdmit({
        title: "ask a question about the repo layout",
        description: "what is the package manager?",
        workMode: "ask",
      }),
    ).toBe(false);
  });

  it("skips coordination roles", () => {
    expect(
      issueRequiresWorkspaceAdmit({
        title: "Coordinate the release train schedule",
        description: "## Objective\nKeep agents unblocked.\n## Acceptance\nBoard is current.",
        assigneeRole: "pm",
        assigneeName: "Dispatch",
      }),
    ).toBe(false);
  });

  it("skips Sentinel/Harbor ops plane residuals", () => {
    expect(
      issueRequiresWorkspaceAdmit({
        title: "[Sentinel/Plane] induct lease dirty",
        description: [
          "## Plane residual (ops — not product code work)",
          "Host plane babysitting residual.",
          "## Decision/Outcome",
          "Plane preflight green with empty criticalCodes.",
        ].join("\n"),
        assigneeName: "Sentinel",
        assigneeRole: "engineer",
      }),
    ).toBe(false);
    expect(
      issueRequiresWorkspaceAdmit({
        title: "[Sentinel/Plane] campaign deadline / epoch",
        description: [
          "## Plane residual (ops — not product code work)",
          "Harbor reopens campaigns via standing auth.",
          "## Decision/Outcome",
          "Campaign hours remaining ≥ 12.",
        ].join("\n"),
        assigneeName: "Harbor",
        assigneeRole: "devops",
      }),
    ).toBe(false);
  });
});

describe("evaluateWorkspaceAdmitCreateRequirements (C2)", () => {
  const enforceEnv = { PAPERCLIP_WORKSPACE_ADMIT_CREATE: "enforce" };

  it("does not require workspace for ops plane residual create", () => {
    const result = evaluateWorkspaceAdmitCreateRequirements({
      title: "[Sentinel/Plane] induct lease dirty",
      description: [
        "## Plane residual (ops — not product code work)",
        "Restore plane preflight without paging Zach.",
        "## Decision/Outcome",
        "Plane preflight green with empty criticalCodes.",
      ].join("\n"),
      assigneeName: "Sentinel",
      assigneeRole: "engineer",
      explicitProjectWorkspaceId: false,
      explicitExecutionWorkspaceId: false,
      env: enforceEnv,
    });
    expect(result.required).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });

  it("requires explicit workspace + full sha for implement", () => {
    const result = evaluateWorkspaceAdmitCreateRequirements({
      title: "Implement workspace admit create gate for product issues",
      description: [
        "## Scope",
        "Require explicit projectWorkspaceId and Exact head on create.",
        "## Acceptance",
        "Create refuses implement packets without workspace + 40-char SHA.",
        `## Exact Head`,
        `Exact head: \`${GOOD_SHA}\``,
      ].join("\n"),
      explicitProjectWorkspaceId: false,
      explicitExecutionWorkspaceId: false,
      resolvedBaseRefSha: GOOD_SHA,
      env: enforceEnv,
    });
    expect(result.required).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toContain(WORKSPACE_ADMIT_REASON.MISSING_EXPLICIT_WORKSPACE);
  });

  it("passes when explicit PWS and full sha present", () => {
    const result = evaluateWorkspaceAdmitCreateRequirements({
      title: "Implement workspace admit create gate for product issues",
      description: [
        "## Scope",
        "Require explicit projectWorkspaceId and Exact head on create.",
        "## Acceptance",
        "Create refuses implement packets without workspace + 40-char SHA.",
        `Exact head: \`${GOOD_SHA}\``,
      ].join("\n"),
      explicitProjectWorkspaceId: true,
      explicitExecutionWorkspaceId: false,
      resolvedBaseRefSha: GOOD_SHA,
      env: enforceEnv,
    });
    expect(result.ok).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });

  it("is off under vitest default", () => {
    const result = evaluateWorkspaceAdmitCreateRequirements({
      title: "Implement something",
      description: "## Scope\nx\n## Acceptance\ny",
      explicitProjectWorkspaceId: false,
      explicitExecutionWorkspaceId: false,
      env: { VITEST: "true" },
    });
    expect(result.ok).toBe(true);
    expect(result.required).toBe(false);
  });
});

describe("formatWorkspaceAdmitFailureComment (C4)", () => {
  it("includes errorCode matching primary reason", () => {
    const result: WorkspaceAdmitPreflightResult = {
      admitted: false,
      checks: [],
      reasonCodes: [
        WORKSPACE_ADMIT_REASON.DIRTY_TREE,
        WORKSPACE_ADMIT_REASON.HEAD_MISMATCH,
      ],
      expectedHeadSha: GOOD_SHA,
      observedHeadSha: OTHER_SHA,
      projectWorkspaceId: "pws-1",
      cwd: "/tmp/ws",
      repoUrl: "https://github.com/gloopsAI/gloops-ui.git",
      details: "dirty and mismatch",
      receipt: {
        schemaVersion: "gloops.workspace-readiness-report.v1",
        admitted: false,
        reasonCodes: [WORKSPACE_ADMIT_REASON.DIRTY_TREE, WORKSPACE_ADMIT_REASON.HEAD_MISMATCH],
        checks: [],
        expectedHeadSha: GOOD_SHA,
        observedHeadSha: OTHER_SHA,
        projectWorkspaceId: "pws-1",
        executionWorkspaceId: null,
        cwd: "/tmp/ws",
        repoUrl: "https://github.com/gloopsAI/gloops-ui.git",
        reportDigest: `sha256:${"1".repeat(64)}`,
      },
    };
    const body = formatWorkspaceAdmitFailureComment(result);
    const primary = primaryWorkspaceAdmitErrorCode(result);
    expect(primary).toBe(WORKSPACE_ADMIT_REASON.DIRTY_TREE);
    expect(body).toContain(`errorCode: \`${primary}\``);
    expect(body).toContain(WORKSPACE_ADMIT_REASON.DIRTY_TREE);
    expect(body).toContain(GOOD_SHA);
    expect(body).toContain(`sha256:${"1".repeat(64)}`);
  });

  it("falls back to workspace_admit.not_ready when no codes", () => {
    const result: WorkspaceAdmitPreflightResult = {
      admitted: false,
      checks: [],
      reasonCodes: [],
      expectedHeadSha: null,
      observedHeadSha: null,
      projectWorkspaceId: null,
      cwd: null,
      repoUrl: null,
      details: "unknown",
      receipt: {
        schemaVersion: "gloops.workspace-readiness-report.v1",
        admitted: false,
        reasonCodes: [],
        checks: [],
        expectedHeadSha: null,
        observedHeadSha: null,
        projectWorkspaceId: null,
        executionWorkspaceId: null,
        cwd: null,
        repoUrl: null,
        reportDigest: `sha256:${"2".repeat(64)}`,
      },
    };
    const body = formatWorkspaceAdmitFailureComment(result);
    expect(body).toContain(`errorCode: \`${WORKSPACE_ADMIT_REASON.NOT_READY}\``);
  });
});
