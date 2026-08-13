#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requestTimeoutMs } from "./platform-ops-tool.mjs";

const scriptPath = fileURLToPath(new URL("./platform-ops-tool.mjs", import.meta.url));

test("mutating broker operations outlive the bounded deployment health window", () => {
  assert.equal(requestTimeoutMs({ operation: "service-status" }), 30_000);
  assert.equal(requestTimeoutMs({ operation: "deploy-pinned-image" }), 180_000);
  assert.equal(requestTimeoutMs({ operation: "rollback-rehearsal" }), 180_000);
});

test("a successful response clears the deadline and lets the CLI exit", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "platform-ops-tool-"));
  const socketPath = path.join(tempDirectory, "broker.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write('{"ok":true,"data":{"state":"active"}}\n');
      socket.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const child = spawn(process.execPath, [scriptPath, "--operation", "memory-usage"], {
      env: { ...process.env, PLATFORM_OPS_BROKER_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    const result = await Promise.race([
      new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 1_000)),
    ]);
    if (result.timedOut) child.kill("SIGKILL");

    assert.deepEqual(result, { code: 0, signal: null }, `stderr=${stderr}`);
    assert.match(stdout, /"ok": true/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
