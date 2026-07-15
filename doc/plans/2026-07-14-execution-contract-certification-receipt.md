# Execution Contract Certification Receipt

Date: 2026-07-14 (Pacific/Honolulu)

## Scope and grade

This receipt covers deterministic implementation verification for the GLoops
Paperclip-to-Hermes execution boundary. It does not authorize autonomous work
or a fifth quality pilot.

- Implementation grade: **built**
- Operational grade: **not yet operational**
- Proven grade: **not yet proven**

Operational promotion remains gated on independent exact-head acceptance, merge,
dark installation, and three zero-work rehearsals that return the system to dark.

## Verified contracts

1. Hermes terminal results reconcile missing streamed usage/model data from the
   final run-status endpoint before Paperclip settles admission.
2. Successful provider execution without usage fails closed. Failed or timed-out
   provider execution without usage preserves the original failure while charging
   the reservation. Deterministic pre-dispatch refusals record zero use without a
   reservation fallback.
3. One-run/zero-recovery policy suppresses recovery row creation before insertion
   across normal, process-loss, and graceful-shutdown paths and leaves the
   original run as the sole execution record.
4. A declared exact workspace head is validated as a clean git checkout at the
   exact 40-character SHA before provider dispatch; validation never mutates the
   workspace.
5. Stop and final-status HTTP reconciliation aborts at a shared absolute deadline;
   terminal issue blocking is committed under the issue row lock.

## Deterministic evidence

- Certification harness: **20/20 consecutive passes**
- Deterministic test executions exercised by the harness: **960**
  - 32 Hermes gateway adapter tests per pass
  - 14 execution-admission/heartbeat tests per pass
  - 2 process-loss/graceful-shutdown tests per pass
- Affected heartbeat lifecycle regression tests: **67/67 passed**
- Full heartbeat process-recovery suite: **86/86 passed**
- Workspace typecheck: **passed across 29 projects**
- Production build: **passed across the workspace**
- Diff whitespace validation: **passed**
- Provider/model calls during deterministic certification: **zero**

The harness includes successful, failed, sparse-usage, deterministic refusal,
stale-workspace, dirty-workspace, and one-run/zero-recovery paths.

## Full-suite reconciliation

The full unit run completed 2,272 tests: 2,268 passed, one skipped, and three
failed. Each failure was isolated against the untouched base checkout and
reproduced there without this change:

- one shared-service adoption test fails in both checkouts because the local
  runtime does not adopt the reset service;
- two branch-containment tests fail in both checkouts because macOS resolves the
  temporary path from `/var/...` to `/private/var/...`.

These are verified pre-existing environment/baseline failures, not inferred
exceptions. They do not touch the changed execution-admission or Hermes gateway
contracts.

## Remaining promotion gates

1. Independent high-reasoning review of the exact implementation head.
2. Merge only after all review findings are resolved at that exact head.
3. Dark-install the merged artifact without enabling heartbeats, schedules, or
   autonomous programs.
4. Run three zero-work rehearsals and verify no task, run, recovery row, or
   provider usage is created.
5. Return Paperclip, Hermes execution, schedules, and Maximum Token Efficiency to
   dark and record the final operational receipt.
