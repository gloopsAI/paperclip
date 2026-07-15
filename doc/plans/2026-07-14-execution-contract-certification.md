# Execution Contract Certification

## Outcome

Certify the GLoops Paperclip-to-Hermes execution boundary without reactivating autonomous work. A certified run must preserve the supported Hermes adapter architecture while proving that the downstream execution-admission hardening cannot create ambiguous usage, extra recovery runs, or work against an undeclared checkout.

Paperclip and the Hermes execution sidecar remain dark during implementation and deterministic verification. This work does not authorize a fifth quality pilot.

## Boundary

The supported directions remain distinct:

- Paperclip wakes Hermes through the built-in `hermes_gateway` adapter.
- Hermes-originated task management uses the bundled `paperclip-task-bridge` skill and a scoped bridge credential.
- The task bridge does not replace heartbeat execution and the heartbeat adapter does not broaden the task-bridge credential.

The GLoops fork may add admission and evidence requirements, but it must adapt those requirements to the supported Hermes API contract instead of inventing a second execution protocol.

## Certified contracts

### 1. Route and usage reconciliation

- A terminal Hermes result is reconciled with `GET /v1/runs/{run_id}` before it is mapped when the streamed terminal event is missing route or usage fields.
- A successful provider invocation without usage remains a fail-closed contract violation.
- A failed or timed-out provider invocation without observed usage charges the full reservation without replacing the original failure reason.
- A deterministic pre-dispatch refusal records zero observed usage and `providerInvocationAttempted=false`; it must not consume a provider reservation as though a provider ran.
- Receipts identify the adapter, provider route when reported, model when reported, usage basis, and whether provider invocation occurred.

### 2. One run / zero recovery

- With execution admission set to `maxRunsPerTask=1` and `maxRetriesPerTask=0`, terminal finalization must not create a recovery wakeup or heartbeat row.
- The original issue is reconciled to a visible terminal or blocked state through the existing liveness path; absence of a recovery run must not leave an unexplained execution lock.
- The rule is enforced before any recovery row is inserted, not by inserting a row that is later denied.

### 3. Immutable workspace head

- A Hermes gateway run may declare a workspace-head contract with an exact 40-character commit SHA.
- Before `POST /v1/runs`, Paperclip verifies that the shared checkout is a git worktree, clean, and exactly at the declared SHA.
- Missing, dirty, or stale workspaces fail before provider invocation with a bounded workspace-validation receipt.
- The adapter never resets, cleans, checks out, or otherwise mutates the operator workspace. Synchronization remains an explicit dark-install/preparation responsibility.

## Deterministic certification matrix

The certification suite runs without a real model and covers:

1. streamed success with complete usage;
2. streamed success with usage recovered from final status;
3. successful provider completion with usage missing everywhere;
4. provider failure without usage;
5. timeout without usage;
6. deterministic pre-dispatch refusal;
7. clean exact-head workspace;
8. stale-head workspace;
9. dirty workspace;
10. one-run/zero-recovery terminal reconciliation.

Each scenario must prove the route/usage receipt, provider-invocation state, reservation settlement, run count, recovery-row count, lock release, and terminal issue state that apply to it.

## Qualification gate

The implementation is qualified only after:

- targeted tests pass;
- the deterministic matrix passes 20 consecutive times, including injected failures;
- full typecheck, unit suite, and build pass;
- an independent high-reasoning review accepts the exact head with no unresolved findings;
- the merged artifact is dark-installed and three zero-work rehearsals return dark without creating work;
- Paperclip, Hermes, schedules, and Maximum Token Efficiency remain inactive afterward.

If this cannot be achieved in one bounded work package of at most two focused implementation pull requests plus independent acceptance, Paperclip remains the control plane and the execution lifecycle moves to a deterministic GLoops controller. No additional pilot is authorized under the failing shape.
