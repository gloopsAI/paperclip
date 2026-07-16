#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

cat >"${stage}/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DOCKER_CALL_LOG}"
if [[ "${DOCKER_FAIL_PHASE}" == 'daemon' && "${1:-}" == 'info' ]]; then
  exit 77
fi
if [[ "${DOCKER_FAIL_PHASE}" == 'inventory' && "${1:-}" == 'network' && "${2:-}" == 'ls' ]]; then
  exit 78
fi
if [[ "${1:-}" == 'info' ]]; then exit 0; fi
echo 'the topology inspector continued after daemon failure' >&2
exit 88
SH
chmod +x "${stage}/docker"
call_log="${stage}/calls"
: >"${call_log}"

set +e
PATH="${stage}:${PATH}" DOCKER_CALL_LOG="${call_log}" DOCKER_FAIL_PHASE=daemon \
  "${SCRIPT_DIR}/inspect-hermes-handshake-topology.sh" >"${stage}/stdout" 2>"${stage}/stderr"
status=$?
set -e

[[ "${status}" -ne 0 ]]
[[ ! -s "${stage}/stdout" ]]
grep -Fq 'Docker daemon/topology is unavailable' "${stage}/stderr"
[[ "$(cat "${call_log}")" == 'info' ]]
echo 'PASS daemon-unavailable topology inspection fails before network absence can be inferred'

: >"${call_log}"
set +e
PATH="${stage}:${PATH}" DOCKER_CALL_LOG="${call_log}" DOCKER_FAIL_PHASE=inventory \
  "${SCRIPT_DIR}/inspect-hermes-handshake-topology.sh" >"${stage}/stdout" 2>"${stage}/stderr"
status=$?
set -e

[[ "${status}" -ne 0 ]]
[[ ! -s "${stage}/stdout" ]]
grep -Fq 'Docker network inventory is unavailable' "${stage}/stderr"
[[ "$(wc -l <"${call_log}" | tr -d ' ')" == '2' ]]
grep -Fxq 'info' "${call_log}"
grep -Fq 'network ls' "${call_log}"
echo 'PASS inventory failure cannot be misclassified as an absent network'
