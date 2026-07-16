#!/usr/bin/env bash
set -euo pipefail

readonly CHAIN='PCLIP-HSHAKE-EGRESS'
readonly STATE_FILE='/run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE'

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}

if [[ -e "${STATE_FILE}" ]] \
  && { ! command -v iptables >/dev/null || ! iptables -nL DOCKER-USER >/dev/null 2>&1; }; then
  echo 'refusing to discard active handshake egress state while Docker firewall cleanup is unavailable' >&2
  exit 1
fi
if command -v iptables >/dev/null && iptables -nL DOCKER-USER >/dev/null 2>&1; then
  command -v python3 >/dev/null || {
    echo 'python3 is required to remove the Hermes handshake egress policy safely' >&2
    exit 1
  }
  python3 - "${CHAIN}" "$(iptables -S DOCKER-USER)" <<'PY'
import shlex, subprocess, sys
chain, rules = sys.argv[1:]
for rule in rules.splitlines():
    args = shlex.split(rule)
    if len(args) >= 3 and args[0] == "-A" and args[-2:] == ["-j", chain]:
        subprocess.run(["iptables", "-D", *args[1:]], check=True)
PY
  if iptables -nL "${CHAIN}" >/dev/null 2>&1; then
    iptables -F "${CHAIN}"
    iptables -X "${CHAIN}"
  fi
fi
rm -f "${STATE_FILE}"

echo 'removed Hermes handshake egress policy'
