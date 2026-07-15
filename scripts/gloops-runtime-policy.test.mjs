import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateHermesRuntimePrivileges } from "./gloops-runtime-policy.mjs";

const service = readFileSync(
  new URL(
    "../gloops-distribution/deploy/hermes/paperclip-hermes-execution.service",
    import.meta.url,
  ),
  "utf8",
);
const insertionPoint = " --security-opt no-new-privileges:true";

function withOption(option) {
  return service.replace(insertionPoint, ` ${option}${insertionPoint}`);
}

test("accepts the exact Hermes runtime privilege boundary", () => {
  assert.deepEqual(validateHermesRuntimePrivileges(service), []);
});

for (const [name, option] of [
  ["equals-form capability", "--cap-add=SYS_ADMIN"],
  ["lowercase capability", "--cap-add=sys_admin"],
  ["duplicate capability", "--cap-add KILL"],
  ["privileged mode", "--privileged"],
  ["equals-form host PID namespace", "--pid=host"],
  ["space-form host PID namespace", "--pid host"],
]) {
  test(`rejects ${name}`, () => {
    assert.notDeepEqual(validateHermesRuntimePrivileges(withOption(option)), []);
  });
}

test("rejects an incomplete capability option", () => {
  assert.notDeepEqual(
    validateHermesRuntimePrivileges(withOption("--cap-add")),
    [],
  );
});
