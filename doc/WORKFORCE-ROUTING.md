# Workforce routing

Paperclip's GLoops workforce policy separates durable operating capacity from
bounded escalation capacity.

## Lanes

- **Durable bench:** `codex_local` agents configured with `gpt-5.6-luna` or
  `gpt-5.6-terra`. Roles such as Wren and Argus should use this lane for normal
  company operation.
- **Supplemental:** Hermes/Ollama capacity may be used when available, but it is
  not a prerequisite for Luna, Terra, or the company to operate.
- **Direct subscription:** Grok CLI and Codex models other than Luna/Terra.
  These lanes may be selected directly when configured, capable, and bounded
  by an execution reservation. A lower-provider attempt is not a prerequisite.

This policy does not start standing burst workers. A model lane is evaluated at
an issue-backed provider boundary only.

## Capacity admission

The policy is enforced by default for every `codex_local` agent configured with
Luna or Terra, which binds Wren/Argus-class roles and future durable roles in
source without relying on a live config mutation. Non-durable routes remain
backwards-compatible and can opt in with `paperclipWorkforceCapacityRequired:
true` in the agent runtime config or the issue's
`assigneeAdapterOverrides.adapterConfig`.
Before model execution Paperclip requires:

1. an issue/run/agent binding;
2. an execution reservation with positive plan, implement, verify, and closeout
   allocations;
3. a just-in-time capacity lease;
4. a non-exhausted provider quota snapshot for Luna/Terra.

The default provider-window ceiling is 95 percent used. A failed, missing, or
percentage-free Luna/Terra quota probe fails closed. Grok currently has no quota
probe, so a directly selected Grok run receives a lease bounded by the per-item
execution reservation. Codex uses the Codex quota probe plus the same per-item
reservation when that probe is configured. A Grok failure never silently
reroutes to Codex.

Denied admissions return `workforce_capacity.denied` with
`providerInvocationAttempted: false`. The typed receipt is stored under
`gloopsWorkforceCapacity` in the heartbeat context snapshot.

## Measurement boundaries

The capacity receipt deliberately keeps these facts separate:

- raw input/output token ceilings (`reservation` provenance);
- subscription capacity windows and utilization;
- direct-selection or typed reroute reason;
- queue latency; and
- billed cost, which is explicitly **not** used for admission.

Do not convert unknown subscription usage or provider capacity into zero cost,
zero tokens, or available capacity. Subscription allocation remains a derived
economics view and never widens an execution lease.

## Failure harness

`server/src/services/workforce-capacity.test.ts` is network-free. It injects
quota exhaustion, missing probes, probe failures, direct Grok selection,
non-authoritative stale route history, and absent/invalid phase budgets.
