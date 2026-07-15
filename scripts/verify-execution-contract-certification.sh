#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

iterations="${PAPERCLIP_EXECUTION_CERTIFICATION_ITERATIONS:-20}"
if ! [[ "$iterations" =~ ^[1-9][0-9]*$ ]]; then
  echo "PAPERCLIP_EXECUTION_CERTIFICATION_ITERATIONS must be a positive integer" >&2
  exit 2
fi

for ((iteration = 1; iteration <= iterations; iteration += 1)); do
  echo "execution-contract certification pass ${iteration}/${iterations}"
  pnpm exec vitest run \
    --config packages/adapters/hermes/vitest.config.ts \
    packages/adapters/hermes/src/gateway/server/execute.test.ts \
    --pool=threads --maxWorkers=1
  pnpm exec vitest run \
    server/src/services/execution-admission.test.ts \
    server/src/__tests__/heartbeat-execution-admission.test.ts \
    --pool=threads --maxWorkers=1
  pnpm exec vitest run \
    server/src/__tests__/heartbeat-process-recovery.test.ts \
    -t 'automatic recovery is prohibited' \
    --pool=threads --maxWorkers=1
done

echo "execution-contract certification complete: ${iterations}/${iterations} passes"
