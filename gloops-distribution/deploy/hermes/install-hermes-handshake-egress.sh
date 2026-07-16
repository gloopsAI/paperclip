#!/usr/bin/env bash
set -euo pipefail

readonly NETWORK='paperclip-execution'
readonly CHAIN='PCLIP-HSHAKE-EGRESS'
readonly JUMP_COMMENT='paperclip-hermes-handshake-egress'
readonly ALLOW_COMMENT='paperclip-hermes-handshake-ollama'
readonly DENY_COMMENT='paperclip-hermes-handshake-deny'
readonly STATE_DIR='/run/paperclip-gloops'
readonly STATE_FILE="${STATE_DIR}/HANDSHAKE_EGRESS_ACTIVE"
readonly CLEANUP='/usr/local/lib/paperclip-gloops/remove-hermes-handshake-egress.sh'

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}

for command in docker getent iptables python3 sha256sum; do
  command -v "${command}" >/dev/null || {
    echo "required command is unavailable: ${command}" >&2
    exit 1
  }
done
iptables -nL DOCKER-USER >/dev/null 2>&1 || {
  echo 'Docker DOCKER-USER chain is unavailable' >&2
  exit 1
}
if [[ -e "${STATE_FILE}" ]] || iptables -nL "${CHAIN}" >/dev/null 2>&1; then
  echo 'refusing to replace an existing Hermes handshake egress policy' >&2
  exit 1
fi

subnet="$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "${NETWORK}")"
ipv6="$(docker network inspect -f '{{.EnableIPv6}}' "${NETWORK}")"
[[ "${ipv6}" == 'false' ]] || {
  echo 'Hermes handshake egress policy requires an IPv4-only Docker network' >&2
  exit 1
}
python3 - "${subnet}" <<'PY'
import ipaddress, sys
network = ipaddress.ip_network(sys.argv[1], strict=True)
if network.version != 4:
    raise SystemExit("handshake Docker subnet must be IPv4")
PY

mapfile -t ollama_ips < <(
  getent ahostsv4 ollama.com \
    | awk '$2 == "STREAM" { print $1 }' \
    | sort -u
)
((${#ollama_ips[@]} > 0)) || {
  echo 'ollama.com did not resolve to any IPv4 address' >&2
  exit 1
}
(${#ollama_ips[@]} <= 16) || {
  echo 'ollama.com resolved to an unexpectedly large IPv4 set' >&2
  exit 1
}
python3 - "${subnet}" "${ollama_ips[@]}" <<'PY'
import ipaddress, sys
network = ipaddress.ip_network(sys.argv[1], strict=True)
for value in sys.argv[2:]:
    address = ipaddress.ip_address(value)
    if address.version != 4 or not address.is_global or address in network:
        raise SystemExit(f"unsafe Ollama IPv4 destination: {value}")
PY

cleanup_on_error() {
  local status="${1:-$?}"
  rm -f "${state_tmp:-}"
  if [[ -x "${CLEANUP}" ]]; then
    "${CLEANUP}" || true
  else
    python3 - "${CHAIN}" "$(iptables -S DOCKER-USER 2>/dev/null || true)" <<'PY' || true
import shlex, subprocess, sys
chain, rules = sys.argv[1:]
for rule in rules.splitlines():
    args = shlex.split(rule)
    if len(args) >= 3 and args[0] == "-A" and args[-2:] == ["-j", chain]:
        subprocess.run(["iptables", "-D", *args[1:]], check=False)
PY
    iptables -F "${CHAIN}" 2>/dev/null || true
    iptables -X "${CHAIN}" 2>/dev/null || true
    rm -f "${STATE_FILE}"
  fi
  exit "${status}"
}
state_tmp=''
trap cleanup_on_error ERR
trap 'cleanup_on_error 130' INT
trap 'cleanup_on_error 143' TERM

iptables -N "${CHAIN}"
iptables -A "${CHAIN}" -d "${subnet}" -m comment --comment "${JUMP_COMMENT}" -j RETURN
for ip in "${ollama_ips[@]}"; do
  iptables -A "${CHAIN}" -p tcp -d "${ip}" --dport 443 \
    -m comment --comment "${ALLOW_COMMENT}" -j RETURN
done
iptables -A "${CHAIN}" -m comment --comment "${DENY_COMMENT}" \
  -j REJECT --reject-with icmp-port-unreachable
iptables -I DOCKER-USER 1 -s "${subnet}" -m comment --comment "${JUMP_COMMENT}" -j "${CHAIN}"

install -d -m 0700 -o root -g root "${STATE_DIR}"
state_tmp="$(mktemp "${STATE_DIR}/.handshake-egress.XXXXXX")"
{
  printf 'schema=gloops.hermes-handshake-egress.v1\n'
  printf 'network=%s\n' "${NETWORK}"
  printf 'subnet=%s\n' "${subnet}"
  printf 'chain=%s\n' "${CHAIN}"
  printf 'ollama_ipv4=%s\n' "$(IFS=,; echo "${ollama_ips[*]}")"
  printf 'policy_sha256=%s\n' "$({ printf '%s\n' "${subnet}"; printf '%s\n' "${ollama_ips[@]}"; } | sha256sum | awk '{print $1}')"
} >"${state_tmp}"
chmod 0600 "${state_tmp}"
chown root:root "${state_tmp}"
mv "${state_tmp}" "${STATE_FILE}"
trap - ERR INT TERM

echo "installed fail-closed Hermes handshake egress policy for ${subnet}: ollama.com:443 only"
