#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DISPOSITIONS = new Set(["adopt", "adapt", "superseded", "reject", "conflict"]);
const POLICY_PATH = new URL("../upstream-efficiency-policy.json", import.meta.url);
const INVENTORY_PATH = new URL("../upstream-efficiency-inventory.json", import.meta.url);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function themeForCommit(subject, paths) {
  const haystack = `${subject}\n${paths.join("\n")}`.toLowerCase();
  if (/productivity|recovery|liveness|watchdog/.test(haystack)) return "productivity_recovery";
  if (/session|compaction|context|heartbeat/.test(haystack)) return "session_context";
  if (/decision|attention|inbox|queue/.test(haystack)) return "decision_attention";
  if (/cost|usage|token|budget|quota|billing/.test(haystack)) return "usage_cost_telemetry";
  if (/workspace|worktree|sandbox/.test(haystack)) return "workspace_lifecycle";
  if (/adapter|codex|claude|grok|hermes|opencode|acp/.test(haystack)) return "adapter_runtime";
  return "other";
}

export function dispositionForCommit(sha, theme, overrides) {
  const override = overrides[sha];
  if (override) return { disposition: override.disposition, reason: override.reason };
  if (theme === "decision_attention") {
    return {
      disposition: "conflict",
      reason: "Decision and attention queues belong to upstream core; absorb them through core synchronization instead of rebuilding them in GLoops.",
    };
  }
  if (["productivity_recovery", "session_context", "decision_attention", "usage_cost_telemetry", "workspace_lifecycle", "adapter_runtime"].includes(theme)) {
    return {
      disposition: "adapt",
      reason: "Efficiency-adjacent upstream change queued for bounded adaptation; direct wholesale cherry-pick is not authorized by this inventory.",
    };
  }
  return {
    disposition: "reject",
    reason: "Outside the token/workforce-efficiency harvest scope; this is not a permanent rejection from the broader upstream synchronization stream.",
  };
}

function parseLog(raw) {
  const records = [];
  let current = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("@@@")) {
      if (current) records.push(current);
      const [sha, date, subject] = line.slice(3).split("\t");
      current = { sha, date, subject, paths: [] };
    } else if (current && line.trim()) {
      current.paths.push(line.trim());
    }
  }
  if (current) records.push(current);
  return records;
}

export function verifyInventory({ root, policy, inventory }) {
  if (policy.schemaVersion !== "gloops.upstream-efficiency-policy.v1") throw new Error("policy_schema_invalid");
  if (inventory.schemaVersion !== "gloops.upstream-efficiency-inventory.v1") throw new Error("inventory_schema_invalid");
  for (const key of ["upstreamHead", "forkBaselineHead", "commonBase"]) {
    if (inventory[key] !== policy[key]) throw new Error(`inventory_${key}_mismatch`);
  }
  if (inventory.upstreamOnlyCount !== inventory.commits.length) throw new Error("inventory_count_mismatch");
  if (inventory.upstreamOnlyCount !== 611 || inventory.forkOnlyCount !== 425) throw new Error("inventory_pinned_divergence_mismatch");
  const seen = new Set();
  for (const commit of inventory.commits) {
    if (!/^[0-9a-f]{40}$/.test(commit.sha) || seen.has(commit.sha)) throw new Error("inventory_commit_identity_invalid");
    if (!DISPOSITIONS.has(commit.disposition)) throw new Error("inventory_disposition_invalid");
    if (!commit.theme || !commit.reason) throw new Error("inventory_commit_classification_incomplete");
    seen.add(commit.sha);
  }
  for (const [relativePath, expected] of Object.entries(policy.freeze.protectedEdgeSurfaceDigests)) {
    const actual = sha256File(`${root}/${relativePath}`);
    if (actual !== expected) throw new Error(`protected_edge_surface_drift:${relativePath}`);
  }
  return true;
}

function generate(root, policy) {
  const commonBase = git(root, "merge-base", policy.forkRef, policy.upstreamRef);
  if (commonBase !== policy.commonBase) throw new Error("common_base_drift");
  if (git(root, "rev-parse", policy.forkRef) !== policy.forkBaselineHead) throw new Error("fork_baseline_drift");
  if (git(root, "rev-parse", policy.upstreamRef) !== policy.upstreamHead) throw new Error("upstream_head_drift");
  const [upstreamOnlyCount, forkOnlyCount] = git(root, "rev-list", "--left-right", "--count", `${policy.upstreamRef}...${policy.forkRef}`)
    .split(/\s+/)
    .map(Number);
  const raw = git(root, "log", "--date=short", "--format=@@@%H%x09%cs%x09%s", "--name-only", `${commonBase}..${policy.upstreamRef}`);
  const commits = parseLog(raw).map((commit) => {
    const theme = themeForCommit(commit.subject, commit.paths);
    return { ...commit, theme, ...dispositionForCommit(commit.sha, theme, policy.commitOverrides) };
  });
  const dispositionCounts = Object.fromEntries([...DISPOSITIONS].map((disposition) => [
    disposition,
    commits.filter((commit) => commit.disposition === disposition).length,
  ]));
  const themeCounts = Object.fromEntries([...new Set(commits.map((commit) => commit.theme))]
    .sort()
    .map((theme) => [theme, commits.filter((commit) => commit.theme === theme).length]));
  return {
    schemaVersion: "gloops.upstream-efficiency-inventory.v1",
    generatedAt: `${policy.assessmentDate}T00:00:00.000Z`,
    upstreamHead: policy.upstreamHead,
    forkBaselineHead: policy.forkBaselineHead,
    commonBase,
    upstreamOnlyCount,
    forkOnlyCount,
    dispositionCounts,
    themeCounts,
    commits,
  };
}

function main() {
  const command = process.argv[2] ?? "verify";
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  if (command === "generate") {
    const inventory = generate(root, policy);
    writeFileSync(INVENTORY_PATH, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
    verifyInventory({ root, policy, inventory });
    console.log(`classified ${inventory.commits.length} upstream commits`);
    return;
  }
  if (command !== "verify") throw new Error("usage: upstream-efficiency-inventory.mjs [generate|verify]");
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
  verifyInventory({ root, policy, inventory });
  console.log(`upstream efficiency inventory verified (${inventory.commits.length} commits)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  main();
}
