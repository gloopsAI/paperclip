#!/usr/bin/env bash
set -euo pipefail

readonly NETWORK='paperclip-handshake'
readonly INPUT_CHAIN='PCLIP-HS-IN'
readonly FORWARD_CHAIN='PCLIP-HS-FWD'
readonly STATE_FILE='/run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly TOPOLOGY_INSPECTOR="${SCRIPT_DIR}/inspect-hermes-handshake-topology.sh"

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
for command in docker iptables python3; do
  command -v "${command}" >/dev/null || {
    echo "refusing incomplete handshake cleanup; required command is unavailable: ${command}" >&2
    exit 1
  }
done
[[ -x "${TOPOLOGY_INSPECTOR}" ]] || {
  echo 'refusing incomplete handshake cleanup; topology inspector is unavailable' >&2
  exit 1
}
topology="$(${TOPOLOGY_INSPECTOR})" || {
  echo 'refusing incomplete handshake cleanup; Docker topology was not proven' >&2
  exit 1
}
[[ "${topology}" != 'attached' ]] || {
  echo 'refusing to weaken the handshake boundary while a container remains attached' >&2
  exit 1
}
iptables -nL INPUT >/dev/null || { echo 'host INPUT firewall is unavailable' >&2; exit 1; }
iptables -nL DOCKER-USER >/dev/null || { echo 'Docker forwarding firewall is unavailable' >&2; exit 1; }

remove_jumps() {
  local parent="$1" target="$2"
  python3 - "${parent}" "${target}" "$(iptables -S "${parent}")" <<'PY'
import shlex, subprocess, sys
parent, target, rules = sys.argv[1:]
for rule in rules.splitlines():
    args = shlex.split(rule)
    if len(args) >= 3 and args[0] == "-A" and args[1] == parent and args[-2:] == ["-j", target]:
        subprocess.run(["iptables", "-D", *args[1:]], check=True)
PY
}
remove_jumps INPUT "${INPUT_CHAIN}"
remove_jumps DOCKER-USER "${FORWARD_CHAIN}"
for chain in "${INPUT_CHAIN}" "${FORWARD_CHAIN}"; do
  if iptables -nL "${chain}" >/dev/null 2>&1; then
    iptables -F "${chain}"
    iptables -X "${chain}"
  fi
done

if [[ "${topology}" == 'empty' ]]; then
  docker network rm "${NETWORK}" >/dev/null
fi
rm -f "${STATE_FILE}"
echo 'removed isolated Hermes handshake egress boundary'
