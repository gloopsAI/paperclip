import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const directory = path.dirname(new URL(import.meta.url).pathname);
const verifier = path.join(directory, "verify-github-read-inventory.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-read-inventory-verifier-"));

const REPO = "gloopsAI/gloops-ui";
const COMMIT = "84a78a998e02249be20b8fccad6c43bdafdd8b2b";
const ROOT_TREE = "1".repeat(40);
const SRC_TREE = "2".repeat(40);
const PAGES_TREE = "3".repeat(40);
const README_BLOB = "4".repeat(40);
const APP_BLOB = "5".repeat(40);
const LATE_BLOB = "6".repeat(40);
const OTHER_BLOB = "7".repeat(40);
const LATE_PATH = "src/pages/late.ts";
const FILE_CONTENT = "bounded late file content";
const AUTH_SECRET = "super-secret-auth-value";

const mockSource = `#!/usr/bin/env node
const args = Object.fromEntries(
  Array.from({ length: process.argv.slice(2).length / 2 }, (_, index) => [
    process.argv.slice(2)[index * 2],
    process.argv.slice(2)[index * 2 + 1],
  ]),
);
const scenario = "__SCENARIO__";
const operation = args["--operation"];
const repo = args["--repo"];
const commit = args["--commit"];
const values = ${JSON.stringify({
  rootTree: ROOT_TREE,
  srcTree: SRC_TREE,
  pagesTree: PAGES_TREE,
  readmeBlob: README_BLOB,
  appBlob: APP_BLOB,
  lateBlob: LATE_BLOB,
  otherBlob: OTHER_BLOB,
  fileContent: FILE_CONTENT,
})};

if (process.env.MOCK_AUTH_SECRET) {
  process.stderr.write(process.env.MOCK_AUTH_SECRET + "\\n");
  process.exit(2);
}
if (scenario === "client_error") {
  process.stderr.write(${JSON.stringify(AUTH_SECRET)} + "\\n");
  process.exit(1);
}

let data;
if (operation === "get-repo-source-metadata") {
  data = {
    repo: scenario === "malformed_metadata" ? "gloopsAI/not-the-requested-repo" : repo,
    commit,
    tree: values.rootTree,
    default_branch: "main",
  };
} else if (operation === "list-source-tree") {
  const prefix = args["--path-prefix"] || "";
  let entries;
  let treeSha;
  if (prefix === "") {
    treeSha = values.rootTree;
    entries = [
      { path: "README.md", type: "blob", mode: "100644", sha: values.readmeBlob, size: 4 },
      { path: "src", type: "tree", mode: "040000", sha: values.srcTree },
    ];
    if (scenario === "duplicate_entry") {
      entries = [entries[0], { ...entries[0] }, entries[1]];
    } else if (scenario === "unsorted_entry") {
      entries = [entries[1], entries[0]];
    }
  } else if (prefix === "src") {
    treeSha = scenario === "malformed_tree" ? values.otherBlob : values.srcTree;
    entries = [
      { path: "app.ts", type: "blob", mode: "100644", sha: values.appBlob, size: 3 },
      { path: "pages", type: "tree", mode: "040000", sha: values.pagesTree },
    ];
  } else if (prefix === "src/pages") {
    treeSha = values.pagesTree;
    entries = scenario === "missing_late_path"
      ? [{ path: "other.ts", type: "blob", mode: "100644", sha: values.otherBlob, size: 4 }]
      : [{ path: "late.ts", type: "blob", mode: "100644", sha: values.lateBlob, size: Buffer.byteLength(values.fileContent) }];
  } else {
    throw new Error("unexpected mock prefix");
  }
  data = {
    repo,
    commit,
    rootTree: values.rootTree,
    pathPrefix: prefix,
    treeSha,
    truncated: false,
    totalReturned: entries.length,
    entries,
  };
} else if (operation === "get-source-file") {
  data = {
    repo,
    commit,
    path: args["--path"],
    sha: scenario === "malformed_file" ? values.otherBlob : values.lateBlob,
    encoding: "utf-8",
    content: values.fileContent,
    size: Buffer.byteLength(values.fileContent),
  };
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: "unsupported mock operation" }) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, data }) + "\\n");
`;

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function createMockClient(scenario) {
  const mockClient = path.join(root, `github-read-tool-${scenario}-${Date.now()}-${Math.random()}.mjs`);
  fs.writeFileSync(mockClient, mockSource.replace("__SCENARIO__", scenario), { mode: 0o755 });
  return mockClient;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifierArgs(client, overrides = {}) {
  const values = {
    "--client": client,
    "--expected-client-sha256": sha256(client),
    "--repo": REPO,
    "--commit": COMMIT,
    "--expected-count": "5",
    "--late-path": LATE_PATH,
    "--expected-root-tree": ROOT_TREE,
    "--expected-late-sha": LATE_BLOB,
    "--expected-late-size": String(Buffer.byteLength(FILE_CONTENT)),
    ...overrides,
  };
  return Object.entries(values).flatMap(([key, value]) => [key, value]);
}

function runVerifier({ scenario = "positive", overrides = {}, transformClient } = {}) {
  return new Promise((resolve) => {
    const originalClient = createMockClient(scenario);
    const client = transformClient ? transformClient(originalClient) : originalClient;
    const child = spawn(process.execPath, [verifier, ...verifierArgs(client, overrides)], {
      env: {
        ...process.env,
        MOCK_AUTH_SECRET: AUTH_SECRET,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr, client }));
  });
}

test("reconciles a hierarchical exact tree and emits a content-free receipt", async () => {
  const result = await runVerifier();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schemaVersion, "paperclip.github-read-inventory-verification.v1");
  assert.deepEqual(receipt.client, {
    path: result.client,
    sha256: sha256(result.client),
  });
  assert.equal(receipt.repo, REPO);
  assert.equal(receipt.commit, COMMIT);
  assert.equal(receipt.rootTree, ROOT_TREE);
  assert.equal(receipt.totalEntries, 5);
  assert.equal(receipt.visitedDirectories, 3);
  assert.deepEqual(receipt.typeCounts, { blob: 3, tree: 2, commit: 0 });
  assert.deepEqual(receipt.lateFile, {
    path: LATE_PATH,
    sha: LATE_BLOB,
    size: Buffer.byteLength(FILE_CONTENT),
    contentSha256: "7e26db153c1e9fa6d70b4087c7c98071d04a0f20057b0259b00d56e3e3df5606",
  });
  assert.doesNotMatch(result.stdout, new RegExp(FILE_CONTENT));
  assert.doesNotMatch(result.stdout, new RegExp(AUTH_SECRET));
  assert.equal(result.stderr, "");
});

test("fails typed when the reconciled count differs", async () => {
  const result = await runVerifier({ overrides: { "--expected-count": "6" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[entry_count_mismatch\]/);
});

test("fails typed on malformed metadata identity", async () => {
  const result = await runVerifier({ scenario: "malformed_metadata" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[metadata_identity_mismatch\]/);
});

test("fails typed on malformed directory identity", async () => {
  const result = await runVerifier({ scenario: "malformed_tree" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[tree_identity_mismatch\]/);
});

test("fails typed on malformed late-file identity", async () => {
  const result = await runVerifier({ scenario: "malformed_file" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[late_file_identity_mismatch\]/);
});

test("fails typed on a duplicate directory entry", async () => {
  const result = await runVerifier({
    scenario: "duplicate_entry",
    overrides: { "--expected-count": "6" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[duplicate_entry\]/);
});

test("fails typed on unsorted directory entries", async () => {
  const result = await runVerifier({ scenario: "unsorted_entry" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[tree_entries_not_sorted\]/);
});

test("fails typed when the required late path is missing", async () => {
  const result = await runVerifier({ scenario: "missing_late_path" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[late_path_missing\]/);
});

test("never relays installed-client stderr or auth material", async () => {
  const result = await runVerifier({ scenario: "client_error" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[client_operation_failed\]/);
  assert.doesNotMatch(result.stdout, new RegExp(AUTH_SECRET));
  assert.doesNotMatch(result.stderr, new RegExp(AUTH_SECRET));
});

test("fails typed when the installed client does not match the reviewed hash", async () => {
  const result = await runVerifier({
    overrides: { "--expected-client-sha256": "0".repeat(64) },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[client_hash_mismatch\]/);
});

test("rejects a symlinked installed client", async () => {
  const result = await runVerifier({
    transformClient(originalClient) {
      const linkedClient = `${originalClient}.symlink`;
      fs.symlinkSync(originalClient, linkedClient);
      return linkedClient;
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[invalid_client\]/);
});
