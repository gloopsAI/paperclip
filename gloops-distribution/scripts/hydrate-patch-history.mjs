#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const canonicalAlgorithm = "git-diff-no-color-full-index-sha256-v1";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--repo" || key === "--manifest" || key === "--remote") {
      args[key.slice(2)] = argv[++index];
    } else if (key === "-h" || key === "--help") {
      console.log(
        "Usage: node hydrate-patch-history.mjs [--repo <path>] [--manifest <path>] [--remote <name>]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${key}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repo = resolve(args.repo ?? defaultRepo);
const manifestPath = resolve(
  repo,
  args.manifest ?? "gloops-distribution/manifest.json",
);
const remote = args.remote ?? "origin";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function hasCommit(sha) {
  return (
    spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: repo,
      stdio: "ignore",
    }).status === 0
  );
}

const required = new Set();
for (const patch of manifest.patches ?? []) {
  if (patch.patchDiffAlgorithm !== canonicalAlgorithm) continue;
  for (const sha of [patch.sourceBase, patch.sourceHead]) {
    if (!/^[0-9a-f]{40}$/u.test(sha ?? "")) {
      throw new Error(`${patch.id}: canonical patch history requires full SHAs`);
    }
    required.add(sha);
  }
}

const missing = [...required].filter((sha) => !hasCommit(sha));
if (missing.length > 0) {
  console.log(
    `Hydrating ${missing.length} canonical patch-history commit(s) from ${remote}`,
  );
  execFileSync(
    "git",
    ["fetch", "--no-tags", "--no-recurse-submodules", remote, ...missing],
    {
      cwd: repo,
      stdio: "inherit",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

const stillMissing = [...required].filter((sha) => !hasCommit(sha));
if (stillMissing.length > 0) {
  throw new Error(
    `canonical patch history remains unavailable after fetch: ${stillMissing.join(", ")}`,
  );
}

console.log(
  `Canonical patch history ready: ${required.size} commit(s), ${missing.length} fetched`,
);
