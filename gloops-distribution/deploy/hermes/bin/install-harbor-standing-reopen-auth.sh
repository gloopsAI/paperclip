#!/usr/bin/env bash
# Install standing Harbor campaign-reopen authorization.
#
# This is Zach's **one-time** standing delegation so Harbor can reopen campaigns
# without per-event phrase typing. Refuses without --confirm-standing-delegation.
#
# Usage:
#   install-harbor-standing-reopen-auth.sh --confirm-standing-delegation
#   install-harbor-standing-reopen-auth.sh --status
#   install-harbor-standing-reopen-auth.sh --dry-run
set -euo pipefail

CONFIRM=0
MODE=install

CAMPAIGN_DIR="${PAPERCLIP_CAMPAIGN_DEADMAN_DIR:-/var/lib/paperclip-gloops/campaign-deadman}"
DEST_DIR="${CAMPAIGN_DIR}/standing"
DEST="${HARBOR_REOPEN_STANDING_AUTH:-${DEST_DIR}/harbor-reopen-authorized.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_CANDIDATES=(
  "${SCRIPT_DIR}/../standing/harbor-reopen-authorized.example.json"
  "/usr/local/lib/paperclip-gloops/standing/harbor-reopen-authorized.example.json"
  "${SCRIPT_DIR}/harbor-reopen-authorized.example.json"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-standing-delegation) CONFIRM=1; shift ;;
    --status) MODE=status; shift ;;
    --dry-run) MODE=dry-run; shift ;;
    --dest) DEST="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

find_example() {
  local p
  for p in "${EXAMPLE_CANDIDATES[@]}"; do
    if [[ -f "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

EXAMPLE="$(find_example || true)"

if [[ "$MODE" == "status" ]]; then
  python3 - <<PY
import json, os
from pathlib import Path
dest = Path("$DEST")
ex = Path("$EXAMPLE") if "$EXAMPLE" else None
out = {
  "dest": str(dest),
  "destExists": dest.is_file(),
  "example": str(ex) if ex else None,
  "exampleExists": bool(ex and ex.is_file()),
}
if dest.is_file():
    try:
        data = json.loads(dest.read_text())
        out["authorized"] = data.get("authorized")
        out["authorizedBy"] = data.get("authorizedBy")
        out["authorizedAt"] = data.get("authorizedAt")
        out["maxAutoReopensPerDay"] = data.get("maxAutoReopensPerDay")
        out["phrase"] = data.get("phrase")
    except Exception as e:
        out["error"] = str(e)
print(json.dumps(out, indent=2, sort_keys=True))
PY
  exit 0
fi

if [[ -z "$EXAMPLE" || ! -f "$EXAMPLE" ]]; then
  echo "REFUSE: example standing auth template not found" >&2
  printf '  tried: %s\n' "${EXAMPLE_CANDIDATES[@]}" >&2
  exit 1
fi

if [[ "$MODE" == "dry-run" ]]; then
  echo "would install:"
  echo "  from: $EXAMPLE"
  echo "  to:   $DEST"
  echo "requires: --confirm-standing-delegation"
  cat "$EXAMPLE"
  exit 0
fi

if [[ "$CONFIRM" -ne 1 ]]; then
  echo "REFUSE: standing Harbor reopen auth is a one-time Zach delegation." >&2
  echo "Re-run with: $0 --confirm-standing-delegation" >&2
  echo "This installs authorized:true with phrase OPEN CAMPAIGN 24H under:" >&2
  echo "  $DEST" >&2
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "REFUSE: must run as root to install standing auth under $DEST_DIR" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
# Stamp authorizedAt at install time; keep phrase + bounds from example.
python3 - "$EXAMPLE" "$DEST" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path
src, dest = map(Path, sys.argv[1:3])
data = json.loads(src.read_text())
data["authorized"] = True
data["authorizedBy"] = data.get("authorizedBy") or "zach-standing-delegation"
data["phrase"] = data.get("phrase") or "OPEN CAMPAIGN 24H"
data["authorizedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
data["schemaVersion"] = data.get("schemaVersion") or "gloops.harbor-reopen-standing-auth.v1"
data.setdefault("maxAutoReopensPerDay", 2)
data["installedBy"] = "install-harbor-standing-reopen-auth.sh"
dest.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
print(f"installed standing Harbor reopen auth -> {dest}")
print(json.dumps(data, indent=2, sort_keys=True))
PY
chmod 0600 "$DEST"
chown root:root "$DEST"
echo "OK: Harbor may now reopen campaigns under maxAutoReopensPerDay without per-event Zach phrases."
