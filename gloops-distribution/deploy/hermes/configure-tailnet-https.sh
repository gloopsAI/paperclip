#!/usr/bin/env bash
set -euo pipefail

readonly HOSTNAME='ubuntu-hermes-nyc1.taild219d6.ts.net'
readonly PORT='8443'
readonly PROXY='http://127.0.0.1:3100'

[[ "${EUID}" -eq 0 ]] || {
  echo "run with sudo" >&2
  exit 1
}

before="$(mktemp)"
after="$(mktemp)"
trap 'rm -f "${before}" "${after}"' EXIT

tailscale serve status --json >"${before}"
tailscale serve --bg --https="${PORT}" --yes "${PROXY}" >/dev/null
tailscale serve status --json >"${after}"

node - "${before}" "${after}" "${HOSTNAME}" "${PORT}" "${PROXY}" <<'NODE'
const { readFileSync } = require("node:fs");
const [beforePath, afterPath, hostname, port, proxy] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
const endpoint = `${hostname}:${port}`;

function withoutEndpoint(config) {
  const copy = structuredClone(config);
  if (copy.TCP) delete copy.TCP[port];
  if (copy.Web) delete copy.Web[endpoint];
  if (copy.AllowFunnel) delete copy.AllowFunnel[endpoint];
  return copy;
}

if (JSON.stringify(withoutEndpoint(before)) !== JSON.stringify(withoutEndpoint(after))) {
  throw new Error("configuring Paperclip HTTPS changed an unrelated Tailscale Serve/Funnel endpoint");
}
if (after.TCP?.[port]?.HTTPS !== true) {
  throw new Error("Paperclip HTTPS listener is missing");
}
if (after.Web?.[endpoint]?.Handlers?.["/"]?.Proxy !== proxy) {
  throw new Error("Paperclip HTTPS proxy target is incorrect");
}
if (after.AllowFunnel?.[endpoint] === true) {
  throw new Error("Paperclip HTTPS must not enable Funnel");
}

console.log(`PASS tailnet-only HTTPS ${endpoint} -> ${proxy}; unrelated endpoints preserved`);
NODE
