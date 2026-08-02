#!/usr/bin/env bash
# WG-PLAT-018 read-lane snapshot/restore/verify unit tests.  Sources the helper
# directly (like backup_dark_test.sh) and exercises capture, TRANSACTIONAL
# restore (single rollback handler), the semantic --check, and terminal
# verification for BOTH read-lane files.
#
# NOTE: sourcing read-lane-snapshot.sh enables `set -e`.  Every subject below is
# invoked through report helpers that run it inside an `if` condition, which
# suspends errexit for that command, so an EXPECTED failure never terminates the
# suite before the final summary.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

export READ_BROKER_INSTALL="${TMP}/lib/github-read-broker.py"
export READ_TOOL_INSTALL="${TMP}/lib/tools/github-read-tool.mjs"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/read-lane-snapshot.sh"   # turns on `set -e`

pass=0; fail=0
_report() { if [[ "$2" -eq 0 ]]; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1" >&2; fail=$((fail+1)); fi; }
exp_ok()   { local d="$1"; shift; if "$@" >/dev/null 2>&1; then _report "${d}" 0; else _report "${d}" 1; fi; }
exp_fail() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then _report "${d}" 1; else _report "${d}" 0; fi; }
assert()   { local d="$1" expr="$2"; if eval "${expr}"; then _report "${d}" 0; else _report "${d}" 1; fi; }

put() { rm -f "$1"; printf '%s\n' "$2" >"$1"; chmod 0555 "$1"; }   # install-like replace
mkinstall() { mkdir -p "${TMP}/lib/tools"; }

# --- PRESENT-pair: both old versions restored + hash/mode verified ----------
stage="${TMP}/present"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "OLD BROKER v1"
put "${READ_TOOL_INSTALL}" "OLD TOOL v1"
broker_old_hash="$(sha256sum "${READ_BROKER_INSTALL}" | awk '{print $1}')"
my_uid="$(id -u)"
exp_ok "present capture succeeds" capture_read_lane_snapshot "${stage}"
assert "present manifest records broker present+mode555+owner" \
  "grep -Eq 'github-read-broker.py\tpresent\tsha256:[0-9a-f]{64}\tmode:555\towner:${my_uid}:[0-9]+' '${stage}/read-lane.manifest'"
put "${READ_BROKER_INSTALL}" "NEW BROKER v2 different length"
put "${READ_TOOL_INSTALL}" "NEW TOOL v2 different length"
exp_ok "present-pair restore succeeds" restore_read_lane_snapshot "${stage}"
assert "present-pair broker restored to old bytes" "[[ \"\$(cat '${READ_BROKER_INSTALL}')\" == 'OLD BROKER v1' ]]"
assert "present-pair tool restored to old bytes" "[[ \"\$(cat '${READ_TOOL_INSTALL}')\" == 'OLD TOOL v1' ]]"
assert "present-pair broker hash == recorded old hash" \
  "[[ \"\$(sha256sum '${READ_BROKER_INSTALL}' | awk '{print \$1}')\" == '${broker_old_hash}' ]]"
assert "present-pair restored mode is 0555" \
  "[[ \"\$(python3 -c 'import os,sys;print(oct(os.stat(sys.argv[1]).st_mode&0o777)[2:])' '${READ_BROKER_INSTALL}')\" == '555' ]]"
exp_ok "verify present-pair passes" verify_read_lane_restored "${stage}"
exp_ok "check present-pair passes" check_read_lane_snapshot "${stage}"

# --- ABSENT-pair: both removed + verified absent ----------------------------
stage="${TMP}/absent"; mkdir -p "${stage}"; mkinstall
rm -f "${READ_BROKER_INSTALL}" "${READ_TOOL_INSTALL}"
exp_ok "absent capture succeeds" capture_read_lane_snapshot "${stage}"
assert "absent manifest broker" "grep -Eq 'github-read-broker.py\tabsent\t-' '${stage}/read-lane.manifest'"
assert "absent manifest tool" "grep -Eq 'github-read-tool.mjs\tabsent\t-' '${stage}/read-lane.manifest'"
put "${READ_BROKER_INSTALL}" "NEW BROKER installed"
put "${READ_TOOL_INSTALL}" "NEW TOOL installed"
exp_ok "absent-pair restore succeeds" restore_read_lane_snapshot "${stage}"
assert "absent-pair removed both" "[[ ! -e '${READ_BROKER_INSTALL}' && ! -e '${READ_TOOL_INSTALL}' ]]"
exp_ok "verify absent-pair passes" verify_read_lane_restored "${stage}"

# --- ONE-ROW manifest -> restore FAILS, BOTH targets untouched --------------
stage="${TMP}/onerow"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "STILL NEW B"
put "${READ_TOOL_INSTALL}" "STILL NEW T"
printf 'github-read-broker.py\tabsent\t-\n' >"${stage}/read-lane.manifest"
exp_fail "one-row manifest -> restore fails" restore_read_lane_snapshot "${stage}"
assert "one-row manifest -> broker untouched" "[[ \"\$(cat '${READ_BROKER_INSTALL}')\" == 'STILL NEW B' ]]"
assert "one-row manifest -> tool untouched" "[[ \"\$(cat '${READ_TOOL_INSTALL}')\" == 'STILL NEW T' ]]"

# --- DUPLICATE / UNKNOWN / MALFORMED manifests fail closed ------------------
declare -a bad_manifests=(
  'github-read-broker.py\tabsent\t-\ngithub-read-broker.py\tabsent\t-'
  'github-read-broker.py\tabsent\t-\ngithub-read-tool.mjs\tabsent\t-\nstranger\tabsent\t-'
  'github-read-broker.py\tpresent\tsha256:zz\tmode:555\towner:0:0\ngithub-read-tool.mjs\tabsent\t-'
  'github-read-broker.py\tpresent\tsha256:'"$(printf 'a%.0s' {1..64})"'\tmode:777\towner:0:0\ngithub-read-tool.mjs\tabsent\t-'
  'github-read-broker.py\tabsent\t-\textra\ngithub-read-tool.mjs\tabsent\t-'
)
i=0
for bad in "${bad_manifests[@]}"; do
  i=$((i+1)); stage="${TMP}/bad${i}"; mkdir -p "${stage}"
  printf "${bad}\n" >"${stage}/read-lane.manifest"
  exp_fail "malformed manifest #${i} rejected by restore" restore_read_lane_snapshot "${stage}"
done

# --- MISSING manifest in a governed dir -> restore + verify FAIL ------------
stage="${TMP}/nomani"; mkdir -p "${stage}"
exp_fail "missing manifest -> restore fails" restore_read_lane_snapshot "${stage}"
exp_fail "governed dir missing manifest -> verify fails" verify_read_lane_restored "${stage}"

# --- SYMLINK vs NON-REGULAR install path on capture (exercised separately) --
stage="${TMP}/sym"; mkdir -p "${stage}"; mkinstall
rm -f "${READ_BROKER_INSTALL}"; ln -s /etc/hosts "${READ_BROKER_INSTALL}"
exp_fail "symlink at install path -> capture fails" capture_read_lane_snapshot "${stage}"
rm -f "${READ_BROKER_INSTALL}"
stage="${TMP}/nonreg"; mkdir -p "${stage}"; mkinstall
rm -f "${READ_BROKER_INSTALL}"; mkdir "${READ_BROKER_INSTALL}"   # a directory: non-regular
exp_fail "non-regular install path -> capture fails" capture_read_lane_snapshot "${stage}"
rmdir "${READ_BROKER_INSTALL}"

# --- PHASE-1 preflight: bad SECOND snapshot -> no target mutated -------------
stage="${TMP}/preflight"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "ORIG B"; put "${READ_TOOL_INSTALL}" "ORIG T"
exp_ok "preflight capture succeeds" capture_read_lane_snapshot "${stage}"
chmod 0644 "${stage}/read-lane.github-read-tool.mjs.before"
printf 'CORRUPT' >"${stage}/read-lane.github-read-tool.mjs.before"
put "${READ_BROKER_INSTALL}" "NEW B"; put "${READ_TOOL_INSTALL}" "NEW T"
exp_fail "bad second snapshot -> restore fails (phase 1)" restore_read_lane_snapshot "${stage}"
assert "phase-1 fail -> broker NOT mutated" "[[ \"\$(cat '${READ_BROKER_INSTALL}')\" == 'NEW B' ]]"
assert "phase-1 fail -> tool NOT mutated" "[[ \"\$(cat '${READ_TOOL_INSTALL}')\" == 'NEW T' ]]"
assert "phase-1 fail -> no leaked staging temp" \
  "[[ -z \"\$(ls -A '${TMP}/lib' '${TMP}/lib/tools' 2>/dev/null | grep -F read-lane || true)\" ]]"

# --- PHASE-2 later-op failure AFTER first target mutated -> rollback ---------
# Shadow `mv` so the SECOND (tool) apply fails only after the FIRST (broker)
# target has already been renamed.  The single rollback handler must restore the
# broker -> no mixed pair.
stage="${TMP}/phase2"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "OLD B2"; put "${READ_TOOL_INSTALL}" "OLD T2"
exp_ok "phase2 capture succeeds" capture_read_lane_snapshot "${stage}"
put "${READ_BROKER_INSTALL}" "NEW B2"; put "${READ_TOOL_INSTALL}" "NEW T2"
mv() { local dst="${@: -1}"; if [[ "${dst}" == "${READ_TOOL_INSTALL}" ]]; then return 1; fi; command mv "$@"; }
exp_fail "phase-2 later mv fails -> restore fails" restore_read_lane_snapshot "${stage}"
unset -f mv
assert "phase-2 rollback -> broker restored to pre-restore (NEW B2), not mixed" \
  "[[ \"\$(cat '${READ_BROKER_INSTALL}')\" == 'NEW B2' ]]"
assert "phase-2 rollback -> tool untouched (NEW T2)" \
  "[[ \"\$(cat '${READ_TOOL_INSTALL}')\" == 'NEW T2' ]]"
assert "phase-2 rollback -> no leaked temp" \
  "[[ -z \"\$(ls -A '${TMP}/lib' '${TMP}/lib/tools' 2>/dev/null | grep -F read-lane || true)\" ]]"

# --- MIXED-VERSION terminal state -> verify FAILS ---------------------------
stage="${TMP}/mixed"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "OLD B"; put "${READ_TOOL_INSTALL}" "OLD T"
exp_ok "mixed capture succeeds" capture_read_lane_snapshot "${stage}"
put "${READ_TOOL_INSTALL}" "NEW T only"   # broker old, tool new -> mixed
exp_fail "mixed-version terminal -> verify fails" verify_read_lane_restored "${stage}"

# --- WRONG MODE terminal state -> verify FAILS ------------------------------
stage="${TMP}/mode"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "MB"; put "${READ_TOOL_INSTALL}" "MT"
exp_ok "mode capture succeeds" capture_read_lane_snapshot "${stage}"
chmod 0755 "${READ_BROKER_INSTALL}"
exp_fail "wrong-mode terminal -> verify fails" verify_read_lane_restored "${stage}"
chmod 0555 "${READ_BROKER_INSTALL}"

# --- EMPTY stat evidence -> verify FAILS (stat/python3 failure not tolerated) -
stage="${TMP}/statfail"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "SB"; put "${READ_TOOL_INSTALL}" "ST"
exp_ok "statfail capture succeeds" capture_read_lane_snapshot "${stage}"
python3() { return 1; }   # force _read_lane_mode/_read_lane_owner to return empty
exp_fail "empty stat evidence -> verify fails" verify_read_lane_restored "${stage}"
unset -f python3

# --- --check: SHA256SUMS-clean but WRONG recorded hash -> --check FAILS ------
stage="${TMP}/checkbad"; mkdir -p "${stage}"; mkinstall
put "${READ_BROKER_INSTALL}" "CB"; put "${READ_TOOL_INSTALL}" "CT"
exp_ok "checkbad capture succeeds" capture_read_lane_snapshot "${stage}"
# Tamper ONLY the recorded broker hash to another valid-format (but wrong) value.
chmod 0644 "${stage}/read-lane.manifest"
sed -E "s#(github-read-broker.py\tpresent\tsha256:)[0-9a-f]{64}#\1$(printf 'f%.0s' {1..64})#" \
  "${stage}/read-lane.manifest" >"${stage}/read-lane.manifest.new"
mv -f "${stage}/read-lane.manifest.new" "${stage}/read-lane.manifest"
exp_fail "check: recorded hash != snapshot bytes -> --check fails" check_read_lane_snapshot "${stage}"

echo "read_lane_snapshot_test: pass=${pass} fail=${fail}"
[[ ${fail} -eq 0 ]]
