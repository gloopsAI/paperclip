#!/usr/bin/env bash
set -euo pipefail

readonly NETWORK='paperclip-handshake'
readonly SUBNET='172.30.241.0/29'
readonly GATEWAY='172.30.241.1'
readonly HERMES_IP='172.30.241.3'
readonly PAPERCLIP_IP='172.30.241.4'
readonly PROXY_PORT='18080'
readonly INPUT_CHAIN='PCLIP-HS-IN'
readonly FORWARD_CHAIN='PCLIP-HS-FWD'
readonly STATE_DIR='/run/paperclip-gloops'
readonly STATE_FILE="${STATE_DIR}/HANDSHAKE_EGRESS_ACTIVE"
readonly CLEANUP='/usr/local/lib/paperclip-gloops/remove-hermes-handshake-egress.sh'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
for command in docker iptables jq python3; do
  command -v "${command}" >/dev/null || { echo "required command is unavailable: ${command}" >&2; exit 1; }
done
iptables -nL INPUT >/dev/null
iptables -nL DOCKER-USER >/dev/null
if [[ -e "${STATE_FILE}" ]] \
  || iptables -nL "${INPUT_CHAIN}" >/dev/null 2>&1 \
  || iptables -nL "${FORWARD_CHAIN}" >/dev/null 2>&1; then
  echo 'refusing to replace an existing Hermes handshake egress boundary' >&2
  exit 1
fi

state_tmp=''
cleanup_on_error() {
  local status="${1:-$?}"
  [[ -z "${state_tmp}" ]] || rm -f "${state_tmp}"
  if [[ -x "${CLEANUP}" ]]; then "${CLEANUP}" || true; fi
  exit "${status}"
}
trap cleanup_on_error ERR
trap 'cleanup_on_error 130' INT
trap 'cleanup_on_error 143' TERM

if docker network inspect "${NETWORK}" >/dev/null 2>&1; then
  docker network inspect "${NETWORK}" | jq -e --arg subnet "${SUBNET}" --arg gateway "${GATEWAY}" '
    length == 1 and .[0].Internal == true and .[0].EnableIPv6 == false and
    .[0].IPAM.Config == [{"Subnet": $subnet, "Gateway": $gateway}] and
    .[0].Options["com.docker.network.bridge.name"] == "pc-hshake0" and
    .[0].Labels["ai.gloops.scope"] == "paperclip-provider-handshake" and
    (.[0].Containers | length) == 0
  ' >/dev/null || { echo 'existing handshake network is not exact and empty' >&2; exit 1; }
else
  docker network create --driver bridge --internal --attachable \
    --subnet "${SUBNET}" --gateway "${GATEWAY}" \
    --opt com.docker.network.bridge.name=pc-hshake0 \
    --label ai.gloops.scope=paperclip-provider-handshake \
    "${NETWORK}" >/dev/null
fi

iptables -N "${INPUT_CHAIN}"
iptables -A "${INPUT_CHAIN}" -s "${HERMES_IP}" -d "${GATEWAY}" -p tcp --dport "${PROXY_PORT}" \
  -m comment --comment paperclip-handshake-proxy -j ACCEPT
iptables -A "${INPUT_CHAIN}" -m comment --comment paperclip-handshake-host-deny \
  -j REJECT --reject-with icmp-port-unreachable
iptables -I INPUT 1 -s "${SUBNET}" -m comment --comment paperclip-handshake-input -j "${INPUT_CHAIN}"

iptables -N "${FORWARD_CHAIN}"
iptables -A "${FORWARD_CHAIN}" -m conntrack --ctstate ESTABLISHED,RELATED \
  -m comment --comment paperclip-handshake-established -j RETURN
iptables -A "${FORWARD_CHAIN}" -s "${PAPERCLIP_IP}" -d "${HERMES_IP}" -p tcp --dport 8642 \
  -m comment --comment paperclip-handshake-api -j ACCEPT
iptables -A "${FORWARD_CHAIN}" -m comment --comment paperclip-handshake-forward-deny \
  -j REJECT --reject-with icmp-port-unreachable
iptables -I DOCKER-USER 1 -s "${SUBNET}" -m comment --comment paperclip-handshake-forward -j "${FORWARD_CHAIN}"

install -d -m 0700 -o root -g root "${STATE_DIR}"
state_tmp="$(mktemp "${STATE_DIR}/.handshake-egress.XXXXXX")"
{
  printf 'schema=gloops.hermes-handshake-egress.v2\n'
  printf 'network=%s\nsubnet=%s\ngateway=%s\nhermes_ip=%s\npaperclip_ip=%s\nproxy_port=%s\n' \
    "${NETWORK}" "${SUBNET}" "${GATEWAY}" "${HERMES_IP}" "${PAPERCLIP_IP}" "${PROXY_PORT}"
  printf 'input_chain=%s\nforward_chain=%s\n' "${INPUT_CHAIN}" "${FORWARD_CHAIN}"
} >"${state_tmp}"
chmod 0600 "${state_tmp}"
chown root:root "${state_tmp}"
mv "${state_tmp}" "${STATE_FILE}"
trap - ERR INT TERM

echo 'installed isolated Hermes handshake network and fail-closed host/forwarding boundary'
