#!/usr/bin/env node
/**
 * Reconcile an exact GitHub repository tree through the installed read client.
 *
 * This verifier never contacts GitHub directly. Every repository observation
 * must pass through github-read-tool.mjs -> Unix socket -> read broker. It
 * walks immediate directories, fails closed on any identity/completeness
 * mismatch, and prints a content-free receipt for one late bounded text file.
 *
 * Usage:
 *   verify-github-read-inventory.mjs \
 *     --client /usr/local/lib/paperclip-gloops/tools/github-read-tool.mjs \
 *     --expected-client-sha256 <exact-64-hex> \
 *     --repo gloopsAI/gloops-ui \
 *     --commit <exact-40-hex> \
 *     --expected-count 2455 \
 *     --late-path 'artifacts/gloops-public/src/pages/doctrine/[slug].astro' \
 *     [--expected-root-tree <exact-40-hex>] \
 *     [--expected-late-sha <exact-40-hex>] \
 *     [--expected-late-size <bytes>]
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENTRY_MODES = {
  blob: new Set(["100644", "100755", "120000"]),
  tree: new Set(["040000"]),
  commit: new Set(["160000"]),
};

class InventoryVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InventoryVerificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new InventoryVerificationError(code, message);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || key in args) {
      fail("invalid_arguments", "arguments must be unique --key value pairs");
    }
    args[key] = value;
  }
  const allowed = new Set([
    "--client",
    "--expected-client-sha256",
    "--repo",
    "--commit",
    "--expected-count",
    "--late-path",
    "--expected-root-tree",
    "--expected-late-sha",
    "--expected-late-size",
  ]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) fail("invalid_arguments", `unsupported argument ${key}`);
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) fail("invalid_arguments", `${key} is required`);
  return value;
}

function parsePositiveInteger(value, flag) {
  if (!/^[0-9]+$/.test(value)) fail("invalid_arguments", `${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail("invalid_arguments", `${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parseNonnegativeInteger(value, flag) {
  if (!/^[0-9]+$/.test(value)) fail("invalid_arguments", `${flag} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail("invalid_arguments", `${flag} must be a nonnegative safe integer`);
  }
  return parsed;
}

function assertSafeRelativePath(value, flag) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    Buffer.byteLength(value, "utf8") > 4096
  ) {
    fail("invalid_arguments", `${flag} must be a nonempty repository-relative path`);
  }
  for (const component of value.split("/")) {
    if (
      component === "" ||
      component === "." ||
      component === ".." ||
      component.includes("\\") ||
      Buffer.byteLength(component, "utf8") > 255 ||
      [...component].some((character) => {
        const code = character.codePointAt(0);
        return code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f);
      })
    ) {
      fail("invalid_arguments", `${flag} contains an unsafe path component`);
    }
  }
  return value;
}

async function assertReviewedClient(client, expectedSha256) {
  if (!path.isAbsolute(client)) {
    fail("invalid_client", "--client must be an absolute installed-client path");
  }
  let stat;
  try {
    stat = await fs.promises.lstat(client);
  } catch {
    fail("invalid_client", "installed read client is missing or unreadable");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0) {
    fail("invalid_client", "installed read client must be a non-symlink regular executable file");
  }
  let observedSha256;
  try {
    observedSha256 = createHash("sha256")
      .update(await fs.promises.readFile(client))
      .digest("hex");
  } catch {
    fail("invalid_client", "installed read client could not be hashed");
  }
  if (observedSha256 !== expectedSha256) {
    fail("client_hash_mismatch", "installed read client did not match the reviewed SHA-256");
  }
  return { path: client, sha256: observedSha256 };
}

async function callClient(client, operation, repo, commit, extra = []) {
  const argv = [
    "--operation", operation,
    "--repo", repo,
    "--commit", commit,
    ...extra,
  ];
  let stdout;
  try {
    // Invoke the reviewed .mjs with this verifier's exact Node binary so an
    // inherited PATH cannot select a substitute interpreter. Project only the
    // optional socket override, never auth/session/provider credentials.
    const clientEnv = {
      ...(process.env.GITHUB_READ_BROKER_SOCKET
        ? { GITHUB_READ_BROKER_SOCKET: process.env.GITHUB_READ_BROKER_SOCKET }
        : {}),
    };
    ({ stdout } = await execFileAsync(process.execPath, [client, ...argv], {
      env: clientEnv,
      encoding: "utf8",
      maxBuffer: 512 * 1024,
      timeout: 30_000,
    }));
  } catch {
    // Never relay child stdout/stderr. The installed client is designed not to
    // expose credentials, but this verifier preserves non-disclosure even if a
    // future client or injected failure writes sensitive material.
    fail("client_operation_failed", `${operation} failed via the installed read client`);
  }

  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    fail("client_malformed_json", `${operation} returned malformed JSON`);
  }
  if (!response || response.ok !== true || typeof response.data !== "object" || response.data === null) {
    fail("client_response_invalid", `${operation} did not return an ok data response`);
  }
  return response.data;
}

function assertMetadataIdentity(metadata, expected) {
  if (
    metadata.repo !== expected.repo ||
    metadata.commit !== expected.commit ||
    !SHA40.test(metadata.tree) ||
    typeof metadata.default_branch !== "string" ||
    metadata.default_branch.length === 0
  ) {
    fail("metadata_identity_mismatch", "metadata did not reconcile to the requested repository and commit");
  }
  if (expected.rootTree && metadata.tree !== expected.rootTree) {
    fail("metadata_identity_mismatch", "metadata root tree did not match the expected exact tree");
  }
}

function assertTreeReceipt(data, expected) {
  if (
    data.repo !== expected.repo ||
    data.commit !== expected.commit ||
    data.rootTree !== expected.rootTree ||
    data.pathPrefix !== expected.prefix ||
    data.treeSha !== expected.treeSha ||
    data.truncated !== false ||
    !Array.isArray(data.entries) ||
    data.totalReturned !== data.entries.length
  ) {
    fail("tree_identity_mismatch", "directory receipt did not reconcile to the requested exact tree");
  }
}

function assertTreeEntry(entry) {
  if (
    !entry ||
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    entry.path === "." ||
    entry.path === ".." ||
    entry.path.includes("/") ||
    entry.path.includes("\\") ||
    Buffer.byteLength(entry.path, "utf8") > 255 ||
    [...entry.path].some((character) => {
      const code = character.codePointAt(0);
      return code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f);
    }) ||
    !SHA40.test(entry.sha) ||
    !Object.hasOwn(ENTRY_MODES, entry.type) ||
    !ENTRY_MODES[entry.type].has(entry.mode)
  ) {
    fail("tree_entry_invalid", "directory receipt contains a malformed entry identity");
  }
  if (entry.type === "blob" && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
    fail("tree_entry_invalid", "directory receipt contains a blob without a valid size");
  }
}

async function verifyInventory(input) {
  const clientIdentity = await assertReviewedClient(input.client, input.expectedClientSha256);
  const metadata = await callClient(input.client, "get-repo-source-metadata", input.repo, input.commit);
  assertMetadataIdentity(metadata, input);

  const queue = [{ prefix: "", treeSha: metadata.tree }];
  const seenPrefixes = new Set();
  const seenPaths = new Set();
  const typeCounts = { blob: 0, tree: 0, commit: 0 };
  let lateEntry = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (seenPrefixes.has(current.prefix)) {
      fail("duplicate_directory", "repository traversal reached the same directory prefix twice");
    }
    seenPrefixes.add(current.prefix);
    if (seenPrefixes.size > input.expectedCount + 1) {
      fail("entry_count_exceeded", "directory traversal exceeded the expected repository bound");
    }

    const extra = current.prefix ? ["--path-prefix", current.prefix] : [];
    const data = await callClient(input.client, "list-source-tree", input.repo, input.commit, extra);
    assertTreeReceipt(data, {
      repo: input.repo,
      commit: input.commit,
      rootTree: metadata.tree,
      prefix: current.prefix,
      treeSha: current.treeSha,
    });

    let previousName = null;
    for (const entry of data.entries) {
      assertTreeEntry(entry);
      const fullPath = current.prefix ? `${current.prefix}/${entry.path}` : entry.path;
      if (seenPaths.has(fullPath)) {
        fail("duplicate_entry", "repository traversal returned a duplicate path");
      }
      if (previousName !== null && entry.path < previousName) {
        fail("tree_entries_not_sorted", "directory entries are not strictly sorted");
      }
      previousName = entry.path;
      seenPaths.add(fullPath);
      if (seenPaths.size > input.expectedCount) {
        fail("entry_count_exceeded", "repository traversal exceeded the expected entry count");
      }
      typeCounts[entry.type] += 1;
      if (fullPath === input.latePath) lateEntry = entry;
      if (entry.type === "tree") queue.push({ prefix: fullPath, treeSha: entry.sha });
    }
  }

  if (seenPaths.size !== input.expectedCount) {
    fail(
      "entry_count_mismatch",
      `expected ${input.expectedCount} repository entries but reconciled ${seenPaths.size}`,
    );
  }
  if (!lateEntry || lateEntry.type !== "blob") {
    fail("late_path_missing", "the required late path was not enumerated as a blob");
  }
  if (input.expectedLateSha && lateEntry.sha !== input.expectedLateSha) {
    fail("late_file_identity_mismatch", "the enumerated late blob SHA did not match the expected SHA");
  }
  if (input.expectedLateSize !== null && lateEntry.size !== input.expectedLateSize) {
    fail("late_file_identity_mismatch", "the enumerated late blob size did not match the expected size");
  }

  const file = await callClient(
    input.client,
    "get-source-file",
    input.repo,
    input.commit,
    ["--path", input.latePath],
  );
  if (
    file.repo !== input.repo ||
    file.commit !== input.commit ||
    file.path !== input.latePath ||
    file.sha !== lateEntry.sha ||
    file.encoding !== "utf-8" ||
    typeof file.content !== "string" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    Buffer.byteLength(file.content, "utf8") !== file.size
  ) {
    fail("late_file_identity_mismatch", "late-file receipt did not reconcile to the enumerated exact blob");
  }

  return {
    schemaVersion: "paperclip.github-read-inventory-verification.v1",
    ok: true,
    client: clientIdentity,
    repo: input.repo,
    commit: input.commit,
    rootTree: metadata.tree,
    defaultBranch: metadata.default_branch,
    totalEntries: seenPaths.size,
    visitedDirectories: seenPrefixes.size,
    typeCounts,
    lateFile: {
      path: file.path,
      sha: file.sha,
      size: file.size,
      contentSha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = requireArg(args, "--client");
  const expectedClientSha256 = requireArg(args, "--expected-client-sha256");
  const repo = requireArg(args, "--repo");
  const commit = requireArg(args, "--commit");
  if (!REPO.test(repo)) fail("invalid_arguments", "--repo must use owner/repo format");
  if (!SHA40.test(commit)) fail("invalid_arguments", "--commit must be an exact lowercase 40-hex SHA");
  if (!SHA256.test(expectedClientSha256)) {
    fail("invalid_arguments", "--expected-client-sha256 must be an exact lowercase 64-hex SHA-256");
  }
  const expectedRootTree = args["--expected-root-tree"] ?? null;
  const expectedLateSha = args["--expected-late-sha"] ?? null;
  if (expectedRootTree && !SHA40.test(expectedRootTree)) {
    fail("invalid_arguments", "--expected-root-tree must be an exact lowercase 40-hex SHA");
  }
  if (expectedLateSha && !SHA40.test(expectedLateSha)) {
    fail("invalid_arguments", "--expected-late-sha must be an exact lowercase 40-hex SHA");
  }

  const receipt = await verifyInventory({
    client,
    expectedClientSha256,
    repo,
    commit,
    expectedCount: parsePositiveInteger(requireArg(args, "--expected-count"), "--expected-count"),
    latePath: assertSafeRelativePath(requireArg(args, "--late-path"), "--late-path"),
    rootTree: expectedRootTree,
    expectedLateSha,
    expectedLateSize: args["--expected-late-size"] === undefined
      ? null
      : parseNonnegativeInteger(args["--expected-late-size"], "--expected-late-size"),
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main().catch((error) => {
  const code = error instanceof InventoryVerificationError ? error.code : "unexpected_failure";
  const message = error instanceof InventoryVerificationError
    ? error.message
    : "unexpected verifier failure";
  process.stderr.write(`inventory verification failed [${code}]: ${message}\n`);
  process.exitCode = 1;
});
