#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_DIR='/etc/paperclip-gloops'
readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly HERMES_UNIT='paperclip-hermes-handshake.service'
readonly EGRESS_UNIT='paperclip-hermes-handshake-egress.service'

[[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }

# Both functions are reached through the EXIT trap.
# shellcheck disable=SC2329
return_dark() {
  local status=0
  set +e
  systemctl stop "${HERMES_UNIT}" "${EGRESS_UNIT}" || status=1
  rm -f "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED" \
    /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE
  "${LIB_DIR}/remove-hermes-handshake-egress.sh" || status=1
  systemctl mask "${HERMES_UNIT}" "${EGRESS_UNIT}" || status=1
  systemctl reset-failed "${HERMES_UNIT}" "${EGRESS_UNIT}" || true
  "${LIB_DIR}/verify-dark.sh" || status=1
  set -e
  return "${status}"
}
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  trap - EXIT
  return_dark || status=1
  exit "${status}"
}
trap cleanup EXIT

"${LIB_DIR}/verify-dark.sh"
systemctl unmask "${HERMES_UNIT}" "${EGRESS_UNIT}"
systemctl daemon-reload
install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED"
systemctl start "${HERMES_UNIT}"
"${LIB_DIR}/verify-hermes-handshake-profile.sh" --live

proxy_pid="$(systemctl show --property=MainPID --value "${EGRESS_UNIT}")"
[[ "${proxy_pid}" =~ ^[1-9][0-9]*$ ]]
kill -KILL "${proxy_pid}"

deadline=$((SECONDS + 60))
while ((SECONDS < deadline)); do
  if ! systemctl is-active --quiet "${HERMES_UNIT}" \
    && ! systemctl is-active --quiet "${EGRESS_UNIT}" \
    && ! docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-hermes-handshake' \
    && [[ ! -e /run/paperclip-gloops/HANDSHAKE_EGRESS_ACTIVE ]] \
    && ! docker network inspect paperclip-handshake >/dev/null 2>&1 \
    && ! iptables -nL PCLIP-HS-IN >/dev/null 2>&1 \
    && ! iptables -nL PCLIP-HS-FWD >/dev/null 2>&1 \
    && ! ss -lntH sport = :18080 | grep -q .; then
    echo 'PASS unexpected proxy exit stopped Hermes and automatically reconciled all egress topology'
    exit 0
  fi
  sleep 1
done

echo 'unexpected proxy exit did not reconcile to an inactive, container-free, egress-free state' >&2
exit 1
