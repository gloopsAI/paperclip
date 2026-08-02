#!/usr/bin/env bash
set -euo pipefail

readonly IMAGE_REPOSITORY='ghcr.io/gloopsai/paperclip-gloops'
readonly IMAGE_PATTERN='^ghcr\.io/gloopsai/paperclip-gloops@sha256:[a-f0-9]{64}$'
readonly DEFAULT_TIMEOUT_SECONDS=120

dry_run=false
skip_pull=false
restart_only=false
from_tag=''
requested_image=''

usage() {
  cat <<'EOF'
Usage:
  sudo ./pin-paperclip-image.sh IMAGE[@sha256:DIGEST] [--dry-run] [--skip-pull]
  sudo ./pin-paperclip-image.sh --from-tag stable [--dry-run] [--skip-pull]
  sudo ./pin-paperclip-image.sh --restart-only [--dry-run]

Pins Paperclip by immutable GLoops image digest, updates the supervisor closure
receipt, restarts the control plane, waits for health, and writes a host receipt.
Mutable tags are discovery-only and are resolved to a RepoDigest before pinning.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --skip-pull) skip_pull=true ;;
    --restart-only) restart_only=true ;;
    --from-tag)
      (($# >= 2)) || { echo '--from-tag requires a value' >&2; usage >&2; exit 2; }
      from_tag="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      [[ -z "${requested_image}" ]] || { echo 'only one image may be supplied' >&2; exit 2; }
      requested_image="$1"
      ;;
  esac
  shift
done

if [[ "${PAPERCLIP_PIN_TEST_MODE:-0}" == '1' ]]; then
  readonly TEST_ROOT="${PAPERCLIP_PIN_TEST_ROOT:?PAPERCLIP_PIN_TEST_ROOT is required in test mode}"
  readonly TEST_BIN_DIR="${PAPERCLIP_PIN_TEST_BIN_DIR:?PAPERCLIP_PIN_TEST_BIN_DIR is required in test mode}"
  [[ "${TEST_ROOT}" == /* && "${TEST_ROOT}" != '/' && "${TEST_BIN_DIR}" == /* ]] || {
    echo 'test paths must be absolute and the test root must not be /' >&2
    exit 2
  }
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
  [[ -z "${PAPERCLIP_PIN_TEST_ROOT:-}${PAPERCLIP_PIN_TEST_BIN_DIR:-}" ]] || {
    echo 'test overrides are forbidden outside test mode' >&2
    exit 1
  }
  root_path() { printf '%s' "$1"; }
  command_path() {
    local path
    path="$(command -v "$1" 2>/dev/null || true)"
    [[ -n "${path}" ]] || { echo "required command is unavailable: $1" >&2; exit 1; }
    printf '%s' "${path}"
  }
fi

DOCKER="$(command_path docker)"; readonly DOCKER
SYSTEMCTL="$(command_path systemctl)"; readonly SYSTEMCTL
CURL="$(command_path curl)"; readonly CURL
JOURNALCTL="$(command_path journalctl)"; readonly JOURNALCTL
PYTHON="$(command_path python3)"; readonly PYTHON
INSTALL="$(command_path install)"; readonly INSTALL

APPROVED_IMAGE_FILE="$(root_path /etc/paperclip-gloops/approved-image)"; readonly APPROVED_IMAGE_FILE
RUNTIME_ENV_FILE="$(root_path /etc/paperclip-gloops/runtime.env)"; readonly RUNTIME_ENV_FILE
SUPERVISOR_RECEIPT="$(root_path /var/lib/paperclip-gloops/controlled-swarm/supervisor-operational-closure.json)"; readonly SUPERVISOR_RECEIPT
RECEIPT_ROOT="$(root_path /var/lib/paperclip-gloops/receipts)"; readonly RECEIPT_ROOT
GITHUB_APP_CONFIG="$(root_path /etc/paperclip-gloops/github-app.json)"; readonly GITHUB_APP_CONFIG
CREDENTIAL_RECEIPT="$(root_path /var/lib/paperclip-gloops/credential-runtime/credential-receipt.json)"; readonly CREDENTIAL_RECEIPT
HERMES_PROFILE="$(root_path /opt/paperclip/hermes-execution-profile)"; readonly HERMES_PROFILE
HERMES_WORKSPACE="$(root_path /opt/paperclip/hermes-execution-state/workspace)"; readonly HERMES_WORKSPACE
HERMES_PROFILE_VERIFIER="$(root_path /usr/local/lib/paperclip-gloops/verify-hermes-execution-profile.sh)"; readonly HERMES_PROFILE_VERIFIER
readonly SERVICE='paperclip-gloops.service'
readonly HEALTH_URL='http://127.0.0.1:3100/api/health'
readonly TIMEOUT_SECONDS="${PAPERCLIP_PIN_TIMEOUT_SECONDS:-${DEFAULT_TIMEOUT_SECONDS}}"

[[ "${TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] || { echo 'timeout must be a positive integer' >&2; exit 2; }
[[ -z "${from_tag}" || -z "${requested_image}" ]] || {
  echo 'supply either an immutable image or --from-tag, not both' >&2
  exit 2
}
if [[ "${restart_only}" == true ]]; then
  [[ -z "${from_tag}${requested_image}" ]] || { echo '--restart-only does not accept an image' >&2; exit 2; }
  skip_pull=true
else
  [[ -n "${from_tag}${requested_image}" ]] || { usage >&2; exit 2; }
fi

for required_file in "${APPROVED_IMAGE_FILE}" "${RUNTIME_ENV_FILE}" "${SUPERVISOR_RECEIPT}"; do
  [[ -f "${required_file}" && ! -L "${required_file}" ]] || {
    echo "required pin file is missing or is a symlink: ${required_file}" >&2
    exit 1
  }
done

old_image="$(tr -d '\r\n' <"${APPROVED_IMAGE_FILE}")"
[[ "${old_image}" =~ ${IMAGE_PATTERN} ]] || {
  echo "approved-image is not a valid immutable GLoops digest: ${old_image}" >&2
  exit 1
}

validate_current_pin_contract() {
  "${PYTHON}" - "${RUNTIME_ENV_FILE}" "${SUPERVISOR_RECEIPT}" "${old_image}" <<'PY'
import json
import sys
from pathlib import Path

runtime_path = Path(sys.argv[1])
receipt_path = Path(sys.argv[2])
approved_image = sys.argv[3]
runtime_lines = runtime_path.read_text(encoding="utf-8").splitlines()
image_lines = [line for line in runtime_lines if line.startswith("PAPERCLIP_IMAGE=")]
if len(image_lines) != 1:
    raise SystemExit(f"runtime.env must contain exactly one PAPERCLIP_IMAGE line; found {len(image_lines)}")
if image_lines[0] != f"PAPERCLIP_IMAGE={approved_image}":
    raise SystemExit("runtime.env PAPERCLIP_IMAGE does not match approved-image")

with receipt_path.open(encoding="utf-8") as handle:
    receipt = json.load(handle)
required = {
    "approvedImage",
    "authorization",
    "authorizedAt",
    "campaignId",
    "providerRoute",
    "schemaVersion",
    "workItem",
}
if not isinstance(receipt, dict):
    raise SystemExit("supervisor operational closure receipt must be a JSON object")
missing = sorted(required - receipt.keys())
if missing:
    raise SystemExit("supervisor operational closure receipt is missing required keys: " + ", ".join(missing))
if receipt.get("approvedImage") != approved_image:
    raise SystemExit("supervisor operational closure approvedImage does not match approved-image")
PY
}

validate_host_footguns() {
  "${PYTHON}" - "${HERMES_PROFILE}" "${GITHUB_APP_CONFIG}" "${CREDENTIAL_RECEIPT}" <<'PY'
import json
import sys
from pathlib import Path

profile, app_path, receipt_path = map(Path, sys.argv[1:])
expected_entries = ["auth.json", "config.yaml", "cron-disabled", "policy.json"]
if not profile.is_dir():
    raise SystemExit(f"Hermes execution profile is missing: {profile}")
entries = sorted(path.name for path in profile.iterdir())
if entries != expected_entries:
    raise SystemExit(
        "Hermes execution profile must contain only auth.json, config.yaml, cron-disabled, policy.json; "
        f"found: {', '.join(entries)}"
    )
if not app_path.is_file():
    raise SystemExit(f"GitHub App config is missing: {app_path}")
if receipt_path.exists():
    app = json.loads(app_path.read_text(encoding="utf-8"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    boundary = ("appId", "installationId", "repository", "repositoryId")
    mismatch = [key for key in boundary if app.get(key) != receipt.get(key)]
    if mismatch:
        raise SystemExit(
            "github-app.json does not match the active credential receipt repository boundary: "
            + ", ".join(mismatch)
        )
else:
    print("NOTICE credential receipt is absent; ExecStartPre will mint and validate the next lifecycle", file=sys.stderr)
PY

  if [[ "${PAPERCLIP_PIN_TEST_MODE:-0}" != '1' ]]; then
    [[ "$(stat -c '%a:%u:%g' "${HERMES_WORKSPACE}" 2>/dev/null || true)" == '2770:10000:985' ]] || {
      echo "Hermes workspace must be mode/owner 2770:10000:985: ${HERMES_WORKSPACE}" >&2
      exit 1
    }
    if "${SYSTEMCTL}" is-active --quiet paperclip-hermes-execution.service; then
      "${HERMES_PROFILE_VERIFIER}" --live
    else
      echo 'NOTICE paperclip-hermes-execution.service is not active; the Paperclip restart preflight will require it' >&2
    fi
  fi
}

resolve_from_tag() {
  [[ "${from_tag}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
    echo "invalid tag: ${from_tag}" >&2
    exit 2
  }
  local tagged_image="${IMAGE_REPOSITORY}:${from_tag}"
  if [[ "${dry_run}" != true && "${skip_pull}" != true ]]; then
    "${DOCKER}" pull "${tagged_image}"
  fi
  "${DOCKER}" image inspect "${tagged_image}" >/dev/null
  local repo_digests
  repo_digests="$("${DOCKER}" image inspect --format '{{json .RepoDigests}}' "${tagged_image}")"
  "${PYTHON}" - "${IMAGE_REPOSITORY}" "${repo_digests}" <<'PY'
import json
import re
import sys

repository, raw = sys.argv[1:]
try:
    values = json.loads(raw)
except json.JSONDecodeError as exc:
    raise SystemExit(f"cannot decode RepoDigests: {exc}") from exc
pattern = re.compile(rf"^{re.escape(repository)}@sha256:[a-f0-9]{{64}}$")
matches = sorted(value for value in values if isinstance(value, str) and pattern.fullmatch(value))
if len(matches) != 1:
    raise SystemExit(f"expected one {repository} RepoDigest, found {len(matches)}")
print(matches[0])
PY
}

validate_current_pin_contract
validate_host_footguns

if [[ "${restart_only}" == true ]]; then
  target_image="${old_image}"
elif [[ -n "${from_tag}" ]]; then
  target_image="$(resolve_from_tag)"
else
  target_image="${requested_image}"
fi
[[ "${target_image}" =~ ${IMAGE_PATTERN} ]] || {
  echo "image must match ${IMAGE_REPOSITORY}@sha256:<64 lowercase hex chars>" >&2
  exit 2
}

if [[ "${restart_only}" != true ]]; then
  if [[ "${dry_run}" != true && "${skip_pull}" != true && -z "${from_tag}" ]]; then
    "${DOCKER}" pull "${target_image}"
  fi
  "${DOCKER}" image inspect "${target_image}" >/dev/null
fi

if [[ "${dry_run}" == true ]]; then
  printf 'DRY RUN OK\ncurrent=%s\ntarget=%s\nrestart_only=%s\nskip_pull=%s\n' \
    "${old_image}" "${target_image}" "${restart_only}" "${skip_pull}"
  exit 0
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir=''

show_failure_evidence() {
  echo "FAIL ${SERVICE} did not reach active + healthy within ${TIMEOUT_SECONDS}s" >&2
  "${SYSTEMCTL}" status "${SERVICE}" --no-pager >&2 || true
  "${JOURNALCTL}" -u "${SERVICE}" -n 80 --no-pager >&2 || true
}

wait_for_health() {
  local deadline=$((SECONDS + TIMEOUT_SECONDS))
  local body
  while ((SECONDS < deadline)); do
    if "${SYSTEMCTL}" is-active --quiet "${SERVICE}"; then
      body="$("${CURL}" -sf --max-time 5 "${HEALTH_URL}" 2>/dev/null || true)"
      if [[ -n "${body}" ]] && "${PYTHON}" -c \
        'import json,sys; d=json.loads(sys.argv[1]); raise SystemExit(0 if d.get("status") == "ok" or d.get("ok") is True else 1)' \
        "${body}"; then
        printf '%s' "${body}"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

restore_pin_files() {
  [[ -n "${backup_dir}" ]] || return 1
  echo "restoring previous pin from ${backup_dir}" >&2
  "${INSTALL}" -m 0600 "${backup_dir}/approved-image" "${APPROVED_IMAGE_FILE}"
  "${INSTALL}" -m 0600 "${backup_dir}/runtime.env" "${RUNTIME_ENV_FILE}"
  "${INSTALL}" -m 0600 "${backup_dir}/supervisor-operational-closure.json" "${SUPERVISOR_RECEIPT}"
}

rollback_files() {
  if [[ -n "${backup_dir}" ]]; then
    restore_pin_files || return 1
  fi
  "${SYSTEMCTL}" reset-failed "${SERVICE}" || true
  "${SYSTEMCTL}" restart "${SERVICE}"
}

handle_live_failure() {
  local rollback_health rollback_image
  show_failure_evidence
  if rollback_files \
    && rollback_health="$(wait_for_health)" \
    && rollback_image="$("${DOCKER}" inspect --format '{{.Config.Image}}' paperclip-gloops)" \
    && [[ "${rollback_image}" == "${old_image}" ]]; then
    echo "ROLLBACK OK restored ${old_image}; health=${rollback_health}" >&2
  else
    echo "ROLLBACK FAILED: ${SERVICE} did not prove the prior image healthy; operator intervention required" >&2
    show_failure_evidence
  fi
}

if [[ "${restart_only}" != true ]]; then
  "${INSTALL}" -d -m 0700 "${RECEIPT_ROOT}" "${RECEIPT_ROOT}/pin-backups"
  backup_dir="$(mktemp -d "${RECEIPT_ROOT}/pin-backups/${stamp}.XXXXXX")"
  chmod 0700 "${backup_dir}"
  "${INSTALL}" -m 0600 "${APPROVED_IMAGE_FILE}" "${backup_dir}/approved-image"
  "${INSTALL}" -m 0600 "${RUNTIME_ENV_FILE}" "${backup_dir}/runtime.env"
  "${INSTALL}" -m 0600 "${SUPERVISOR_RECEIPT}" "${backup_dir}/supervisor-operational-closure.json"

  runtime_stage="$(mktemp "${RUNTIME_ENV_FILE}.pin.XXXXXX")"
  receipt_stage="$(mktemp "${SUPERVISOR_RECEIPT}.pin.XXXXXX")"
  approved_stage="$(mktemp "${APPROVED_IMAGE_FILE}.pin.XXXXXX")"
  cleanup_stages() { rm -f "${runtime_stage:-}" "${receipt_stage:-}" "${approved_stage:-}"; }
  trap cleanup_stages EXIT

  "${PYTHON}" - "${RUNTIME_ENV_FILE}" "${runtime_stage}" "${old_image}" "${target_image}" <<'PY'
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:3])
old_image, new_image = sys.argv[3:]
lines = source.read_text(encoding="utf-8").splitlines(keepends=True)
matches = [index for index, line in enumerate(lines) if line.startswith("PAPERCLIP_IMAGE=")]
if len(matches) != 1 or lines[matches[0]].rstrip("\r\n") != f"PAPERCLIP_IMAGE={old_image}":
    raise SystemExit("runtime.env changed after preflight; refusing patch")
newline = "\r\n" if lines[matches[0]].endswith("\r\n") else "\n"
lines[matches[0]] = f"PAPERCLIP_IMAGE={new_image}{newline}"
target.write_text("".join(lines), encoding="utf-8")
PY
  "${PYTHON}" - "${SUPERVISOR_RECEIPT}" "${receipt_stage}" "${old_image}" "${target_image}" <<'PY'
import json
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:3])
old_image, new_image = sys.argv[3:]
with source.open(encoding="utf-8") as handle:
    receipt = json.load(handle)
if receipt.get("approvedImage") != old_image:
    raise SystemExit("supervisor receipt changed after preflight; refusing patch")
receipt["approvedImage"] = new_image
target.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  printf '%s\n' "${target_image}" >"${approved_stage}"

  chmod 0600 "${approved_stage}" "${runtime_stage}" "${receipt_stage}"
  if ! mv "${approved_stage}" "${APPROVED_IMAGE_FILE}" \
    || ! mv "${runtime_stage}" "${RUNTIME_ENV_FILE}" \
    || ! mv "${receipt_stage}" "${SUPERVISOR_RECEIPT}"; then
    echo 'pin file update failed; restoring all three prior files before restart' >&2
    restore_pin_files || echo 'pin file restoration failed; operator intervention required' >&2
    exit 1
  fi
fi

if ! "${SYSTEMCTL}" reset-failed "${SERVICE}"; then
  echo "cannot reset the ${SERVICE} failure state" >&2
  handle_live_failure
  exit 1
fi
if ! "${SYSTEMCTL}" restart "${SERVICE}"; then
  handle_live_failure
  exit 1
fi
if ! health_json="$(wait_for_health)"; then
  handle_live_failure
  exit 1
fi

if ! container_image="$("${DOCKER}" inspect --format '{{.Config.Image}}' paperclip-gloops)" \
  || ! container_image_id="$("${DOCKER}" inspect --format '{{.Image}}' paperclip-gloops)" \
  || ! revision="$("${DOCKER}" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${container_image_id}")"; then
  echo 'running container proof collection failed' >&2
  handle_live_failure
  exit 1
fi
if [[ ! "${revision}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "running image revision label is not a full lowercase Git SHA: ${revision}" >&2
  handle_live_failure
  exit 1
fi
if [[ "${container_image}" != "${target_image}" ]]; then
  echo "running container image does not match target: ${container_image}" >&2
  handle_live_failure
  exit 1
fi

if ! "${INSTALL}" -d -m 0700 "${RECEIPT_ROOT}" \
  || ! health_stage="$(mktemp)" \
  || ! receipt_path="$(mktemp "${RECEIPT_ROOT}/pin-paperclip-image-${stamp}.XXXXXX.json")"; then
  echo 'cannot stage the pin receipt' >&2
  handle_live_failure
  exit 1
fi
printf '%s' "${health_json}" >"${health_stage}"
if ! "${PYTHON}" - "${receipt_path}" "${started_at}" "${target_image}" "${old_image}" \
  "${backup_dir}" "${container_image}" "${container_image_id}" "${revision}" "${health_stage}" \
  "${restart_only}" "${skip_pull}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

(path, started_at, target, previous, backup_dir, container_image,
 image_id, revision, health_path, restart_only, skip_pull) = sys.argv[1:]
health = json.loads(Path(health_path).read_text(encoding="utf-8"))
receipt = {
    "schemaVersion": "gloops.paperclip-image-pin.v1",
    "status": "succeeded",
    "startedAt": started_at,
    "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "previousImage": previous,
    "approvedImage": target,
    "containerImage": container_image,
    "containerImageId": image_id,
    "sourceRevision": revision,
    "health": health,
    "backupPath": backup_dir or None,
    "restartOnly": restart_only == "true",
    "skipPull": skip_pull == "true",
}
stage = Path(path + f".tmp.{os.getpid()}")
stage.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
os.chmod(stage, 0o600)
os.replace(stage, path)
PY
then
  rm -f "${health_stage}" "${receipt_path}"
  echo 'pin receipt write failed' >&2
  handle_live_failure
  exit 1
fi
rm -f "${health_stage}"

printf 'PIN OK\ncontainer_image=%s\ncontainer_image_id=%s\nrevision=%s\nhealth=%s\nreceipt=%s\nbackup=%s\n' \
  "${container_image}" "${container_image_id}" "${revision}" "${health_json}" \
  "${receipt_path}" "${backup_dir:-none}"
