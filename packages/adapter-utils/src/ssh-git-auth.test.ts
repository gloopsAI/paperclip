import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  SSH_GIT_CREDENTIAL_TOKEN_ENV_KEY,
  SSH_GIT_LFS_MISSING_CREDENTIAL_MESSAGE,
  buildSshGitAuthCheckoutRemoteCommand,
  mergeSshGitAuthCheckoutConfigArgs,
  prepareWorkspaceForSshExecution,
  redactThrownGitAuthError,
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

/** Matches `buildGitAuthInvocation` in server git-credentials: helper only, no LFS filters. */
function productionGitAuth(token: string, extraEnv?: Record<string, string>): SshGitAuthInvocation {
  const helper =
    `!f() { ok=; proto=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=github.com|host=www.github.com) ok=1;; protocol=https) proto=1;; esac; done; if [ "$1" = get ] && [ -n "$ok" ] && [ -n "$proto" ]; then printf 'username=x-access-token\\npassword=%s\\n' "$PAPERCLIP_GIT_TOKEN"; fi; }; f`;
  return {
    configArgs: [
      "-c",
      "credential.helper=",
      "-c",
      `credential.https://github.com.helper=${helper}`,
      "-c",
      `credential.https://www.github.com.helper=${helper}`,
    ],
    env: {
      [SSH_GIT_CREDENTIAL_TOKEN_ENV_KEY]: token,
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnv,
    },
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

async function collectUtf8Files(rootDir: string): Promise<string[]> {
  const bodies: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const body = await readFile(fullPath, "utf8").catch(() => "");
      bodies.push(body);
    }
  }
  return bodies;
}

describe("redactThrownGitAuthError", () => {
  const token = "ghp_example_token_value";

  it("returns the error unchanged when no token is provided", () => {
    const error = new Error("clone failed");
    expect(redactThrownGitAuthError(error)).toBe(error);
    expect(redactThrownGitAuthError(error, "")).toBe(error);
    expect(error.message).toBe("clone failed");
  });

  it("redacts the token from Error.message and optional stdout/stderr strings", () => {
    const error = Object.assign(new Error(`fatal: Authentication failed for ${token}`), {
      stderr: `remote: Invalid username or password: ${token}\n`,
      stdout: `hint: using token ${token}\n`,
    });
    const result = redactThrownGitAuthError(error, token) as Error & {
      stderr: string;
      stdout: string;
    };
    expect(result).toBe(error);
    expect(result.message).toContain("***REDACTED***");
    expect(result.message).not.toContain(token);
    expect(result.stderr).toContain("***REDACTED***");
    expect(result.stderr).not.toContain(token);
    expect(result.stdout).toContain("***REDACTED***");
    expect(result.stdout).not.toContain(token);
  });

  it("does not treat non-string stdout/stderr as redaction targets", () => {
    const error = Object.assign(new Error(`fail ${token}`), {
      stderr: 12,
      stdout: Buffer.from(token),
    });
    redactThrownGitAuthError(error, token);
    expect(error.message).not.toContain(token);
    expect((error as Error & { stderr: number }).stderr).toBe(12);
    expect(Buffer.isBuffer((error as Error & { stdout: Buffer }).stdout)).toBe(true);
    expect((error as Error & { stdout: Buffer }).stdout.toString()).toBe(token);
  });
});

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

  it("injects LFS smudge for production credential-only auth and keeps the token out of argv", () => {
    const token = "ghp_fixturetokenAAAAAAAAAAAAAAAAAAAA";
    const merged = mergeSshGitAuthCheckoutConfigArgs(productionGitAuth(token).configArgs);
    expect(merged.join(" ")).toContain("filter.lfs.smudge=git-lfs smudge -- %f");
    expect(merged.join(" ")).toContain("filter.lfs.required=true");
    expect(merged.join(" ")).not.toContain("filter.lfs.process=");
    expect(merged.join(" ")).not.toContain(token);
  });
});

describe("SSH GitHub LFS hydration through production auth", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("hydrates a restricted LFS pointer without ambient git config and without leaking the token into logs, comments, or files", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-lfs-hydrate-"));
    cleanupDirs.push(rootDir);
    const token = "ghp_fixturetokenAAAAAAAAAAAAAAAAAAAA";
    const payload = "hydrated-lfs-payload\n";
    const source = await createRepo(rootDir, "source");
    await addGitLfsPointer(source);
    await git(source, ["remote", "add", "origin", "https://github.com/InductAI/induct.git"]);
    const head = await git(source, ["rev-parse", "HEAD"]);

    const dest = path.join(rootDir, "dest");
    await mkdir(dest, { recursive: true });
    await git(dest, ["init"]);
    const bundlePath = path.join(rootDir, "workspace.bundle");
    const tempRef = "refs/paperclip/ssh-sync/import/test";
    await git(source, ["update-ref", tempRef, head]);
    await git(source, ["bundle", "create", bundlePath, tempRef]);
    await git(dest, ["fetch", "--force", bundlePath, `${tempRef}:${tempRef}`]);
    await git(dest, ["remote", "add", "origin", "https://github.com/InductAI/induct.git"]);
    await git(dest, ["config", "--local", "filter.lfs.process", "git-lfs filter-process"]);

    const fakeLfsDir = path.join(rootDir, "fake-lfs-bin");
    await mkdir(fakeLfsDir, { recursive: true });
    await writeFile(
      path.join(fakeLfsDir, "git-lfs"),
      `#!/bin/sh
if [ "$1" = "smudge" ]; then
  if [ -z "$PAPERCLIP_GIT_TOKEN" ]; then echo "missing Paperclip git token" >&2; exit 1; fi
  case "$PAPERCLIP_GIT_TOKEN" in
    ghp_*) ;;
    *) echo "rejected Paperclip git token" >&2; exit 1 ;;
  esac
  cat >/dev/null
  printf '%s\\n' 'hydrated-lfs-payload'
  exit 0
fi
echo "unexpected git-lfs invocation: $*" >&2
exit 1
`,
      { mode: 0o755 },
    );
    await chmod(path.join(fakeLfsDir, "git-lfs"), 0o755);

    const auth = productionGitAuth(token, {
      PATH: `${fakeLfsDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    const remoteCommand = buildSshGitAuthCheckoutRemoteCommand({
      remoteDir: dest,
      branchName: "main",
      headCommit: head,
      tempRef,
      auth,
    });
    expect(remoteCommand).not.toContain(token);
    expect(remoteCommand).toContain("filter.lfs.smudge=git-lfs smudge -- %f");

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("sh", ["-c", remoteCommand], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`checkout script timed out\n${stderr}`));
      }, 15_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(stderr.trim() || `checkout script exited ${code}`));
      });
      child.stdin.write(`${token}\n`);
      child.stdin.end();
    });

    const persistedRunLog = path.join(rootDir, "persisted-run.log");
    const issueComment = path.join(rootDir, "issue-comment.md");
    await writeFile(
      persistedRunLog,
      ["stdout:", result.stdout, "stderr:", result.stderr, "command:", remoteCommand].join("\n"),
      "utf8",
    );
    await writeFile(
      issueComment,
      `SSH Git LFS import completed.\n\n${result.stdout}\n${result.stderr}\n`,
      "utf8",
    );

    const restored = await readFile(path.join(dest, "asset.bin"), "utf8");
    expect(restored).toBe(payload);
    expect(restored).not.toMatch(/git-lfs\.github\.com\/spec\/v1/);
    expect(restored).not.toContain(token);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
    expect(await readFile(persistedRunLog, "utf8")).not.toContain(token);
    expect(await readFile(issueComment, "utf8")).not.toContain(token);
    for (const body of await collectUtf8Files(dest)) {
      expect(body).not.toContain(token);
    }
  }, 20_000);
});
