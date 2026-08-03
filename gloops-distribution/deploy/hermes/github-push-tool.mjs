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
const DEFAULT_SOCKET = "/run/paperclip-github-broker/broker.sock";
const DEFAULT_INGRESS = "/run/paperclip-github-broker/ingress";
const ACCEPTED_BLOB_MODES = new Set(["100644", "100755", "120000"]);
const ACCEPTED_TREE_MODE = "040000";
const MAX_SYMLINK_TARGET_BYTES = 4096;

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

  const worktreeMarker = `${path.sep}.paperclip${path.sep}worktrees${path.sep}`;
  const markerIndex = repoDir.indexOf(worktreeMarker);
  if (markerIndex <= 0) fail("repository worktree is outside the Paperclip worktree boundary");
  const projectRoot = repoDir.slice(0, markerIndex);
  const expectedCommonGitdir = fs.realpathSync(path.join(projectRoot, ".git"));
  const expectedGitdirParent = fs.realpathSync(path.join(expectedCommonGitdir, "worktrees"));
  if (path.dirname(resolvedGitdir) !== expectedGitdirParent) {
    fail("repository worktree gitdir is outside the project Git boundary");
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
  if (resolvedCommonGitdir !== expectedCommonGitdir) {
    fail("repository worktree common Git boundary does not match the project");
  }
  return {
    gitdir: resolvedCommonGitdir,
    headOid: await resolveHeadOid(resolvedCommonGitdir, path.join(resolvedGitdir, "HEAD")),
  };
}

function validateSymlinkTarget(blob, entryPath) {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength > MAX_SYMLINK_TARGET_BYTES) {
    fail("tree contains an unsafe symbolic link target");
  }
  let target;
  try {
    target = new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    fail("tree contains an unsafe symbolic link target");
  }
  if (
    path.posix.isAbsolute(target)
    || /^[A-Za-z]:/u.test(target)
    || target.includes("\\")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(target)
  ) {
    fail("tree contains an unsafe symbolic link target");
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  const resolvesThroughGitBoundary = resolved
    .split("/")
    .some((segment) => segment.toLowerCase() === ".git");
  if (
    resolved === ".."
    || resolved.startsWith("../")
    || path.posix.isAbsolute(resolved)
    || resolvesThroughGitBoundary
  ) {
    fail("tree contains an unsafe symbolic link target");
  }
}

async function collectTreeInventory(
  gitdir,
  treeOid,
  inventory,
  treePath = "",
  visitedTreeContexts = new Set(),
) {
  const visitKey = `${treeOid}\u0000${treePath}`;
  if (visitedTreeContexts.has(visitKey)) return;
  visitedTreeContexts.add(visitKey);
  if (visitedTreeContexts.size > MAX_OBJECTS) fail("commit closure exceeds the tree-context ceiling");
  inventory.trees.add(treeOid);
  if (inventory.trees.size > MAX_OBJECTS) fail("commit closure exceeds the object-count ceiling");
  const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
  for (const entry of tree) {
    const entryPath = treePath ? `${treePath}/${entry.path}` : entry.path;
    if (!OID_PATTERN.test(entry.oid)) fail("tree contains a malformed object id");
    if (
      (entry.type === "tree" && entry.mode !== ACCEPTED_TREE_MODE)
      || (entry.type === "blob" && !ACCEPTED_BLOB_MODES.has(entry.mode))
      || (entry.type !== "tree" && entry.type !== "blob")
    ) {
      fail("tree contains an unsupported object type or mode");
    }
    if (entry.type === "blob" && entry.mode === "120000") {
      const { blob } = await git.readBlob({ fs, gitdir, oid: entry.oid });
      validateSymlinkTarget(blob, entryPath);
      inventory.symlinks.add(entry.oid);
    } else if (entry.type === "blob") {
      inventory.blobs.add(entry.oid);
    }
    if (entry.type === "tree") {
      await collectTreeInventory(
        gitdir,
        entry.oid,
        inventory,
        entryPath,
        visitedTreeContexts,
      );
    }
    if (
      inventory.trees.size + inventory.symlinks.size + inventory.blobs.size > MAX_OBJECTS
    ) {
      fail("commit closure exceeds the object-count ceiling");
    }
  }
}

function runRevisionWalk(gitdir, commitOid, baseOid) {
  const revisions = baseOid
    ? [commitOid, `^${baseOid}`]
    : [commitOid, "--not", "--remotes"];
  const result = spawnSync(
    "/usr/bin/git",
    ["--git-dir", gitdir, "rev-list", "--topo-order", "--boundary", ...revisions],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (result.error?.code === "ENOBUFS") fail("base-aware revision walk exceeds the output ceiling");
  if (result.status !== 0) {
    const detail = result.stderr.trim().split("\n").at(-1) ?? "revision walk failed";
    fail(`base-aware revision walk failed: ${detail.slice(0, 500)}`);
  }
  const commits = [];
  const boundaries = [];
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const isBoundary = line.startsWith("-");
    const oid = isBoundary ? line.slice(1) : line;
    if (!OID_PATTERN.test(oid)) fail("base-aware revision walk returned a malformed object id");
    (isBoundary ? boundaries : commits).push(oid);
  }
  if (commits.length === 0 || commits[0] !== commitOid || commits.length > MAX_OBJECTS) {
    fail("repository HEAD is not ahead of a bounded published base");
  }
  if (baseOid && !boundaries.includes(baseOid)) {
    fail("explicit base object is not an ancestor boundary of repository HEAD");
  }
  return {
    commits: [...new Set(commits)],
    boundaries: [...new Set(boundaries)],
  };
}

async function collectCommitClosure(gitdir, commitOid, baseOid = "") {
  if (!OID_PATTERN.test(commitOid)) fail("commit closure contains a malformed object id");
  if (baseOid && (!OID_PATTERN.test(baseOid) || baseOid === ZERO_OID)) {
    fail("base object must be a non-zero SHA-1 commit");
  }
  const { commits, boundaries } = runRevisionWalk(gitdir, commitOid, baseOid);
  const commitSet = new Set(commits);
  const boundarySet = new Set(boundaries);
  const objects = new Set(boundaries);
  for (const oid of commits) {
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    objects.add(oid);
    for (const parent of commit.parent) {
      if (!commitSet.has(parent) && !boundarySet.has(parent)) {
        fail("base-aware revision walk does not close over the new commit graph");
      }
    }
    const inventory = { trees: new Set(), symlinks: new Set(), blobs: new Set() };
    await collectTreeInventory(gitdir, commit.tree, inventory);
    for (const objectOid of [...inventory.trees, ...inventory.symlinks, ...inventory.blobs]) {
      objects.add(objectOid);
    }
    if (objects.size > MAX_OBJECTS) fail("commit closure exceeds the object-count ceiling");
  }
  if (boundaries.length === 0) {
    fail("published base boundary is unavailable; refusing an unbounded history walk");
  }
  for (const boundary of boundaries) await git.readCommit({ fs, gitdir, oid: boundary });
  return [...objects].sort();
}

async function collectImportedCommitClosure(gitdir, commitOid, indexedOids) {
  const objects = new Set();
  const boundaries = new Set();
  const pending = [commitOid];
  while (pending.length > 0) {
    const oid = pending.pop();
    if (objects.has(oid)) continue;
    if (!OID_PATTERN.test(oid) || !indexedOids.has(oid)) {
      fail("commit closure contains a missing or malformed object id");
    }
    objects.add(oid);
    if (objects.size > MAX_OBJECTS) fail("commit closure exceeds the object-count ceiling");
    const { commit } = await git.readCommit({ fs, gitdir, oid });
    if (oid !== commitOid && !indexedOids.has(commit.tree)) {
      boundaries.add(oid);
      continue;
    }
    const inventory = { trees: new Set(), symlinks: new Set(), blobs: new Set() };
    await collectTreeInventory(gitdir, commit.tree, inventory);
    for (const objectOid of [...inventory.trees, ...inventory.symlinks, ...inventory.blobs]) {
      objects.add(objectOid);
    }
    for (const parent of commit.parent) pending.push(parent);
  }
  return { objects: [...objects].sort(), boundaries: [...boundaries].sort() };
}

function packCommitClosure(gitdir, objectOids) {
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--git-dir", gitdir,
      "pack-objects",
      "--stdout",
      "--no-reuse-delta",
      "--no-reuse-object",
    ],
    {
      input: `${objectOids.join("\n")}\n`,
      maxBuffer: MAX_PACK_BYTES + 1,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: gitdir,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
  if (result.error?.code === "ENOBUFS") fail("commit pack exceeds the byte ceiling");
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim().split("\n").at(-1) ?? "native pack failed";
    fail(`native commit pack failed: ${detail.slice(0, 500)}`);
  }
  return result.stdout;
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
  const { gitdir, headOid: newOid } = await resolveRepositoryGitContext(repoDir);
  if (!OID_PATTERN.test(newOid)) fail("repository HEAD is not a SHA-1 commit");
  await git.readCommit({ fs, gitdir, oid: newOid });
  const objectOids = await collectCommitClosure(gitdir, newOid, args.get("--base-oid") ?? "");
  const packfile = packCommitClosure(gitdir, objectOids);
  if (!(packfile instanceof Uint8Array) || packfile.byteLength <= 0 || packfile.byteLength > MAX_PACK_BYTES) {
    fail("commit pack is empty or exceeds the byte ceiling");
  }
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
    schemaVersion: "gloops.github-push-bundle.v1",
    heartbeatRunId: runId,
    expectedNewOid: newOid,
    objectCount: objectOids.length,
    objectOids,
    packBytes: packfile.byteLength,
    packName,
    packSha256: sha256(packfile),
  };
  writeExclusive(manifestPath, `${canonicalJson(manifest)}\n`);
  try {
    const response = await requestBroker(socketPath, {
      schemaVersion: "gloops.github-push-client-request.v1",
      heartbeatRunId: runId,
      expectedNewOid: newOid,
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
    "defaultBranch",
    "expectedNewOid",
    "expectedOldOid",
    "gitdir",
    "objectOids",
    "packPath",
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
    || request.expectedOldOid !== ZERO_OID
    || !branchRunId
    || !RUN_ID_PATTERN.test(branchRunId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repositoryFullName)
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
  const { objects: reachable, boundaries } = await collectImportedCommitClosure(
    gitdir,
    request.expectedNewOid,
    new Set(indexed),
  );
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
  return { request, gitdir, boundaries };
}

async function validateCommand(args) {
  const { request } = await importWorkerBundle(args);
  process.stdout.write(`${canonicalJson({ ok: true, expectedNewOid: request.expectedNewOid })}\n`);
}

async function workerCommand(args) {
  const { request, gitdir, boundaries } = await importWorkerBundle(args);
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
  if (boundaries.length > 0) {
    fs.writeFileSync(path.join(gitdir, "shallow"), `${boundaries.join("\n")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  // Supply the non-secret GitHub App username in the URL so Git only asks the
  // isolated credential helper for the short-lived installation token.
  const url = `https://x-access-token@github.com/${request.repositoryFullName}.git`;
  // Git's askpass discovery is not reliable inside the transient hardened
  // systemd worker. Use the native credential-helper protocol instead. The
  // helper command contains only the systemd credential path; the token itself
  // never appears in argv, environment values, logs, or repository config.
  const credentialHelper = [
    "!f() {",
    "printf 'username=x-access-token\\npassword=';",
    "cat \"$CREDENTIALS_DIRECTORY/github-token\";",
    "printf '\\n';",
    "}; f",
  ].join(" ");
  const result = spawnSync(
    "/usr/bin/git",
    [
      "--git-dir", gitdir,
      "push",
      "--porcelain",
      "--no-force",
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
        GIT_CONFIG_VALUE_0: credentialHelper,
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
