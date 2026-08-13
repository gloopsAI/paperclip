#!/usr/bin/env node
/**
 * Credential-free platform operations client for Hermes engineering agents.
 *
 * Connects to the root-owned platform-ops-broker over a Unix socket and
 * returns bounded JSON.  No credential is ever read, printed, or returned.
 *
 * Usage:
 *   platform-ops-tool.mjs --operation <op> [options]
 *
 * Operations (read-only):
 *   service-status   --service <unit.service>
 *   service-health   --service <unit.service>
 *   disk-usage       [--path /]
 *   memory-usage
 *   cpu-usage
 *   cache-inspect    --cache <name>
 *   list-receipts    [--limit 50]
 *   get-receipt      --receiptId <id>
 *
 * Operations (mutating, require --actor and --idempotencyKey):
 *   service-restart      --service <unit.service> --actor <id> --idempotencyKey <key>
 *   cache-reclaim        --cache <name> --actor <id> --idempotencyKey <key>
 *   deploy-pinned-image  --service <unit.service> --image <digest> --actor <id> --idempotencyKey <key>
 *   rollback-rehearsal   --service <unit.service> --actor <id> --idempotencyKey <key>
 *
 * Output is bounded JSON to stdout and never includes credentials.
 */

import net from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_SOCKET = "/run/paperclip-platform-ops-broker/broker.sock";
const MAX_RESPONSE_BYTES = 128 * 1024;
const READ_ONLY_TIMEOUT_MS = 30_000;
const MUTATING_TIMEOUT_MS = 180_000;

const ALLOWED_OPERATIONS = new Set([
  "service-status",
  "service-health",
  "service-restart",
  "disk-usage",
  "memory-usage",
  "cpu-usage",
  "cache-inspect",
  "cache-reclaim",
  "deploy-pinned-image",
  "rollback-rehearsal",
  "list-receipts",
  "get-receipt",
]);

const MUTATING_OPERATIONS = new Set([
  "service-restart",
  "cache-reclaim",
  "deploy-pinned-image",
  "rollback-rehearsal",
]);

export function requestTimeoutMs(request) {
  return MUTATING_OPERATIONS.has(request?.operation)
    ? MUTATING_TIMEOUT_MS
    : READ_ONLY_TIMEOUT_MS;
}

function fail(message) {
  process.stderr.write(`platform-ops-tool: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`arguments must be --key value pairs (got: ${key} ${value ?? ""})`);
    }
    if (key in out) fail(`duplicate argument: ${key}`);
    out[key] = value;
  }
  return out;
}

function buildRequest(args) {
  const operation = args["--operation"];
  if (!operation) fail("--operation is required");
  if (!ALLOWED_OPERATIONS.has(operation)) {
    fail(`--operation must be one of: ${[...ALLOWED_OPERATIONS].join(", ")}`);
  }

  const request = { operation };

  // Mutating operations require actor and idempotencyKey
  if (MUTATING_OPERATIONS.has(operation)) {
    if (!args["--actor"]) fail("--actor is required for mutating operations");
    if (!args["--idempotencyKey"]) fail("--idempotencyKey is required for mutating operations");
    request.actor = args["--actor"];
    request.idempotencyKey = args["--idempotencyKey"];
  }

  switch (operation) {
    case "service-status":
    case "service-health":
    case "service-restart":
    case "rollback-rehearsal": {
      if (!args["--service"]) fail("--service is required");
      request.service = args["--service"];
      break;
    }
    case "deploy-pinned-image": {
      if (!args["--service"]) fail("--service is required");
      request.service = args["--service"];
      if (!args["--image"]) fail("--image is required for deploy-pinned-image");
      request.image = args["--image"];
      break;
    }
    case "disk-usage": {
      if (args["--path"]) request.path = args["--path"];
      break;
    }
    case "cache-inspect":
    case "cache-reclaim": {
      if (!args["--cache"]) fail("--cache is required");
      request.cache = args["--cache"];
      break;
    }
    case "list-receipts": {
      if (args["--limit"]) {
        const limit = parseInt(args["--limit"], 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          fail("--limit must be an integer between 1 and 200");
        }
        request.limit = limit;
      }
      break;
    }
    case "get-receipt": {
      if (!args["--receiptId"]) fail("--receiptId is required");
      request.receiptId = args["--receiptId"];
      break;
    }
    case "memory-usage":
    case "cpu-usage":
      // No additional parameters
      break;
    default:
      fail(`unsupported operation: ${operation}`);
  }

  return request;
}

function sendRequest(request) {
  const socketPath = process.env.PLATFORM_OPS_BROKER_SOCKET || DEFAULT_SOCKET;
  const payload = JSON.stringify(request) + "\n";

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(payload);
    });

    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    socket.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("response exceeds the bounded-response ceiling"));
        }
        return;
      }
      chunks.push(chunk);
      const combined = Buffer.concat(chunks);
      const newlineIndex = combined.indexOf(0x0a);
      if (newlineIndex >= 0) {
        settled = true;
        socket.destroy();
        const line = combined.slice(0, newlineIndex).toString("utf8");
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error("broker returned malformed JSON"));
        }
      }
    });

    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`socket error: ${error.message}`));
      }
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        if (chunks.length === 0) {
          reject(new Error("broker connection closed without response"));
        } else {
          const line = Buffer.concat(chunks).toString("utf8").trim();
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("broker returned malformed JSON"));
          }
        }
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("broker request timed out"));
      }
    }, requestTimeoutMs(request));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const request = buildRequest(args);

  try {
    const response = await sendRequest(request);
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    if (response.ok === false) {
      process.exit(1);
    }
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
