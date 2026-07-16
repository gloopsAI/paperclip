#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

cat >"${stage}/docker" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${DOCKER_CALL_LOG}"
if [[ "${1:-}" == 'info' ]]; then
  exit 77
fi
echo 'the topology inspector continued after daemon failure' >&2
exit 88
SH
chmod +x "${stage}/docker"
call_log="${stage}/calls"
: >"${call_log}"

set +e
PATH="${stage}:${PATH}" DOCKER_CALL_LOG="${call_log}" \
  "${SCRIPT_DIR}/inspect-hermes-handshake-topology.sh" >"${stage}/stdout" 2>"${stage}/stderr"
status=$?
set -e

[[ "${status}" -ne 0 ]]
[[ ! -s "${stage}/stdout" ]]
grep -Fq 'Docker daemon/topology is unavailable' "${stage}/stderr"
[[ "$(cat "${call_log}")" == 'info' ]]
echo 'PASS daemon-unavailable topology inspection fails before network absence can be inferred'
