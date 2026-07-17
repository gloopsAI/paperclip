#!/usr/bin/env bash
set -euo pipefail

readonly UNIT="paperclip-runtime-deadman-proof-${BASHPID}.service"
readonly MAX_WAIT_SECONDS=15

[[ "${EUID}" -eq 0 ]] || {
  echo 'run with sudo' >&2
  exit 1
}

cleanup() {
  systemctl stop "${UNIT}" >/dev/null 2>&1 || true
  systemctl reset-failed "${UNIT}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

started="$(date +%s)"
systemd-run \
  --quiet \
  --unit "${UNIT}" \
  --property Type=exec \
  --property RuntimeMaxSec=2 \
  --property TimeoutStopSec=2 \
  /usr/bin/sleep 30

deadline=$((started + MAX_WAIT_SECONDS))
while systemctl is-active --quiet "${UNIT}"; do
  if (( $(date +%s) >= deadline )); then
    echo 'runtime deadman proof did not terminate within its bounded window' >&2
    exit 1
  fi
  sleep 1
done

result="$(systemctl show "${UNIT}" --property Result --value)"
runtime_max="$(systemctl show "${UNIT}" --property RuntimeMaxUSec --value)"
elapsed=$(( $(date +%s) - started ))
[[ "${result}" == 'timeout' ]] || {
  echo "runtime deadman proof ended with unexpected result: ${result}" >&2
  exit 1
}
((elapsed < 15)) || {
  echo "runtime deadman proof exceeded its outer bound: ${elapsed}s" >&2
  exit 1
}
[[ "${runtime_max}" != 'infinity' && -n "${runtime_max}" ]] || {
  echo 'runtime deadman proof did not apply RuntimeMaxSec' >&2
  exit 1
}

echo "PASS systemd RuntimeMaxSec terminated an exec service after ${elapsed}s (${runtime_max})"
