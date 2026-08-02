#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY='ghcr.io/gloopsai/paperclip-gloops'
readonly TAGGED_IMAGE="${REPOSITORY}:stable"
readonly DIGEST_PATTERN='^ghcr\.io/gloopsai/paperclip-gloops@sha256:[a-f0-9]{64}$'
dry_run=false

if (($# > 1)); then
  echo 'usage: pull-latest-stable.sh [--dry-run]' >&2
  exit 2
fi
if (($# == 1)); then
  [[ "$1" == '--dry-run' ]] || { echo "unknown option: $1" >&2; exit 2; }
  dry_run=true
fi

if [[ "${PAPERCLIP_PREPULL_TEST_MODE:-0}" == '1' ]]; then
  readonly TEST_ROOT="${PAPERCLIP_PREPULL_TEST_ROOT:?PAPERCLIP_PREPULL_TEST_ROOT is required}"
  readonly TEST_BIN_DIR="${PAPERCLIP_PREPULL_TEST_BIN_DIR:?PAPERCLIP_PREPULL_TEST_BIN_DIR is required}"
  [[ "${TEST_ROOT}" == /* && "${TEST_ROOT}" != '/' && "${TEST_BIN_DIR}" == /* ]] || exit 2
  root_path() { printf '%s%s' "${TEST_ROOT}" "$1"; }
  command_path() {
    if [[ -x "${TEST_BIN_DIR}/$1" ]]; then
      printf '%s/%s' "${TEST_BIN_DIR}" "$1"
    else
      command -v "$1"
    fi
  }
else
  [[ "${EUID}" -eq 0 ]] || { echo 'run with sudo' >&2; exit 1; }
  [[ -z "${PAPERCLIP_PREPULL_TEST_ROOT:-}${PAPERCLIP_PREPULL_TEST_BIN_DIR:-}" ]] || {
    echo 'test overrides are forbidden outside test mode' >&2
    exit 1
  }
  root_path() { printf '%s' "$1"; }
  command_path() { command -v "$1"; }
fi

DOCKER="$(command_path docker)"; readonly DOCKER
PYTHON="$(command_path python3)"; readonly PYTHON
INSTALL="$(command_path install)"; readonly INSTALL
STATE_DIR="$(root_path /var/lib/paperclip-gloops/prepull)"; readonly STATE_DIR
RECEIPT_DIR="$(root_path /var/lib/paperclip-gloops/receipts)"; readonly RECEIPT_DIR
APPROVED_IMAGE_FILE="$(root_path /etc/paperclip-gloops/approved-image)"; readonly APPROVED_IMAGE_FILE

if [[ "${dry_run}" != true ]]; then
  "${DOCKER}" pull "${TAGGED_IMAGE}"
else
  "${DOCKER}" image inspect "${TAGGED_IMAGE}" >/dev/null
fi
repo_digests="$("${DOCKER}" image inspect --format '{{json .RepoDigests}}' "${TAGGED_IMAGE}")"
resolved_image="$("${PYTHON}" - "${REPOSITORY}" "${repo_digests}" <<'PY'
import json
import re
import sys

repository, raw = sys.argv[1:]
values = json.loads(raw)
pattern = re.compile(rf"^{re.escape(repository)}@sha256:[a-f0-9]{{64}}$")
matches = sorted(value for value in values if isinstance(value, str) and pattern.fullmatch(value))
if len(matches) != 1:
    raise SystemExit(f"expected one {repository} RepoDigest, found {len(matches)}")
print(matches[0])
PY
)"
[[ "${resolved_image}" =~ ${DIGEST_PATTERN} ]] || { echo 'resolved RepoDigest is malformed' >&2; exit 1; }

if [[ "${dry_run}" == true ]]; then
  printf 'DRY RUN OK\ntag=%s\nresolved=%s\n' "${TAGGED_IMAGE}" "${resolved_image}"
  exit 0
fi

"${INSTALL}" -d -m 0700 "${STATE_DIR}" "${RECEIPT_DIR}"
last_image=''
[[ ! -f "${STATE_DIR}/latest-stable-image" ]] || last_image="$(tr -d '\r\n' <"${STATE_DIR}/latest-stable-image")"
if [[ "${last_image}" == "${resolved_image}" ]]; then
  printf 'PREPULL UNCHANGED\nresolved=%s\n' "${resolved_image}"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
state_stage="$(mktemp "${STATE_DIR}/.latest-stable-image.XXXXXX")"
printf '%s\n' "${resolved_image}" >"${state_stage}"
chmod 0600 "${state_stage}"
mv "${state_stage}" "${STATE_DIR}/latest-stable-image"

approved_image=''
[[ ! -f "${APPROVED_IMAGE_FILE}" ]] || approved_image="$(tr -d '\r\n' <"${APPROVED_IMAGE_FILE}")"
receipt_path="${RECEIPT_DIR}/prepull-stable-${stamp}.json"
"${PYTHON}" - "${receipt_path}" "${TAGGED_IMAGE}" "${resolved_image}" "${last_image}" "${approved_image}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

path, tag, resolved, previous, approved = sys.argv[1:]
receipt = {
    "schemaVersion": "gloops.paperclip-image-prepull.v1",
    "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "tag": tag,
    "resolvedImage": resolved,
    "previousResolvedImage": previous or None,
    "currentlyApprovedImage": approved or None,
    "activationPerformed": False,
}
stage = Path(path + f".tmp.{os.getpid()}")
stage.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
os.chmod(stage, 0o600)
os.replace(stage, path)
PY
chmod 0600 "${receipt_path}"
printf 'PREPULL UPDATED\nresolved=%s\nreceipt=%s\n' "${resolved_image}" "${receipt_path}"
