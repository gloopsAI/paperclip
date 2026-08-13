#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { requestTimeoutMs } from "./platform-ops-tool.mjs";

test("mutating broker operations outlive the bounded deployment health window", () => {
  assert.equal(requestTimeoutMs({ operation: "service-status" }), 30_000);
  assert.equal(requestTimeoutMs({ operation: "deploy-pinned-image" }), 180_000);
  assert.equal(requestTimeoutMs({ operation: "rollback-rehearsal" }), 180_000);
});
