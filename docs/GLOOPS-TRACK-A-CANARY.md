# GLOOPS Track A Canary

**Issue:** GLO-1910 (`c0bea6ea-e614-4738-b1d8-5cc3f66adf0b`)
**Parent:** GLO-1866 — PLATFORM MANDATE: company as default operator (closed-loop + create-work-unit)
**Run ID:** `b3acf4dc-a19f-4b47-857f-38f2526b7e5c`
**Agent:** `3298054f-0fc5-4ff9-8c53-b1382b3046d3` (Wren)
**Base SHA:** `ae9f916426023a202c2ca1d9d3f2c4ef5fc2dc67`
**Branch:** `paperclip/b3acf4dc-a19f-4b47-857f-38f2526b7e5c/calibration`

## Purpose

This file is the Track A agent-authoring canary. It proves the agent-closed-loop path
can produce a durable GitHub SHA via the broker (with prefetched `gloops/stable`
alternates) and open a draft PR — as opposed to the board-proxy App publish path.

## Context

Prior GLO-1909 produced a local SHA (`0c7b6f718…`) but the broker rejected the
push with `bounded_failure` due to missing parent trees in the thin pack. The
broker has since been updated to prefetch `gloops/stable` into object alternates,
which should resolve the missing-object rejection.

## Acceptance criteria

1. Checkout-bound Wren run; `executionRunId`/`checkoutRunId` == run.
2. This file committed on branch `paperclip/<runId>/calibration`, content
   mentions this issue id (GLO-1910).
3. HEAD must differ from base `ae9f916426023a202c2ca1d9d3f2c4ef5fc2dc67` /
   current `gloops/stable` before push.
4. Exactly one push, via
   `node /opt/data/bin/github-push-tool.bundle.cjs client --run-id $RUN`.
5. Comment durable SHA + draft PR URL; do not mark parent GLO-1866 done.
6. Do not claim done without platform-accepted terminal + durable SHA
   (Q-NO-PROOF guard).

## Proof

See issue GLO-1910 comment thread for the durable SHA and draft PR URL once
the push is accepted by the broker.
