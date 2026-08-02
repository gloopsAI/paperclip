#!/usr/bin/env bash
# WG-PLAT-018 symmetric, transactional pre-install snapshot / restore for BOTH
# halves of the read-only evidence lane: the broker (github-read-broker.py) AND
# the read-tool client (github-read-tool.mjs).  Sourced by backup-dark.sh
# (capture), rollback.sh (restore), and verify-rollback-dark.sh (terminal
# verify); the functions are unit-tested directly.
#
# The manifest records EXACTLY two rows -- one per required file -- each either
#   <name>\tpresent\tsha256:<hash>\tmode:<octal>\towner:<uid>:<gid>
# (with a byte-exact pre-install snapshot) or
#   <name>\tabsent\t-
# Restore is TWO-PHASE: it parses+validates the manifest, then STAGES every
# present snapshot (hash + recorded mode/owner) into same-directory temp files
# and verifies each BEFORE any install path is mutated; only then does it apply
# renames/removals.  EVERY apply-phase failure (a failed save, rename, or
# removal of any target) is routed through a SINGLE rollback handler that
# restores every already-mutated target, so a failed invocation can never leave
# a mixed pair (old broker + new client).  Restore RESTORES the recorded
# mode/owner (it does not silently normalize).
#
# CONTRACT SCOPE: this provides FAILURE ATOMICITY WITHIN A SINGLE INVOCATION.
# It is NOT a crash-recovery mechanism -- a process/host death BETWEEN the two
# target mutations is explicitly OUT OF SCOPE for this PR (no durable restore
# journal is written).  The terminal verifier (verify_read_lane_restored) is the
# backstop that detects a stranded mixed pair on the next governed run.
set -euo pipefail

READ_BROKER_INSTALL="${READ_BROKER_INSTALL:-/usr/local/lib/paperclip-gloops/github-read-broker.py}"
READ_TOOL_INSTALL="${READ_TOOL_INSTALL:-/usr/local/lib/paperclip-gloops/tools/github-read-tool.mjs}"

_read_lane_names() {
  printf '%s\n' 'github-read-broker.py' 'github-read-tool.mjs'
}

_read_lane_target_for() {
  case "$1" in
    'github-read-broker.py') printf '%s' "${READ_BROKER_INSTALL}" ;;
    'github-read-tool.mjs') printf '%s' "${READ_TOOL_INSTALL}" ;;
    *) return 1 ;;
  esac
}

_read_lane_running_as_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]]; }
_read_lane_sha256() { sha256sum "$1" | awk '{print $1}'; }

# Portable octal mode ("555") via python3; empty string on failure (caller must
# treat empty as a hard failure, never as "ok").
_read_lane_mode() {
  python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1" 2>/dev/null || printf ''
}
_read_lane_owner() {
  python3 -c 'import os,sys; st=os.stat(sys.argv[1]); print(f"{st.st_uid}:{st.st_gid}")' "$1" 2>/dev/null || printf ''
}

# capture_read_lane_snapshot <stage-dir>
# Emits a complete two-row manifest plus a byte-exact snapshot per present file.
# FAILS CLOSED on a symlink or non-regular file at an install path (that is not
# an exact pre-install state and must not be misrecorded as absent).
capture_read_lane_snapshot() {
  local stage="${1:?stage dir required}"
  local manifest="${stage}/read-lane.manifest"
  : >"${manifest}"
  local name target mode owner
  while IFS= read -r name; do
    target="$(_read_lane_target_for "${name}")"
    if [[ -L "${target}" ]]; then
      echo "read-lane capture refuses a symlink at install path: ${target}" >&2
      return 1
    fi
    if [[ -e "${target}" && ! -f "${target}" ]]; then
      echo "read-lane capture refuses a non-regular install path: ${target}" >&2
      return 1
    fi
    if [[ -f "${target}" ]]; then
      mode="$(_read_lane_mode "${target}")"
      owner="$(_read_lane_owner "${target}")"
      [[ -n "${mode}" && -n "${owner}" ]] \
        || { echo "read-lane capture could not stat install path: ${target}" >&2; return 1; }
      cp "${target}" "${stage}/read-lane.${name}.before"
      chmod 0444 "${stage}/read-lane.${name}.before"
      printf '%s\tpresent\tsha256:%s\tmode:%s\towner:%s\n' \
        "${name}" "$(_read_lane_sha256 "${target}")" "${mode}" "${owner}" >>"${manifest}"
    else
      printf '%s\tabsent\t-\n' "${name}" >>"${manifest}"
    fi
  done < <(_read_lane_names)
  chmod 0444 "${manifest}"
}

# Parse + strictly validate the manifest.  Requires exactly the two-name set,
# one row each, well-formed fields, no extras.  Sets globals _RL_STATE/_RL_HASH/
# _RL_MODE/_RL_OWNER.  For governed read-lane controls a present row MUST record
# the immutable pre-state mode 555 (and, when root, owner uid 0).
_read_lane_parse_manifest() {
  local manifest="${1:?manifest required}"
  [[ -f "${manifest}" ]] || { echo "read-lane manifest is missing: ${manifest}" >&2; return 1; }
  declare -gA _RL_STATE=() _RL_HASH=() _RL_MODE=() _RL_OWNER=()
  local line name state
  local -a f
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -n "${line}" ]] || continue
    IFS=$'\t' read -r -a f <<<"${line}"
    name="${f[0]:-}"; state="${f[1]:-}"
    _read_lane_target_for "${name}" >/dev/null || { echo "read-lane manifest has an unknown name: ${name}" >&2; return 1; }
    [[ -z "${_RL_STATE[${name}]:-}" ]] || { echo "read-lane manifest has a duplicate row: ${name}" >&2; return 1; }
    case "${state}" in
      present)
        [[ "${#f[@]}" -eq 5 ]] || { echo "read-lane present row field count is wrong: ${name}" >&2; return 1; }
        [[ "${f[2]}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "read-lane malformed hash: ${name}" >&2; return 1; }
        [[ "${f[3]}" =~ ^mode:[0-7]{3,4}$ ]] || { echo "read-lane malformed mode: ${name}" >&2; return 1; }
        [[ "${f[4]}" =~ ^owner:[0-9]+:[0-9]+$ ]] || { echo "read-lane malformed owner: ${name}" >&2; return 1; }
        _RL_HASH["${name}"]="${f[2]#sha256:}"
        _RL_MODE["${name}"]="${f[3]#mode:}"
        _RL_OWNER["${name}"]="${f[4]#owner:}"
        [[ "${_RL_MODE[${name}]}" == '555' ]] \
          || { echo "read-lane recorded mode is not the governed 0555: ${name}" >&2; return 1; }
        ;;
      absent)
        [[ "${#f[@]}" -eq 3 && "${f[2]}" == '-' ]] || { echo "read-lane malformed absent row: ${name}" >&2; return 1; }
        ;;
      *)
        echo "read-lane manifest has an unknown state for ${name}: ${state}" >&2; return 1 ;;
    esac
    _RL_STATE["${name}"]="${state}"
  done <"${manifest}"
  local expected
  while IFS= read -r expected; do
    [[ -n "${_RL_STATE[${expected}]:-}" ]] || { echo "read-lane manifest is missing the required row: ${expected}" >&2; return 1; }
  done < <(_read_lane_names)
}

# restore_read_lane_snapshot <backup-dir>  (TWO-PHASE, transactional)
restore_read_lane_snapshot() {
  local backup_dir="${1:?backup dir required}"
  _read_lane_parse_manifest "${backup_dir}/read-lane.manifest" || return 1

  local name target snap tmp got
  local -A staged=()
  local -a cleanup=()

  # ----- Phase 1: PREFLIGHT + STAGE (no install path mutated) -----
  while IFS= read -r name; do
    [[ "${_RL_STATE[${name}]}" == 'present' ]] || continue
    target="$(_read_lane_target_for "${name}")"
    snap="${backup_dir}/read-lane.${name}.before"
    if [[ ! -f "${snap}" ]]; then
      echo "missing read-lane snapshot: ${name}" >&2
      for t in "${cleanup[@]:-}"; do [[ -n "${t}" ]] && rm -f "${t}"; done
      return 1
    fi
    mkdir -p "$(dirname "${target}")"
    tmp="$(mktemp "$(dirname "${target}")/.read-lane.${name}.XXXXXX")"
    cleanup+=("${tmp}")
    cp "${snap}" "${tmp}"
    chmod "0${_RL_MODE[${name}]}" "${tmp}"
    _read_lane_running_as_root && chown "${_RL_OWNER[${name}]}" "${tmp}"
    got="$(_read_lane_sha256 "${tmp}")"
    if [[ "${got}" != "${_RL_HASH[${name}]}" ]]; then
      echo "staged read-lane hash mismatch (no target mutated): ${name}" >&2
      for t in "${cleanup[@]:-}"; do [[ -n "${t}" ]] && rm -f "${t}"; done
      return 1
    fi
    staged["${name}"]="${tmp}"
  done < <(_read_lane_names)

  # ----- Phase 2: APPLY with a SINGLE rollback handler -----
  # _RL_PRIOR / _RL_APPLIED / _RL_STAGED are dynamically visible to the handler.
  declare -gA _RL_PRIOR=()
  local -a _RL_APPLIED=()
  local -A _RL_STAGED=()
  for name in "${!staged[@]}"; do _RL_STAGED["${name}"]="${staged[${name}]}"; done
  local save
  while IFS= read -r name; do
    target="$(_read_lane_target_for "${name}")"
    # Save prior target so any later failure can be fully undone.
    if [[ -e "${target}" || -L "${target}" ]]; then
      save="$(mktemp "$(dirname "${target}")/.read-lane-prior.${name}.XXXXXX")" \
        || { _read_lane_apply_rollback "${name}"; return 1; }
      { cp -p "${target}" "${save}" 2>/dev/null || cp "${target}" "${save}"; } \
        || { _read_lane_apply_rollback "${name}"; return 1; }
      _RL_PRIOR["${name}"]="${save}"
    else
      _RL_PRIOR["${name}"]=''
    fi
    # Apply.  ANY failure here routes through the single rollback handler.
    if [[ "${_RL_STATE[${name}]}" == 'present' ]]; then
      mv -f "${staged[${name}]}" "${target}" \
        || { _read_lane_apply_rollback "${name}"; return 1; }
    else
      rm -f "${target}" \
        || { _read_lane_apply_rollback "${name}"; return 1; }
    fi
    _RL_APPLIED+=("${name}")
  done < <(_read_lane_names)

  # Success: drop saved prior copies.
  for name in "${!_RL_PRIOR[@]}"; do
    [[ -n "${_RL_PRIOR[${name}]}" ]] && rm -f "${_RL_PRIOR[${name}]}"
  done
  return 0
}

# Undo every already-applied target and clean up staged/prior temps.  Called for
# ANY apply-phase failure (save, rename, or removal of any target).
_read_lane_apply_rollback() {
  local failed="${1:-}"
  echo "read-lane apply failed at ${failed}; rolling back mutated targets" >&2
  local n dt
  for n in "${_RL_APPLIED[@]:-}"; do
    [[ -n "${n}" ]] || continue
    dt="$(_read_lane_target_for "${n}")"
    rm -f "${dt}"
    [[ -n "${_RL_PRIOR[${n}]:-}" && -e "${_RL_PRIOR[${n}]}" ]] && mv -f "${_RL_PRIOR[${n}]}" "${dt}"
  done
  local t
  for t in "${_RL_STAGED[@]:-}"; do [[ -n "${t}" && -e "${t}" ]] && rm -f "${t}"; done
  for n in "${!_RL_PRIOR[@]}"; do
    [[ -n "${_RL_PRIOR[${n}]}" && -e "${_RL_PRIOR[${n}]}" ]] && rm -f "${_RL_PRIOR[${n}]}"
  done
}

# check_read_lane_snapshot <backup-dir>
# Semantic --check: parse the manifest and reconcile EVERY present snapshot's
# stored bytes against the recorded hash, plus the governed mode/owner recorded
# state -- so a passing SHA256SUMS with a mis-recorded hash/mode/owner still
# fails.  Absent rows require no snapshot file.
check_read_lane_snapshot() {
  local backup_dir="${1:?backup dir required}"
  _read_lane_parse_manifest "${backup_dir}/read-lane.manifest" || return 1
  local name snap got rc=0
  while IFS= read -r name; do
    if [[ "${_RL_STATE[${name}]}" == 'present' ]]; then
      snap="${backup_dir}/read-lane.${name}.before"
      [[ -f "${snap}" ]] || { echo "read-lane check: missing snapshot ${name}" >&2; rc=1; continue; }
      got="$(_read_lane_sha256 "${snap}")"
      [[ "${got}" == "${_RL_HASH[${name}]}" ]] \
        || { echo "read-lane check: snapshot bytes != recorded hash for ${name}" >&2; rc=1; }
      # Governed pre-state: mode must be 0555 (enforced by parse) and, when the
      # backup was captured by root, the recorded owner must be uid 0.
      if _read_lane_running_as_root; then
        [[ "${_RL_OWNER[${name}]%%:*}" == '0' ]] \
          || { echo "read-lane check: recorded owner is not root for ${name}" >&2; rc=1; }
      fi
    else
      [[ ! -e "${backup_dir}/read-lane.${name}.before" ]] \
        || { echo "read-lane check: absent row has a stray snapshot ${name}" >&2; rc=1; }
    fi
  done < <(_read_lane_names)
  return "${rc}"
}

# verify_read_lane_restored [backup-dir]
# Governed backup dir (nonempty): the manifest is REQUIRED and parsed; each file
# is compared to the recorded OLD hash and recorded mode/owner (stat failure or
# any mismatch FAILS closed).  No backup dir: fall back to presence symmetry.
verify_read_lane_restored() {
  local backup_dir="${1:-}"
  if [[ -n "${backup_dir}" ]]; then
    _read_lane_parse_manifest "${backup_dir}/read-lane.manifest" || return 1
    local name target got mode owner rc=0
    while IFS= read -r name; do
      target="$(_read_lane_target_for "${name}")"
      if [[ "${_RL_STATE[${name}]}" == 'present' ]]; then
        if [[ -L "${target}" || ! -f "${target}" ]]; then
          echo "FAIL read-lane file not restored as a regular file: ${target}" >&2; rc=1; continue
        fi
        got="$(_read_lane_sha256 "${target}")"
        [[ "${got}" == "${_RL_HASH[${name}]}" ]] \
          || { echo "FAIL read-lane restored hash != recorded old hash: ${target}" >&2; rc=1; }
        mode="$(_read_lane_mode "${target}")"
        [[ -n "${mode}" && "${mode}" == "${_RL_MODE[${name}]}" ]] \
          || { echo "FAIL read-lane restored mode != recorded (${mode:-stat-failed}): ${target}" >&2; rc=1; }
        if _read_lane_running_as_root; then
          owner="$(_read_lane_owner "${target}")"
          [[ -n "${owner}" && "${owner}" == "${_RL_OWNER[${name}]}" ]] \
            || { echo "FAIL read-lane restored owner != recorded (${owner:-stat-failed}): ${target}" >&2; rc=1; }
        fi
      else
        if [[ -e "${target}" || -L "${target}" ]]; then
          echo "FAIL read-lane file should be absent after rollback: ${target}" >&2; rc=1
        fi
      fi
    done < <(_read_lane_names)
    return "${rc}"
  fi
  # Fallback presence-symmetry invariant (no manifest reference available).
  local broker_present=0 tool_present=0
  [[ -e "${READ_BROKER_INSTALL}" || -L "${READ_BROKER_INSTALL}" ]] && broker_present=1
  [[ -e "${READ_TOOL_INSTALL}" || -L "${READ_TOOL_INSTALL}" ]] && tool_present=1
  if (( broker_present != tool_present )); then
    echo "FAIL read-lane rollback is asymmetric: broker=${broker_present} tool=${tool_present}" >&2
    return 1
  fi
  if (( broker_present )); then
    local f
    for f in "${READ_BROKER_INSTALL}" "${READ_TOOL_INSTALL}"; do
      [[ ! -L "${f}" && -f "${f}" ]] \
        || { echo "FAIL read-lane path is not a regular file: ${f}" >&2; return 1; }
    done
  fi
  return 0
}
