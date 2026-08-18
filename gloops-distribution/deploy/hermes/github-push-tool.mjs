import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as git from "isomorphic-git";

const ZERO_OID = "0".repeat(40);
const OID_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OBJECTS = 100_000;
const MAX_PACK_BYTES = 64 * 1024 * 1024;
const MAX_GIT_STDOUT_BYTES = MAX_PACK_BYTES + 1024 * 1024;
const DEFAULT_SOCKET = "/run/paperclip-github-broker/broker.sock";
const DEFAULT_INGRESS = "/run/paperclip-github-broker/ingress";
// The broker imports a content-addressed object graph into a bare repository;
// it never checks the submitted tree out.  A tracked symlink is therefore an
// ordinary blob in this boundary, not a host filesystem traversal.  Paperclip
// itself contains tracked skill aliases, so rejecting mode 120000 made every
// Paperclip publication impossible even when the changed files were regular.
const ACCEPTED_BLOB_MODES = new Set(["100644", "100755", "120000"]);
const ACCEPTED_TREE_MODE = "040000";

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    fail("canonical receipt contains an unsupported number");
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys do not match the accepted schema`);
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("arguments must be --key value pairs");
    if (args.has(key)) fail(`duplicate argument: ${key}`);
    args.set(key, value);
  }
  return args;
}

async function resolveHeadOid(gitdir, headFile) {
  const head = fs.readFileSync(headFile, "utf8").trim();
  if (OID_PATTERN.test(head)) return head;
  const match = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(head);
  if (!match || match[1].includes("..") || match[1].endsWith("/")) {
    fail("repository HEAD is malformed");
  }
  return git.resolveRef({ fs, gitdir, ref: match[1] });
}

async function resolveRepositoryGitContext(repoDir) {
  const dotGit = path.join(repoDir, ".git");
  const dotGitStat = fs.lstatSync(dotGit);
  if (dotGitStat.isSymbolicLink()) fail("repository .git boundary must not be a symlink");
  if (dotGitStat.isDirectory()) {
    const gitdir = fs.realpathSync(dotGit);
    return { gitdir, headOid: await resolveHeadOid(gitdir, path.join(gitdir, "HEAD")) };
  }
  if (!dotGitStat.isFile() || dotGitStat.size > 4096) {
    fail("repository does not contain a supported .git boundary");
  }

  const match = /^gitdir: ([^\r\n]+)\n?$/.exec(fs.readFileSync(dotGit, "utf8"));
  if (!match) fail("repository worktree .git boundary is malformed");
  const resolvedGitdir = fs.realpathSync(path.resolve(repoDir, match[1]));
  const gitdirStat = fs.lstatSync(resolvedGitdir);
  if (!gitdirStat.isDirectory() || gitdirStat.isSymbolicLink()) {
    fail("repository worktree gitdir must be a real directory");
  }

  const backpointer = path.join(resolvedGitdir, "gitdir");
  const backpointerStat = fs.lstatSync(backpointer);
  if (!backpointerStat.isFile() || backpointerStat.isSymbolicLink() || backpointerStat.size > 4096) {
    fail("repository worktree gitdir backpointer is unavailable");
  }
  const resolvedBackpointer = fs.realpathSync(
    path.resolve(resolvedGitdir, fs.readFileSync(backpointer, "utf8").trim()),
  );
  if (resolvedBackpointer !== fs.realpathSync(dotGit)) {
    fail("repository worktree gitdir backpointer does not match the assigned worktree");
  }
  const commondir = path.join(resolvedGitdir, "commondir");
  const commondirStat = fs.lstatSync(commondir);
  if (!commondirStat.isFile() || commondirStat.isSymbolicLink() || commondirStat.size > 4096) {
    fail("repository worktree common Git boundary is unavailable");
  }
  const resolvedCommonGitdir = fs.realpathSync(
    path.resolve(resolvedGitdir, fs.readFileSync(commondir, "utf8").trim()),
  );
  const commonGitdirStat = fs.lstatSync(resolvedCommonGitdir);
  if (
    !commonGitdirStat.isDirectory()
    || commonGitdirStat.isSymbolicLink()
    || path.basename(resolvedCommonGitdir) !== ".git"
  ) {
    fail("repository worktree common Git boundary is unavailable");
  }
  const projectRoot = path.dirname(resolvedCommonGitdir);
  const projectRootStat = fs.lstatSync(projectRoot);
  if (
    !projectRootStat.isDirectory()
    || projectRootStat.isSymbolicLink()
    || fs.realpathSync(projectRoot) !== projectRoot
  ) {
    fail("repository worktree project boundary must be a real directory");
  }
  const expectedCommonGitdir = fs.realpathSync(path.join(projectRoot, ".git"));
  const expectedGitdirParent = fs.realpathSync(path.join(expectedCommonGitdir, "worktrees"));
  if (
    resolvedCommonGitdir !== expectedCommonGitdir
    || path.dirname(resolvedGitdir) !== expectedGitdirParent
  ) {
    fail("repository worktree gitdir is outside the project Git boundary");
  }

  const managedWorktreeRoot = path.join(projectRoot, ".paperclip", "worktrees");
  const isManagedNestedWorktree = repoDir.startsWith(`${managedWorktreeRoot}${path.sep}`);
  const isGovernedSiblingWorktree = (
    repoDir !== projectRoot
    && path.dirname(repoDir) === path.dirname(projectRoot)
  );
  if (!isManagedNestedWorktree && !isGovernedSiblingWorktree) {
    fail("repository worktree is outside the Paperclip worktree boundary");
  }
  return {
    gitdir: resolvedCommonGitdir,
    headOid: await resolveHeadOid(resolvedCommonGitdir, path.join(resolvedGitdir, "HEAD")),
  };
}

async function collectTreeObjects(gitdir, treeOid, output) {
  if (output.has(treeOid)) return;
  output.add(treeOid);
  if (output.size > MAX_OBJECTS) fail("commit closure exceeds the object-count ceiling");
  const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
  for (const entry of tree) {
    if (!OID_PATTERN.test(entry.oid)) fail("tree contains a malformed object id");
    if (
      (entry.type === "tree" && entry.mode !== ACCEPTED_TREE_MODE)
      || (entry.type === "blob" && !ACCEPTED_BLOB_MODES.has(entry.mode))
      || (entry.type !== "tree" && entry.type !== "blob")
    ) {
      fail("tree contains an unsupported object type or mode");
    }
    if (entry.type === "tree") {
      await collectTreeObjects(gitdir, entry.oid, output);
    } else {
      output.add(entry.oid);
      if (output.size > MAX_OBJECTS) fail("commit closure exceeds the object-count ceiling");
    }
  }
}

async function collectCommitClosure(gitdir, commitOid) {
  const objects = new Set();
  const pending = [commitOid];
  while (pending.length > 0) {
    const oid = pending.pop();
    if (objects.has(oid)) continue;
    if (!OID_PATTERN.test(oid)) fail("commit closure contains a malformed object id");
    objects.add(oid);
    if (objects.size > MAX_OBJECTS) fail("commit closure exceeds the object-count ceiling");
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    await collectTreeObjects(gitdir, commit.tree, objects);
    for (const parent of commit.parent) pending.push(parent);
  }
  return [...objects].sort();
}

async function validateDeltaTreeModes(gitdir, commitOid, baseOid) {
  const pending = [commitOid];
  const visited = new Set();
  while (pending.length > 0) {
    const oid = pending.pop();
    if (oid === baseOid || visited.has(oid)) continue;
    if (!OID_PATTERN.test(oid)) fail("commit delta contains a malformed object id");
    visited.add(oid);
    if (visited.size > MAX_OBJECTS) fail("commit delta exceeds the object-count ceiling");
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    await collectTreeObjects(gitdir, commit.tree, new Set());
    for (const parent of commit.parent) pending.push(parent);
  }
  if (!visited.has(commitOid)) fail("publication head does not extend the required base");
}

function nativeGit(gitdir, args, options = {}) {
  const result = spawnSync(
    "/usr/bin/git",
    ["--git-dir", gitdir, ...args],
    {
      encoding: options.binary ? null : "utf8",
      input: options.input,
      maxBuffer: options.maxBuffer ?? MAX_GIT_STDOUT_BYTES,
      timeout: options.timeout ?? 120_000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: gitdir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr ?? "");
    fail(`bounded Git operation failed: ${(stderr.trim().split("\n").at(-1) ?? "unknown").slice(0, 500)}`);
  }
  return result.stdout;
}

function collectCommitDelta(gitdir, headOid, baseOid) {
  if (!OID_PATTERN.test(baseOid)) fail("broker preparation returned a malformed required base");
  nativeGit(gitdir, ["cat-file", "-e", `${baseOid}^{commit}`]);
  nativeGit(gitdir, ["merge-base", "--is-ancestor", baseOid, headOid]);
  const output = String(nativeGit(
    gitdir,
    ["rev-list", "--objects", "--no-object-names", headOid, `^${baseOid}`],
    { maxBuffer: 16 * 1024 * 1024 },
  ));
  const objectOids = [...new Set(output.split(/\r?\n/).filter(Boolean))].sort();
  if (objectOids.length === 0) fail("publication head contains no objects beyond the claimed base");
  if (objectOids.length > MAX_OBJECTS || objectOids.some((oid) => !OID_PATTERN.test(oid))) {
    fail("commit delta exceeds the object-count ceiling or contains a malformed object id");
  }
  const packfile = nativeGit(
    gitdir,
    ["pack-objects", "--stdout", "--revs"],
    { input: `${headOid}\n^${baseOid}\n`, binary: true },
  );
  if (!Buffer.isBuffer(packfile) || packfile.byteLength <= 0 || packfile.byteLength > MAX_PACK_BYTES) {
    fail("commit delta pack is empty or exceeds the byte ceiling");
  }
  return { objectOids, packfile };
}

function credentialHelper() {
  return [
    "!f() {",
    "printf 'username=x-access-token\\npassword=';",
    "cat \"$CREDENTIALS_DIRECTORY/github-token\";",
    "printf '\\n';",
    "}; f",
  ].join(" ");
}

function fetchRequiredBase(gitdir, repositoryFullName, baseRepositoryUrl, requiredBaseOid) {
  const tokenPath = process.env.CREDENTIALS_DIRECTORY
    ? path.join(process.env.CREDENTIALS_DIRECTORY, "github-token")
    : "";
  if (!tokenPath) fail("worker credential boundary is unavailable");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token.startsWith("ghs_") || /\s/.test(token)) fail("worker credential is malformed");
  const canonicalUrl = `https://github.com/${repositoryFullName}.git`;
  const testFileUrl = process.env.GLOOPS_GITHUB_PUSH_TEST_MODE === "1"
    && /^file:\/\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(baseRepositoryUrl);
  if (baseRepositoryUrl !== canonicalUrl && !testFileUrl) {
    fail("base repository URL conflicts with the authenticated repository");
  }
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--git-dir", gitdir,
      "-c", `credential.helper=${credentialHelper()}`,
      "fetch", "--quiet", "--no-tags", "--depth=1",
      testFileUrl ? baseRepositoryUrl : `https://x-access-token@github.com/${repositoryFullName}.git`,
      requiredBaseOid,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: gitdir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        CREDENTIALS_DIRECTORY: process.env.CREDENTIALS_DIRECTORY,
      },
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "base fetch failed";
    fail(`required base fetch failed: ${detail.slice(0, 500)}`);
  }
  const fetched = String(nativeGit(gitdir, ["rev-parse", "FETCH_HEAD"])).trim();
  if (fetched !== requiredBaseOid) fail("fetched base does not match authenticated preparation");
}

function writeExclusive(filepath, bytes) {
  const fd = fs.openSync(filepath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function requestBroker(socketPath, request) {
  const payload = `${canonicalJson(request)}\n`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(180_000);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      output += chunk;
      if (output.length > 128 * 1024) socket.destroy(new Error("broker response exceeds limit"));
    });
    socket.on("timeout", () => socket.destroy(new Error("broker response timed out")));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        const response = JSON.parse(output);
        resolve(response);
      } catch (error) {
        reject(new Error(`broker returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function clientCommand(args) {
  const runId = args.get("--run-id") ?? process.env.PAPERCLIP_RUN_ID ?? "";
  const repoDir = path.resolve(args.get("--repo-dir") ?? process.cwd());
  const socketPath = args.get("--socket") ?? DEFAULT_SOCKET;
  const ingress = args.get("--ingress") ?? DEFAULT_INGRESS;
  if (!RUN_ID_PATTERN.test(runId)) fail("a canonical Paperclip run id is required");
  const repoStat = fs.lstatSync(repoDir);
  if (!repoStat.isDirectory() || repoStat.isSymbolicLink()) fail("repository path must be a real directory");
  const workspaceIdentity = fs.realpathSync(repoDir);
  const { gitdir, headOid: newOid } = await resolveRepositoryGitContext(workspaceIdentity);
  if (!OID_PATTERN.test(newOid)) fail("repository HEAD is not a SHA-1 commit");
  await git.readCommit({ fs, gitdir, oid: newOid });
  const preparation = await requestBroker(socketPath, {
    schemaVersion: "gloops.github-push-prepare-request.v1",
    heartbeatRunId: runId,
    expectedNewOid: newOid,
    workspaceIdentity,
  });
  if (preparation?.ok === false) {
    exactKeys(preparation, ["error", "ok", "schemaVersion"], "broker preparation failure");
    if (
      preparation.schemaVersion !== "gloops.github-push-client-response.v1"
      || typeof preparation.error !== "string"
      || !preparation.error
    ) {
      fail("broker preparation failure was malformed");
    }
    fail(preparation.error);
  }
  exactKeys(preparation, [
    "authorizationDigest",
    "expectedNewOid",
    "heartbeatRunId",
    "ok",
    "preparationDigest",
    "requiredBaseOid",
    "schemaVersion",
  ], "broker preparation");
  if (
    preparation.ok !== true
    || preparation.schemaVersion !== "gloops.github-push-prepare-response.v1"
    || preparation.heartbeatRunId !== runId
    || preparation.expectedNewOid !== newOid
    || !OID_PATTERN.test(preparation.requiredBaseOid)
    || !/^sha256:[0-9a-f]{64}$/.test(preparation.authorizationDigest)
    || !/^sha256:[0-9a-f]{64}$/.test(preparation.preparationDigest)
  ) {
    fail(typeof preparation?.error === "string" ? preparation.error : "broker preparation was invalid");
  }
  const requiredBaseOid = preparation.requiredBaseOid;
  const { objectOids, packfile } = collectCommitDelta(gitdir, newOid, requiredBaseOid);
  const ingressReal = fs.realpathSync(ingress);
  const ingressStat = fs.statSync(ingressReal);
  if (!ingressStat.isDirectory()) fail("broker ingress is unavailable");
  const suffix = randomBytes(16).toString("hex");
  const stem = `${runId}-${suffix}`;
  const packName = `${stem}.pack`;
  const manifestName = `${stem}.json`;
  const packPath = path.join(ingressReal, packName);
  const manifestPath = path.join(ingressReal, manifestName);
  writeExclusive(packPath, packfile);
  const manifest = {
    schemaVersion: "gloops.github-push-bundle.v2",
    heartbeatRunId: runId,
    expectedNewOid: newOid,
    requiredBaseOid,
    preparationDigest: preparation.preparationDigest,
    workspaceIdentity,
    objectCount: objectOids.length,
    objectOids,
    packBytes: packfile.byteLength,
    packName,
    packSha256: sha256(packfile),
  };
  writeExclusive(manifestPath, `${canonicalJson(manifest)}\n`);
  try {
    const response = await requestBroker(socketPath, {
      schemaVersion: "gloops.github-push-client-request.v2",
      heartbeatRunId: runId,
      expectedNewOid: newOid,
      requiredBaseOid,
      preparationDigest: preparation.preparationDigest,
      workspaceIdentity,
      manifestName,
    });
    if (!response || response.ok !== true) {
      fail(typeof response?.error === "string" ? response.error : "broker rejected the mutation");
    }
    process.stdout.write(`${canonicalJson(response)}\n`);
  } finally {
    for (const filepath of [manifestPath, packPath]) {
      try {
        fs.unlinkSync(filepath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

async function importWorkerBundle(args) {
  const requestPath = path.resolve(args.get("--request") ?? "");
  if (!requestPath) fail("worker request boundary is unavailable");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  exactKeys(request, [
    "baseRepositoryUrl",
    "defaultBranch",
    "expectedNewOid",
    "expectedOldOid",
    "gitdir",
    "objectOids",
    "packPath",
    "requiredBaseOid",
    "remoteRef",
    "repositoryFullName",
    "schemaVersion",
  ], "worker request");
  const branchRunId = /^refs\/heads\/paperclip\/([^/]+)\/calibration$/.exec(
    request.remoteRef,
  )?.[1];
  if (
    request.schemaVersion !== "gloops.github-push-worker-request.v1"
    || !OID_PATTERN.test(request.expectedNewOid)
    || !OID_PATTERN.test(request.requiredBaseOid)
    || request.expectedOldOid !== ZERO_OID
    || !branchRunId
    || !RUN_ID_PATTERN.test(branchRunId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repositoryFullName)
    || typeof request.baseRepositoryUrl !== "string"
    || !Array.isArray(request.objectOids)
    || request.objectOids.length === 0
    || request.objectOids.length > MAX_OBJECTS
    || new Set(request.objectOids).size !== request.objectOids.length
    || request.objectOids.some((oid) => !OID_PATTERN.test(oid))
  ) {
    fail("worker request violates the accepted push contract");
  }
  const gitdir = path.resolve(request.gitdir);
  const packPath = path.resolve(request.packPath);
  fs.mkdirSync(path.join(gitdir, "objects", "pack"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(gitdir, "refs", "heads"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/paperclip-source\n", {
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(gitdir, "config"),
    [
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = true",
      "\tbare = true",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  fetchRequiredBase(
    gitdir,
    request.repositoryFullName,
    request.baseRepositoryUrl,
    request.requiredBaseOid,
  );
  const localPack = path.join(gitdir, "objects", "pack", "pack-input.pack");
  fs.copyFileSync(packPath, localPack, fs.constants.COPYFILE_EXCL);
  const { oids } = await git.indexPack({
    fs,
    dir: gitdir,
    gitdir,
    filepath: "objects/pack/pack-input.pack",
  });
  const indexed = [...oids].sort();
  const declared = [...new Set(request.objectOids)].sort();
  if (indexed.length !== declared.length || indexed.some((oid, index) => oid !== declared[index])) {
    fail("pack objects differ from the declared content-addressed bundle");
  }
  nativeGit(gitdir, ["merge-base", "--is-ancestor", request.requiredBaseOid, request.expectedNewOid]);
  await validateDeltaTreeModes(gitdir, request.expectedNewOid, request.requiredBaseOid);
  const reachable = String(nativeGit(
    gitdir,
    [
      "rev-list", "--objects", "--no-object-names",
      request.expectedNewOid, `^${request.requiredBaseOid}`,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  )).split(/\r?\n/).filter(Boolean).sort();
  if (reachable.length !== indexed.length || reachable.some((oid, index) => oid !== indexed[index])) {
    const reachableSet = new Set(reachable);
    const indexedSet = new Set(indexed);
    const missing = reachable.filter((oid) => !indexedSet.has(oid));
    const extra = indexed.filter((oid) => !reachableSet.has(oid));
    fail(
      `pack contains extra objects or does not close over the expected commit `
      + `(reachable=${reachable.length}, indexed=${indexed.length}, missing=${missing.join(",") || "none"}, `
      + `extra=${extra.join(",") || "none"})`,
    );
  }
  return { request, gitdir };
}

async function validateCommand(args) {
  const { request } = await importWorkerBundle(args);
  process.stdout.write(`${canonicalJson({ ok: true, expectedNewOid: request.expectedNewOid })}\n`);
}

async function workerCommand(args) {
  const { request, gitdir } = await importWorkerBundle(args);
  const tokenPath = process.env.CREDENTIALS_DIRECTORY
    ? path.join(process.env.CREDENTIALS_DIRECTORY, "github-token")
    : "";
  if (!tokenPath) fail("worker credential boundary is unavailable");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token.startsWith("ghs_") || /\s/.test(token)) fail("worker credential is malformed");
  await git.writeRef({
    fs,
    gitdir,
    ref: "refs/heads/paperclip-source",
    value: request.expectedNewOid,
    force: false,
  });
  // Supply the non-secret GitHub App username in the URL so Git only asks the
  // isolated credential helper for the short-lived installation token.
  const url = `https://x-access-token@github.com/${request.repositoryFullName}.git`;
  // Git's askpass discovery is not reliable inside the transient hardened
  // systemd worker. Use the native credential-helper protocol instead. The
  // helper command contains only the systemd credential path; the token itself
  // never appears in argv, environment values, logs, or repository config.
  const helper = credentialHelper();
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--git-dir", gitdir,
      "push",
      "--porcelain",
      "--no-force",
      "--no-thin",
      url,
      `refs/heads/paperclip-source:${request.remoteRef}`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: gitdir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: helper,
        GIT_TERMINAL_PROMPT: "0",
        CREDENTIALS_DIRECTORY: process.env.CREDENTIALS_DIRECTORY,
      },
      timeout: 120_000,
    },
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "native Git push failed";
    fail(`native Git push failed: ${detail.slice(0, 500)}`);
  }
  process.stdout.write(`${canonicalJson({ ok: true, expectedNewOid: request.expectedNewOid })}\n`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "client") return clientCommand(args);
  if (command === "validate") return validateCommand(args);
  if (command === "worker") return workerCommand(args);
  fail("usage: github-push-tool client|validate|worker --key value");
}

main().catch((error) => {
  process.stderr.write(`github-push-tool: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
