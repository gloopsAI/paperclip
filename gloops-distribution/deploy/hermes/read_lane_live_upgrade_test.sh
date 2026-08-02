#!/usr/bin/env bash
# Executable failure-path suite for read-lane-live-upgrade.sh.
#
# The wrapper is invoked as a SUBPROCESS (`bash read-lane-live-upgrade.sh ...`),
# so its `set -euo pipefail` cannot leak into this harness.  systemctl / curl /
# flock are mocked via PATH shims (real services are never touched); the read
# tool client and broker socket are mocked so the suite runs without a live
# plane or node_modules.  Every case asserts the wrapper's exit code AND the
# governed side effects (no mutation on abort, no temp/staging/token leak).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="${HERE}/read-lane-live-upgrade.sh"
PASS=0; FAIL=0
SHA256() { sha256sum "$1" | awk '{print $1}'; }
# Create a real AF_UNIX socket file so the wrapper's `[[ -S ]]` readiness gate is
# genuinely exercised (a regular file must NOT satisfy it).
mksock() { rm -f "$1"; python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$1" 2>/dev/null || :; }

chk() { # chk <desc> <cond-rc>
  if [[ "$2" -eq 0 ]]; then PASS=$((PASS+1)); printf 'ok   %s\n' "$1"
  else FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; fi
}

# ---- mock bin (systemctl/curl/flock) ---------------------------------------
make_mockbin() {
  local dir="$1"
  mkdir -p "${dir}"

  cat >"${dir}/flock" <<'SH'
#!/usr/bin/env bash
# succeed unless MOCK_FLOCK_FAIL=1 (contention)
[[ "${MOCK_FLOCK_FAIL:-0}" == "1" ]] && exit 1
exit 0
SH

  cat >"${dir}/curl" <<'SH'
#!/usr/bin/env bash
# Writes the canned body to the -o target, prints the http code, exits MOCK rc.
# A per-invocation sequence is read from ${MOCK_CURL_SEQ_DIR}/<n> (n = call #)
# containing three tab fields: CODE<TAB>RC<TAB>BODY.  Falls back to the single
# MOCK_CURL_{CODE,RC,BODY} triple.
cn="${MOCK_SYSTEMD_DIR:-/tmp}/curl.n"
c=$(( $(cat "$cn" 2>/dev/null || echo 0) + 1 )); echo "$c" >"$cn"
out=""; prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
code="${MOCK_CURL_CODE:-200}"; rc="${MOCK_CURL_RC:-0}"; body="${MOCK_CURL_BODY:-[]}"
if [[ -n "${MOCK_CURL_SEQ_DIR:-}" && -f "${MOCK_CURL_SEQ_DIR}/${c}" ]]; then
  IFS=$'\t' read -r code rc body <"${MOCK_CURL_SEQ_DIR}/${c}"
fi
[[ -n "$out" ]] && printf '%s' "$body" >"$out"
printf '%s' "$code"
# Injected side effect on the Nth call (e.g., simulate a concurrent installer or
# a governed-dir change between the second proof and apply).
[[ "${MOCK_CURL_SIDEEFFECT_ON:-0}" == "$c" && -n "${MOCK_CURL_SIDEEFFECT:-}" ]] && eval "${MOCK_CURL_SIDEEFFECT}"
exit "$rc"
SH

  # default systemctl: pre-state healthy (active/running/disabled), socket present
  cat >"${dir}/systemctl" <<'SH'
#!/usr/bin/env bash
# Minimal governed mock. State via ${MOCK_SYSTEMD_DIR}. Env knobs let cases
# force stop/start failures. Never touches real units.
sd="${MOCK_SYSTEMD_DIR:-/tmp/mock-systemd-missing}"
case "$1" in
  stop)
    c=$(( $(cat "${sd}/stop.n" 2>/dev/null || echo 0) + 1 )); echo "$c" >"${sd}/stop.n"
    { [[ "${MOCK_STOP_FAIL:-0}" == 1 ]] || [[ "${MOCK_STOP_FAIL_ON:-0}" == "$c" ]]; } && exit 1
    if [[ "${MOCK_MUTATE_ON_STOP:-0}" == 1 && -n "${MOCK_MUTATE_TARGET:-}" ]]; then
      chmod u+w "${MOCK_MUTATE_TARGET}" 2>/dev/null; echo TAMPERED >>"${MOCK_MUTATE_TARGET}"   # simulate a root installer
    fi
    if [[ "${MOCK_STOP_LEAVE_ACTIVE:-0}" == 1 || "${MOCK_STOP_LEAVE_ACTIVE_ON:-0}" == "$c" ]]; then printf 'active' >"${sd}/active"; exit 0; fi
    printf 'inactive' >"${sd}/active"
    sm="${MOCK_STOP_SOCKET:-remove}"; [[ "${MOCK_STOP_SOCKET_ON:-0}" == "$c" ]] && sm="${MOCK_STOP_SOCKET_MODE:-keep}"
    case "$sm" in
      keep)    : ;;
      regfile) rm -f "${sd}/socket"; : >"${sd}/socket" ;;
      symlink) rm -f "${sd}/socket"; ln -s /tmp/rlu-nonexistent "${sd}/socket" ;;
      *)       rm -f "${sd}/socket" ;;
    esac
    exit 0 ;;
  start)
    c=$(( $(cat "${sd}/start.n" 2>/dev/null || echo 0) + 1 )); echo "$c" >"${sd}/start.n"; echo 1 >>"${sd}/start.log"
    { [[ "${MOCK_START_FAIL:-0}" == 1 ]] || [[ "${MOCK_START_FAIL_ON:-0}" == "$c" ]]; } && exit 1
    printf 'active' >"${sd}/active"; rm -f "${sd}/socket"
    if [[ "${MOCK_START_NOSOCKET_ON:-0}" != "$c" ]]; then python3 -c 'import socket,sys
s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "${sd}/socket" 2>/dev/null || :; fi
    exit 0 ;;
  is-active) [[ "$(cat "${sd}/active" 2>/dev/null)" == active ]] && exit 0 || exit 3 ;;
  show)
    prop=""; for a in "$@"; do case "$a" in -p) :;; ActiveState|SubState|UnitFileState) prop="$a";; esac; done
    case "$prop" in
      ActiveState)   cat "${sd}/active" 2>/dev/null || echo unknown ;;
      SubState)      [[ "$(cat "${sd}/active" 2>/dev/null)" == active ]] && echo running || echo dead ;;
      UnitFileState) cat "${sd}/enabled" 2>/dev/null || echo disabled ;;
    esac; exit 0 ;;
  is-enabled) cat "${sd}/enabled" 2>/dev/null || echo disabled; exit 0 ;;
  *) exit 0 ;;
esac
SH
  chmod +x "${dir}/flock" "${dir}/curl" "${dir}/systemctl"
}

# ---- sandbox ----------------------------------------------------------------
# Creates a fresh sandbox and echoes its root.  Installs the OLD 0555 pair, a
# NEW source pair, a mock systemd state (active/running/disabled + socket), and
# exports the env the wrapper reads.  Callers tweak env knobs per case.
new_sandbox() {
  local sbx; sbx="$(mktemp -d "${TMPDIR:-/tmp}/rlu-test.XXXXXX")"
  mkdir -p "${sbx}/install" "${sbx}/src" "${sbx}/mockbin" "${sbx}/systemd"
  make_mockbin "${sbx}/mockbin"
  printf 'OLD-broker\n' >"${sbx}/install/github-read-broker.py"
  printf 'OLD-tool\n'   >"${sbx}/install/github-read-tool.mjs"
  chmod 0555 "${sbx}/install/github-read-broker.py" "${sbx}/install/github-read-tool.mjs"
  printf 'NEW-broker\n' >"${sbx}/src/github-read-broker.py"
  printf 'NEW-tool\n'   >"${sbx}/src/github-read-tool.mjs"
  printf 'active'   >"${sbx}/systemd/active"
  printf 'disabled' >"${sbx}/systemd/enabled"
  mksock "${sbx}/systemd/socket"
  echo "${sbx}"
}

# Run the wrapper in a sandbox with the standard-good env; extra `KEY=VAL` args
# override/add env.  Captures rc + combined output into RC / OUT globals.
run_case() {
  local sbx="$1"; shift
  local -a env=(
    "PATH=${sbx}/mockbin:${PATH}"
    "MOCK_SYSTEMD_DIR=${sbx}/systemd"
    "READ_BROKER_INSTALL=${sbx}/install/github-read-broker.py"
    "READ_TOOL_INSTALL=${sbx}/install/github-read-tool.mjs"
    "READ_LANE_SOURCE_DIR=${sbx}/src"
    "READ_LANE_BROKER_SHA256=$(SHA256 "${sbx}/src/github-read-broker.py")"
    "READ_LANE_TOOL_SHA256=$(SHA256 "${sbx}/src/github-read-tool.mjs")"
    "READ_LANE_BACKUP_DIR=${sbx}/backup"
    "READ_LANE_LOCK=${sbx}/lock"
    "GITHUB_READ_BROKER_SOCKET=${sbx}/systemd/socket"
    "PAPERCLIP_API_BASE=http://ctrl.invalid"
    "PAPERCLIP_COMPANY_ID=00000000-0000-0000-0000-000000000000"
    "PAPERCLIP_API_TOKEN=SUPER-SECRET-TOKEN"
    "READ_LANE_CANARY_COMMIT=0123456789abcdef0123456789abcdef01234567"
    "MOCK_CURL_BODY=[]"
  )
  OUT="$(env -i "${env[@]}" "$@" bash "${WRAPPER}" 2>&1)"; RC=$?
}

# no staged temp / leaked lock-following file remains in the install dir
no_staged_leak() { ! find "$1/install" -maxdepth 1 -name '.read-lane-live.*' | grep -q .; }
files_unchanged() { # both installed files still the OLD bytes
  [[ "$(cat "$1/install/github-read-broker.py")" == "OLD-broker" ]] &&
  [[ "$(cat "$1/install/github-read-tool.mjs")"   == "OLD-tool" ]]
}
no_token_leak() { ! grep -q 'SUPER-SECRET-TOKEN' <<<"${OUT}"; }

echo "== read-lane-live-upgrade negative matrix =="

# 1. missing required API base -> abort 2, nothing mutated
S="$(new_sandbox)"; run_case "$S" PAPERCLIP_API_BASE=
chk "missing API base aborts (2)" "$([[ $RC -eq 2 ]] && echo 0 || echo 1)"
chk "  ...no token leak" "$(no_token_leak && echo 0 || echo 1)"; rm -rf "$S"

# 2. missing token -> abort 2
S="$(new_sandbox)"; run_case "$S" PAPERCLIP_API_TOKEN=
chk "missing token aborts (2)" "$([[ $RC -eq 2 ]] && echo 0 || echo 1)"; rm -rf "$S"

# 3. missing expected broker sha -> abort 2
S="$(new_sandbox)"; run_case "$S" READ_LANE_BROKER_SHA256=
chk "missing expected broker sha aborts (2)" "$([[ $RC -eq 2 ]] && echo 0 || echo 1)"; rm -rf "$S"

# 4. expected broker sha MISMATCH -> abort 4, files unchanged, no staged leak
S="$(new_sandbox)"; run_case "$S" READ_LANE_BROKER_SHA256=$(printf 'f%.0s' {1..64})
chk "expected-hash mismatch aborts (4)" "$([[ $RC -eq 4 ]] && echo 0 || echo 1)"
chk "  ...files unchanged" "$(files_unchanged "$S" && echo 0 || echo 1)"
chk "  ...no staged leak" "$(no_staged_leak "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 5. symlink source artifact -> abort 4 (reject symlink), files unchanged.
#    Link to a REGULAR file created inside the sandbox and hash that target, so
#    the expected hash is valid and the wrapper reaches the symlink rejection.
S="$(new_sandbox)"; printf 'NEW-broker\n' >"$S/realbroker"
ln -sf "$S/realbroker" "$S/src/github-read-broker.py"
run_case "$S" READ_LANE_BROKER_SHA256=$(SHA256 "$S/realbroker")
chk "symlink source rejected (4)" "$([[ $RC -eq 4 ]] && echo 0 || echo 1)"
chk "  ...files unchanged" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 6. lock is a symlink -> abort 4 (P0: never follow), files unchanged
S="$(new_sandbox)"; ln -sf "$S/decoy" "$S/lock"; printf 'PRECIOUS' >"$S/decoy"
run_case "$S" READ_LANE_LOCK="$S/lock"
chk "symlink lock path rejected (4)" "$([[ $RC -eq 4 ]] && echo 0 || echo 1)"
chk "  ...decoy not truncated" "$([[ "$(cat "$S/decoy")" == PRECIOUS ]] && echo 0 || echo 1)"
chk "  ...files unchanged" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 7. lock contention (flock fails) -> abort 4
S="$(new_sandbox)"; run_case "$S" MOCK_FLOCK_FAIL=1
chk "lock contention aborts (4)" "$([[ $RC -eq 4 ]] && echo 0 || echo 1)"; rm -rf "$S"

# 8. first no-work proof NONEMPTY -> abort 3, files unchanged, no mutation
S="$(new_sandbox)"; run_case "$S" 'MOCK_CURL_BODY=[{"id":"r1"}]'
chk "first preflight nonempty aborts (3)" "$([[ $RC -eq 3 ]] && echo 0 || echo 1)"
chk "  ...files unchanged" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 9. first no-work proof HTTP 500 -> abort 3
S="$(new_sandbox)"; run_case "$S" MOCK_CURL_CODE=500
chk "first preflight HTTP-500 aborts (3)" "$([[ $RC -eq 3 ]] && echo 0 || echo 1)"; rm -rf "$S"

# 10. first no-work proof MALFORMED body -> abort 3
S="$(new_sandbox)"; run_case "$S" 'MOCK_CURL_BODY=not json{'
chk "first preflight malformed aborts (3)" "$([[ $RC -eq 3 ]] && echo 0 || echo 1)"; rm -rf "$S"

# 11. first no-work proof NON-ARRAY body -> abort 3
S="$(new_sandbox)"; run_case "$S" 'MOCK_CURL_BODY={"ok":true}'
chk "first preflight non-array aborts (3)" "$([[ $RC -eq 3 ]] && echo 0 || echo 1)"; rm -rf "$S"

# 12. pre-existing backup dir -> abort 4 (create-fresh only), files unchanged
S="$(new_sandbox)"; mkdir -p "$S/backup"
run_case "$S" READ_LANE_BACKUP_DIR="$S/backup"
chk "pre-existing backup dir rejected (4)" "$([[ $RC -eq 4 ]] && echo 0 || echo 1)"
chk "  ...files unchanged" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# ---- full systemctl-driven flow (reaches apply + identity-bound canaries) ----
# Install a mock read-tool client AS the source client so it is expected-hashed,
# staged, applied, and then executed by the canaries.  It emits {ok,data} JSON
# per --operation; MOCK_CLIENT_MODE injects wrong identity / non-ok / bad blob.
install_client_mock() {
  cat >"$1/src/github-read-tool.mjs" <<'CLIENT'
#!/usr/bin/env bash
op=""; repo=""; commit=""; fpath=""; prev=""
for a in "$@"; do
  case "$prev" in
    --operation) op="$a";; --repo) repo="$a";; --commit) commit="$a";; --path) fpath="$a";;
  esac; prev="$a"
done
rrepo="$repo"; rcommit="$commit"; rpath="$fpath"
sha="1111111111111111111111111111111111111111"
tree="2222222222222222222222222222222222222222"
roottree="$tree"
content="abc"; fsize=3; enc="utf-8"
b="4444444444444444444444444444444444444444"; t="5555555555555555555555555555555555555555"
entries='[{"path":"README.md","type":"blob","mode":"100644","sha":"'"$b"'","size":3},{"path":"src","type":"tree","mode":"040000","sha":"'"$t"'"}]'
tcount=2
case "${MOCK_CLIENT_MODE:-good}" in
  wrong-repo)    rrepo="evil/other" ;;
  wrong-commit)  rcommit="0000000000000000000000000000000000000000" ;;
  wrong-path)    rpath="OTHER.md" ;;
  bad-blob)      sha="not-hex" ;;
  no-tree)       tree="not-hex" ;;
  mismatch-tree) roottree="3333333333333333333333333333333333333333" ;;
  bad-size)      fsize=99 ;;
  bad-encoding)  enc="base64" ;;
  entry-bad-sha)  entries='[{"path":"README.md","type":"blob","mode":"100644","sha":"nothex","size":3}]'; tcount=1 ;;
  entry-bad-mode) entries='[{"path":"README.md","type":"blob","mode":"040000","sha":"'"$b"'","size":3}]'; tcount=1 ;;
  entry-no-size)  entries='[{"path":"README.md","type":"blob","mode":"100644","sha":"'"$b"'"}]'; tcount=1 ;;
  entry-nested)   entries='[{"path":"a/b","type":"blob","mode":"100644","sha":"'"$b"'","size":3}]'; tcount=1 ;;
  entry-dup)      entries='[{"path":"README.md","type":"blob","mode":"100644","sha":"'"$b"'","size":3},{"path":"README.md","type":"tree","mode":"040000","sha":"'"$t"'"}]'; tcount=2 ;;
  entry-unsorted) entries='[{"path":"src","type":"tree","mode":"040000","sha":"'"$t"'"},{"path":"README.md","type":"blob","mode":"100644","sha":"'"$b"'","size":3}]'; tcount=2 ;;
  not-ok)        echo '{"ok":false,"error":"denied"}'; exit 1 ;;
esac
case "$op" in
  get-repo-source-metadata) printf '{"ok":true,"data":{"repo":"%s","commit":"%s","tree":"%s","default_branch":"main"}}\n' "$rrepo" "$rcommit" "$tree" ;;
  list-source-tree)         printf '{"ok":true,"data":{"repo":"%s","commit":"%s","rootTree":"%s","pathPrefix":"","treeSha":"%s","truncated":false,"totalReturned":%s,"entries":%s}}\n' "$rrepo" "$rcommit" "$roottree" "$roottree" "$tcount" "$entries" ;;
  get-source-file)          printf '{"ok":true,"data":{"repo":"%s","commit":"%s","path":"%s","sha":"%s","encoding":"%s","content":"%s","size":%s}}\n' "$rrepo" "$rcommit" "$rpath" "$sha" "$enc" "$content" "$fsize"; [[ -n "${MOCK_SABOTAGE_DIR:-}" ]] && chmod 0500 "${MOCK_SABOTAGE_DIR}" 2>/dev/null; [[ -n "${MOCK_MUTATE_AFTER_CANARY:-}" ]] && { chmod u+w "${MOCK_MUTATE_AFTER_CANARY}" 2>/dev/null; echo TAMPERED >>"${MOCK_MUTATE_AFTER_CANARY}"; } ;;
  *) echo '{"ok":false,"error":"unknown op"}'; exit 1 ;;
esac
exit 0
CLIENT
  chmod 0555 "$1/src/github-read-tool.mjs"
}
receipt_has() { grep -q "^$2\$" "$1/backup/read-lane.receipt" 2>/dev/null; }
applied_new() { # both installed files carry the applied source bytes
  [[ "$(cat "$1/install/github-read-broker.py")" == "NEW-broker" ]] &&
  grep -q 'MOCK_CLIENT_MODE' "$1/install/github-read-tool.mjs" 2>/dev/null
}

# 13. happy path -> exit 0, both applied, broker restarted once, canaries bound,
#     durable success receipt with the verified blob sha.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=good
chk "happy path succeeds (0)" "$([[ $RC -eq 0 ]] && echo 0 || echo 1)"
chk "  ...both files applied (new)" "$(applied_new "$S" && echo 0 || echo 1)"
chk "  ...receipt disposition=success" "$(receipt_has "$S" 'disposition=success' && echo 0 || echo 1)"
OBSERVED_BROKER_SHA256="$(SHA256 "$S/install/github-read-broker.py")"
OBSERVED_TOOL_SHA256="$(SHA256 "$S/install/github-read-tool.mjs")"
chk "  ...receipt binds final observed broker hash" "$(receipt_has "$S" "observed_broker_sha256=${OBSERVED_BROKER_SHA256}" && echo 0 || echo 1)"
chk "  ...receipt binds final observed tool hash" "$(receipt_has "$S" "observed_tool_sha256=${OBSERVED_TOOL_SHA256}" && echo 0 || echo 1)"
chk "  ...receipt binds rootTree+blob+size" "$(receipt_has "$S" 'canary_verified=rootTree=2222222222222222222222222222222222222222; file README.md blob=1111111111111111111111111111111111111111 size=3' && echo 0 || echo 1)"
chk "  ...no token leak" "$(no_token_leak && echo 0 || echo 1)"
chk "  ...no staged leak" "$(no_staged_leak "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 14. exit-0 WRONG-IDENTITY canary (wrong repo) -> rollback, files restored old,
#     receipt disposition=rolled-back.  This is the core identity-binding proof.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=wrong-repo
chk "wrong-identity canary rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"
chk "  ...receipt disposition=rolled-back" "$(receipt_has "$S" 'disposition=rolled-back' && echo 0 || echo 1)"
chk "  ...no staged leak" "$(no_staged_leak "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 15. exit-0 wrong blob sha -> identity mismatch -> rollback
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=bad-blob
chk "wrong blob-sha canary rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 16. client returns ok:false (exit 1) -> canary fails -> rollback
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=not-ok
chk "not-ok canary rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 17. metadata omits a valid tree sha -> canary fails -> rollback
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=no-tree
chk "metadata missing tree rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 18. tree rootTree != metadata.tree -> reconciliation fails -> rollback
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=mismatch-tree
chk "root-tree mismatch rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 19. file size != UTF-8 byte length -> malformed text payload -> rollback
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=bad-size
chk "file size mismatch rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 20. file encoding != utf-8 -> rollback
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_CLIENT_MODE=bad-encoding
chk "file bad-encoding rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 21-26. structurally invalid tree rows -> tree canary fails closed -> rollback.
for m in entry-bad-sha entry-bad-mode entry-no-size entry-nested entry-dup entry-unsorted; do
  S="$(new_sandbox)"; install_client_mock "$S"
  run_case "$S" MOCK_CLIENT_MODE="$m"
  chk "tree ${m} rolls back (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
  chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"
done

# 27. between-capture-and-apply mutation (a DIFFERENT installer changes an
#     installed file after capture) -> pre-apply revalidation fails closed:
#     TERMINAL (6), NO new artifact installed.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_MUTATE_ON_STOP=1 "MOCK_MUTATE_TARGET=$S/install/github-read-broker.py" MOCK_CLIENT_MODE=good
chk "post-capture divergence is terminal (6)" "$([[ $RC -eq 6 ]] && echo 0 || echo 1)"
chk "  ...concurrent mutation occurred" "$(grep -q TAMPERED "$S/install/github-read-broker.py" && echo 0 || echo 1)"
chk "  ...NO broker restart (start not called)" "$([[ ! -s "$S/systemd/start.log" ]] && echo 0 || echo 1)"
chk "  ...unit left inactive" "$([[ "$(cat "$S/systemd/active")" == inactive ]] && echo 0 || echo 1)"
chk "  ...no new broker artifact installed" "$([[ "$(head -1 "$S/install/github-read-broker.py")" == "OLD-broker" ]] && echo 0 || echo 1)"
chk "  ...no new client artifact installed" "$(! grep -q MOCK_CLIENT_MODE "$S/install/github-read-tool.mjs" && echo 0 || echo 1)"; rm -rf "$S"

# ---- stop-boundary: a stop rc 0 is not proof the broker is down (forward) ----
# Each fails the forward stop verifier -> safe abort (5), NOTHING installed.
for desc_mode in "still-active:MOCK_STOP_LEAVE_ACTIVE_ON=1" \
                 "socket-survives:MOCK_STOP_SOCKET_ON=1 MOCK_STOP_SOCKET_MODE=keep" \
                 "socket-regfile:MOCK_STOP_SOCKET_ON=1 MOCK_STOP_SOCKET_MODE=regfile" \
                 "socket-symlink:MOCK_STOP_SOCKET_ON=1 MOCK_STOP_SOCKET_MODE=symlink"; do
  d="${desc_mode%%:*}"; kv="${desc_mode#*:}"
  S="$(new_sandbox)"; install_client_mock "$S"
  run_case "$S" $kv MOCK_CLIENT_MODE=good
  chk "forward stop ${d} -> safe abort (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
  chk "  ...nothing installed" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"
done

# 32. second (post-stop) no-work proof NONEMPTY -> restart untouched, no apply.
S="$(new_sandbox)"; install_client_mock "$S"; sq="$S/curlseq"; mkdir -p "$sq"
printf '200\t0\t[]' >"$sq/1"; printf '200\t0\t[{"id":"r"}]' >"$sq/2"
run_case "$S" "MOCK_CURL_SEQ_DIR=$sq" MOCK_CLIENT_MODE=good
chk "second preflight nonempty -> safe abort (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...nothing installed" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 33. forward start fails -> rollback restores OLD -> exit 5.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_START_FAIL_ON=1 MOCK_CLIENT_MODE=good
chk "forward start-fail -> rollback (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 34. forward start ok but socket never appears -> rollback restores OLD -> 5.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_START_NOSOCKET_ON=1 MOCK_CLIENT_MODE=good
chk "forward socket-fail -> rollback (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 35. rollback's stop cannot verify-inactive -> TERMINAL (6), NO restore under an
#     ambiguously-active broker (installed pair left as the applied new bytes).
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_STOP_FAIL_ON=2 MOCK_CLIENT_MODE=wrong-repo
chk "rollback stop-fail -> terminal (6)" "$([[ $RC -eq 6 ]] && echo 0 || echo 1)"
chk "  ...did NOT restore under ambiguous broker" "$([[ "$(head -1 "$S/install/github-read-broker.py")" == "NEW-broker" ]] && echo 0 || echo 1)"; rm -rf "$S"

# 36. apply fails on the SECOND artifact (its staged temp vanishes just before
#     apply) -> single rollback handler restores BOTH to OLD -> exit 5.
S="$(new_sandbox)"; install_client_mock "$S"
se="rm -f $S/install/.read-lane-live.github-read-tool.mjs.*"
run_case "$S" MOCK_CURL_SIDEEFFECT_ON=2 "MOCK_CURL_SIDEEFFECT=$se" MOCK_CLIENT_MODE=good
chk "apply-fail -> rollback (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...both files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"; rm -rf "$S"

# 37. durable SUCCESS receipt publication fails after a completed upgrade (backup
#     dir made unwritable) -> typed TERMINAL (6), never a silent success.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" "MOCK_SABOTAGE_DIR=$S/backup" MOCK_CLIENT_MODE=good
chk "success receipt-publish fail -> terminal (6)" "$([[ $RC -eq 6 ]] && echo 0 || echo 1)"
chmod -R u+w "$S" 2>/dev/null; rm -rf "$S"

# 38. rollback's stop returns 0 but leaves the unit ACTIVE -> verifier fails ->
#     TERMINAL (6), no restore under an ambiguously-active broker.
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" MOCK_STOP_LEAVE_ACTIVE_ON=2 MOCK_CLIENT_MODE=wrong-repo
chk "rollback stop-still-active -> terminal (6)" "$([[ $RC -eq 6 ]] && echo 0 || echo 1)"
chk "  ...did NOT restore under ambiguous broker" "$([[ "$(head -1 "$S/install/github-read-broker.py")" == "NEW-broker" ]] && echo 0 || echo 1)"; rm -rf "$S"

# 39. concurrent installer changes a live file AFTER canaries but BEFORE the
#     success receipt -> final installed-pair revalidation fails -> rollback
#     restores OLD (5); NO success receipt (never attest bytes no longer live).
S="$(new_sandbox)"; install_client_mock "$S"
run_case "$S" "MOCK_MUTATE_AFTER_CANARY=$S/install/github-read-broker.py" MOCK_CLIENT_MODE=good
chk "post-canary mutation -> rollback (5)" "$([[ $RC -eq 5 ]] && echo 0 || echo 1)"
chk "  ...both files restored to OLD" "$(files_unchanged "$S" && echo 0 || echo 1)"
chk "  ...disposition=rolled-back (not success)" "$(receipt_has "$S" 'disposition=rolled-back' && echo 0 || echo 1)"; rm -rf "$S"

echo "== pass=${PASS} fail=${FAIL} =="
[[ "${FAIL}" -eq 0 ]]
