#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly CONTAINER='paperclip-gloops-handshake'
readonly IMAGE='node:lts-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169'
readonly RESPONSE_COMMENT='paperclip-handshake-control-plane-response'
readonly HEALTH_URL='http://172.30.241.4:3100/api/health'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
for command in curl docker iptables; do
  command -v "${command}" >/dev/null || { echo "required command is unavailable: ${command}" >&2; exit 1; }
done
for unit in paperclip-gloops.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service; do
  if systemctl is-active --quiet "${unit}" 2>/dev/null; then
    echo "refusing firewall rehearsal while ${unit} is active" >&2
    exit 1
  fi
done
if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER}" \
  || docker network inspect paperclip-handshake >/dev/null 2>&1 \
  || iptables -nL PCLIP-HS-IN >/dev/null 2>&1 \
  || iptables -nL PCLIP-HS-FWD >/dev/null 2>&1 \
  || [[ -e /run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE ]]; then
  echo 'refusing to replace an existing handshake topology' >&2
  exit 1
fi

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  if docker network inspect paperclip-handshake >/dev/null 2>&1 \
    || iptables -nL PCLIP-HS-IN >/dev/null 2>&1 \
    || iptables -nL PCLIP-HS-FWD >/dev/null 2>&1; then
    "${SCRIPT_DIR}/remove-hermes-handshake-egress.sh" >/dev/null
  fi
}
trap cleanup EXIT INT TERM

"${SCRIPT_DIR}/install-hermes-handshake-egress.sh" >/dev/null
docker pull "${IMAGE}" >/dev/null
docker run --detach --name "${CONTAINER}" --pull never \
  --network paperclip-handshake --ip 172.30.241.4 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --health-cmd "node -e \"fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
  --health-interval 1s --health-timeout 1s --health-retries 10 --health-start-period 1s \
  "${IMAGE}" node -e \
  "require('node:http').createServer((req,res)=>{res.writeHead(req.url==='/api/health'?200:404);res.end('ok')}).listen(3100,'0.0.0.0')" \
  >/dev/null

PAPERCLIP_CONTAINER="${CONTAINER}" "${SCRIPT_DIR}/wait-paperclip-control-plane.sh" >/dev/null
[[ -z "$(docker port "${CONTAINER}")" ]] || { echo 'test container unexpectedly publishes a host port' >&2; exit 1; }

iptables -D PCLIP-HS-IN -s 172.30.241.4 -d 172.30.241.1 -p tcp --sport 3100 \
  -m conntrack --ctstate ESTABLISHED,RELATED \
  -m comment --comment "${RESPONSE_COMMENT}" -j ACCEPT
if curl --fail --silent --show-error --max-time 2 --header 'Host: 127.0.0.1' "${HEALTH_URL}" >/dev/null 2>&1; then
  echo 'host readiness succeeded after its established-response grant was removed' >&2
  exit 1
fi
iptables -I PCLIP-HS-IN 2 -s 172.30.241.4 -d 172.30.241.1 -p tcp --sport 3100 \
  -m conntrack --ctstate ESTABLISHED,RELATED \
  -m comment --comment "${RESPONSE_COMMENT}" -j ACCEPT
PAPERCLIP_CONTAINER="${CONTAINER}" "${SCRIPT_DIR}/wait-paperclip-control-plane.sh" >/dev/null

echo 'PASS internal control-plane readiness is reachable only through its established-response firewall grant'
