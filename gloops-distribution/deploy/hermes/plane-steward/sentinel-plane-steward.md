# Sentinel → Plane Steward (LIVE host loop)

Status: **LIVE host loop** — timer-driven residual + lease auto-apply.
Advisory detect/apply pack remains for workspace admit recipes; plane babysitting
no longer defaults to Zach.

See **[`SENTINEL_HARBOR_PLANE_LOOPS.md`](./SENTINEL_HARBOR_PLANE_LOOPS.md)** for
authority bounds, paths, and how Harbor owns campaign reopen.

## Current state

| Component | State |
|-----------|--------|
| Sentinel agent | `32de720b-4231-45f3-9322-aa5da3d9f44d` |
| Sentinel plane loop | **LIVE** — `sentinel-plane-loop.py` + `paperclip-sentinel-plane-loop.timer` (5m) |
| Harbor plane loop | **LIVE** — `harbor-plane-loop.py` + `paperclip-harbor-plane-loop.timer` (5m) |
| Closed-loop authority | Lease auto-apply allowlisted (`SENTINEL_AUTO_APPLY_LEASE` default **1**); campaign reopen = Harbor standing auth only |
| Recipe pack | `deploy/hermes/plane-steward/` + `harbor-campaign-reopen` |

## Loop (Sentinel)

Every timer tick:

1. Run `verify-induct-sdlc-preflight.sh` (S0)
2. Collect `criticalCodes` / `warningCodes`
3. If lease/head dirty: auto-apply `refresh-induct-lease.py --apply --only-if-stale` (**only** this recipe)
4. If critical remain **or** campaign hours &lt; 12: upsert single residual  
   title prefix `[Sentinel/Plane]` (dedupe fingerprint + state file; comment rate-limit ≥30m)
5. Assignee: Harbor for `campaign.*` / pin / commission; else Sentinel
6. If plane green: comment + cancel residual
7. Receipt: `/var/lib/paperclip-gloops/plane-steward/sentinel-loop-last.json`  
   Log: `/var/log/paperclip-gloops/plane-steward/sentinel-loop.jsonl`

```bash
python3 /usr/local/lib/paperclip-gloops/plane-steward/sentinel-plane-loop.py
# dry-run (no board writes / no lease apply)
python3 …/sentinel-plane-loop.py --dry-run
```

## Explicit non-goals for Sentinel

- Enabling `HEARTBEAT_SCHEDULER_ENABLED`
- Opening / renewing campaigns (Harbor only via standing auth)
- Multi-UUID READMIT / whole-company unfreeze
- Induct product unpause
- Editing gloops-ui / paperclip product source
- Using branch name `main` as expected head
- Paging Zach for happy-path plane babysitting

## Workspace admit recipes (unchanged advisory path)

Detect / apply for dirty tree, wrong head, ACL, null-issueId, READMIT remains
via `detect.py` + `apply_recipe.py` (dry-run default). See [`README.md`](./README.md).

## Harbor campaign reopen

```bash
harbor-campaign-reopen.sh --status
harbor-campaign-reopen.sh --dry-run
harbor-campaign-reopen.sh --execute --confirm-execute [--issue-id UUID]
```

Standing auth install (Zach one-time):

```bash
sudo install-harbor-standing-reopen-auth.sh --confirm-standing-delegation
```
