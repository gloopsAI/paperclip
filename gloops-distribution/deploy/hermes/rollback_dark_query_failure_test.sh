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
  ps) echo 'synthetic post-preflight Docker query failure' >&2; exit 79 ;;
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
