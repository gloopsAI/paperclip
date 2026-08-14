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
  assert.equal(requestTimeoutMs({ operation: "rollback-proof" }), 180_000);
  assert.equal(requestTimeoutMs({ operation: "front-door-health" }), 30_000);
});

test("rollback-proof emits the bounded terminal-proof request", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "platform-ops-tool-proof-"));
  const socketPath = path.join(tempDirectory, "broker.sock");
  let request;
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      request = JSON.parse(chunk.toString("utf8"));
      socket.end('{"ok":true,"data":{"state":"completed"}}\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const expectedImage = `ghcr.io/gloopsai/paperclip-gloops@sha256:${"a".repeat(64)}`;
    const child = spawn(process.execPath, [
      scriptPath,
      "--operation", "rollback-proof",
      "--service", "paperclip-gloops.service",
      "--mode", "restored",
      "--expectedPriorImage", expectedImage,
      "--actor", "wren-agent",
      "--idempotencyKey", "proof-001",
    ], {
      env: { ...process.env, PLATFORM_OPS_BROKER_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
    assert.deepEqual(request, {
      operation: "rollback-proof",
      actor: "wren-agent",
      idempotencyKey: "proof-001",
      service: "paperclip-gloops.service",
      mode: "restored",
      expectedPriorImage: expectedImage,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("deploy-pinned-image binds the expected merge commit", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "platform-ops-tool-deploy-"));
  const socketPath = path.join(tempDirectory, "broker.sock");
  let request;
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      request = JSON.parse(chunk.toString("utf8"));
      socket.end('{"ok":true,"data":{"state":"completed"}}\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const image = `ghcr.io/gloopsai/paperclip-gloops@sha256:${"a".repeat(64)}`;
    const sourceCommit = "d".repeat(40);
    const child = spawn(process.execPath, [
      scriptPath,
      "--operation", "deploy-pinned-image",
      "--service", "paperclip-gloops.service",
      "--image", image,
      "--sourceCommit", sourceCommit,
      "--actor", "wren-agent",
      "--idempotencyKey", "deploy-source-001",
    ], {
      env: { ...process.env, PLATFORM_OPS_BROKER_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0);
    assert.equal(request.sourceCommit, sourceCommit);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDirectory, { recursive: true, force: true });
  }
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

test("an unhealthy front-door response exits nonzero", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "platform-ops-tool-unhealthy-"));
  const socketPath = path.join(tempDirectory, "broker.sock");
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end('{"ok":true,"data":{"healthy":false,"probes":[]}}\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const child = spawn(process.execPath, [
      scriptPath,
      "--operation", "front-door-health",
      "--service", "paperclip-gloops.service",
    ], {
      env: { ...process.env, PLATFORM_OPS_BROKER_SOCKET: socketPath },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

for (const state of ["initiated", "failed", "reconciliation_required"]) {
  test(`a replayed ${state} mutation receipt exits nonzero`, async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "platform-ops-tool-replay-"));
    const socketPath = path.join(tempDirectory, "broker.sock");
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ ok: true, data: { state, replayed: true } })}\n`);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const child = spawn(process.execPath, [
        scriptPath,
        "--operation", "rollback-rehearsal",
        "--service", "paperclip-gloops.service",
        "--actor", "wren-agent",
        "--idempotencyKey", `replay-${state}`,
      ], {
        env: { ...process.env, PLATFORM_OPS_BROKER_SOCKET: socketPath },
        stdio: ["ignore", "ignore", "ignore"],
      });
      const code = await new Promise((resolve) => child.once("exit", resolve));
      assert.equal(code, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
}
