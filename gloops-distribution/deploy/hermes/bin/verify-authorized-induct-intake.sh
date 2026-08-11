#!/usr/bin/env bash
# Offline fixture harness for the board-authorized Induct intake resolver.
# No network, credentials, or service state is required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"
pnpm --filter @paperclipai/shared exec vitest run src/validators/issue.test.ts
pnpm --filter @paperclipai/server exec vitest run \
  src/services/authorized-induct-work-item-intake.test.ts \
  src/__tests__/issue-workspace-command-authz.test.ts
