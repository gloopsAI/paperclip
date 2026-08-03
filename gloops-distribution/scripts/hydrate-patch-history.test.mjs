import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./hydrate-patch-history.mjs",
);
const roots = [];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hydrate-patch-history-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");

  git(root, "init", "--bare", remote);
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Patch History Test");
  git(seed, "config", "user.email", "patch-history@example.invalid");
  writeFileSync(join(seed, "main.txt"), "main\n");
  git(seed, "add", "main.txt");
  git(seed, "commit", "-m", "main");

  git(seed, "switch", "-c", "archive");
  writeFileSync(join(seed, "patch.txt"), "base\n");
  git(seed, "add", "patch.txt");
  git(seed, "commit", "-m", "patch base");
  const base = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "patch.txt"), "head\n");
  git(seed, "commit", "-am", "patch head");
  const head = git(seed, "rev-parse", "HEAD");

  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main", "archive");
  git(root, "clone", "--no-local", "--single-branch", "--branch", "main", remote, clone);

  return { base, clone, head };
}

function writeManifest(repo, base, head) {
  const path = join(repo, "manifest.json");
  writeFileSync(
    path,
    JSON.stringify({
      patches: [
        {
          id: "fixture",
          sourceBase: base,
          sourceHead: head,
          patchDiffAlgorithm: "git-diff-no-color-full-index-sha256-v1",
        },
      ],
    }),
  );
  return path;
}

function hasCommit(repo, sha) {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: repo,
      stdio: "ignore",
    }).status === 0
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("hydrate-patch-history", () => {
  it("fetches exact canonical source commits omitted by a single-branch clone", () => {
    const { base, clone, head } = fixture();
    const manifest = writeManifest(clone, base, head);
    assert.equal(hasCommit(clone, head), false);

    execFileSync(
      "node",
      [script, "--repo", clone, "--manifest", manifest],
      { stdio: "pipe" },
    );

    assert.equal(hasCommit(clone, base), true);
    assert.equal(hasCommit(clone, head), true);
  });

  it("fails closed when a canonical source commit cannot be fetched", () => {
    const { base, clone } = fixture();
    const missing = "f".repeat(40);
    const manifest = writeManifest(clone, base, missing);

    assert.throws(() => {
      execFileSync(
        "node",
        [script, "--repo", clone, "--manifest", manifest],
        { stdio: "pipe" },
      );
    });
    assert.equal(hasCommit(clone, missing), false);
  });
});
