#!/usr/bin/env bash
set -euo pipefail

readonly LIB_DIR='/usr/local/lib/paperclip-gloops'
readonly JOURNAL='/var/lib/paperclip-gloops/controlled-swarm/commissioning-rollback.json'
readonly RECOVERY_UNIT='paperclip-controlled-swarm-commissioning-recovery.service'

set +e
"${LIB_DIR}/controlled-swarm-commissioner.py" "$@"
status=$?
set -e

if ((status != 0)) && [[ -e "${JOURNAL}" ]]; then
  # The root-owned wrapper remains alive if the commissioner child is killed.
  # Recovery itself must fence persisted and effective execution before it
  # parses or restores the journal; the wrapper must not mask that proof.
  systemctl start --wait "${RECOVERY_UNIT}"
fi

exit "${status}"
