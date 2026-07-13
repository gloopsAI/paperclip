#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_IMAGE='ghcr.io/gloopsai/paperclip-gloops@sha256:38e0bd4725377cb930290f033b19418e0ccb1c3efc773243f66d25f5fb6e3d9f'
readonly ACTIVATION_MARKER='/etc/paperclip-gloops/ACTIVATION_APPROVED'
readonly STATE_DIR='/home/paperclip/.paperclip'
readonly PLUGIN_DIR='/opt/paperclip/plugins'
readonly MTE_PLUGIN_DIR='/home/paperclip/mte-shadow-package'
readonly MAX_STATE_BYTES=$((10 * 1024 * 1024 * 1024))
readonly MIN_FREE_BYTES=$((10 * 1024 * 1024 * 1024))

[[ -f "${ACTIVATION_MARKER}" ]] || {
  echo "operator activation marker is absent" >&2
  exit 1
}

[[ "${PAPERCLIP_IMAGE:-}" == "${EXPECTED_IMAGE}" ]] || {
  echo "service image does not match the approved immutable digest" >&2
  exit 1
}

[[ -d "${STATE_DIR}" ]] || {
  echo "Paperclip state directory is missing" >&2
  exit 1
}
[[ -d "${PLUGIN_DIR}" && -d "${MTE_PLUGIN_DIR}" ]] || {
  echo "one or more installed plugin directories are missing" >&2
  exit 1
}

state_bytes="$(du -sb "${STATE_DIR}" | awk '{print $1}')"
free_bytes="$(df -PB1 "${STATE_DIR}" | awk 'NR == 2 {print $4}')"
[[ "${state_bytes}" -le "${MAX_STATE_BYTES}" ]] || {
  echo "Paperclip state exceeds the 10 GiB admission ceiling" >&2
  exit 1
}
[[ "${free_bytes}" -ge "${MIN_FREE_BYTES}" ]] || {
  echo "host has less than the required 10 GiB free-space reserve" >&2
  exit 1
}

/usr/bin/docker image inspect "${EXPECTED_IMAGE}" >/dev/null
if /usr/bin/docker ps -a --format '{{.Names}}' | grep -Fxq 'paperclip-gloops'; then
  echo "a Paperclip container already exists; refusing concurrent execution" >&2
  exit 1
fi
