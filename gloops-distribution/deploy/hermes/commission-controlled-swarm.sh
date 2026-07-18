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
  # Fence execution before asking the narrowly conditioned recovery unit to
  # invoke the commissioner's existing rollback path. This also covers SIGKILL
  # of the commissioner child: the root-owned wrapper remains the parent.
  "${LIB_DIR}/set-controlled-swarm-commissioning.py" false
  systemctl start --wait "${RECOVERY_UNIT}"
fi

exit "${status}"
