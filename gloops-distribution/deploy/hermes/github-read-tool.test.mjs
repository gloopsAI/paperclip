import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const tool = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "github-read-tool.mjs",
);

// Real target commit from the WG-PLAT-017 evidence: exact 40-hex lowercase SHA.
const COMMIT = "84a78a998e02249be20b8fccad6c43bdafdd8b2b";
const REPO = "gloopsAI/gloops-ui";

function runReadTool(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// A mock read broker that captures the single forwarded request line and
// answers with a bounded ok:true envelope, mirroring the real socket protocol.
function startMockBroker(socketPath) {
  let captured = null;
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0 && captured === null) {
        captured = JSON.parse(buf.slice(0, nl));
        sock.end(JSON.stringify({ ok: true, data: { echoed: captured } }) + "\n");
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, ready, getCaptured: () => captured };
}

async function withBroker(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-read-tool-"));
  const socketPath = path.join(root, "broker.sock");
  const broker = startMockBroker(socketPath);
  await broker.ready;
  try {
    return await fn({ socketPath, broker });
  } finally {
    broker.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// -- request-shape forwarding for each new source-inventory operation --------

test("get-repo-source-metadata forwards {operation,repo,commit}", async () => {
  await withBroker(async ({ socketPath, broker }) => {
    const result = await runReadTool(
      ["--operation", "get-repo-source-metadata", "--repo", REPO, "--commit", COMMIT],
      { GITHUB_READ_BROKER_SOCKET: socketPath },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(broker.getCaptured(), {
      operation: "get-repo-source-metadata",
      repo: REPO,
      commit: COMMIT,
    });
  });
});

test("list-source-tree without --path-prefix omits pathPrefix (root listing)", async () => {
  await withBroker(async ({ socketPath, broker }) => {
    const result = await runReadTool(
      ["--operation", "list-source-tree", "--repo", REPO, "--commit", COMMIT],
      { GITHUB_READ_BROKER_SOCKET: socketPath },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(broker.getCaptured(), {
      operation: "list-source-tree",
      repo: REPO,
      commit: COMMIT,
    });
  });
});

test("list-source-tree forwards a safe --path-prefix", async () => {
  await withBroker(async ({ socketPath, broker }) => {
    const result = await runReadTool(
      ["--operation", "list-source-tree", "--repo", REPO, "--commit", COMMIT,
        "--path-prefix", "src/components"],
      { GITHUB_READ_BROKER_SOCKET: socketPath },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(broker.getCaptured(), {
      operation: "list-source-tree",
      repo: REPO,
      commit: COMMIT,
      pathPrefix: "src/components",
    });
  });
});

test("get-source-file forwards {operation,repo,commit,path}", async () => {
  await withBroker(async ({ socketPath, broker }) => {
    const result = await runReadTool(
      ["--operation", "get-source-file", "--repo", REPO, "--commit", COMMIT,
        "--path", "src/app.ts"],
      { GITHUB_READ_BROKER_SOCKET: socketPath },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(broker.getCaptured(), {
      operation: "get-source-file",
      repo: REPO,
      commit: COMMIT,
      path: "src/app.ts",
    });
  });
});

test("get-source-file forwards a bracketed [slug].astro path unencoded in JSON", async () => {
  await withBroker(async ({ socketPath, broker }) => {
    const astroPath = "artifacts/gloops-public/src/pages/doctrine/[slug].astro";
    const result = await runReadTool(
      ["--operation", "get-source-file", "--repo", REPO, "--commit", COMMIT,
        "--path", astroPath],
      { GITHUB_READ_BROKER_SOCKET: socketPath },
    );
    assert.equal(result.status, 0, result.stderr);
    // The client forwards the raw path; the broker performs URL-encoding.
    assert.equal(broker.getCaptured().path, astroPath);
  });
});

test("client settles and exits promptly (no leaked 15s request timer)", async () => {
  await withBroker(async ({ socketPath }) => {
    const started = Date.now();
    const result = await runReadTool(
      ["--operation", "get-repo-source-metadata", "--repo", REPO, "--commit", COMMIT],
      { GITHUB_READ_BROKER_SOCKET: socketPath },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, result.stderr);
    // An uncleared 15 s timeout would hold the event loop ~15 s after the
    // response settles; require the full spawn -> settle -> exit cycle to
    // complete far below that.  Harbor makes one such call per directory/file.
    assert.ok(elapsed < 5000, `client took ${elapsed}ms to settle and exit`);
  });
});

// -- client-side rejections happen BEFORE the broker socket is contacted -----
// A bogus socket path proves this: a validation failure surfaces the validation
// message, never a "socket error" (which would mean it tried to connect).

const UNREACHABLE = { GITHUB_READ_BROKER_SOCKET: "/nonexistent/paperclip/broker.sock" };

test("client rejects a mutable ref before contacting the broker", async () => {
  const result = await runReadTool(
    ["--operation", "get-source-file", "--repo", REPO, "--commit", "main",
      "--path", "src/app.ts"],
    UNREACHABLE,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact 40-character/);
  assert.doesNotMatch(result.stderr, /socket error/);
});

test("client rejects an uppercase / abbreviated SHA before contacting the broker", async () => {
  for (const bad of [COMMIT.toUpperCase(), COMMIT.slice(0, 12), `${COMMIT}00`]) {
    const result = await runReadTool(
      ["--operation", "list-source-tree", "--repo", REPO, "--commit", bad],
      UNREACHABLE,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exact 40-character/);
    assert.doesNotMatch(result.stderr, /socket error/);
  }
});

test("client rejects path traversal in --path before contacting the broker", async () => {
  for (const bad of ["../etc/passwd", "a/../../b", "/etc/passwd", "a/./b", "a\\b"]) {
    const result = await runReadTool(
      ["--operation", "get-source-file", "--repo", REPO, "--commit", COMMIT,
        "--path", bad],
      UNREACHABLE,
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /socket error/);
  }
});

test("client rejects path traversal in --path-prefix before contacting the broker", async () => {
  for (const bad of ["../secret", "a/../../b", "/abs", ".."]) {
    const result = await runReadTool(
      ["--operation", "list-source-tree", "--repo", REPO, "--commit", COMMIT,
        "--path-prefix", bad],
      UNREACHABLE,
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /socket error/);
  }
});

test("client enforces the read allowlist before contacting the broker", async () => {
  for (const repo of ["evil/repo", "gloopsAI/secret-internal", "InductAI/private-x"]) {
    const result = await runReadTool(
      ["--operation", "list-source-tree", "--repo", repo, "--commit", COMMIT],
      UNREACHABLE,
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in the read allowlist/);
    assert.doesNotMatch(result.stderr, /socket error/);
  }
});

test("client accepts every allowlisted read repo", async () => {
  const allow = [
    "InductAI/induct",
    "InductAI/induct-knowledge",
    "gloopsAI/gloops-ui",
    "gloopsAI/paperclip-gym",
  ];
  for (const repo of allow) {
    await withBroker(async ({ socketPath, broker }) => {
      const result = await runReadTool(
        ["--operation", "get-repo-source-metadata", "--repo", repo, "--commit", COMMIT],
        { GITHUB_READ_BROKER_SOCKET: socketPath },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(broker.getCaptured().repo, repo);
    });
  }
});

test("the new source-inventory operations are in the allowed set", async () => {
  const result = await runReadTool(["--operation", "delete-repo", "--repo", REPO]);
  assert.notEqual(result.status, 0);
  for (const op of ["get-repo-source-metadata", "list-source-tree", "get-source-file"]) {
    assert.match(result.stderr, new RegExp(op));
  }
});

test("get-source-file requires --commit and --path", async () => {
  const missingCommit = await runReadTool(
    ["--operation", "get-source-file", "--repo", REPO, "--path", "src/app.ts"],
    UNREACHABLE,
  );
  assert.notEqual(missingCommit.status, 0);
  assert.match(missingCommit.stderr, /--commit is required/);

  const missingPath = await runReadTool(
    ["--operation", "get-source-file", "--repo", REPO, "--commit", COMMIT],
    UNREACHABLE,
  );
  assert.notEqual(missingPath.status, 0);
  assert.match(missingPath.stderr, /--path is required/);
});
