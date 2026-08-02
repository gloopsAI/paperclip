#!/usr/bin/env bash
# WG-PLAT-4a governed LIVE, host-only upgrade/rollback of BOTH halves of the
# read-only evidence lane -- the read broker (github-read-broker.py) AND the
# read-tool client (github-read-tool.mjs) -- against a HEALTHY, running Paperclip
# container plane.
#
# The cold whole-plane lifecycle commands refuse to run while services/containers
# are up, so they cannot perform a live host-only swap of just these two files.
# This wrapper binds the sourceable snapshot/restore primitives to do exactly and
# only that, under a fail-closed double no-work gate, rolling back atomically on
# any failure.  It NEVER touches the Paperclip/Hermes container, any container
# image or digest, the runtime configuration, or any systemd unit other than the
# read broker service.  The read broker unit is observed active-but-DISABLED;
# this wrapper only ever `systemctl start`/`stop`s it and NEVER enables (or
# disables) it, so the disabled-but-running pre-state is preserved and verified.
#
# EXACT governed sequence (grading matrix):
#   1. STAGE both merged artifacts to temp (copy + hash).  Temp only -- the
#      installed live files are NOT modified here.
#   2. FIRST authenticated zero-live-run proof: the live-runs endpoint must be an
#      EXACTLY EMPTY JSON array.  ANY of {nonempty array, non-2xx, malformed /
#      non-JSON, non-array JSON, transport/query error} aborts with ZERO live
#      mutation (staged temps are swept).
#   3. CAPTURE + semantically CHECK the exact OLD installed pair (sha256 + mode +
#      owner) into the governed backup dir, and record the unit's observed
#      pre-state = active/running but DISABLED.
#   4. STOP ONLY paperclip-github-read-broker.service.
#   5. SECOND authenticated zero-live-run proof.  This gate protects the APPLY:
#      the installed live files are NOT mutated until this second proof passes
#      clean.  On failure, restart the UNTOUCHED old broker, prove its old
#      hashes + health + disabled-but-running state, and fail closed.
#   6. APPLY the pair (atomic temp->rename of BOTH -- the only live-path
#      mutation), and record the new hashes.
#   7. START the broker with `systemctl start` ONLY (never enable) + health check
#      (active, socket ready, enablement unchanged).
#   8. Installed-client canaries: exact metadata read, source-tree read, and
#      source-file read -- each must succeed.
#   9. Receipt.
#
#   FAILURE-ATOMIC ROLLBACK: any failure at/after APPLY (step 6) routes through
#   ONE handler -- stop the read broker, restore the captured pair, restart the
#   read broker, and prove the restored files match the OLD recorded hashes and
#   the broker is healthy AND disabled-but-running.  A rollback restore/restart
#   that itself fails is surfaced as a TERMINAL error, never a false success.
#
# The auth token is taken from the environment and is NEVER printed, echoed, or
# logged, and is never placed on any process argv or on-disk file.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SELF_DIR

# The ONLY systemd unit this wrapper controls.  Start-only; never enabled.
readonly BROKER_UNIT='paperclip-github-read-broker.service'

# Bind (do NOT reimplement) the symmetric, transactional read-lane snapshot
# primitives: capture_read_lane_snapshot / check_read_lane_snapshot /
# restore_read_lane_snapshot / verify_read_lane_restored plus their helpers.
# shellcheck source=/dev/null
source "${SELF_DIR}/read-lane-snapshot.sh"   # also (re)asserts set -euo pipefail

# --- state visible to the failure handlers ----------------------------------
WORKDIR=''
BACKUP_DIR=''
PRE_ENABLED=''
OLD_BROKER_HASH=''
OLD_TOOL_HASH=''
_FAIL_REASON=''
_APPLY_ERR=''
_START_ERR=''
_SOCKET_ERR=''
_CANARY_ERR=''
_CANARY_VERIFIED=''
_REVAL_ERR=''
_PRE_APPLY_FAILURE=0
_PRE_APPLY_MISMATCH=0
_LR_RESULT=''
_LR_DETAIL=''
declare -a _STAGED_TMPS=()
declare -gA _NEW_HASH=()
declare -gA _STAGED_FOR=()
declare -gA _EXPECTED_HASH=()
declare -gA _OBSERVED_HASH=()
_FIRST_LR=''
_SECOND_LR=''

_usage() {
  cat >&2 <<'USAGE'
usage: read-lane-live-upgrade.sh [--api-base URL] [--company-id ID]
                                 [--source-dir DIR] [--canary-repo OWNER/REPO]
                                 [--canary-commit 40-HEX] [--canary-path PATH]

Governed LIVE host-only upgrade of the read-lane broker + client pair.

Inputs (env or flag; flags override env):
  PAPERCLIP_API_BASE     / --api-base       control-plane base URL for the
                                            live-runs no-work proofs (required)
  PAPERCLIP_COMPANY_ID   / --company-id     company UUID for the proofs (required)
  PAPERCLIP_API_TOKEN                        bearer token for the proofs; ENV
                                            ONLY, never a flag, never logged (required)
  READ_LANE_SOURCE_DIR   / --source-dir     dir holding the merged
                                            github-read-broker.py +
                                            github-read-tool.mjs (default: this
                                            script's directory)
  READ_LANE_CANARY_REPO  / --canary-repo    allowlisted repo for the canaries
                                            (default: gloopsAI/gloops-ui)
  READ_LANE_CANARY_COMMIT/ --canary-commit  exact 40-hex commit SHA (required)
  READ_LANE_CANARY_PATH  / --canary-path    repo-relative file for the file-read
                                            canary (default: README.md)
  READ_BROKER_INSTALL / READ_TOOL_INSTALL   install targets (from the snapshot
                                            primitives; governed defaults)
  READ_LANE_BACKUP_DIR                       optional dir to record the old
                                            snapshot (default: a fresh mktemp dir)
  GITHUB_READ_BROKER_SOCKET                  broker socket path to poll for
                                            readiness (default: the governed path)
USAGE
  exit 2
}

_cleanup() {
  _sweep_staged
  [[ -n "${WORKDIR:-}" && -d "${WORKDIR}" ]] && rm -rf "${WORKDIR}"
  return 0
}

# _abort CODE MESSAGE...  -- typed, live-mutation-free failure.  The EXIT trap
# sweeps any staged temps.  NEVER prints the token.
_abort() {
  local code="$1"; shift
  echo "read-lane-live-upgrade: ABORT: $*" >&2
  _FAIL_REASON="${_FAIL_REASON:-$*}"
  _write_receipt 'aborted' || true
  exit "${code}"
}

# Classify the live-runs body: prints EMPTY / NONEMPTY / NONARRAY / MALFORMED and
# always exits 0 (a parse failure is reported as MALFORMED, not a crash).
_classify_live_runs() {
  python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    print("MALFORMED"); sys.exit(0)
if not isinstance(data, list):
    print("NONARRAY"); sys.exit(0)
print("EMPTY" if len(data) == 0 else "NONEMPTY")
PY
}

# _check_live_runs -- authenticated no-work query.  Sets _LR_RESULT in
# {empty,nonempty,nonarray,malformed,http,transport,query} and _LR_DETAIL (never
# any auth material).  Returns 0 iff _LR_RESULT == empty.  The bearer token is
# injected via a curl --config file on an anonymous FD so it never lands on any
# process argv, child environment, or on-disk file.
_check_live_runs() {
  local url body_file err_file code rc classify
  url="${API_BASE%/}/api/companies/${COMPANY_ID}/live-runs"
  body_file="$(mktemp "${WORKDIR}/live-runs-body.XXXXXX")"
  err_file="$(mktemp "${WORKDIR}/live-runs-err.XXXXXX")"
  _LR_RESULT=''
  _LR_DETAIL=''
  if code="$(curl --silent --show-error --max-time 10 \
      -o "${body_file}" -w '%{http_code}' \
      --config <(printf 'header = "Authorization: Bearer %s"\n' "${PAPERCLIP_API_TOKEN}") \
      "${url}" 2>"${err_file}")"; then
    rc=0
  else
    rc=$?
  fi
  if [[ "${rc}" -ne 0 ]]; then
    _LR_RESULT='transport'; _LR_DETAIL="query transport error (curl exit ${rc})"; return 1
  fi
  if ! [[ "${code}" =~ ^2[0-9][0-9]$ ]]; then
    _LR_RESULT='http'; _LR_DETAIL="HTTP ${code:-<none>}"; return 1
  fi
  if ! classify="$(_classify_live_runs "${body_file}")"; then
    _LR_RESULT='query'; _LR_DETAIL='classification error'; return 1
  fi
  case "${classify}" in
    EMPTY)     _LR_RESULT='empty'; return 0 ;;
    NONEMPTY)  _LR_RESULT='nonempty'; _LR_DETAIL='active queued/running runs present'; return 1 ;;
    NONARRAY)  _LR_RESULT='nonarray'; _LR_DETAIL='body is JSON but not an array'; return 1 ;;
    MALFORMED) _LR_RESULT='malformed'; _LR_DETAIL='body is malformed / not JSON'; return 1 ;;
    *)         _LR_RESULT='query'; _LR_DETAIL='unknown classification'; return 1 ;;
  esac
}

_manifest_hash() {
  awk -F '\t' -v n="$1" '$1 == n && $2 == "present" { sub(/^sha256:/, "", $3); print $3 }' \
    "${BACKUP_DIR}/read-lane.manifest"
}

# Remove any leftover staging temps (the tracked ones and any stray files
# matching the staging prefix in the two install directories).  Always succeeds.
_sweep_staged() {
  local t d
  for t in "${_STAGED_TMPS[@]:-}"; do
    if [[ -n "${t}" && -e "${t}" ]]; then rm -f "${t}" || true; fi
  done
  for d in "$(dirname "$(_read_lane_target_for github-read-broker.py)")" \
           "$(dirname "$(_read_lane_target_for github-read-tool.mjs)")"; do
    if [[ -d "${d}" ]]; then
      find "${d}" -maxdepth 1 -name '.read-lane-live.*' -exec rm -f {} + 2>/dev/null || true
    fi
  done
  return 0
}

# systemctl property value (empty string on any failure).
_unit_prop() { systemctl show -p "$1" --value "${BROKER_UNIT}" 2>/dev/null || true; }

# Exact health + pre-state proof: ActiveState=active, SubState=running,
# UnitFileState unchanged from the recorded pre-state (disabled), AND the broker
# socket is ready.  Proves the unit is genuinely running AND was never enabled --
# not merely a bare is-active that could pass before the socket exists.
_broker_running_in_prestate() {
  [[ "$(_unit_prop ActiveState)" == "active" ]]      || return 1
  [[ "$(_unit_prop SubState)" == "running" ]]        || return 1
  [[ "$(_unit_prop UnitFileState)" == "${PRE_ENABLED}" ]] || return 1
  _wait_broker_socket
}

# Bounded wait for the broker's Unix socket to appear (readiness gate).
_wait_broker_socket() {
  local sock i
  sock="${GITHUB_READ_BROKER_SOCKET:-/run/paperclip-github-read-broker/broker.sock}"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if [[ -S "${sock}" ]]; then return 0; fi
    sleep 0.2
  done
  _SOCKET_ERR="broker socket ${sock} did not appear"
  return 1
}

# STEP 1 -- STAGE both merged artifacts to same-directory temp files and hash
# them.  Temp only: NO installed live file is mutated here.
_stage_pair() {
  local name src target tmp got expected
  _NEW_HASH=(); _STAGED_FOR=(); _STAGED_TMPS=()
  while IFS= read -r name; do
    src="${SOURCE_DIR}/${name}"
    target="$(_read_lane_target_for "${name}")"
    expected="${_EXPECTED_HASH[${name}]:-}"
    # Blocker: require an exact reviewed expected sha256 and reject symlink /
    # non-regular source BEFORE any staging, live-run proof, or mutation.
    [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] \
      || { _APPLY_ERR="missing/invalid expected sha256 for ${name}"; return 1; }
    [[ ! -L "${src}" ]] || { _APPLY_ERR="source artifact is a symlink (rejected): ${name}"; return 1; }
    [[ -f "${src}" ]] || { _APPLY_ERR="missing/non-regular merged artifact: ${name}"; return 1; }
    [[ ! "${src}" -ef "${target}" ]] \
      || { _APPLY_ERR="source artifact is the install target (self-copy) for ${name}"; return 1; }
    mkdir -p "$(dirname "${target}")" || { _APPLY_ERR="cannot ensure install dir for ${name}"; return 1; }
    tmp="$(mktemp "$(dirname "${target}")/.read-lane-live.${name}.XXXXXX")" \
      || { _APPLY_ERR="cannot stage ${name}"; return 1; }
    _STAGED_TMPS+=("${tmp}")
    cp "${src}" "${tmp}" || { _APPLY_ERR="cannot copy staged ${name}"; return 1; }
    chmod 0555 "${tmp}" || { _APPLY_ERR="cannot set governed mode on staged ${name}"; return 1; }
    if _read_lane_running_as_root; then
      chown 0:0 "${tmp}" || { _APPLY_ERR="cannot set governed owner on staged ${name}"; return 1; }
    fi
    got="$(_read_lane_sha256 "${tmp}")" || { _APPLY_ERR="cannot hash staged ${name}"; return 1; }
    # Blocker: the staged bytes MUST equal the reviewed expected hash.
    [[ "${got}" == "${expected}" ]] \
      || { _APPLY_ERR="staged ${name} sha256 ${got} != expected ${expected}"; return 1; }
    _NEW_HASH["${name}"]="${got}"
    _STAGED_FOR["${name}"]="${tmp}"
  done < <(_read_lane_names)
  return 0
}

# A `systemctl stop` returning 0 is NOT proof the broker is down.  Require
# ActiveState inactive, SubState not running, and the socket absent as ANY
# filesystem object (a surviving socket / regular file / symlink fails closed).
# Shared by the apply path AND rollback so neither ever touches installed files
# under an ambiguously-active broker.
_verify_broker_stopped() {
  [[ "$(_unit_prop ActiveState)" == "inactive" ]] || return 1
  [[ "$(_unit_prop SubState)" != "running" ]] || return 1
  local sock="${GITHUB_READ_BROKER_SOCKET:-/run/paperclip-github-read-broker/broker.sock}"
  [[ ! -e "${sock}" && ! -L "${sock}" ]] || return 1
  return 0
}

_stop_read_broker() {
  if ! systemctl stop "${BROKER_UNIT}"; then return 1; fi
  if ! _verify_broker_stopped; then return 1; fi
  return 0
}

# STEP 6 -- APPLY the already-staged pair as one governed pair (temp->rename),
# then prove installed bytes == recorded new hashes and record them.  This is the
# ONLY live-path mutation.  Any failure sweeps staged temps and returns non-zero
# so the single rollback handler can restore the recorded old pair.
_apply_pair() {
  local name target got
  while IFS= read -r name; do
    target="$(_read_lane_target_for "${name}")"
    if ! mv -f "${_STAGED_FOR[${name}]}" "${target}"; then
      _APPLY_ERR="atomic rename failed for ${name}"; _sweep_staged; return 1
    fi
  done < <(_read_lane_names)
  while IFS= read -r name; do
    target="$(_read_lane_target_for "${name}")"
    # Blocker: guard the hash read -- errexit is disabled through the `if !`
    # caller, so an unguarded failure could otherwise pass through.
    if ! got="$(_read_lane_sha256 "${target}")"; then
      _APPLY_ERR="cannot hash applied ${name}"; return 1
    fi
    if [[ "${got}" != "${_NEW_HASH[${name}]}" ]]; then
      _APPLY_ERR="post-apply hash mismatch for ${name}"; return 1
    fi
  done < <(_read_lane_names)
  # Blocker: guard every receipt write; a failed redirection must fail the apply,
  # not silently return later success.
  : >"${BACKUP_DIR}/read-lane.new-hashes" \
    || { _APPLY_ERR="cannot initialize new-hashes receipt"; return 1; }
  while IFS= read -r name; do
    printf '%s\tsha256:%s\n' "${name}" "${_NEW_HASH[${name}]}" >>"${BACKUP_DIR}/read-lane.new-hashes" \
      || { _APPLY_ERR="cannot append new-hashes receipt for ${name}"; return 1; }
  done < <(_read_lane_names)
  return 0
}

# STEP 7 -- start ONLY (never enable), then verify active + socket-ready +
# enablement unchanged (disabled-but-running preserved).
_start_and_verify_read_broker() {
  if ! systemctl start "${BROKER_UNIT}"; then _START_ERR='start returned non-zero'; return 1; fi
  # Exact health + never-enabled proof (ActiveState/SubState/UnitFileState +
  # socket), not a bare is-active that can pass before the socket exists.
  if ! _broker_running_in_prestate; then
    _START_ERR="post-start proof failed (ActiveState=$(_unit_prop ActiveState), SubState=$(_unit_prop SubState), UnitFileState=$(_unit_prop UnitFileState); expected active/running/${PRE_ENABLED} + socket)"
    return 1
  fi
  return 0
}

# Run the installed read-tool client.  The bearer token is already de-exported,
# so this child cannot inherit PAPERCLIP_API_TOKEN.  Prints the client JSON.
_run_client() {
  # Broker verify_peer requires SO_PEERCRED uid == EXPECTED_HERMES_UID (10000 /
  # hermes-peer). Live upgrades run as root; drop only when root and the
  # production identity exists. Non-root harnesses/tests keep the mock client
  # path so the executable suite stays portable.
  if [[ "$(id -u)" -eq 0 ]] && id -u hermes-peer >/dev/null 2>&1; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u hermes-peer -- "${READ_TOOL_INSTALL}" "$@"
    else
      sudo -u hermes-peer -- "${READ_TOOL_INSTALL}" "$@"
    fi
  else
    "${READ_TOOL_INSTALL}" "$@"
  fi
}

# STEP 8 -- assert the installed client's response OBJECTS for a source op, not
# merely its exit code or request coordinates: a wrong-identity exit-0 must FAIL
# so it cannot produce a success receipt and escape rollback.  Cross-reconciles
# metadata.tree === tree.rootTree === tree.treeSha (root canary), and binds the
# file to encoding/size/blob.  `metadata` prints the 40-hex tree; `file` prints
# "<blob-sha> <size>".  Content is never printed or receipted.
_canary_assert() {
  local kind="$1" expected_tree="$2"; shift 2
  local out
  out="$(_run_client "$@" 2>/dev/null)" || return 1
  printf '%s' "${out}" | python3 -c '
import json, re, sys
kind, repo, commit, path, expected_tree = sys.argv[1:6]
try:
    resp = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
if resp.get("ok") is not True:
    sys.exit(1)
d = resp.get("data")
if not isinstance(d, dict):
    sys.exit(1)
if d.get("repo") != repo or d.get("commit") != commit:
    sys.exit(1)
H = re.compile(r"^[0-9a-f]{40}$")
if kind == "metadata":
    tree = str(d.get("tree", ""))
    if not H.match(tree):
        sys.exit(1)
    sys.stdout.write(tree)
elif kind == "tree":
    root = str(d.get("rootTree", ""))
    if not H.match(root):
        sys.exit(1)
    if expected_tree and root != expected_tree:
        sys.exit(1)
    if str(d.get("treeSha", "")) != root:           # root canary: no path prefix
        sys.exit(1)
    if d.get("pathPrefix") != "":
        sys.exit(1)
    if d.get("truncated") is not False:
        sys.exit(1)
    entries = d.get("entries")
    if not isinstance(entries, list):
        sys.exit(1)
    tr = d.get("totalReturned")
    if type(tr) is not int or tr != len(entries):
        sys.exit(1)
    # Mirror the reviewed broker per-row contract: known type, exact 40-hex
    # object sha, safe single-component name, type-consistent mode, and a
    # nonnegative int size for blobs (trees/commits may omit).
    names = []
    for e in entries:
        if not isinstance(e, dict):
            sys.exit(1)
        t = e.get("type")
        if t not in ("blob", "tree", "commit"):
            sys.exit(1)
        s = e.get("sha")
        if not isinstance(s, str) or not H.match(s):
            sys.exit(1)
        p = e.get("path")
        if not isinstance(p, str) or p in ("", ".", ".."):
            sys.exit(1)
        if "/" in p or "\\" in p or any(ord(c) < 0x20 or 0x7f <= ord(c) <= 0x9f for c in p):
            sys.exit(1)
        if len(p.encode("utf-8")) > 255:
            sys.exit(1)
        m = e.get("mode")
        if t == "tree":
            if m != "040000": sys.exit(1)
        elif t == "commit":
            if m != "160000": sys.exit(1)
        else:  # blob
            if m not in ("100644", "100755", "120000"): sys.exit(1)
        sz = e.get("size")
        if t == "blob":
            if type(sz) is not int or sz < 0: sys.exit(1)
        elif sz is not None and (type(sz) is not int or sz < 0):
            sys.exit(1)
        names.append(p)
    # No duplicate or unsorted immediate names -- totalReturned must not bless
    # ambiguous or reordered evidence.
    if names != sorted(names) or len(set(names)) != len(names):
        sys.exit(1)
elif kind == "file":
    if d.get("path") != path:
        sys.exit(1)
    if d.get("encoding") != "utf-8":
        sys.exit(1)
    content = d.get("content")
    if not isinstance(content, str):
        sys.exit(1)
    size = d.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size < 0:
        sys.exit(1)
    if size != len(content.encode("utf-8")):
        sys.exit(1)
    sha = str(d.get("sha", ""))
    if not H.match(sha):
        sys.exit(1)
    sys.stdout.write(sha + " " + str(size))         # blob/size identities only
else:
    sys.exit(1)
' "${kind}" "${CANARY_REPO}" "${CANARY_COMMIT}" "${CANARY_PATH}" "${expected_tree}"
}

# metadata -> capture root tree; tree -> reconcile rootTree/treeSha/prefix/count;
# file -> bind encoding/size/blob.  Records only root-tree/blob/size identities.
_run_canaries() {
  local meta_tree blob_size blob fsize
  if ! meta_tree="$(_canary_assert metadata '' --operation get-repo-source-metadata \
      --repo "${CANARY_REPO}" --commit "${CANARY_COMMIT}")"; then
    _CANARY_ERR='metadata identity'; return 1
  fi
  if ! _canary_assert tree "${meta_tree}" --operation list-source-tree \
      --repo "${CANARY_REPO}" --commit "${CANARY_COMMIT}" >/dev/null; then
    _CANARY_ERR='tree/root-tree reconciliation'; return 1
  fi
  if ! blob_size="$(_canary_assert file '' --operation get-source-file \
      --repo "${CANARY_REPO}" --commit "${CANARY_COMMIT}" --path "${CANARY_PATH}")"; then
    _CANARY_ERR='file identity'; return 1
  fi
  blob="${blob_size%% *}"; fsize="${blob_size##* }"
  _CANARY_VERIFIED="rootTree=${meta_tree}; file ${CANARY_PATH} blob=${blob} size=${fsize}"
  echo "PASS read-lane canaries: rootTree ${meta_tree} reconciled; file ${CANARY_PATH} blob=${blob} size=${fsize}"
  return 0
}

# Final integrity gate: after canaries, rehash BOTH installed files and require
# each to be a non-symlink regular 0555 file (root-owned when running as root)
# whose bytes equal the applied hash.  Records the observed hashes for the
# receipt so success never attests staged bytes that are no longer installed.
_revalidate_installed_pair() {
  local name target got mode owner
  _OBSERVED_HASH=()
  while IFS= read -r name; do
    target="$(_read_lane_target_for "${name}")"
    if [[ -L "${target}" || ! -f "${target}" ]]; then
      _REVAL_ERR="installed ${name} is not a regular file"; return 1
    fi
    if ! got="$(_read_lane_sha256 "${target}")"; then
      _REVAL_ERR="cannot hash installed ${name}"; return 1
    fi
    if [[ "${got}" != "${_NEW_HASH[${name}]}" ]]; then
      _REVAL_ERR="installed ${name} sha256 ${got} != applied ${_NEW_HASH[${name}]}"; return 1
    fi
    mode="$(_read_lane_mode "${target}")"
    [[ "${mode}" == "555" ]] || { _REVAL_ERR="installed ${name} mode ${mode:-stat-failed} != 0555"; return 1; }
    if _read_lane_running_as_root; then
      owner="$(_read_lane_owner "${target}")"
      [[ "${owner}" == "0:0" ]] || { _REVAL_ERR="installed ${name} owner ${owner:-stat-failed} != 0:0"; return 1; }
    fi
    _OBSERVED_HASH["${name}"]="${got}"
  done < <(_read_lane_names)
  return 0
}

# Steps 4 -> 8.  Returns 0 on full success; on any failure sets _FAIL_REASON.
# A failure BEFORE the apply (stop failure or the second no-work race gate) sets
# _PRE_APPLY_FAILURE=1 so the untouched-restart path runs instead of a restore.
_run_upgrade() {
  if ! _stop_read_broker; then
    _FAIL_REASON='could not stop the read broker'; _PRE_APPLY_FAILURE=1; return 1
  fi
  if ! _check_live_runs; then
    _SECOND_LR="${_LR_RESULT}"
    _FAIL_REASON="post-stop no-work race gate failed (${_LR_RESULT}: ${_LR_DETAIL})"
    _PRE_APPLY_FAILURE=1; return 1
  fi
  _SECOND_LR="${_LR_RESULT}"
  echo "PASS post-stop no-work race gate: live-runs still an empty array"
  # Fail-closed: revalidate the live OLD pair still matches the captured snapshot
  # before overwriting anything.  Our lock only excludes another copy of THIS
  # wrapper; a different installer could have changed either installed file after
  # capture.  On divergence, abort WITHOUT applying -- the installed pair no
  # longer matches the governed snapshot, so it is neither an untouched old pair
  # nor safely restorable; the pre-apply abort verifier surfaces it as terminal.
  if ! verify_read_lane_restored "${BACKUP_DIR}"; then
    _FAIL_REASON='installed read-lane pair diverged from the captured snapshot after capture (concurrent installer); refusing to apply'
    # DISTINCT from a clean second-proof abort: the installed bytes are unknown,
    # so we must NOT restart the broker with them.  Route to the terminal
    # mismatch handler (no apply/restore/restart; broker stays stopped).
    _PRE_APPLY_MISMATCH=1; return 1
  fi
  echo "PASS installed pair still matches the captured snapshot (no concurrent change)"
  if ! _apply_pair; then _FAIL_REASON="apply failed: ${_APPLY_ERR:-unknown}"; return 1; fi
  echo "PASS applied the read-lane pair (atomic temp->rename); new hashes recorded"
  if ! _start_and_verify_read_broker; then
    _FAIL_REASON="read broker did not start/verify: ${_START_ERR:-unknown}"; return 1
  fi
  echo "PASS read broker started (start-only) and healthy: active, socket-ready, disabled-but-running"
  if ! _run_canaries; then _FAIL_REASON="canary failed: ${_CANARY_ERR:-unknown}"; return 1; fi
  # Final fail-closed revalidation: rehash the INSTALLED pair after canaries and
  # immediately before success, so a concurrent installer that changed a live
  # path post-apply cannot be receipted as the reviewed bytes.  Any divergence
  # routes through the rollback handler (restore the recorded old pair).
  if ! _revalidate_installed_pair; then
    _FAIL_REASON="post-canary installed-pair revalidation failed: ${_REVAL_ERR:-unknown}"; return 1
  fi
  echo "PASS installed pair revalidated after canaries: bytes/mode/owner match the applied hashes"
  return 0
}

# Pre-apply abort compensation: nothing was applied, so restart the UNTOUCHED old
# broker (start-only), prove its health + disabled-but-running pre-state, and
# prove both files still match their recorded old hashes.  No restore, no
# artifact mutation.  A failure here is TERMINAL.
_restart_untouched_and_abort() {
  echo "read-lane live upgrade ABORTED before any live mutation: ${_FAIL_REASON}" >&2
  _sweep_staged
  if ! systemctl start "${BROKER_UNIT}"; then
    echo "FATAL could not restart the read broker after a pre-apply abort" >&2; _write_receipt 'abort-fatal' || echo "read-lane: WARNING durable receipt publication also failed on abort-fatal path" >&2; exit 6
  fi
  if ! _broker_running_in_prestate; then
    echo "FATAL read broker not healthy/in disabled-but-running pre-state after a pre-apply restart" >&2; _write_receipt 'abort-fatal' || echo "read-lane: WARNING durable receipt publication also failed on abort-fatal path" >&2; exit 6
  fi
  if ! verify_read_lane_restored "${BACKUP_DIR}"; then
    echo "FATAL read-lane files diverged from recorded old hashes during a pre-apply abort" >&2; _write_receipt 'abort-fatal' || echo "read-lane: WARNING durable receipt publication also failed on abort-fatal path" >&2; exit 6
  fi
  echo "read-lane live upgrade safely aborted: OLD broker restarted, disabled-but-running, both files unchanged" >&2
  if ! _write_receipt 'aborted-pre-apply'; then
    echo "FATAL durable pre-apply-abort receipt could not be published; manual verification required" >&2
    exit 6
  fi
  exit 5
}

# Pre-apply snapshot mismatch (a concurrent installer wrote unknown bytes into an
# installed file after capture).  Do NOT apply, restore, or restart -- starting
# unknown bytes would be unsafe and restoring the earlier snapshot would falsely
# claim an exact rollback.  Leave the read broker STOPPED, publish a typed
# terminal receipt (with the observed current hashes), and exit terminal.
_pre_apply_mismatch_terminal() {
  echo "FATAL read-lane pre-apply revalidation failed: ${_FAIL_REASON}" >&2
  echo "FATAL installed pair diverged from the captured snapshot; NOT applying/restoring/restarting; read broker left STOPPED; manual intervention required" >&2
  _sweep_staged
  local obs_b obs_t
  obs_b="$(_read_lane_sha256 "$(_read_lane_target_for github-read-broker.py)" 2>/dev/null || echo unknown)"
  obs_t="$(_read_lane_sha256 "$(_read_lane_target_for github-read-tool.mjs)" 2>/dev/null || echo unknown)"
  _FAIL_REASON="${_FAIL_REASON}; observed broker=${obs_b} tool=${obs_t}"
  _write_receipt 'pre-apply-mismatch-terminal' \
    || echo "read-lane: WARNING durable receipt publication also failed on pre-apply-mismatch path" >&2
  exit 6
}

# Single failure-atomic rollback handler for any failure from APPLY onward.
_rollback_pair() {
  echo "read-lane live upgrade FAILED: ${_FAIL_REASON}; rolling back to the captured pre-upgrade pair" >&2
  # Blocker: a broker stop failure during rollback is TERMINAL.  Restoring files
  # under a still-running old process could let a later start/is-active falsely
  # pass; never claim restored runtime health in that case.
  if ! _stop_read_broker; then
    echo "FATAL rollback could not stop+verify-inactive the read broker; refusing to restore under an ambiguously active broker; manual intervention required" >&2
    _write_receipt 'rollback-fatal' || echo "read-lane: WARNING durable receipt publication also failed on rollback-fatal path" >&2; exit 6
  fi
  _sweep_staged
  if ! restore_read_lane_snapshot "${BACKUP_DIR}"; then
    echo "FATAL read-lane rollback restore failed; manual intervention required" >&2; _write_receipt 'rollback-fatal' || echo "read-lane: WARNING durable receipt publication also failed on rollback-fatal path" >&2; exit 6
  fi
  if ! systemctl start "${BROKER_UNIT}"; then
    echo "FATAL rollback could not restart the read broker" >&2; _write_receipt 'rollback-fatal' || echo "read-lane: WARNING durable receipt publication also failed on rollback-fatal path" >&2; exit 6
  fi
  if ! _broker_running_in_prestate; then
    echo "FATAL read broker not healthy/in disabled-but-running pre-state after rollback" >&2; _write_receipt 'rollback-fatal' || echo "read-lane: WARNING durable receipt publication also failed on rollback-fatal path" >&2; exit 6
  fi
  if ! verify_read_lane_restored "${BACKUP_DIR}"; then
    echo "FATAL restored read-lane pair does not match recorded old hashes" >&2; _write_receipt 'rollback-fatal' || echo "read-lane: WARNING durable receipt publication also failed on rollback-fatal path" >&2; exit 6
  fi
  echo "read-lane rollback complete: both files restored to recorded old hashes; read broker disabled-but-running" >&2
  if ! _write_receipt 'rolled-back'; then
    echo "FATAL durable rollback receipt could not be published after restore; manual verification required" >&2
    exit 6
  fi
  exit 5
}

_finalize_success() {
  echo "read-lane live upgrade complete: broker + client updated as a governed pair; read broker healthy"
  echo "  backup dir:                        ${BACKUP_DIR}"
  echo "  unit pre-state:                    active/running, enablement=${PRE_ENABLED} (preserved; never enabled)"
  echo "  old github-read-broker.py sha256:  ${OLD_BROKER_HASH}"
  echo "  new github-read-broker.py sha256:  ${_NEW_HASH[github-read-broker.py]}"
  echo "  old github-read-tool.mjs   sha256: ${OLD_TOOL_HASH}"
  echo "  new github-read-tool.mjs   sha256: ${_NEW_HASH[github-read-tool.mjs]}"
  if ! _write_receipt 'success'; then
    echo "FATAL durable success receipt could not be published after a completed live upgrade; manual verification required" >&2
    exit 6
  fi
}

# Blocker: durable disposition receipt bound to service before/after, expected +
# observed old/new hashes, both preflight results, canary identity, and the final
# disposition -- written on EVERY terminal path.  Content-free re auth material.
_write_receipt() {
  # Blocker: ATOMIC + FAIL-CLOSED.  Stage to a same-dir temp with every write
  # guarded, then rename.  Returns non-zero if the durable receipt cannot be
  # published; post-mutation callers (success / rolled-back) treat that as
  # TERMINAL, never a silent success.
  local disposition="$1" dir tmp a s u
  dir="${BACKUP_DIR:-${WORKDIR:-}}"
  [[ -n "${dir}" && -d "${dir}" ]] || return 1
  # Precompute the three service-state values as guarded LITERALS -- embedding
  # $(_unit_prop ...) directly in the printf would let a failed systemctl be
  # masked by the successful printf and publish empty service evidence.
  a="$(systemctl show -p ActiveState   --value "${BROKER_UNIT}" 2>/dev/null || true)"
  s="$(systemctl show -p SubState      --value "${BROKER_UNIT}" 2>/dev/null || true)"
  u="$(systemctl show -p UnitFileState --value "${BROKER_UNIT}" 2>/dev/null || true)"
  # Dispositions that assert a HEALTHY terminal broker require real evidence in
  # the exact governed pre-state; empty or wrong evidence fails the receipt.
  case "${disposition}" in
    success|rolled-back|aborted-pre-apply)
      if [[ "${a}" != "active" || "${s}" != "running" || "${u}" != "disabled" ]]; then
        echo "read-lane receipt: '${disposition}' requires active/running/disabled service evidence, got '${a}'/'${s}'/'${u}'" >&2
        return 1
      fi ;;
    *) : ;;
  esac
  tmp="$(mktemp "${dir}/.read-lane.receipt.XXXXXX")" || return 1
  # ONE guarded printf of ONLY precomputed literals (no embedded substitutions).
  printf '%s\n' \
    "schema=read-lane.live-upgrade.receipt.v1" \
    "disposition=${disposition}" \
    "broker_unit=${BROKER_UNIT}" \
    "unit_pre_enablement=${PRE_ENABLED:-unknown}" \
    "unit_post_activestate=${a:-unknown}" \
    "unit_post_substate=${s:-unknown}" \
    "unit_post_unitfilestate=${u:-unknown}" \
    "first_preflight=${_FIRST_LR:-unrun}" \
    "second_preflight=${_SECOND_LR:-unrun}" \
    "old_broker_sha256=${OLD_BROKER_HASH}" \
    "old_tool_sha256=${OLD_TOOL_HASH}" \
    "expected_broker_sha256=${_EXPECTED_HASH[github-read-broker.py]:-}" \
    "expected_tool_sha256=${_EXPECTED_HASH[github-read-tool.mjs]:-}" \
    "new_broker_sha256=${_NEW_HASH[github-read-broker.py]:-}" \
    "new_tool_sha256=${_NEW_HASH[github-read-tool.mjs]:-}" \
    "observed_broker_sha256=${_OBSERVED_HASH[github-read-broker.py]:-}" \
    "observed_tool_sha256=${_OBSERVED_HASH[github-read-tool.mjs]:-}" \
    "canary_target=${CANARY_REPO:-}@${CANARY_COMMIT:-} path=${CANARY_PATH:-}" \
    "canary_verified=${_CANARY_VERIFIED:-none}" \
    "canary_error=${_CANARY_ERR:-none}" \
    "fail_reason=${_FAIL_REASON:-none}" \
    >"${tmp}" || { rm -f "${tmp}"; return 1; }
  # Verify the STAGED receipt before publishing: non-empty and schema present.
  { [[ -s "${tmp}" ]] && grep -q '^schema=read-lane.live-upgrade.receipt.v1$' "${tmp}"; } \
    || { rm -f "${tmp}"; return 1; }
  mv -f "${tmp}" "${dir}/read-lane.receipt" || { rm -f "${tmp}"; return 1; }
  return 0
}

main() {
  local API_BASE COMPANY_ID SOURCE_DIR CANARY_REPO CANARY_COMMIT CANARY_PATH
  local EXPECTED_BROKER_SHA256 EXPECTED_TOOL_SHA256
  API_BASE="${PAPERCLIP_API_BASE:-}"
  COMPANY_ID="${PAPERCLIP_COMPANY_ID:-}"
  SOURCE_DIR="${READ_LANE_SOURCE_DIR:-${SELF_DIR}}"
  CANARY_REPO="${READ_LANE_CANARY_REPO:-gloopsAI/gloops-ui}"
  CANARY_COMMIT="${READ_LANE_CANARY_COMMIT:-}"
  CANARY_PATH="${READ_LANE_CANARY_PATH:-README.md}"
  EXPECTED_BROKER_SHA256="${READ_LANE_BROKER_SHA256:-}"
  EXPECTED_TOOL_SHA256="${READ_LANE_TOOL_SHA256:-}"

  while (($#)); do
    case "$1" in
      --api-base)      API_BASE="$2"; shift 2 ;;
      --company-id)    COMPANY_ID="$2"; shift 2 ;;
      --source-dir)    SOURCE_DIR="$2"; shift 2 ;;
      --canary-repo)   CANARY_REPO="$2"; shift 2 ;;
      --canary-commit) CANARY_COMMIT="$2"; shift 2 ;;
      --canary-path)   CANARY_PATH="$2"; shift 2 ;;
      --expected-broker-sha256) EXPECTED_BROKER_SHA256="$2"; shift 2 ;;
      --expected-tool-sha256)   EXPECTED_TOOL_SHA256="$2"; shift 2 ;;
      -h|--help)       _usage ;;
      *)               _abort 2 "unknown argument: $1" ;;
    esac
  done

  # Validate inputs (no mutation).  The token is required but NEVER echoed.
  [[ -n "${API_BASE}" ]]                  || _abort 2 "API base is required (PAPERCLIP_API_BASE or --api-base)"
  [[ -n "${COMPANY_ID}" ]]                || _abort 2 "company id is required (PAPERCLIP_COMPANY_ID or --company-id)"
  [[ -n "${PAPERCLIP_API_TOKEN:-}" ]]     || _abort 2 "PAPERCLIP_API_TOKEN env var is required (never passed as a flag)"
  [[ -d "${SOURCE_DIR}" ]]                || _abort 2 "source dir does not exist: ${SOURCE_DIR}"
  [[ "${CANARY_COMMIT}" =~ ^[0-9a-f]{40}$ ]] \
    || _abort 2 "canary commit must be an exact 40-hex commit SHA (READ_LANE_CANARY_COMMIT or --canary-commit)"
  # Blocker: require exact reviewed expected sha256 for BOTH merged artifacts.
  [[ "${EXPECTED_BROKER_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
    || _abort 2 "expected broker sha256 required (READ_LANE_BROKER_SHA256 or --expected-broker-sha256), exact 64-hex"
  [[ "${EXPECTED_TOOL_SHA256}" =~ ^[0-9a-f]{64}$ ]] \
    || _abort 2 "expected tool sha256 required (READ_LANE_TOOL_SHA256 or --expected-tool-sha256), exact 64-hex"
  _EXPECTED_HASH['github-read-broker.py']="${EXPECTED_BROKER_SHA256}"
  _EXPECTED_HASH['github-read-tool.mjs']="${EXPECTED_TOOL_SHA256}"

  # Blocker: keep the bearer token usable by THIS shell (for the curl anonymous-FD
  # config) but strip its export attribute so NO child process (curl, python3, the
  # installed-client canaries) can inherit it through the environment.
  export -n PAPERCLIP_API_TOKEN

  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/read-lane-live-upgrade.work.XXXXXX")"
  trap '_cleanup' EXIT

  # Blocker: single-invocation lock acquired BEFORE staging/preflight so two
  # concurrent wrappers cannot race the same service/files.  P0: open the lock
  # NON-truncating (>>) and reject a symlink lock path or non-directory/symlink
  # parent, so a root run can never truncate or follow an arbitrary file even if
  # the override env var is attacker-controlled.
  local lock_file lock_parent
  lock_file="${READ_LANE_LOCK:-/run/lock/read-lane-live-upgrade.lock}"
  lock_parent="$(dirname "${lock_file}")"
  [[ -d "${lock_parent}" && ! -L "${lock_parent}" ]] \
    || _abort 4 "lock parent must be an existing non-symlink directory: ${lock_parent}"
  [[ ! -L "${lock_file}" ]] || _abort 4 "lock path must not be a symlink: ${lock_file}"
  if ! exec 9>>"${lock_file}"; then _abort 4 "cannot open single-invocation lock file: ${lock_file}"; fi
  if ! flock -n 9; then _abort 4 "another read-lane live upgrade holds ${lock_file}; refusing concurrent invocation"; fi

  # STEP 1 -- STAGE both artifacts to temp (copy + hash).  No live mutation.
  if ! _stage_pair; then _abort 4 "staging the merged read-lane pair failed (${_APPLY_ERR:-unknown}); no live mutation"; fi
  echo "PASS staged both merged read-lane artifacts to temp (no live file modified)"

  # STEP 2 -- FIRST fail-closed no-work proof (before any capture/stop/apply).
  if ! _check_live_runs; then
    _FIRST_LR="${_LR_RESULT}"
    _abort 3 "first no-work proof failed (${_LR_RESULT}: ${_LR_DETAIL}); refusing live read-lane upgrade with zero live mutation"
  fi
  _FIRST_LR="${_LR_RESULT}"
  echo "PASS first no-work proof: live-runs is an empty array (no active Harbor/Work Graph runs)"

  # STEP 3 -- CAPTURE + CHECK the OLD pair and record the unit pre-state.
  if [[ -n "${READ_LANE_BACKUP_DIR:-}" ]]; then
    # Blocker: a user-supplied backup dir must be a fresh/empty, non-symlink, 0700,
    # safe-owned target -- never a pre-existing/nonempty/symlinked path.
    BACKUP_DIR="${READ_LANE_BACKUP_DIR}"
    # Blocker: only a NEWLY created, non-symlink, empty 0700 dir is acceptable --
    # reject ANY pre-existing target (do not adopt/normalize an existing dir).
    [[ ! -e "${BACKUP_DIR}" && ! -L "${BACKUP_DIR}" ]] \
      || _abort 4 "backup dir must not pre-exist (create-fresh only): ${BACKUP_DIR}"
    mkdir -m 0700 "${BACKUP_DIR}" || _abort 4 "cannot create backup dir: ${BACKUP_DIR}"
    if _read_lane_running_as_root; then
      chown 0:0 "${BACKUP_DIR}" || _abort 4 "cannot set safe ownership on backup dir: ${BACKUP_DIR}"
    fi
  else
    BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/read-lane-live-upgrade.backup.XXXXXX")"
    chmod 0700 "${BACKUP_DIR}" || _abort 4 "cannot set 0700 on backup dir: ${BACKUP_DIR}"
  fi
  if ! capture_read_lane_snapshot "${BACKUP_DIR}"; then
    _abort 4 "capture of the current read-lane pair failed; refusing upgrade (no service mutation)"
  fi
  if ! check_read_lane_snapshot "${BACKUP_DIR}"; then
    _abort 4 "captured read-lane snapshot failed verification; refusing upgrade (no service mutation)"
  fi
  OLD_BROKER_HASH="$(_manifest_hash 'github-read-broker.py')"
  OLD_TOOL_HASH="$(_manifest_hash 'github-read-tool.mjs')"
  [[ "${OLD_BROKER_HASH}" =~ ^[0-9a-f]{64}$ ]] \
    || _abort 4 "captured old github-read-broker.py hash is not exact 64-hex; refusing upgrade"
  [[ "${OLD_TOOL_HASH}" =~ ^[0-9a-f]{64}$ ]] \
    || _abort 4 "captured old github-read-tool.mjs hash is not exact 64-hex; refusing upgrade"
  # Blocker: exact pre-state proof -- ActiveState=active, SubState=running,
  # UnitFileState=disabled, and socket ready.
  local pre_active pre_sub
  pre_active="$(_unit_prop ActiveState)"; pre_sub="$(_unit_prop SubState)"
  PRE_ENABLED="$(_unit_prop UnitFileState)"
  [[ "${pre_active}" == "active" ]] \
    || _abort 4 "read broker ActiveState is '${pre_active:-<unknown>}', expected 'active'; a live upgrade needs a healthy running broker"
  [[ "${pre_sub}" == "running" ]] \
    || _abort 4 "read broker SubState is '${pre_sub:-<unknown>}', expected 'running'"
  [[ "${PRE_ENABLED}" == "disabled" ]] \
    || _abort 4 "read broker UnitFileState is '${PRE_ENABLED:-<unknown>}', expected the governed 'disabled' pre-state"
  if ! _wait_broker_socket; then
    _abort 4 "read broker socket not ready at pre-state: ${_SOCKET_ERR:-unavailable}"
  fi
  echo "PASS captured + checked the current read-lane pair into ${BACKUP_DIR}"
  echo "PASS recorded read broker pre-state: ActiveState=active, SubState=running, UnitFileState=${PRE_ENABLED}, socket ready"

  # STEPS 4 -> 8, with the single failure-atomic handler on any failure.
  local _upgrade_rc=0
  _run_upgrade || _upgrade_rc=$?
  if [[ "${_upgrade_rc}" -ne 0 ]]; then
    if [[ "${_PRE_APPLY_MISMATCH}" -eq 1 ]]; then
      _pre_apply_mismatch_terminal
    elif [[ "${_PRE_APPLY_FAILURE}" -eq 1 ]]; then
      _restart_untouched_and_abort
    else
      _rollback_pair
    fi
  fi

  # STEP 9 -- receipt.
  _finalize_success
  exit 0
}

main "$@"
