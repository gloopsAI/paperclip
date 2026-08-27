import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  SSH_GIT_CREDENTIAL_TOKEN_ENV_KEY,
  SSH_GIT_LFS_MISSING_CREDENTIAL_MESSAGE,
  prepareWorkspaceForSshExecution,
  workspaceRequiresGitHubLfsNetworkAccess,
  type SshGitAuthInvocation,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function createRepo(rootDir: string, name = "repo"): Promise<string> {
  const repo = path.join(rootDir, name);
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["checkout", "-b", "main"]);
  await git(repo, ["config", "user.name", "Paperclip Test"]);
  await git(repo, ["config", "user.email", "test@paperclip.dev"]);
  await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "base"]);
  return repo;
}

async function addGitLfsPointer(repo: string): Promise<void> {
  await writeFile(
    path.join(repo, ".gitattributes"),
    "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    "utf8",
  );
  await writeFile(
    path.join(repo, "asset.bin"),
    [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "size 21",
      "",
    ].join("\n"),
    "utf8",
  );
  await git(repo, ["add", ".gitattributes", "asset.bin"]);
  await git(repo, ["commit", "-m", "lfs pointer"]);
}

function unreachableSshSpec(): SshRemoteExecutionSpec {
  return {
    host: "127.0.0.1",
    port: 1,
    username: "nobody",
    remoteWorkspacePath: "/tmp/paperclip-ssh-unreachable",
    remoteCwd: "/tmp/paperclip-ssh-unreachable",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: false,
  };
}

function fixtureAuth(token: string, extra?: Partial<SshGitAuthInvocation>): SshGitAuthInvocation {
  return {
    configArgs: [
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=!f() { printf 'username=x-access-token\\npassword=%s\\n' "$${SSH_GIT_CREDENTIAL_TOKEN_ENV_KEY}"; }; f`,
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=true",
      "-c",
      "filter.lfs.smudge=git-lfs smudge -- %f",
    ],
    env: {
      [SSH_GIT_CREDENTIAL_TOKEN_ENV_KEY]: token,
      GIT_TERMINAL_PROMPT: "0",
      ...extra?.env,
    },
    ...extra,
  };
}

describe("SSH GitHub LFS credential preflight", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("requires GitHub HTTPS LFS auth only when HEAD has LFS pointers and origin is github.com", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-lfs-detect-"));
    cleanupDirs.push(rootDir);
    const lfsRepo = await createRepo(rootDir, "lfs");
    await addGitLfsPointer(lfsRepo);
    await git(lfsRepo, ["remote", "add", "origin", "https://github.com/InductAI/induct.git"]);

    const plainRepo = await createRepo(rootDir, "plain");
    await git(plainRepo, ["remote", "add", "origin", "https://github.com/InductAI/induct.git"]);

    const otherHost = await createRepo(rootDir, "other");
    await addGitLfsPointer(otherHost);
    await git(otherHost, ["remote", "add", "origin", "https://example.invalid/repo.git"]);

    await expect(workspaceRequiresGitHubLfsNetworkAccess(lfsRepo)).resolves.toEqual({
      required: true,
      originUrl: "https://github.com/InductAI/induct.git",
    });
    await expect(workspaceRequiresGitHubLfsNetworkAccess(plainRepo)).resolves.toEqual({
      required: false,
      originUrl: "https://github.com/InductAI/induct.git",
    });
    await expect(workspaceRequiresGitHubLfsNetworkAccess(otherHost)).resolves.toEqual({
      required: false,
      originUrl: "https://example.invalid/repo.git",
    });
  });

  it("fails closed before git bundle create when GitHub LFS auth is missing", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-lfs-preflight-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await addGitLfsPointer(repo);
    await git(repo, ["remote", "add", "origin", "https://github.com/InductAI/induct.git"]);
    await writeFile(path.join(repo, "dirty-untracked.txt"), "keep me\n", "utf8");
    const headBefore = await git(repo, ["rev-parse", "HEAD"]);
    const statusBefore = await git(repo, ["status", "--porcelain"]);

    const wrapperDir = path.join(rootDir, "git-wrapper");
    await mkdir(wrapperDir, { recursive: true });
    const logPath = path.join(rootDir, "git-args.log");
    const realGit = (await execFile("sh", ["-c", "command -v git"], { encoding: "utf8" })).stdout.trim();
    await writeFile(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    await chmod(path.join(wrapperDir, "git"), 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(prepareWorkspaceForSshExecution({
        spec: unreachableSshSpec(),
        localDir: repo,
        resolveGitAuth: async () => null,
      })).rejects.toThrow(SSH_GIT_LFS_MISSING_CREDENTIAL_MESSAGE);

      const gitLog = await readFile(logPath, "utf8").catch(() => "");
      expect(gitLog).not.toMatch(/\bbundle create\b/);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
      expect(await readFile(path.join(repo, "dirty-untracked.txt"), "utf8")).toBe("keep me\n");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("creates the git bundle after a present GitHub LFS credential and does not embed the token in git argv", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-lfs-present-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await addGitLfsPointer(repo);
    await git(repo, ["remote", "add", "origin", "https://github.com/InductAI/induct.git"]);
    const token = "ghp_fixturetokenAAAAAAAAAAAAAAAAAAAA";

    const wrapperDir = path.join(rootDir, "git-wrapper");
    await mkdir(wrapperDir, { recursive: true });
    const logPath = path.join(rootDir, "git-args.log");
    const realGit = (await execFile("sh", ["-c", "command -v git"], { encoding: "utf8" })).stdout.trim();
    await writeFile(
      path.join(wrapperDir, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    await chmod(path.join(wrapperDir, "git"), 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(prepareWorkspaceForSshExecution({
        spec: unreachableSshSpec(),
        localDir: repo,
        resolveGitAuth: async () => fixtureAuth(token),
      })).rejects.toThrow(/ssh: connect to host 127\.0\.0\.1 port 1/);

      const gitLog = await readFile(logPath, "utf8");
      expect(gitLog).toMatch(/\bbundle create\b/);
      expect(gitLog).not.toContain(token);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("does not require credentials for a non-LFS GitHub workspace before import", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-non-lfs-"));
    cleanupDirs.push(rootDir);
    const repo = await createRepo(rootDir);
    await git(repo, ["remote", "add", "origin", "https://github.com/paperclipai/paperclip.git"]);

    await expect(workspaceRequiresGitHubLfsNetworkAccess(repo)).resolves.toEqual({
      required: false,
      originUrl: "https://github.com/paperclipai/paperclip.git",
    });
  });
});

describe("SSH GitHub LFS auth invocation", () => {
  it("keeps the token in helper env and out of git config argv", () => {
    const token = "ghp_fixturetokenAAAAAAAAAAAAAAAAAAAA";
    const invocation = fixtureAuth(token);
    expect(invocation.configArgs.join(" ")).not.toContain(token);
    expect(invocation.env[SSH_GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe(token);
  });
});
