import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldExcludePath } from "./exclude-patterns.js";
import {
  WORKSPACE_HEAVY_DIR_EXCLUDES,
  WORKSPACE_HEAVY_DIR_NAMES,
  buildManagedWorkspaceArchiveExclude,
  expandWorkspaceHeavyDirExcludes,
  mergeWorkspaceArchiveExcludes,
} from "./workspace-archive-excludes.js";
import { buildRemoteManagedWorkspaceExclude } from "./remote-managed-runtime.js";

async function listTarMembers(rootDir: string, name: string, sourceDir: string, exclude: string[]): Promise<string[]> {
  const archivePath = path.join(rootDir, name);
  const excludeArgs = ["._*", ...exclude].flatMap((entry) => ["--exclude", entry]);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "tar",
      [...excludeArgs, "-cf", archivePath, "-C", sourceDir, "."],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
          return;
        }
        resolve();
      },
    );
  });
  const listed = await new Promise<string>((resolve, reject) => {
    execFile("tar", ["-tf", archivePath], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
  return listed
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter((entry) => entry.length > 0 && entry !== ".");
}

describe("workspace archive excludes", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("expands heavy directory names to root and nested tar patterns", () => {
    expect(WORKSPACE_HEAVY_DIR_NAMES).toContain("node_modules");
    expect(WORKSPACE_HEAVY_DIR_EXCLUDES).toEqual(
      expect.arrayContaining([
        "node_modules",
        "node_modules/*",
        "*/node_modules",
        "*/node_modules/*",
        "dist",
        "*/dist/*",
        ".cache",
        "*/.cache/*",
      ]),
    );
    expect(expandWorkspaceHeavyDirExcludes(["foo"])).toEqual([
      "foo",
      "foo/*",
      "*/foo",
      "*/foo/*",
    ]);
  });

  it("merges exclude groups uniquely and threads workspaceExclude + ignored paths", () => {
    expect(
      mergeWorkspaceArchiveExcludes(["a", "b"], ["b", "c"], undefined, null, [".claude/skills"]),
    ).toEqual(["a", "b", "c", ".claude/skills"]);

    const managed = buildManagedWorkspaceArchiveExclude({
      gitBacked: true,
      workspaceExclude: [".claude/skills", ".claude/skills/*"],
      gitIgnoredPaths: ["coverage-report"],
    });
    expect(managed).toEqual(
      expect.arrayContaining([
        "node_modules",
        "*/node_modules/*",
        ".git",
        ".git/*",
        ".paperclip-runtime",
        ".claude/skills",
        ".claude/skills/*",
        "coverage-report",
      ]),
    );
    expect(new Set(managed).size).toBe(managed.length);

    expect(
      buildRemoteManagedWorkspaceExclude({
        workspaceExclude: [".claude/skills"],
        gitIgnoredPaths: ["vendor-cache"],
      }),
    ).toEqual([".claude/skills", "vendor-cache"]);
  });

  it("matches nested dependency paths via shouldExcludePath against heavy excludes", () => {
    expect(shouldExcludePath("node_modules/pkg/index.js", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(true);
    expect(shouldExcludePath("packages/ui/node_modules/pkg/index.js", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(true);
    expect(shouldExcludePath("src/app.ts", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(false);
    expect(shouldExcludePath("packages/ui/src/app.ts", WORKSPACE_HEAVY_DIR_EXCLUDES)).toBe(false);
  });

  it("keeps source files and drops nested node_modules from a tar member listing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ws-archive-exclude-"));
    cleanupDirs.push(rootDir);
    const sourceDir = path.join(rootDir, "workspace");
    await mkdir(path.join(sourceDir, "src"), { recursive: true });
    await mkdir(path.join(sourceDir, "node_modules", "root-package"), { recursive: true });
    await mkdir(path.join(sourceDir, "packages", "ui", "node_modules", "nested-package"), { recursive: true });
    await writeFile(path.join(sourceDir, "src", "ok.ts"), "export const ok = true;\n", "utf8");
    await writeFile(path.join(sourceDir, "node_modules", "root-package", "cache.bin"), "root dep\n", "utf8");
    await writeFile(
      path.join(sourceDir, "packages", "ui", "node_modules", "nested-package", "cache.bin"),
      "nested dep\n",
      "utf8",
    );
    await mkdir(path.join(sourceDir, ".claude", "skills", "run-skill"), { recursive: true });
    await writeFile(path.join(sourceDir, ".claude", "skills", "run-skill", "SKILL.md"), "skill\n", "utf8");
    await writeFile(path.join(sourceDir, "src", "keep-me.ts"), "export const keep = true;\n", "utf8");

    const exclude = buildManagedWorkspaceArchiveExclude({
      gitBacked: true,
      workspaceExclude: [".claude/skills", ".claude/skills/*"],
    });
    const members = await listTarMembers(rootDir, "workspace.tar", sourceDir, exclude);

    expect(members).toContain("src/ok.ts");
    expect(members).toContain("src/keep-me.ts");
    expect(members.some((entry) => entry === "node_modules" || entry.startsWith("node_modules/"))).toBe(false);
    expect(members.some((entry) => entry.includes("/node_modules/") || entry.endsWith("/node_modules"))).toBe(false);
    expect(members.some((entry) => entry === ".git" || entry.startsWith(".git/"))).toBe(false);
    expect(members.some((entry) => entry.startsWith(".claude/skills"))).toBe(false);
    // Source under packages stays when it is not a heavy dir.
    await mkdir(path.join(sourceDir, "packages", "ui", "src"), { recursive: true });
    await writeFile(path.join(sourceDir, "packages", "ui", "src", "widget.ts"), "export {}\n", "utf8");
    const membersWithPackageSource = await listTarMembers(rootDir, "workspace-2.tar", sourceDir, exclude);
    expect(membersWithPackageSource).toContain("packages/ui/src/widget.ts");

    // Sanity: file on disk is still present for the retained source path.
    await expect(readFile(path.join(sourceDir, "src", "ok.ts"), "utf8")).resolves.toBe("export const ok = true;\n");
  });
});
