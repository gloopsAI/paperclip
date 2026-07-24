---
name: gloops-terminal-reconciliation
description: Reconcile provider output, workspace state, tests, commits, pull requests, and Paperclip records into one truthful terminal outcome. Use after any execution, timeout, cancellation, retry, or apparently completed run whose system state may disagree with its material result.
---

# GLoops terminal reconciliation

1. Identify the exact run, task, workspace, repository head, and expected terminal contract.
2. Read deterministic evidence before model prose: process status, materialized diff, verification output, commit or PR identity, and current Paperclip state.
3. Classify exactly one outcome:
   - `done`: required artifact exists and named verification passed;
   - `blocked`: no further autonomous progress is possible without a named dependency;
   - `failed`: execution ended without satisfying the contract;
   - `cancelled`: work was intentionally superseded or stopped.
4. In a Paperclip/Hermes run, do not call `paperclip-task`, `update-status`,
   or another control-plane write tool. Return the signed terminal protocol
   below; Paperclip's deterministic reconciler owns the single state change.
   Outside that runtime, reconcile the authoritative task record once.
5. Preserve the continuation cursor and the smallest useful failure evidence.

Do not infer success from provider text, configured ceilings, or a draft PR. Do not report a configured token cap as measured usage. Do not create retries during reconciliation.

For a successful Paperclip/Hermes run, return exactly:

`PAPERCLIP_SWARM_V1:{"action":"operations_complete","summary":"<evidence-backed summary>"}`

For a blocked Paperclip/Hermes run, return exactly:

`PAPERCLIP_SWARM_V1:{"action":"blocked","reason":"<typed blocker and next condition>"}`

The host assigns `failed` or `cancelled` from execution state; the agent must not
simulate either outcome with a control-plane write.

Outside Paperclip/Hermes, return one line first:
`OUTCOME=<state> EVIDENCE=<artifact-or-reason>`. Follow with measured provider
usage, materialized changes, verification, and any single next action.
