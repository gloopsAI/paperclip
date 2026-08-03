import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const tool = path.resolve(path.dirname(new URL(import.meta.url).pathname), "github-push-tool.bundle.cjs");
const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function markRemoteBase(repo, oid = "HEAD") {
  git(repo, "update-ref", "refs/remotes/origin/gloops/stable", oid);
}

function runTool(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runClientAgainstBroker(repo, root) {
  const ingress = path.join(root, "ingress");
  const socket = path.join(root, "broker.sock");
  fs.mkdirSync(ingress);
  const head = git(repo, "rev-parse", "HEAD");

  let resolveObserved;
  let rejectObserved;
  const observed = new Promise((resolve, reject) => {
    resolveObserved = resolve;
    rejectObserved = reject;
  });
  const server = net.createServer((client) => {
    let input = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => { input += chunk; });
    client.on("end", () => {
      try {
        const request = JSON.parse(input);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(ingress, request.manifestName), "utf8"),
        );
        const pack = fs.readFileSync(path.join(ingress, manifest.packName));
        assert.equal(request.expectedNewOid, head);
        assert.equal(manifest.expectedNewOid, head);
        assert.equal(manifest.objectCount, manifest.objectOids.length);
        assert.ok(manifest.objectOids.includes(head));
        assert.equal(manifest.packBytes, pack.length);
        client.end(JSON.stringify({
          ok: true,
          schemaVersion: "gloops.github-push-client-response.v1",
          heartbeatRunId: runId,
          branchRef: `refs/heads/paperclip/${runId}/calibration`,
          remoteNewOid: head,
          brokerReceiptDigest: `sha256:${"a".repeat(64)}`,
        }));
        server.close(() => resolveObserved(manifest));
      } catch (error) {
        rejectObserved(error);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  const toolRun = runTool([
    "client",
    "--run-id", runId,
    "--repo-dir", repo,
    "--socket", socket,
    "--ingress", ingress,
  ], repo).then((result) => {
    if (result.status !== 0) {
      server.close();
      rejectObserved(new Error(result.stderr));
    }
    return result;
  });
  const [result, manifest] = await Promise.all([toolRun, observed]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).remoteNewOid, head);
  assert.deepEqual(fs.readdirSync(ingress), []);
  assert.ok(manifest.objectCount >= 3);
  return manifest;
}

test("client emits a content-addressed commit closure without retaining ingress files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "remote base\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "remote base");
  markRemoteBase(repo);
  fs.writeFileSync(path.join(repo, "proof.txt"), "one owner, one run, one push\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "calibration proof");
  await runClientAgainstBroker(repo, root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client bounds a deep history at the direct remote-base parent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-deep-history-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  for (let index = 0; index < 80; index += 1) {
    fs.writeFileSync(path.join(repo, "history.txt"), `history ${index}\n`);
    git(repo, "add", "history.txt");
    git(repo, "commit", "-m", `history ${index}`);
  }
  const base = git(repo, "rev-parse", "HEAD");
  const preBase = git(repo, "rev-parse", "HEAD~1");
  markRemoteBase(repo, base);
  fs.writeFileSync(path.join(repo, "proof.txt"), "bounded delta\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "bounded delta");

  const manifest = await runClientAgainstBroker(repo, root);
  assert.ok(manifest.objectOids.includes(base));
  assert.ok(!manifest.objectOids.includes(preBase));
  assert.ok(manifest.objectCount <= 8, `expected bounded closure, got ${manifest.objectCount}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client includes every commit in a local stack above the published base", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-stacked-history-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "base\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "published base");
  const base = git(repo, "rev-parse", "HEAD");
  markRemoteBase(repo, base);
  const commits = [];
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(path.join(repo, "proof.txt"), `stack ${index}\n`);
    git(repo, "add", "proof.txt");
    git(repo, "commit", "-m", `stack ${index}`);
    commits.push(git(repo, "rev-parse", "HEAD"));
  }
  const manifest = await runClientAgainstBroker(repo, root);
  assert.ok(manifest.objectOids.includes(base));
  for (const oid of commits) assert.ok(manifest.objectOids.includes(oid));
  fs.rmSync(root, { recursive: true, force: true });
});

test("client fails closed when a remote-base parent is unavailable", async (t) => {
  await t.test("root commit has no base", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-root-base-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.name", "Calibration");
    git(repo, "config", "user.email", "calibration@example.com");
    fs.writeFileSync(path.join(repo, "proof.txt"), "root\n");
    git(repo, "add", "proof.txt");
    git(repo, "commit", "-m", "root");
    const result = await runTool([
      "client",
      "--run-id", runId,
      "--repo-dir", repo,
      "--socket", path.join(root, "missing.sock"),
      "--ingress", root,
    ], repo);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /published base boundary is unavailable/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test("declared base object is missing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-missing-base-"));
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init");
    git(repo, "config", "user.name", "Calibration");
    git(repo, "config", "user.email", "calibration@example.com");
    fs.writeFileSync(path.join(repo, "proof.txt"), "root\n");
    git(repo, "add", "proof.txt");
    git(repo, "commit", "-m", "root");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    const missing = "f".repeat(40);
    const body = [
      `tree ${tree}`,
      `parent ${missing}`,
      "author Calibration <calibration@example.com> 1700000000 +0000",
      "committer Calibration <calibration@example.com> 1700000000 +0000",
      "",
      "missing base",
      "",
    ].join("\n");
    const literal = spawnSync("git", ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], {
      cwd: repo,
      input: body,
      encoding: "utf8",
    });
    assert.equal(literal.status, 0, literal.stderr);
    git(repo, "update-ref", "HEAD", literal.stdout.trim());
    const result = await runTool([
      "client",
      "--run-id", runId,
      "--repo-dir", repo,
      "--socket", path.join(root, "missing.sock"),
      "--ingress", root,
    ], repo);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /base-aware revision walk failed/i);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test("client accepts contained committed symlinks in the content-addressed closure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-contained-symlink-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "base.txt"), "remote base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "remote base");
  markRemoteBase(repo);
  fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".agents", "skills"), { recursive: true });
  fs.mkdirSync(path.join(repo, "skills"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".agents", "skills", "company-creator"), "company creator\n");
  fs.writeFileSync(path.join(repo, "skills", "paperclip"), "paperclip\n");
  fs.symlinkSync("../../.agents/skills/company-creator", path.join(repo, ".claude", "skills", "company-creator"));
  fs.symlinkSync("../../skills/paperclip", path.join(repo, ".claude", "skills", "paperclip"));
  git(repo, "add", "--all");
  git(repo, "commit", "-m", "contained symlink closure");

  await runClientAgainstBroker(repo, root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client rejects unsafe committed symlink targets before contacting the broker", async (t) => {
  const cases = [
    ["absolute", "/etc/passwd"],
    ["escaping", "../../../outside"],
    ["git-boundary", "../../.git/config"],
    ["case-folded-git-boundary", "../../.GIT/hooks"],
    ["nested-git-boundary", "../../sub/.git/config"],
    ["windows-drive-absolute", "C:/outside"],
    ["windows-drive-relative", "C:outside"],
    ["control-bearing", "bad\npath"],
    ["backslash-bearing", "..\\..\\outside"],
  ];
  for (const [name, target] of cases) {
    await t.test(name, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `github-push-client-${name}-symlink-`));
      const repo = path.join(root, "repo");
      fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
      git(repo, "init");
      git(repo, "config", "user.name", "Calibration");
      git(repo, "config", "user.email", "calibration@example.com");
      fs.writeFileSync(path.join(repo, "base.txt"), "remote base\n");
      git(repo, "add", "base.txt");
      git(repo, "commit", "-m", "remote base");
      markRemoteBase(repo);
      fs.symlinkSync(target, path.join(repo, ".claude", "skills", "unsafe"));
      git(repo, "add", "--all");
      git(repo, "commit", "-m", `${name} symlink target`);
      const result = await runTool([
        "client",
        "--run-id", runId,
        "--repo-dir", repo,
        "--socket", path.join(root, "missing.sock"),
        "--ingress", root,
      ], repo);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe symbolic link target/);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }
});

test("client revalidates a reused symlink subtree in every repository path context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-reused-symlink-tree-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "deep", "nested"), { recursive: true });
  fs.mkdirSync(path.join(repo, "nested"), { recursive: true });
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "base.txt"), "remote base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "remote base");
  markRemoteBase(repo);
  fs.writeFileSync(path.join(repo, "inside"), "inside\n");
  fs.symlinkSync("../../inside", path.join(repo, "deep", "nested", "link"));
  fs.symlinkSync("../../inside", path.join(repo, "nested", "link"));
  git(repo, "add", "--all");
  git(repo, "commit", "-m", "same symlink tree in safe and escaping contexts");
  assert.equal(
    git(repo, "rev-parse", "HEAD:deep/nested"),
    git(repo, "rev-parse", "HEAD:nested"),
    "fixture must reuse the exact same tree object",
  );

  const result = await runTool([
    "client",
    "--run-id", runId,
    "--repo-dir", repo,
    "--socket", path.join(root, "missing.sock"),
    "--ingress", root,
  ], repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe symbolic link target/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client rejects empty, oversized, and non-UTF-8 symlink blobs", async (t) => {
  const cases = [
    ["empty", Buffer.alloc(0)],
    ["oversized", Buffer.alloc(4097, "a")],
    ["non-utf8", Buffer.from([0xff])],
  ];
  for (const [name, blob] of cases) {
    await t.test(name, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `github-push-client-${name}-symlink-blob-`));
      const repo = path.join(root, "repo");
      fs.mkdirSync(repo);
      git(repo, "init");
      git(repo, "config", "user.name", "Calibration");
      git(repo, "config", "user.email", "calibration@example.com");
      fs.writeFileSync(path.join(repo, "base.txt"), "remote base\n");
      git(repo, "add", "base.txt");
      git(repo, "commit", "-m", "remote base");
      markRemoteBase(repo);
      const hashed = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: repo,
        input: blob,
        encoding: "utf8",
      });
      assert.equal(hashed.status, 0, hashed.stderr);
      const oid = hashed.stdout.trim();
      git(repo, "update-index", "--add", "--cacheinfo", `120000,${oid},.claude/skills/unsafe`);
      git(repo, "commit", "-m", `${name} symlink blob`);
      const result = await runTool([
        "client",
        "--run-id", runId,
        "--repo-dir", repo,
        "--socket", path.join(root, "missing.sock"),
        "--ingress", root,
      ], repo);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe symbolic link target/);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }
});

test("client rejects a committed gitlink before contacting the broker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-gitlink-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  markRemoteBase(repo, base);
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${base},vendor/submodule`);
  git(repo, "commit", "-m", "gitlink must be rejected");
  const result = await runTool([
    "client",
    "--run-id", runId,
    "--repo-dir", repo,
    "--socket", path.join(root, "missing.sock"),
    "--ingress", root,
  ], repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported object type or mode/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client emits a commit closure from a Paperclip-managed git worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-worktree-"));
  const repo = path.join(root, "repo");
  const worktreeParent = path.join(repo, ".paperclip", "worktrees");
  const worktree = path.join(worktreeParent, "run");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "base\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "base");
  markRemoteBase(repo);
  fs.mkdirSync(worktreeParent, { recursive: true });
  git(repo, "worktree", "add", "-b", "paperclip-run", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "proof.txt"), "worktree proof\n");
  git(worktree, "add", "proof.txt");
  git(worktree, "commit", "-m", "worktree proof");

  await runClientAgainstBroker(worktree, root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client rejects a symlinked repository before contacting the broker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-symlink-"));
  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  fs.mkdirSync(real);
  fs.symlinkSync(real, linked);
  const result = await runTool([
    "client",
    "--run-id", runId,
    "--repo-dir", linked,
    "--socket", path.join(root, "missing.sock"),
    "--ingress", root,
  ], root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository path must be a real directory/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker imports a complete closure into a native bare repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-worker-native-"));
  const repo = path.join(root, "repo");
  const gitdir = path.join(root, "worker.git");
  const pack = path.join(root, "input.pack");
  const request = path.join(root, "request.json");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "base.txt"), "remote base\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "remote base");
  const parent = git(repo, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(repo, "nested"), { recursive: true });
  fs.writeFileSync(path.join(repo, "nested", "proof.txt"), "complete closure\n");
  git(repo, "add", "nested/proof.txt");
  git(repo, "commit", "-m", "nested closure");
  const head = git(repo, "rev-parse", "HEAD");
  const objectOids = [
    head,
    parent,
    git(repo, "rev-parse", "HEAD^{tree}"),
    git(repo, "rev-parse", "HEAD:base.txt"),
    git(repo, "rev-parse", "HEAD:nested"),
    git(repo, "rev-parse", "HEAD:nested/proof.txt"),
  ].sort();
  const packed = spawnSync("git", ["pack-objects", "--stdout"], {
    cwd: repo,
    input: `${objectOids.join("\n")}\n`,
  });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  fs.writeFileSync(pack, packed.stdout);
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    defaultBranch: "main",
    remoteRef: `refs/heads/paperclip/${runId}/calibration`,
    expectedOldOid: "0".repeat(40),
    expectedNewOid: head,
    objectOids,
    packPath: pack,
    gitdir,
  }));

  const result = await runTool(["validate", "--request", request], root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(root, "--git-dir", gitdir, "rev-parse", "--is-bare-repository"), "true");
  assert.equal(git(root, "--git-dir", gitdir, "cat-file", "-t", head), "commit");
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker accepts a contained committed symlink closure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-worker-symlink-"));
  const repo = path.join(root, "repo");
  const gitdir = path.join(root, "worker.git");
  const pack = path.join(root, "input.pack");
  const request = path.join(root, "request.json");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "target.txt"), "target\n");
  git(repo, "add", "target.txt");
  git(repo, "commit", "-m", "remote base");
  const parent = git(repo, "rev-parse", "HEAD");
  fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
  git(repo, "add", "link.txt");
  git(repo, "commit", "-m", "contained symlink closure");
  const head = git(repo, "rev-parse", "HEAD");
  const objectOids = [
    head,
    parent,
    git(repo, "rev-parse", "HEAD^{tree}"),
    git(repo, "rev-parse", "HEAD:link.txt"),
    git(repo, "rev-parse", "HEAD:target.txt"),
  ].sort();
  const packed = spawnSync("git", ["pack-objects", "--stdout"], {
    cwd: repo,
    input: `${objectOids.join("\n")}\n`,
  });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  fs.writeFileSync(pack, packed.stdout);
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    defaultBranch: "main",
    remoteRef: `refs/heads/paperclip/${runId}/calibration`,
    expectedOldOid: "0".repeat(40),
    expectedNewOid: head,
    objectOids,
    packPath: pack,
    gitdir,
  }));
  const result = await runTool(["validate", "--request", request], root);
  assert.equal(result.status, 0, result.stderr);
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker recognizes a root base boundary when an empty tip reuses its tree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-worker-empty-tip-"));
  const repo = path.join(root, "repo");
  const gitdir = path.join(root, "worker.git");
  const pack = path.join(root, "input.pack");
  const request = path.join(root, "request.json");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "same tree\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "root base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "--allow-empty", "-m", "empty bounded tip");
  const head = git(repo, "rev-parse", "HEAD");
  assert.equal(git(repo, "rev-parse", "HEAD^{tree}"), git(repo, "rev-parse", `${base}^{tree}`));
  const objectOids = [
    head,
    base,
    git(repo, "rev-parse", "HEAD^{tree}"),
    git(repo, "rev-parse", "HEAD:proof.txt"),
  ].sort();
  const packed = spawnSync("git", ["pack-objects", "--stdout"], {
    cwd: repo,
    input: `${objectOids.join("\n")}\n`,
  });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  fs.writeFileSync(pack, packed.stdout);
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    defaultBranch: "main",
    remoteRef: `refs/heads/paperclip/${runId}/calibration`,
    expectedOldOid: "0".repeat(40),
    expectedNewOid: head,
    objectOids,
    packPath: pack,
    gitdir,
  }));
  const result = await runTool(["validate", "--request", request], root);
  assert.equal(result.status, 0, result.stderr);
  fs.rmSync(root, { recursive: true, force: true });
});

test("isolated shallow repository pushes a bounded stack to a remote that holds the base", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-native-shallow-"));
  const repo = path.join(root, "repo");
  const remote = path.join(root, "remote.git");
  const worker = path.join(root, "worker.git");
  const pack = path.join(root, "input.pack");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "unchanged.txt"), "remote-held\n");
  fs.writeFileSync(path.join(repo, "changed.txt"), "base\n");
  git(repo, "add", "--all");
  git(repo, "commit", "-m", "published base");
  const base = git(repo, "rev-parse", "HEAD");
  git(root, "init", "--bare", remote);
  git(repo, "push", remote, `HEAD:refs/heads/gloops/stable`);
  fs.writeFileSync(path.join(repo, "changed.txt"), "new\n");
  git(repo, "add", "changed.txt");
  git(repo, "commit", "-m", "bounded change");
  const head = git(repo, "rev-parse", "HEAD");
  const objectOids = new Set([head, base, git(repo, "rev-parse", "HEAD^{tree}")]);
  for (const line of git(repo, "ls-tree", "-r", "HEAD").split("\n")) {
    const oid = /^\d+ \w+ ([0-9a-f]{40})\t/u.exec(line)?.[1];
    if (oid) objectOids.add(oid);
  }
  const packed = spawnSync("git", ["pack-objects", "--stdout"], {
    cwd: repo,
    input: `${[...objectOids].join("\n")}\n`,
  });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  fs.writeFileSync(pack, packed.stdout);
  git(root, "init", "--bare", worker);
  const workerPack = path.join(worker, "objects", "pack", "input.pack");
  fs.copyFileSync(pack, workerPack);
  git(root, "--git-dir", worker, "index-pack", workerPack);
  git(root, "--git-dir", worker, "update-ref", "refs/heads/paperclip-source", head);
  fs.writeFileSync(path.join(worker, "shallow"), `${base}\n`);
  git(
    root,
    "--git-dir", worker,
    "push",
    "--porcelain",
    remote,
    `refs/heads/paperclip-source:refs/heads/paperclip/${runId}/calibration`,
  );
  assert.equal(
    git(root, "--git-dir", remote, "rev-parse", `refs/heads/paperclip/${runId}/calibration`),
    head,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker rejects an overbroad ref before reading a credential or making a request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-worker-"));
  const request = path.join(root, "request.json");
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    defaultBranch: "main",
    remoteRef: "refs/heads/main",
    expectedOldOid: "0".repeat(40),
    expectedNewOid: "a".repeat(40),
    objectOids: ["a".repeat(40)],
    packPath: path.join(root, "input.pack"),
    gitdir: path.join(root, "repo.git"),
  }));
  const credentials = path.join(root, "credentials");
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(credentials, "github-token"), "ghs_not_observed\n");
  const result = await runTool(
    ["worker", "--request", request],
    root,
    { CREDENTIALS_DIRECTORY: credentials },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /accepted push contract/);
  fs.rmSync(root, { recursive: true, force: true });
});
