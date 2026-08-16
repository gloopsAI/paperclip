#!/usr/bin/env bash
# Closed-loop standing helper — App B independent-review publish.
# Usage:
#   closed-loop-publish-review.sh --pr 203 --verdict accepted
#   closed-loop-publish-review.sh --pr 223 --verdict accepted --force-after-action-required
#   closed-loop-publish-review.sh --status --pr 203
set -euo pipefail

PR=""; VERDICT=""; STATUS=0; FORCE=0; BASE=""; BASE_SHA=""; HEAD=""; REVIEW_ISSUE_ID=""; REVIEW_RUN_ID=""
PUBLISHER="${WOPR_REVIEW_PUBLISHER:-/usr/local/lib/paperclip-gloops/wopr-review-publisher.py}"
REPO="${CLOSED_LOOP_REPO:-gloopsAI/paperclip}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="$2"; shift 2;;
    --verdict) VERDICT="$2"; shift 2;;
    --status) STATUS=1; shift;;
    --force-after-action-required) FORCE=1; shift;;
    --repo) REPO="$2"; shift 2;;
    --base) BASE="$2"; shift 2;;
    --base-sha) BASE_SHA="$2"; shift 2;;
    --head) HEAD="$2"; shift 2;;
    --review-issue-id) REVIEW_ISSUE_ID="$2"; shift 2;;
    --review-run-id) REVIEW_RUN_ID="$2"; shift 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "unknown $1" >&2; exit 2;;
  esac
done

[[ -n "$PR" ]] || { echo "need --pr N" >&2; exit 2; }

if [[ "$STATUS" -eq 1 ]]; then
  echo "=== PR #${PR} checks ==="
  gh pr view "$PR" --repo "$REPO" --json url,state,mergeable,statusCheckRollup \
    --jq '{url,state,mergeable,checks:[.statusCheckRollup[]?|{name,conclusion,status}]}'
  exit 0
fi

[[ -n "$VERDICT" ]] || { echo "need --verdict" >&2; exit 2; }
[[ -n "$BASE" && -n "$BASE_SHA" && -n "$HEAD" && -n "$REVIEW_ISSUE_ID" && -n "$REVIEW_RUN_ID" ]] || { echo "need --base, --base-sha, --head, --review-issue-id, and --review-run-id" >&2; exit 2; }
[[ -f "$PUBLISHER" ]] || { echo "publisher missing: $PUBLISHER" >&2; exit 2; }

EXTRA=()
[[ "$FORCE" == "1" ]] && EXTRA+=(--force-after-action-required)

echo "=== closed-loop publish independent-review pr=$PR verdict=$VERDICT force=$FORCE ==="
if [[ "$(id -u)" -eq 0 ]]; then
  python3 "$PUBLISHER" --repo "$REPO" --base "$BASE" --base-sha "$BASE_SHA" --pr "$PR" --head "$HEAD" --review-issue-id "$REVIEW_ISSUE_ID" --review-run-id "$REVIEW_RUN_ID" --verdict "$VERDICT" "${EXTRA[@]}"
elif command -v sudo >/dev/null 2>&1; then
  sudo -n python3 "$PUBLISHER" --repo "$REPO" --base "$BASE" --base-sha "$BASE_SHA" --pr "$PR" --head "$HEAD" --review-issue-id "$REVIEW_ISSUE_ID" --review-run-id "$REVIEW_RUN_ID" --verdict "$VERDICT" "${EXTRA[@]}"
else
  python3 "$PUBLISHER" --repo "$REPO" --base "$BASE" --base-sha "$BASE_SHA" --pr "$PR" --head "$HEAD" --review-issue-id "$REVIEW_ISSUE_ID" --review-run-id "$REVIEW_RUN_ID" --verdict "$VERDICT" "${EXTRA[@]}"
fi

echo "=== post-publish ==="
gh pr checks "$PR" --repo "$REPO" 2>/dev/null | head -30 || true
