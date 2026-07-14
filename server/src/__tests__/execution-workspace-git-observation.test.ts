import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectExecutionWorkspaceGit } from "../services/execution-workspaces.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("host-observed execution workspace Git evidence", () => {
  it("binds a clean workspace to its exact HEAD and changes digest when the tree becomes dirty", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-observation-"));
    cleanup.push(repo);
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "paperclip@example.test"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Paperclip Test"], { cwd: repo });
    await fs.writeFile(path.join(repo, "README.md"), "trusted\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: repo });
    await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: repo });

    const clean = await inspectExecutionWorkspaceGit({ providerRef: repo, cwd: repo });
    expect(clean.state).toBe("available");
    expect(clean.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(clean.changedAt).toMatch(/Z$/);
    expect(clean.dirty).toBe(false);

    await fs.writeFile(path.join(repo, "README.md"), "dirty\n", "utf8");
    const dirty = await inspectExecutionWorkspaceGit({ providerRef: repo, cwd: repo });
    expect(dirty.headSha).toBe(clean.headSha);
    expect(dirty.digest).not.toBe(clean.digest);
    expect(dirty.dirty).toBe(true);
  });

  it("fails closed when the workspace is absent", async () => {
    const observation = await inspectExecutionWorkspaceGit({ providerRef: "/definitely/missing/paperclip-workspace", cwd: null });
    expect(observation).toMatchObject({ state: "missing", headSha: null, digest: null, dirty: null });
  });
});
