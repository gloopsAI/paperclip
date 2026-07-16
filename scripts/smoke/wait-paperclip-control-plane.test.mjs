import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(
  repoRoot,
  "gloops-distribution",
  "deploy",
  "hermes",
  "wait-paperclip-control-plane.sh",
);
const script = fs.readFileSync(scriptPath, "utf8");
const functionPrefix = script.slice(0, script.indexOf('[[ "${EUID}"'));

function runFunction(container, functionName, env = {}) {
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
docker() {
  case "$*" in
    *NetworkID*) printf '%s\n' "\${MOCK_NETWORK_ID:-network-id}" ;;
    *HostIp*) printf '%s\n' "\${MOCK_HOST_IP:-127.0.0.1}" ;;
    *HostPort*) printf '%s\n' "\${MOCK_HOST_PORT:-3100}" ;;
    *Internal*paperclip-handshake*) printf '%s\n' "\${MOCK_INTERNAL:-true}" ;;
    *paperclip-handshake*IPAddress*) printf '%s\n' "\${MOCK_CONTAINER_IP:-172.30.241.4}" ;;
    *) return 1 ;;
  esac
}
curl() {
  printf '%s\n' "$*" > "\${MOCK_CURL_LOG}"
  [[ "\${MOCK_CURL_OK:-1}" == '1' ]]
}
${functionPrefix}
${functionName}`,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PAPERCLIP_CONTAINER: container, ...env },
    },
  );
}

test("execution readiness accepts only the exact loopback publication", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-execution-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops", "verify_execution_topology", {
    MOCK_CURL_LOG: curlLog,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(curlLog, "utf8"), /http:\/\/127\.0\.0\.1:3100\/api\/health/u);
  fs.rmSync(curlLog, { force: true });
});

test("execution readiness rejects a non-loopback publication", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-execution-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops", "verify_execution_topology", {
    MOCK_CURL_LOG: curlLog,
    MOCK_HOST_IP: "0.0.0.0",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip execution topology drifted/u);
  assert.doesNotMatch(result.stderr, /network-id.*0\.0\.0\.0.*3100.*token/u);
  fs.rmSync(curlLog, { force: true });
});

test("handshake readiness preserves the internal fixed-IP boundary", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-handshake-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops-handshake", "verify_handshake_topology", {
    MOCK_CURL_LOG: curlLog,
  });
  assert.equal(result.status, 0, result.stderr);
  const request = fs.readFileSync(curlLog, "utf8");
  assert.match(request, /Host: 127\.0\.0\.1/u);
  assert.match(request, /http:\/\/172\.30\.241\.4:3100\/api\/health/u);
  fs.rmSync(curlLog, { force: true });
});

test("handshake readiness rejects a non-internal network", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-handshake-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops-handshake", "verify_handshake_topology", {
    MOCK_CURL_LOG: curlLog,
    MOCK_INTERNAL: "false",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip handshake topology drifted/u);
  fs.rmSync(curlLog, { force: true });
});
