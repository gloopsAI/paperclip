import assert from "node:assert/strict";
import test from "node:test";

import { classifyGloopsFastPath } from "./classify-gloops-fast-path.mjs";

test("accepts a Hermes adapter change plus its tests", () => {
  const result = classifyGloopsFastPath([
    "packages/adapters/hermes/src/gateway/server/execute.ts",
    "packages/adapters/hermes/src/gateway/server/execute.test.ts",
  ]);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.rejected, []);
});

test("accepts the focused server implementation and companion tests", () => {
  const result = classifyGloopsFastPath([
    "server/src/services/execution-admission.ts",
    "server/src/services/execution-admission.test.ts",
    "server/src/services/guarded-admission-reset.ts",
    "server/src/__tests__/guarded-admission-reset.test.ts",
  ]);
  assert.equal(result.eligible, true);
});

test("requires heartbeat tests only when heartbeat implementation is touched", () => {
  const result = classifyGloopsFastPath([
    "server/src/services/heartbeat.ts",
    "server/src/__tests__/heartbeat-comment-wake-batching.test.ts",
  ]);
  assert.equal(result.eligible, true);
  assert.equal(result.heartbeatTouched, true);
});

test("rejects mixed changes outside the narrow production class", () => {
  const result = classifyGloopsFastPath([
    "packages/adapters/hermes/src/gateway/server/execute.ts",
    "packages/db/src/schema/issues.ts",
  ]);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.rejected, ["packages/db/src/schema/issues.ts"]);
});

test("rejects Hermes package metadata and dependency changes", () => {
  const result = classifyGloopsFastPath([
    "packages/adapters/hermes/src/gateway/server/execute.ts",
    "packages/adapters/hermes/package.json",
  ]);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.rejected, ["packages/adapters/hermes/package.json"]);
});

test("rejects an empty change list", () => {
  assert.equal(classifyGloopsFastPath([]).eligible, false);
});
