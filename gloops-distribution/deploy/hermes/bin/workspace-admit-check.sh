#!/usr/bin/env bash
# workspace-admit-check.sh — curl Paperclip workspace-admit preflight when base URL set.
# Optional helper for operators / plane steward (C1 surface + C5/C7 ops).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: workspace-admit-check.sh [--issue UUID] [--json FILE] [--base URL]

Calls the Paperclip workspace-admit preflight endpoint when PAPERCLIP_API_BASE
(or --base) is set. Prints JSON to stdout.

Env:
  PAPERCLIP_API_BASE   e.g. https://paperclip.example
  PAPERCLIP_API_TOKEN  optional bearer

Exit:
  0  HTTP success (admitted may still be false — read JSON)
  1  usage / missing config
  2  HTTP or curl failure
EOF
}

BASE="${PAPERCLIP_API_BASE:-}"
TOKEN="${PAPERCLIP_API_TOKEN:-}"
ISSUE=""
JSON_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) ISSUE="${2:-}"; shift 2 ;;
    --json) JSON_FILE="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$BASE" ]]; then
  echo '{"ok":false,"error":"PAPERCLIP_API_BASE or --base required"}' >&2
  exit 1
fi

BASE="${BASE%/}"
AUTH=()
if [[ -n "$TOKEN" ]]; then
  AUTH=(-H "Authorization: Bearer ${TOKEN}")
fi

# Prefer issue UUID path; fall back to POST body from file.
if [[ -n "$ISSUE" ]]; then
  # Try common route shapes without assuming product final path.
  for path in \
    "/api/issues/${ISSUE}/workspace-admit" \
    "/api/workspace-admit?issueId=${ISSUE}" \
    "/issues/${ISSUE}/workspace-admit"
  do
    url="${BASE}${path}"
    if body=$(curl -fsS -H "Accept: application/json" "${AUTH[@]}" "$url" 2>/dev/null); then
      printf '%s\n' "$body"
      exit 0
    fi
  done
  echo "{\"ok\":false,\"error\":\"workspace-admit GET failed for issue ${ISSUE}\"}" >&2
  exit 2
fi

if [[ -n "$JSON_FILE" ]]; then
  if [[ ! -f "$JSON_FILE" ]]; then
    echo "{\"ok\":false,\"error\":\"json file not found: ${JSON_FILE}\"}" >&2
    exit 1
  fi
  for path in "/api/workspace-admit" "/api/issues/workspace-admit-preflight" "/workspace-admit"; do
    url="${BASE}${path}"
    if body=$(curl -fsS -X POST \
      -H "Accept: application/json" \
      -H "Content-Type: application/json" \
      "${AUTH[@]}" \
      --data-binary @"${JSON_FILE}" \
      "$url" 2>/dev/null); then
      printf '%s\n' "$body"
      exit 0
    fi
  done
  echo '{"ok":false,"error":"workspace-admit POST failed on known paths"}' >&2
  exit 2
fi

echo '{"ok":false,"error":"provide --issue UUID or --json FILE"}' >&2
usage >&2
exit 1
