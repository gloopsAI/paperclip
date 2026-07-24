#!/usr/bin/env node
/**
 * Read-only GitHub evidence client for Hermes engineering agents.
 *
 * Connects to the root-owned github-read-broker over a Unix socket and
 * returns bounded JSON.  No credential is ever read, printed, or returned.
 *
 * Usage:
 *   github-read-tool.mjs --operation <op> --repo <owner/repo> [options]
 *
 * Operations:
 *   search-issues  --query <text> [--limit 30]
 *   list-issues    [--state open|closed|all] [--limit 30] [--label <name>]
 *   get-issue      --number <n>
 *   search-prs     --query <text> [--limit 30]
 *   list-prs       [--state open|closed|merged|all] [--limit 30] [--label <name>]
 *   get-pr         --number <n>
 *   get-pr-status  --number <n>
 *   get-pr-checks  --number <n>
 *
 * Output is bounded JSON to stdout and never includes credentials.
 */

import net from "node:net";
import os from "node:os";
import process from "node:process";

const DEFAULT_SOCKET = "/run/paperclip-github-read-broker/broker.sock";
const MAX_RESPONSE_BYTES = 256 * 1024;

const ALLOWED_OPERATIONS = new Set([
  "search-issues",
  "list-issues",
  "get-issue",
  "search-prs",
  "list-prs",
  "get-pr",
  "get-pr-status",
  "get-pr-checks",
]);

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(message) {
  process.stderr.write(`github-read-tool: ${message}\n`);
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

  // All operations require --repo
  const repo = args["--repo"];
  if (!repo) fail("--repo is required");
  if (!REPO_PATTERN.test(repo)) fail("--repo must be in owner/repo format");
  request.repo = repo;

  // Operation-specific parameters
  switch (operation) {
    case "search-issues":
    case "search-prs": {
      const query = args["--query"];
      if (!query) fail("--query is required for search operations");
      if (query.length > 500) fail("--query is too long (max 500 chars)");
      request.query = query;
      if (args["--limit"]) {
        const limit = parseInt(args["--limit"], 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
          fail("--limit must be an integer between 1 and 30");
        }
        request.limit = limit;
      }
      break;
    }
    case "list-issues":
    case "list-prs": {
      if (args["--state"]) {
        request.state = args["--state"];
      }
      if (args["--limit"]) {
        const limit = parseInt(args["--limit"], 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
          fail("--limit must be an integer between 1 and 30");
        }
        request.limit = limit;
      }
      if (args["--label"]) {
        request.label = args["--label"];
      }
      break;
    }
    case "get-issue":
    case "get-pr":
    case "get-pr-status":
    case "get-pr-checks": {
      if (!args["--number"]) fail("--number is required");
      const number = parseInt(args["--number"], 10);
      if (!Number.isInteger(number) || number < 1) {
        fail("--number must be a positive integer");
      }
      request.number = number;
      break;
    }
    default:
      fail(`unsupported operation: ${operation}`);
  }

  return request;
}

function sendRequest(request) {
  const socketPath = process.env.GITHUB_READ_BROKER_SOCKET || DEFAULT_SOCKET;
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
      // Check for newline-delimited JSON
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

    // 15 second timeout
    setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error("broker request timed out"));
      }
    }, 15000);
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

main();