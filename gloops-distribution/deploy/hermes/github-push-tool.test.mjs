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
  const base = git(repo, "rev-parse", "HEAD^");

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
        if (request.schemaVersion === "gloops.github-push-prepare-request.v1") {
          assert.equal(request.expectedNewOid, head);
          const authorizationDigest = `sha256:${"b".repeat(64)}`;
          const preparationDigest = `sha256:${"c".repeat(64)}`;
          client.end(JSON.stringify({
            ok: true,
            schemaVersion: "gloops.github-push-prepare-response.v1",
            authorizationDigest,
            heartbeatRunId: runId,
            expectedNewOid: head,
            requiredBaseOid: base,
            preparationDigest,
          }));
          return;
        }
        const manifest = JSON.parse(
          fs.readFileSync(path.join(ingress, request.manifestName), "utf8"),
        );
        const pack = fs.readFileSync(path.join(ingress, manifest.packName));
        assert.equal(request.expectedNewOid, head);
        assert.equal(request.requiredBaseOid, base);
        assert.equal(manifest.expectedNewOid, head);
        assert.equal(manifest.requiredBaseOid, base);
        assert.equal(manifest.objectCount, manifest.objectOids.length);
        assert.ok(manifest.objectOids.includes(head));
        assert.ok(!manifest.objectOids.includes(base));
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

test("client emits a content-addressed claimed-base delta without retaining ingress files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "one owner, one run, one push\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "calibration proof");
  fs.writeFileSync(path.join(repo, "proof.txt"), "one owner, one run, one bounded delta\n");
  git(repo, "commit", "-am", "bounded delta");
  await runClientAgainstBroker(repo, root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client preserves a typed broker preparation denial", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-denial-"));
  const repo = path.join(root, "repo");
  const ingress = path.join(root, "ingress");
  const socket = path.join(root, "broker.sock");
  fs.mkdirSync(repo); fs.mkdirSync(ingress);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "base\n");
  git(repo, "add", "proof.txt"); git(repo, "commit", "-m", "base");
  fs.writeFileSync(path.join(repo, "proof.txt"), "candidate\n");
  git(repo, "commit", "-am", "candidate");
  const server = net.createServer((client) => {
    client.resume();
    client.on("end", () => client.end(JSON.stringify({
      ok: false,
      schemaVersion: "gloops.github-push-client-response.v1",
      error: "root authorization disagrees with the GitHub App repository boundary",
    })));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(socket, resolve);
  });
  const result = await runTool([
    "client", "--run-id", runId, "--repo-dir", repo,
    "--socket", socket, "--ingress", ingress,
  ], repo);
  server.close();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root authorization disagrees with the GitHub App repository boundary/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client delta size is independent of inherited history depth", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-history-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  for (let index = 0; index < 64; index += 1) {
    fs.writeFileSync(path.join(repo, "history.txt"), `${index}\n`);
    git(repo, "add", "history.txt");
    git(repo, "commit", "-m", `history ${index}`);
  }
  fs.writeFileSync(path.join(repo, "candidate.txt"), "bounded candidate\n");
  git(repo, "add", "candidate.txt");
  git(repo, "commit", "-m", "bounded candidate");
  const fullObjectCount = Number(git(repo, "rev-list", "--objects", "--count", "HEAD"));
  const manifest = await runClientAgainstBroker(repo, root);
  assert.ok(fullObjectCount > 64);
  assert.ok(manifest.objectCount <= 4, `expected bounded delta, got ${manifest.objectCount}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client transports tracked symlink blobs without following them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-tree-symlink-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "target.txt"), "target\n");
  git(repo, "add", "target.txt");
  git(repo, "commit", "-m", "base target");
  fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
  git(repo, "add", "link.txt");
  git(repo, "commit", "-m", "tracked symlink closure");

  const manifest = await runClientAgainstBroker(repo, root);
  const linkOid = git(repo, "rev-parse", "HEAD:link.txt");
  assert.ok(manifest.objectOids.includes(linkOid));
  assert.equal(git(repo, "cat-file", "-p", linkOid), "target.txt");
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
  fs.mkdirSync(worktreeParent, { recursive: true });
  git(repo, "worktree", "add", "-b", "paperclip-run", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "proof.txt"), "worktree proof\n");
  git(worktree, "add", "proof.txt");
  git(worktree, "commit", "-m", "worktree proof");

  await runClientAgainstBroker(worktree, root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client emits a commit closure from a governed sibling git worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-sibling-worktree-"));
  const repo = path.join(root, "paperclip-release");
  const worktree = path.join(root, "paperclip-glo2971");
  fs.mkdirSync(repo);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "base\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "worktree", "add", "-b", "paperclip-run", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "proof.txt"), "sibling worktree proof\n");
  git(worktree, "add", "proof.txt");
  git(worktree, "commit", "-m", "sibling worktree proof");

  await runClientAgainstBroker(worktree, root);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client rejects a linked worktree outside both governed layouts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-external-worktree-"));
  const repo = path.join(root, "paperclip-release");
  const externalParent = path.join(root, "external");
  const worktree = path.join(externalParent, "paperclip-run");
  fs.mkdirSync(repo);
  fs.mkdirSync(externalParent);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "base\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "worktree", "add", "-b", "external-run", worktree, "HEAD");

  const result = await runTool([
    "client",
    "--run-id", runId,
    "--repo-dir", worktree,
    "--socket", path.join(root, "missing.sock"),
    "--ingress", root,
  ], root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the Paperclip worktree boundary/);
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
  fs.mkdirSync(path.join(repo, "nested"), { recursive: true });
  fs.writeFileSync(path.join(repo, "nested", "proof.txt"), "complete closure\n");
  git(repo, "add", "nested/proof.txt");
  git(repo, "commit", "-m", "base closure");
  const base = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "nested", "proof.txt"), "descendant closure\n");
  git(repo, "commit", "-am", "descendant closure");
  const head = git(repo, "rev-parse", "HEAD");
  const objectOids = git(repo, "rev-list", "--objects", "--no-object-names", head, `^${base}`)
    .split("\n")
    .filter(Boolean)
    .sort();
  const packed = spawnSync("git", ["pack-objects", "--stdout", "--revs"], {
    cwd: repo,
    input: `${head}\n^${base}\n`,
  });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  fs.writeFileSync(pack, packed.stdout);
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    baseRepositoryUrl: `file://${repo}`,
    defaultBranch: "main",
    remoteRef: `refs/heads/paperclip/${runId}/calibration`,
    expectedOldOid: "0".repeat(40),
    expectedNewOid: head,
    requiredBaseOid: base,
    objectOids,
    packPath: pack,
    gitdir,
  }));

  const credentials = path.join(root, "credentials");
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(credentials, "github-token"), "ghs_test_read_only\n");
  const testEnv = { CREDENTIALS_DIRECTORY: credentials, GLOOPS_GITHUB_PUSH_TEST_MODE: "1" };
  const result = await runTool(["validate", "--request", request], root, testEnv);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(root, "--git-dir", gitdir, "rev-parse", "--is-bare-repository"), "true");
  assert.equal(git(root, "--git-dir", gitdir, "cat-file", "-t", head), "commit");
  const rejectedRequest = JSON.parse(fs.readFileSync(request, "utf8"));
  rejectedRequest.requiredBaseOid = "f".repeat(40);
  rejectedRequest.gitdir = path.join(root, "rejected-worker.git");
  fs.writeFileSync(request, JSON.stringify(rejectedRequest));
  const rejected = await runTool(["validate", "--request", request], root, testEnv);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /required base (?:commit|fetch)|descendant|not an ancestor/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker imports a committed symlink as a bare blob without following it", async () => {
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
  git(repo, "commit", "-m", "base target");
  const base = git(repo, "rev-parse", "HEAD");
  fs.symlinkSync("target.txt", path.join(repo, "link.txt"));
  git(repo, "add", "link.txt");
  git(repo, "commit", "-m", "tracked symlink is a bare blob");
  const head = git(repo, "rev-parse", "HEAD");
  const objectOids = git(repo, "rev-list", "--objects", "--no-object-names", head, `^${base}`)
    .split("\n")
    .filter(Boolean)
    .sort();
  const packed = spawnSync("git", ["pack-objects", "--stdout", "--revs"], {
    cwd: repo,
    input: `${head}\n^${base}\n`,
  });
  assert.equal(packed.status, 0, packed.stderr?.toString());
  fs.writeFileSync(pack, packed.stdout);
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    baseRepositoryUrl: `file://${repo}`,
    defaultBranch: "main",
    remoteRef: `refs/heads/paperclip/${runId}/calibration`,
    expectedOldOid: "0".repeat(40),
    expectedNewOid: head,
    requiredBaseOid: base,
    objectOids,
    packPath: pack,
    gitdir,
  }));
  const credentials = path.join(root, "credentials");
  fs.mkdirSync(credentials);
  fs.writeFileSync(path.join(credentials, "github-token"), "ghs_test_read_only\n");
  const result = await runTool(
    ["validate", "--request", request],
    root,
    { CREDENTIALS_DIRECTORY: credentials, GLOOPS_GITHUB_PUSH_TEST_MODE: "1" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(root, "--git-dir", gitdir, "cat-file", "-p", `${head}:link.txt`), "target.txt");
  fs.rmSync(root, { recursive: true, force: true });
});

test("worker rejects an overbroad ref before reading a credential or making a request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-worker-"));
  const request = path.join(root, "request.json");
  fs.writeFileSync(request, JSON.stringify({
    schemaVersion: "gloops.github-push-worker-request.v1",
    repositoryFullName: "gloopsAI/gloops-paperclip-plugin",
    baseRepositoryUrl: "https://github.com/gloopsAI/gloops-paperclip-plugin.git",
    defaultBranch: "main",
    remoteRef: "refs/heads/main",
    expectedOldOid: "0".repeat(40),
    expectedNewOid: "a".repeat(40),
    requiredBaseOid: "b".repeat(40),
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
