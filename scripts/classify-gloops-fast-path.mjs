#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

const exactPaths = new Set([
  "server/src/services/execution-admission.ts",
  "server/src/services/execution-admission.test.ts",
  "server/src/services/guarded-admission-reset.ts",
  "server/src/services/heartbeat.ts",
  "server/src/__tests__/guarded-admission-reset.test.ts",
  "server/src/__tests__/heartbeat-comment-wake-batching.test.ts",
  "gloops-distribution/deploy/hermes/pin-paperclip-image.sh",
  "gloops-distribution/deploy/hermes/pin_paperclip_image_test.sh",
]);

const allowedPrefixes = [
  "packages/adapters/hermes/src/",
];

export function classifyGloopsFastPath(files) {
  const normalized = files
    .map((file) => file.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  const rejected = normalized.filter(
    (file) => !exactPaths.has(file) && !allowedPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  return {
    eligible: normalized.length > 0 && rejected.length === 0,
    heartbeatTouched: normalized.includes("server/src/services/heartbeat.ts"),
    files: normalized,
    rejected,
  };
}

function main() {
  const args = process.argv.slice(2);
  let outputPath = "";
  if (args[0] === "--github-output") {
    outputPath = args[1] ?? "";
    args.splice(0, 2);
  }
  if (args.length !== 1) {
    throw new Error("usage: classify-gloops-fast-path.mjs [--github-output PATH] CHANGED_FILES");
  }
  const result = classifyGloopsFastPath(readFileSync(args[0], "utf8").split("\n"));
  const output = [
    `eligible=${String(result.eligible)}`,
    `heartbeat_touched=${String(result.heartbeatTouched)}`,
    `changed_count=${result.files.length}`,
    `rejected_count=${result.rejected.length}`,
  ].join("\n") + "\n";
  if (outputPath) appendFileSync(outputPath, output);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
