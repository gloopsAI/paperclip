import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dispositionForCommit, themeForCommit, verifyInventoryFileDigest } from "./upstream-efficiency-inventory.mjs";

test("classifies efficiency themes from subject and changed paths", () => {
  assert.equal(themeForCommit("fix recovery loop", ["server/src/services/foo.ts"]), "productivity_recovery");
  assert.equal(themeForCommit("refactor", ["packages/adapter-utils/src/session-compaction.ts"]), "session_context");
  assert.equal(themeForCommit("add queue", ["server/src/services/decision-queues.ts"]), "decision_attention");
  assert.equal(themeForCommit("report usage", ["server/src/services/costs.ts"]), "usage_cost_telemetry");
  assert.equal(themeForCommit("copy", ["server/src/services/workspace-runtime.ts"]), "workspace_lifecycle");
  assert.equal(themeForCommit("adapter fix", ["packages/adapters/codex-local/src/server.ts"]), "adapter_runtime");
  assert.equal(themeForCommit("button polish", ["ui/src/button.tsx"]), "other");
});

test("curated overrides win and remaining commits fail into explicit bounded dispositions", () => {
  assert.deepEqual(
    dispositionForCommit("a".repeat(40), "session_context", {
      ["a".repeat(40)]: { disposition: "superseded", reason: "already present" },
    }),
    { disposition: "superseded", reason: "already present" },
  );
  assert.equal(dispositionForCommit("b".repeat(40), "adapter_runtime", {}).disposition, "adapt");
  assert.equal(dispositionForCommit("b".repeat(40), "decision_attention", {}).disposition, "conflict");
  assert.equal(dispositionForCommit("c".repeat(40), "other", {}).disposition, "reject");
});

test("the committed inventory digest fails closed on same-count row tampering", () => {
  const bytes = Buffer.from('{"commits":[{"sha":"a"}]}\n');
  const digest = createHash("sha256").update(bytes).digest("hex");
  const policy = { freeze: { inventoryFileSha256: digest } };
  assert.throws(
    () => verifyInventoryFileDigest(policy, bytes),
    /inventory_pinned_graph_attestation_mismatch/,
  );
  const tamperedBytes = Buffer.from('{"commits":[{"sha":"b"}]}\n');
  const pairedTamperedPolicy = {
    freeze: { inventoryFileSha256: createHash("sha256").update(tamperedBytes).digest("hex") },
  };
  assert.throws(
    () => verifyInventoryFileDigest(pairedTamperedPolicy, tamperedBytes),
    /inventory_pinned_graph_attestation_mismatch/,
  );
});
