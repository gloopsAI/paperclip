# Atomic writable issue admission

Every writable entry into the private GLoops SDLC has one authority source: Paperclip's issue row
and its existing `checkoutRunId` / `executionRunId` pair. There is no parallel workspace-lock or
Buzz-lock database.

## Entry paths

- **Paperclip-managed agents** use the native heartbeat claim and workspace-admission path.
- **Buzz/Hermes** uses `paperclip-task.mjs claim --entry-point buzz` before a repository write.
- **Interactive Codex** uses the same helper with `--entry-point interactive_codex` before a
  repository write.

The external endpoint creates a real running heartbeat run whose id is the supplied claim UUID and,
in the same database transaction, assigns the issue and sets both issue ownership columns. The
binding records company, issue, agent, entry point, repository, exact base SHA, derived branch,
project workspace, and caller workspace identity.

## Contract

1. The issue packet and workspace-admission gates run before the claim transaction.
2. The project workspace must be a GitHub repository pinned to an exact 40-character commit.
3. The branch is exactly `paperclip/<claim-id>/calibration`.
4. Exact replay is idempotent. A different live owner receives conflict with no workspace effect.
5. Only a terminal or missing prior run can be reconciled; an existing different assignee is never
   stolen.
6. Validation rechecks the live run, issue locks, assignment, project workspace, repository, base,
   branch, and workspace identity.
7. Repository publication independently checks the same binding and proves the pinned base is an
   ancestor of the proposed head.
8. Release is owner-only. `handoff` moves to `in_review`; `abandoned` returns to `todo`. Neither can
   complete the issue.
9. The processless external run has a four-hour silent lease. Exact replay or validation renews it.
   Expiry atomically cancels the run, clears only matching issue locks, and blocks the issue without
   retry or provider routing.

## Failure behavior

- Malformed or missing claim evidence on an `external_claim` run fails closed before a repository
  mutation receipt can be prepared.
- A non-external run cannot inject external-claim evidence.
- Buzz and interactive callers must use the exact issue UUID; the helper performs no search in an
  authority-bearing operation.
- Claim loss, repository drift, or ancestry failure stops publication. Do not create another lock or
  bypass the broker; release or reconcile the Paperclip issue ownership instead.

## Operational proof

A deployment receipt must record the merged source SHA, old/new installed hashes, private-pilot
health, one live claim/validate/release cycle, and confirmation that the released issue is not
`done`. The first installation is a documented bootstrap exception because the claim capability did
not yet exist; the post-deploy cycle establishes the enforcement point for subsequent writes.
