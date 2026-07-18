#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT

# Sourcing exposes only the deterministic journal guard. The backup script's
# root-only main path is not executed in this unit test.
source "${SCRIPT_DIR}/backup-dark.sh"

journal="${stage}/commissioning-rollback.json"
destination="${stage}/backup-artifact"
touch "${journal}"

set +e
if refuse_unresolved_commissioning "${journal}" 2>"${stage}/stderr"; then
  mkdir "${destination}"
  status=0
else
  status=$?
fi
set -e

[[ "${status}" -ne 0 ]]
grep -Fq \
  'refusing cold backup while a controlled-swarm commissioning rollback journal survives' \
  "${stage}/stderr"
[[ ! -e "${destination}" ]]

rm -f "${journal}"
refuse_unresolved_commissioning "${journal}"

ln -s "${stage}/missing-journal-target" "${journal}"
set +e
refuse_unresolved_commissioning "${journal}" 2>"${stage}/symlink-stderr"
symlink_status=$?
set -e
[[ "${symlink_status}" -ne 0 ]]
grep -Fq 'refusing cold backup' "${stage}/symlink-stderr"
[[ ! -e "${destination}" ]]

echo 'PASS unresolved commissioning journal cannot produce a cold backup artifact'
