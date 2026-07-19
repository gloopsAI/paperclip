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

test("client emits a content-addressed commit closure without retaining ingress files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-push-client-"));
  const repo = path.join(root, "repo");
  const ingress = path.join(root, "ingress");
  const socket = path.join(root, "broker.sock");
  fs.mkdirSync(repo);
  fs.mkdirSync(ingress);
  git(repo, "init");
  git(repo, "config", "user.name", "Calibration");
  git(repo, "config", "user.email", "calibration@example.com");
  fs.writeFileSync(path.join(repo, "proof.txt"), "one owner, one run, one push\n");
  git(repo, "add", "proof.txt");
  git(repo, "commit", "-m", "calibration proof");
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
