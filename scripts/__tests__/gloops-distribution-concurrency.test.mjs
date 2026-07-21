import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("gloops distribution supersedes obsolete stable-head publication runs", () => {
  const workflow = readWorkflow("gloops-distribution.yml");

  assert.match(
    workflow,
    /concurrency:\n\s+group: gloops-distribution-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true\n/,
  );

  // Stable publication remains push-driven on gloops/stable.
  assert.match(workflow, /branches:\n\s+-\s+"gloops\/stable"/);
  assert.match(workflow, /type=raw,value=stable,enable=\$\{\{ github\.ref == 'refs\/heads\/gloops\/stable' \}\}/);

  // Multiarch publication is reserved for push (not PR) builds.
  assert.match(
    workflow,
    /platforms: \$\{\{ github\.event_name == 'push' && 'linux\/amd64,linux\/arm64' \|\| 'linux\/amd64' \}\}/,
  );
  assert.match(workflow, /push: \$\{\{ github\.event_name == 'push' \}\}/);
});

test("PR CI concurrency remains isolated per pull request", () => {
  const prWorkflow = readWorkflow("pr.yml");

  assert.match(
    prWorkflow,
    /concurrency:\n\s+group: pr-\$\{\{ github\.event\.pull_request\.number \}\}\n\s+cancel-in-progress: true\n/,
  );
});

test("manual stable release workflow keeps non-cancelling concurrency", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /concurrency:\n\s+group: release-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false\n/,
  );
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /publish_stable:/);
});
