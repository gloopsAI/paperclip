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
  const handshake = container === "paperclip-gloops-handshake";
  const expectedNetworkId = handshake ? "handshake-network-id" : "execution-network-id";
  const defaultNetworks = handshake
    ? { "paperclip-handshake": { NetworkID: expectedNetworkId, IPAddress: "172.30.241.4" } }
    : { "paperclip-execution": { NetworkID: expectedNetworkId, IPAddress: "172.30.240.4" } };
  const defaultPorts = handshake
    ? { "3100/tcp": null }
    : { "3100/tcp": [{ HostIp: "127.0.0.1", HostPort: "3100" }] };
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
docker() {
  case "$*" in
    *network*inspect*Internal*) printf '%s\n' "\${MOCK_INTERNAL:-true}" ;;
    *network*inspect*.Id*) printf '%s\n' "\${MOCK_EXPECTED_NETWORK_ID}" ;;
    *NetworkSettings.Networks*) printf '%s\n' "\${MOCK_NETWORKS_JSON}" ;;
    *NetworkSettings.Ports*) printf '%s\n' "\${MOCK_PORTS_JSON}" ;;
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
      env: {
        ...process.env,
        PAPERCLIP_CONTAINER: container,
        MOCK_EXPECTED_NETWORK_ID: expectedNetworkId,
        MOCK_NETWORKS_JSON: JSON.stringify(defaultNetworks),
        MOCK_PORTS_JSON: JSON.stringify(defaultPorts),
        ...env,
      },
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
    MOCK_PORTS_JSON: JSON.stringify({ "3100/tcp": [{ HostIp: "0.0.0.0", HostPort: "3100" }] }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip execution topology drifted/u);
  fs.rmSync(curlLog, { force: true });
});

test("execution readiness rejects an additional public binding", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-execution-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops", "verify_execution_topology", {
    MOCK_CURL_LOG: curlLog,
    MOCK_PORTS_JSON: JSON.stringify({
      "3100/tcp": [
        { HostIp: "127.0.0.1", HostPort: "3100" },
        { HostIp: "0.0.0.0", HostPort: "3100" },
      ],
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip execution topology drifted/u);
  fs.rmSync(curlLog, { force: true });
});

test("execution readiness rejects an additional network attachment", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-execution-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops", "verify_execution_topology", {
    MOCK_CURL_LOG: curlLog,
    MOCK_NETWORKS_JSON: JSON.stringify({
      "paperclip-execution": { NetworkID: "execution-network-id", IPAddress: "172.30.240.4" },
      bridge: { NetworkID: "unexpected-network-id", IPAddress: "172.17.0.2" },
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip execution topology drifted/u);
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

test("handshake readiness rejects an additional network attachment", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-handshake-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops-handshake", "verify_handshake_topology", {
    MOCK_CURL_LOG: curlLog,
    MOCK_NETWORKS_JSON: JSON.stringify({
      "paperclip-handshake": { NetworkID: "handshake-network-id", IPAddress: "172.30.241.4" },
      bridge: { NetworkID: "unexpected-network-id", IPAddress: "172.17.0.3" },
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip handshake topology drifted/u);
  fs.rmSync(curlLog, { force: true });
});

test("handshake readiness rejects any published binding", () => {
  const curlLog = path.join(process.env.TMPDIR ?? "/tmp", `paperclip-handshake-curl-${process.pid}`);
  const result = runFunction("paperclip-gloops-handshake", "verify_handshake_topology", {
    MOCK_CURL_LOG: curlLog,
    MOCK_PORTS_JSON: JSON.stringify({
      "3100/tcp": [{ HostIp: "127.0.0.1", HostPort: "3100" }],
    }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Paperclip handshake topology drifted/u);
  fs.rmSync(curlLog, { force: true });
});
