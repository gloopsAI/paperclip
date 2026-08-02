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
 *   search-issues            --query <text> [--limit 30]
 *   list-issues              [--state open|closed|all] [--limit 30] [--label <name>]
 *   get-issue                --number <n>
 *   search-prs               --query <text> [--limit 30]
 *   list-prs                 [--state open|closed|merged|all] [--limit 30] [--label <name>]
 *   get-pr                   --number <n>
 *   get-pr-status            --number <n>
 *   get-pr-checks            --number <n>
 *   get-repo-source-metadata --commit <40-hex>
 *   list-source-tree         --commit <40-hex> [--path-prefix <repo-relative-dir>]
 *   get-source-file          --commit <40-hex> --path <repo-relative-file>
 *
 * Source-inventory operations require an EXACT immutable 40-character lowercase
 * hex commit SHA; mutable refs (branch/tag/HEAD/short/uppercase SHA) and any
 * traversal / absolute path are rejected client-side before the broker socket
 * is contacted.  The read repository allowlist is enforced here too.
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
  "get-repo-source-metadata",
  "list-source-tree",
  "get-source-file",
]);

// The READ allowlist mirrors the broker's ALLOWED_REPOSITORIES exactly.  It is a
// read-only inventory scope and MUST NOT be widened to any write-credential set.
const READ_ALLOWLIST = new Set([
  "InductAI/induct",
  "InductAI/induct-knowledge",
  "gloopsAI/gloops-ui",
  "gloopsAI/paperclip-gym",
]);

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// EXACT immutable commit: 40 lowercase hex chars only.  Rejects branch/tag/HEAD,
// abbreviated SHAs, and uppercase SHAs so no mutable ref can reach the broker.
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PATH_COMPONENT_BYTES = 255;
const MAX_SOURCE_PATH_BYTES = 4096;

function requireExactCommit(args) {
  const commit = args["--commit"];
  if (!commit) fail("--commit is required and must be an exact 40-hex commit SHA");
  if (!COMMIT_PATTERN.test(commit)) {
    fail(
      "--commit must be an exact 40-character lowercase hex SHA; mutable refs " +
        "(branch, tag, HEAD) and short/uppercase SHAs are rejected",
    );
  }
  return commit;
}

// Structural (not ASCII-allowlist) component validation.  Legitimate Git names
// -- brackets like `[slug].astro`, spaces, Unicode -- are permitted; only what
// enables traversal or smuggling is rejected: empty / `.` / `..`, over-long,
// separators, NUL, or C0/DEL/C1 control characters.
function isSafePathComponent(component) {
  if (component === "" || component === "." || component === "..") return false;
  if (Buffer.byteLength(component, "utf8") > MAX_PATH_COMPONENT_BYTES) return false;
  for (const ch of component) {
    const code = ch.codePointAt(0);
    if (ch === "/" || ch === "\\" || code === 0) return false;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
}

function requireSafeRelativePath(value, flag) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${flag} is required and must be a repo-relative path`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SOURCE_PATH_BYTES) {
    fail(`${flag} is too long`);
  }
  if (value.startsWith("/")) {
    fail(`${flag} must be repo-relative, not absolute`);
  }
  for (const component of value.split("/")) {
    if (!isSafePathComponent(component)) {
      fail(`${flag} contains an empty, '.'/'..', separator, NUL, or control component`);
    }
  }
  return value;
}

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

  // All operations require --repo and it must be inside the read allowlist.
  const repo = args["--repo"];
  if (!repo) fail("--repo is required");
  if (!REPO_PATTERN.test(repo)) fail("--repo must be in owner/repo format");
  if (!READ_ALLOWLIST.has(repo)) fail(`--repo ${repo} is not in the read allowlist`);
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
    case "get-repo-source-metadata": {
      request.commit = requireExactCommit(args);
      break;
    }
    case "list-source-tree": {
      request.commit = requireExactCommit(args);
      if (args["--path-prefix"] !== undefined) {
        request.pathPrefix = requireSafeRelativePath(
          args["--path-prefix"],
          "--path-prefix",
        );
      }
      break;
    }
    case "get-source-file": {
      request.commit = requireExactCommit(args);
      request.path = requireSafeRelativePath(args["--path"], "--path");
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

    // 15 second timeout.  It is created up front and CLEARED on every terminal
    // path so a settled request never leaves a live timer keeping the Node
    // event loop alive (which previously added ~15 s of latency per call).
    const timer = setTimeout(() => {
      settle(() => reject(new Error("broker request timed out")));
    }, 15000);
    if (typeof timer.unref === "function") timer.unref();

    // Single idempotent settlement boundary: clear the timeout, tear down the
    // socket, and resolve/reject exactly once.
    function settle(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    }

    socket.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        settle(() =>
          reject(new Error("response exceeds the bounded-response ceiling")),
        );
        return;
      }
      chunks.push(chunk);
      // Check for newline-delimited JSON.
      const combined = Buffer.concat(chunks);
      const newlineIndex = combined.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const line = combined.slice(0, newlineIndex).toString("utf8");
        settle(() => {
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("broker returned malformed JSON"));
          }
        });
      }
    });

    socket.on("error", (error) => {
      settle(() => reject(new Error(`socket error: ${error.message}`)));
    });

    socket.on("close", () => {
      if (settled) return;
      if (chunks.length === 0) {
        settle(() =>
          reject(new Error("broker connection closed without response")),
        );
      } else {
        const line = Buffer.concat(chunks).toString("utf8").trim();
        settle(() => {
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error("broker returned malformed JSON"));
          }
        });
      }
    });
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