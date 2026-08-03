#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const USAGE = `Usage: node canonical-patch-digest.mjs --base <SHA> --head <SHA> [--repo <path>]

Emit the canonical SHA-256 digest of git diff --no-color --full-index base..head.
The working-tree Git configuration is ignored so core.abbrev cannot change output.
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--base" || key === "--head" || key === "--repo") {
      args[key.slice(2)] = argv[++i];
    } else if (key === "-h" || key === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
  }
  return args;
}

const { base, head, repo } = parseArgs(process.argv.slice(2));

if (!/^[0-9a-f]{40}$/i.test(base ?? "")) {
  console.error("--base must be a full 40-character SHA");
  process.exit(1);
}
if (!/^[0-9a-f]{40}$/i.test(head ?? "")) {
  console.error("--head must be a full 40-character SHA");
  process.exit(1);
}

const cwd = repo ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const diff = execFileSync(
  "git",
  ["diff", "--no-color", "--full-index", `${base}..${head}`],
  {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  },
);

const digest = createHash("sha256").update(diff).digest("hex");
console.log(digest);
