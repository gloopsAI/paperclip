import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendExactHeadToIntakeDescription,
  AUTHORIZED_INDUCT_INTAKE_REASON,
  evaluateAuthorizedInductWorkItemIntake,
} from "./authorized-induct-work-item-intake.js";

const COMPANY_ID = "company-1";
const PROJECT_ID = "project-induct";
const WORKSPACE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const tempDirs: string[] = [];

function makeLease(): { cwd: string; head: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), "authorized-induct-intake-"));
  tempDirs.push(cwd);
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return (result.stdout ?? "").trim();
  };
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Intake Test"]);
  mkdirSync(path.join(cwd, "src"));
  writeFileSync(path.join(cwd, "src", "main.ts"), "export const intake = true;\n");
  run(["add", "."]);
  run(["commit", "-m", "lease"]);
  return { cwd, head: run(["rev-parse", "HEAD"]).toLowerCase() };
}

afterEach(() => { while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true }); });

describe("authorized Induct work-item intake", () => {
  it("selects the configured managed lease and pins its exact head before emission", () => {
    const { cwd, head } = makeLease();
    const result = evaluateAuthorizedInductWorkItemIntake({
      boardAuthorized: true, companyId: COMPANY_ID, projectId: PROJECT_ID,
      requestedRepoUrl: "https://github.com/InductAI/induct.git",
      workspaceCandidates: [{ id: WORKSPACE_ID, companyId: COMPANY_ID, projectId: PROJECT_ID, cwd, repoUrl: "git@github.com:InductAI/induct.git", repoRef: head }],
      env: { PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS: WORKSPACE_ID },
    });
    expect(result.ok).toBe(true);
    expect(result.workspace?.id).toBe(WORKSPACE_ID);
    expect(result.exactHeadSha).toBe(head);
    expect(appendExactHeadToIntakeDescription("## Scope\n- src/main.ts", head)).toContain(`Exact head: \`${head}\``);
  });

  it("rejects a wrong repository namespace before task emission", () => {
    const result = evaluateAuthorizedInductWorkItemIntake({
      boardAuthorized: true, companyId: COMPANY_ID, projectId: PROJECT_ID,
      requestedRepoUrl: "https://github.com/gloopsAI/gloops-ui.git", workspaceCandidates: [],
      env: { PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS: WORKSPACE_ID },
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toEqual([AUTHORIZED_INDUCT_INTAKE_REASON.INVALID_TARGET]);
  });

  it("rejects a container-invisible lease before task emission", () => {
    const result = evaluateAuthorizedInductWorkItemIntake({
      boardAuthorized: true, companyId: COMPANY_ID, projectId: PROJECT_ID, requestedRepoUrl: "InductAI/induct",
      workspaceCandidates: [{ id: WORKSPACE_ID, companyId: COMPANY_ID, projectId: PROJECT_ID, cwd: "/container-invisible/induct-main", repoUrl: "https://github.com/InductAI/induct.git", repoRef: "a".repeat(40) }],
      env: { PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS: WORKSPACE_ID },
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toEqual([AUTHORIZED_INDUCT_INTAKE_REASON.LEASE_NOT_ADMITTED]);
    expect(result.details).toMatch(/does not exist/);
  });

  it("rejects a declared exact head that conflicts with the admitted lease", () => {
    const { cwd, head } = makeLease();
    const declaredHead = "b".repeat(40);
    const result = evaluateAuthorizedInductWorkItemIntake({
      boardAuthorized: true,
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      requestedRepoUrl: "InductAI/induct",
      description: `Base SHA: \`${declaredHead}\`\nExact head: \`${head}\``,
      workspaceCandidates: [
        {
          id: WORKSPACE_ID,
          companyId: COMPANY_ID,
          projectId: PROJECT_ID,
          cwd,
          repoUrl: "https://github.com/InductAI/induct.git",
          repoRef: head,
        },
      ],
      env: { PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS: WORKSPACE_ID },
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toEqual([
      AUTHORIZED_INDUCT_INTAKE_REASON.EXACT_HEAD_MISMATCH,
    ]);
    expect(result.details).toContain(declaredHead);
    expect(result.details).toContain(head);
  });

  it("does not let a configured workspace cross project identity", () => {
    const { cwd, head } = makeLease();
    const result = evaluateAuthorizedInductWorkItemIntake({
      boardAuthorized: true, companyId: COMPANY_ID, projectId: "project-other", requestedRepoUrl: "InductAI/induct",
      workspaceCandidates: [{ id: WORKSPACE_ID, companyId: COMPANY_ID, projectId: PROJECT_ID, cwd, repoUrl: "https://github.com/InductAI/induct.git", repoRef: head }],
      env: { PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS: WORKSPACE_ID },
    });
    expect(result.ok).toBe(false);
    expect(result.reasonCodes).toEqual([AUTHORIZED_INDUCT_INTAKE_REASON.PROJECT_WORKSPACE_MISMATCH]);
  });
});
