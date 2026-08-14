# Autonomous SDLC upstream reconciliation — 2026-08-14

Exact comparison:

- GLoops base: `3bda109636fe43c68eb21e13e9a996da42fb00eb` (`gloops/stable`).
- Paperclip upstream inspected: `aac6ce82e10ff8d5c964421b021f9828e77d2435` (`paperclipai/paperclip/master`).

This pass composes GLoops policy with Paperclip primitives. It does not add a
second orchestrator, execution ledger, workspace subsystem, or retry loop.

| Capability | Upstream/fork evidence | Disposition |
|---|---|---|
| Workspace admission and context packet | Fork `buildBoundExecutionContext` / `readBoundExecutionContext`; packet digest is persisted on the heartbeat run | Reuse; explicitly enable DoR enforcement in the Hermes profile |
| Pipelines and transition enforcement | Paperclip pipeline service, cases, review stages, transitions, leases, events | Reuse; configure `gloops-autonomous-sdlc-v1` |
| Review-round limit | Upstream `27f8c8d` | Adapt narrowly at the existing GLoops implementation-review handoff; three total rounds including cancelled rounds |
| Review policy / stalled review | Upstream `f554d67`, `678728f`, `814cb33` | Do not backport their overlapping core migrations; use the existing handoff, designated reviewer qualification, terminal three-round decision, and Paperclip pipeline visibility |
| Pull-request check loop | Fork `.agents/skills/prcheckloop/SKILL.md` | Reuse unchanged for CI-to-merge ownership |
| Merge-aware terminal workspace cleanup | Upstream change already incorporated in fork history (`72b509c895` lineage) and hardened by GLoops publication receipts | Reuse unchanged |
| Plugin webhook transport | Core `POST /api/plugins/:pluginId/webhooks/:endpointKey` route and worker delivery | Reuse; add only signed GitHub Check Suite handling to the existing autonomic policy plugin |
| Provider accounting | Paperclip has provider routing evidence but provider names can share one subscription | Add GLoops billing-pool suppression; never route Luna/Terra/Codex successively after a shared-pool exhaustion |
| Deploy and rollback truth | Existing GLoops broker has action digests, prior-release snapshots, health and compensation receipts | Extend only with expected merge-commit ↔ OCI revision ↔ immutable image digest binding |

## Authority boundaries

- The pipeline is the visibility and transition shell. Issue execution remains
  the work authority, and the implementation-review handoff remains the
  reviewer-qualification authority.
- The Check Suite webhook observes completed checks. It cannot create issues,
  wake agents, repair code, merge, or deploy.
- `prcheckloop` owns CI observation and bounded progression; it is not copied
  into the plugin.
- The deployment broker alone mutates the pilot release, and a deployment is
  accepted only when its caller supplies the exact merge commit and the pulled
  image's OCI revision and RepoDigest bind that commit to the immutable image.
- A third review request is the final allowed round. Further requests terminate
  as `review_rounds_exhausted`; they do not self-trigger another reviewer.

## Source-controlled pipeline configuration

`autonomous-sdlc-pipeline.json` is applied with the existing Paperclip CLI/API:
create the pipeline with its `stages` array, then apply its `transitions` array
with transition enforcement. Live configuration must be compared to this exact
document before a receipt is accepted.
