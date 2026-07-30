# Phase-2 Decomposition Proposal — Self-Host Mandate

Companion to receipts/GLO-2025-phase-1-receipt.md. Filed 2026-07-30 under
GLO-2025 (aab4a766-6d01-440f-af37-835ace107413) by Wren (3298054f-...), run
28673010-7662-4592-ae76-3c568efe1997.

## Why a Phase-2 proposal

Phase-1 checkpoint validation surfaced that only 1 of 5 payload families has a
shippable commit on its leased branch (GLO-2023), 2 of 5 have on-disk but
uncommitted code (GLO-2021, GLO-2022), and 2 of 5 have no implementation at
all (GLO-2020 measurement, GLO-2024 cockpit). GLO-2018's "Onboarding Gate"
cannot be lifted until those gaps are closed. Phase-2 is the work that closes
them.

## Acceptance inherited from GLO-2018

The mandate (per GLO-2018 ## Scope) is: a paying company can self-host the
Paperclip control plane and run a Paperclip-managed AI team end-to-end with
production-quality observability, auditability, and economic accountability.
Phase-1 covered the five payload families as a minimum-viable slice of that.
Phase-2 covers the hardening, closure, and missing-payload backfill needed to
move Phase-1 to a shippable onboarding gate.

## Phase-2 workstreams (proposed)

### PS2-A — Measurement consumers phase-1 intake and display (closes GLO-2020 gap)
Parent issue: GLO-2020 (4aa3fecf-f0ac-4ae7-b09d-a15e378cda84).
Description: implement the first slice of measurement event intake (e.g.,
heartbeat cost/interrupt signals) and surface them on a board/operator page so
the early-access cohort can see what is happening to their runs. Landing as a
single shippable commit on the existing leased branch.
Acceptance:
- One or more new routes under server/src/routes/ that accept and persist a
  minimum set of measurement events.
- A board page (or extension to an existing page) that surfaces the events.
- One test file covering the new route handlers and any store path.
- Commit landed on the GLO-2020 leased branch, base = a7aca6efc.

### PS2-B — Token economics ledger MTE commit + steward (closes GLO-2021 gap)
Parent issue: GLO-2021 (0c9e50a6-ce01-46ac-b3ec-230b4004bc2d).
Description: GLO-2021 has on-disk uncommitted MTE rollup code in the leased
worktree (+7/-0 + new files). Commit and ship that work, ensure tests pass,
and wire the rollups into the steward service.
Acceptance:
- Existing uncommitted change staged and committed on the leased branch as
  one or more shippable commits.
- New test file mte-rollups.test.ts runs green under pnpm -r test.
- packages/shared/src/index.ts export updated.
- Commit landed on GLO-2021 leased branch, base = a7aca6efc.

### PS2-C — Learning substrate OK-09 commit + smoke (closes GLO-2022 gap)
Parent issue: GLO-2022 (9ea6a033-20ee-4547-8e71-3e59a79b18b4).
Description: GLO-2022 has +314/-8 uncommitted across DB schema, migration,
and server routes (gbrain persistence). Stage, validate, and ship.
Acceptance:
- Existing uncommitted changes committed on the leased branch as one or more
  shippable commits.
- pnpm db:generate succeeds; migration 0152_gbrain_substrate.sql valid.
- pnpm -r typecheck passes.
- pnpm -r test for packages/db and server passes (including any gbrain tests).
- Commit landed on GLO-2022 leased branch, base = a7aca6efc.

### PS2-D — Reliability reviewer-fallback merge + review (carries GLO-2023 forward)
Parent issue: GLO-2023 (c62cc5ec-37bd-453a-9974-3a85cb1ef00e).
Description: GLO-2023 produced the only Phase-1 commit (ee721543b, reviewer-
fallback handoff). Push to a branch and request review (PR or paperclip review
handoff), then merge into origin/gloops/stable as the first Phase-2 ship.
Acceptance:
- Branch pushed to origin via the broker tool (paperclip task + push handoff).
- Implementation review record created via paperclip.
- Commit merged into origin/gloops/stable.

### PS2-E — Cockpit attention + heartbeat optimization (closes GLO-2024 gap)
Parent issue: GLO-2024 (ba365835-0f06-4661-b242-2f7bb1674daa).
Description: implement the cockpit attention / heartbeat optimization slice
that GLO-2024 has not yet started. Concrete scope: reduce attention-feed
duplicates and tighten heartbeat dispatch latency under steady-state load.
Acceptance:
- Concrete diff in server/ (and packages/db or shared as needed) for the
  attention dedup + heartbeat throttling.
- New/updated tests covering the optimization.
- Commit landed on GLO-2024 leased branch, base = a7aca6efc.

### PS2-F — Phase-2 closure receipt
Description: after PS2-A..PS2-E land, file a Phase-2 closure receipt that
re-runs the same per-family evidence method documented in
receipts/GLO-2025-phase-1-receipt.md, and either lift the GLO-2018 onboarding
gate or escalate the residual blockers.
Acceptance:
- receipts/GLO-2025-phase-2-closure-receipt.md filed on the leased branch.
- Per-family evidence table shows 5/5 with MVI or 5/5 with deferral decisions.
- Either GLO-2018 unblocked or a precise residual-blocker list returned to
  product owner for resolution.

## Dependencies and ordering

- PS2-D (GLO-2023 merge) and PS2-A (GLO-2020 implement) are independent and
  may run in parallel.
- PS2-B (commit GLO-2021) and PS2-C (commit GLO-2022) are independent of each
  other; the on-disk code is already in place so they are fast.
- PS2-E (GLO-2024 implement) is independent and may run in parallel with
  B/C/D.
- PS2-F must follow all of A-E; it consumes the per-family evidence they
  produce.

## Risks and decisions to escalate

- Authorization: Wren's Paperclip authorization is bounded to its own
  assigned issues. PS2-A through PS2-E each need to be assigned to (or
  picked up by) the agent currently holding that issue's lease. If the
  leases are stale, reassignment is required before any PS2-X work begins.
- Push policy: PS2-D and any A/C/E ship will use the broker push tool under
  --run-id. No raw `git push` from any agent.
- GLO-2018 unblocking is not in scope for this proposal — it remains a
  human / control-plane decision.

---
Schema: gloops.phase-decomposition-proposal/v1
Generated: 2026-07-30T16:00:00Z
