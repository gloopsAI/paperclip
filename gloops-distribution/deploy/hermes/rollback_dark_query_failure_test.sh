#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

cat >"${stage}/docker" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  info) exit 0 ;;
  ps)
    if [[ "${DOCKER_PS_FAIL:-1}" == '1' ]]; then
      echo 'synthetic post-preflight Docker query failure' >&2
      exit 79
    fi
    exit 0
    ;;
  network) [[ "${2:-}" == 'ls' ]] && exit 0 ;;
esac
exit 80
SH
cat >"${stage}/iptables" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == '-nL' ]]; then exit 0; fi
if [[ "${1:-}" == '-S' ]]; then exit 0; fi
exit 81
SH
cat >"${stage}/ss" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == '-lntH' ]]
SH
cat >"${stage}/systemctl" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  show) echo inactive ;;
  is-enabled) echo masked ;;
  *) exit 82 ;;
esac
SH
chmod +x "${stage}/docker" "${stage}/iptables" "${stage}/ss" "${stage}/systemctl"

set +e
PATH="${stage}:${PATH}" "${SCRIPT_DIR}/verify-rollback-dark.sh" >"${stage}/stdout" 2>"${stage}/stderr"
status=$?
set -e

[[ "${status}" -ne 0 ]]
grep -Fq 'FAIL rollback verifier cannot inspect Docker containers' "${stage}/stderr"
if grep -Fq 'PASS rollback terminal state' "${stage}/stdout"; then
  echo 'rollback verifier falsely passed after a post-preflight query failure' >&2
  exit 1
fi
echo 'PASS post-preflight query failure cannot be interpreted as terminal absence'

deadman_socket="${stage}/deadman.sock"
python3 - "${deadman_socket}" <<'PY' &
import socket
import sys
import time

server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sys.argv[1])
server.listen(1)
try:
    time.sleep(30)
finally:
    server.close()
PY
deadman_pid=$!
trap 'kill "${deadman_pid}" 2>/dev/null || true; wait "${deadman_pid}" 2>/dev/null || true; rm -rf "${stage}"' EXIT
deadline=$((SECONDS + 3))
while [[ ! -S "${deadman_socket}" && "${SECONDS}" -lt "${deadline}" ]]; do
  sleep 0.05
done
[[ -S "${deadman_socket}" ]]

set +e
DOCKER_PS_FAIL=0 \
  PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET_PATH="${deadman_socket}" \
  PATH="${stage}:${PATH}" \
  "${SCRIPT_DIR}/verify-rollback-dark.sh" >"${stage}/deadman-stdout" 2>"${stage}/deadman-stderr"
deadman_status=$?
set -e

[[ "${deadman_status}" -ne 0 ]]
grep -Fq 'FAIL rollback left the campaign deadman socket' "${stage}/deadman-stderr"
if grep -Fq 'PASS rollback terminal state' "${stage}/deadman-stdout"; then
  echo 'rollback verifier falsely passed with a live campaign deadman socket' >&2
  exit 1
fi
echo 'PASS surviving campaign deadman socket cannot be interpreted as terminal dark'
