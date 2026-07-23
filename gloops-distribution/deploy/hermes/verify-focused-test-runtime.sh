#!/usr/bin/env bash
set -euo pipefail

readonly WORKSPACE_ROOT='/opt/paperclip/hermes-execution-state/workspace'
readonly TOOL='/usr/local/lib/paperclip-gloops/tools/focused_test'

mapfile -t candidates < <(
  find "${WORKSPACE_ROOT}" -mindepth 1 -maxdepth 1 -type d \
    -name 'paperclip-gloops-stable-*' -print | sort
)

[[ "${#candidates[@]}" -eq 1 ]] || {
  echo "focused-test preflight: expected one canonical Paperclip workspace, found ${#candidates[@]}" >&2
  exit 1
}

readonly dependency_root="${candidates[0]}"
for required in \
  "${dependency_root}/node_modules/vitest/vitest.mjs" \
  "${dependency_root}/packages/adapters/hermes/node_modules" \
  "${dependency_root}/packages/adapter-utils/node_modules" \
  "${dependency_root}/packages/adapters/hermes/src/gateway/server/execute.test.ts"; do
  [[ -r "${required}" ]] || {
    echo "focused-test preflight: missing pre-provisioned runtime path: ${required}" >&2
    exit 1
  }
done

[[ "$(stat -c '%a:%U:%G' "${TOOL}" 2>/dev/null || true)" == '555:root:root' ]] \
  && "${TOOL}" --help | grep -Fq 'usage: focused_test --check' || {
  echo 'focused-test preflight: immutable helper is unavailable' >&2
  exit 1
}

echo 'focused-test preflight: ready'
