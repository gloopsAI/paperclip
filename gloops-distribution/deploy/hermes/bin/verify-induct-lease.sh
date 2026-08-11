#!/usr/bin/env bash
# P3 — Verify Induct lease is usable for a thin product slice (hermes host).
# Not full monorepo CI — proves package manager + typecheck surface for agents.
set -euo pipefail
CWD="${1:-/opt/paperclip/hermes-execution-state/workspace/induct-main}"
SHA_EXPECT="${2:-}"

echo "=== verify-induct-lease ==="
echo "cwd=$CWD"
test -d "$CWD"
test -d "$CWD/.git"
HEAD=$(git -C "$CWD" rev-parse HEAD)
echo "HEAD=$HEAD"
if [[ -n "$SHA_EXPECT" ]]; then
  test "$HEAD" = "$SHA_EXPECT" || { echo "HEAD_MISMATCH expected=$SHA_EXPECT"; exit 2; }
fi
PORCELAIN=$(git -C "$CWD" status --porcelain)
if [[ -n "$PORCELAIN" ]]; then
  echo "DIRTY_TREE"; echo "$PORCELAIN" | head -20; exit 3
fi
# package.json present
test -f "$CWD/package.json"
# Prefer pnpm if lockfile
if [[ -f "$CWD/pnpm-lock.yaml" ]]; then
  echo "lock=pnpm"
elif [[ -f "$CWD/package-lock.json" ]]; then
  echo "lock=npm"
else
  echo "lock=unknown"
fi
# Lightweight structural checks agents can mirror
python3 - <<PY
import json, pathlib
p=pathlib.Path("$CWD")/ "package.json"
pkg=json.loads(p.read_text())
print("name=", pkg.get("name"))
print("scripts=", sorted((pkg.get("scripts") or {}).keys())[:20])
# monorepo workspaces hint
print("private=", pkg.get("private"))
print("packageManager=", pkg.get("packageManager"))
PY
# paperclip uid readable
if id paperclip &>/dev/null; then
  sudo -u paperclip -g paperclip test -r "$CWD/package.json"
  sudo -u paperclip -g paperclip git -C "$CWD" rev-parse HEAD >/dev/null
  echo "paperclip_read=ok"
fi
echo "VERIFY_INDUCT_LEASE_OK head=$HEAD"
echo "Agent verify recipe (from lease cwd):"
echo "  1) git status --porcelain  # empty"
echo "  2) git rev-parse HEAD      # match Exact head"
echo "  3) Prefer package scripts: typecheck / test:unit scoped — do NOT run full monorepo e2e unless packet says so"
echo "  4) Publish only through the registered root broker (requires a root-authorized Paperclip run):"
echo "     node /opt/data/bin/github-push-tool.bundle.cjs client --run-id \$PAPERCLIP_RUN_ID --repo-dir \$CWD"
