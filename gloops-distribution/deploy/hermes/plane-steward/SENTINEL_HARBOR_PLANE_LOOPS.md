# Sentinel + Harbor plane loops (host-closed)

**Status: LIVE host loops** (timer oneshots). Goal: stop defaulting plane babysitting to Zach.

## Roles

| Role | Agent UUID | Loop | Mutating authority |
|------|------------|------|--------------------|
| **Sentinel** | `32de720b-4231-45f3-9322-aa5da3d9f44d` | `sentinel-plane-loop.py` @ 5m | Preflight + residual GLO + **only** `induct-lease-refresh` auto-apply |
| **Harbor** | `a3a1cb4c-390a-4d40-9a88-8609183ed012` | `harbor-plane-loop.py` @ 5m | Campaign reopen via **standing auth** + `open-campaign-24h.sh` |

Company: `89ed0964-d918-4fcc-b830-5be49d2d4089`  
Project (residuals): `cfca4683-e256-40e0-91b3-f2e513170ec0`  
Board token: `/etc/paperclip-gloops/operator-board-token`  
API: `http://127.0.0.1:3100`

## How Zach is out of the happy path

1. **Sentinel** wakes on timer → S0 preflight → if lease dirty, auto-applies lease refresh (default on) → if still red or campaign &lt; 12h, upserts a single residual issue `[Sentinel/Plane] …` assigned to Harbor (campaign/pin/commission) or Sentinel (other).
2. **Harbor** wakes on timer → if campaign hours &lt; 6 **and** standing reopen auth is installed → runs `harbor-campaign-reopen.sh --execute --confirm-execute` (phrase from standing file, not Slack typing).
3. Residual issues are commented/cancelled when plane returns green. Receipts land under `/var/lib/paperclip-gloops/plane-steward/` and campaign-deadman receipts.

Zach’s remaining duty: **one-time** install of standing Harbor auth (delegation), not per-event phrase babysitting.

```bash
sudo /usr/local/lib/paperclip-gloops/bin/install-harbor-standing-reopen-auth.sh \
  --confirm-standing-delegation
```

## Authority bounds

**Allowed**

- Sentinel: read preflight; create/comment/cancel residual GLOs; auto-apply **only** `refresh-induct-lease.py --apply --only-if-stale` when `SENTINEL_AUTO_APPLY_LEASE=1` (default **1**)
- Harbor: execute open-campaign-24h with standing phrase; export deadline to runtime; mint/update supervisor-operational-closure `approvedImage` only; restart deadman/gloops **only if** open-campaign did not already

**Forbidden (both)**

- `HEARTBEAT_SCHEDULER_ENABLED=true`
- Multi-UUID READMIT / whole-company unfreeze
- Sentinel opening campaigns (Harbor only)
- Per-event Zach phrase typing for reopen once standing auth is live

## systemd

| Unit | Cadence |
|------|---------|
| `paperclip-sentinel-plane-loop.timer` | OnBootSec=2min, OnUnitActiveSec=5min |
| `paperclip-harbor-plane-loop.timer` | OnBootSec=3min, OnUnitActiveSec=5min |

```bash
# After packing to host lib paths:
systemctl enable --now paperclip-sentinel-plane-loop.timer
systemctl enable --now paperclip-harbor-plane-loop.timer
systemctl list-timers 'paperclip-*-plane-loop*'
```

## Paths

| Artifact | Path |
|----------|------|
| Sentinel loop | `/usr/local/lib/paperclip-gloops/plane-steward/sentinel-plane-loop.py` |
| Harbor loop | `/usr/local/lib/paperclip-gloops/plane-steward/harbor-plane-loop.py` |
| Harbor reopen | `/usr/local/lib/paperclip-gloops/bin/harbor-campaign-reopen.sh` |
| open-campaign (host tool) | `/usr/local/lib/paperclip-gloops/tools/open-campaign-24h.sh` |
| Standing auth (live) | `/var/lib/paperclip-gloops/campaign-deadman/standing/harbor-reopen-authorized.json` |
| Standing auth (example) | `deploy/hermes/standing/harbor-reopen-authorized.example.json` |
| Sentinel state | `/var/lib/paperclip-gloops/plane-steward/sentinel-loop-state.json` |
| Sentinel receipt | `/var/lib/paperclip-gloops/plane-steward/sentinel-loop-last.json` |
| Sentinel log | `/var/log/paperclip-gloops/plane-steward/sentinel-loop.jsonl` |
| Harbor reopen receipts | `/var/lib/paperclip-gloops/campaign-deadman/receipts/harbor-reopen-*.json` |

## Env knobs

| Variable | Default | Meaning |
|----------|---------|---------|
| `SENTINEL_AUTO_APPLY_LEASE` | `1` | Auto-apply lease refresh when lease/head codes present |
| `SENTINEL_RESIDUAL_HOURS` | `12` | Residual if hours remaining under this |
| `SENTINEL_COMMENT_MIN_INTERVAL_SEC` | `1800` | Rate-limit residual comments (≥30m) |
| `HARBOR_REOPEN_HOURS` | `6` | Harbor auto-reopen threshold |
| `HARBOR_REOPEN_NOT_NEEDED_HOURS` | `6` | dry-run exit 0 “not needed” if hours above and no forced residual |
| `HARBOR_REOPEN_STANDING_AUTH` | standing path above | Standing auth JSON |

## Manual ops

```bash
# Sentinel once
python3 /usr/local/lib/paperclip-gloops/plane-steward/sentinel-plane-loop.py
python3 …/sentinel-plane-loop.py --dry-run

# Harbor reopen
harbor-campaign-reopen.sh --status
harbor-campaign-reopen.sh --dry-run
harbor-campaign-reopen.sh --execute --confirm-execute [--issue-id UUID]
```

## Recipe catalog

`harbor-campaign-reopen` is registered in `recipes.json` / `recipes.yaml` pointing at the host command path.

## Related

- [`SDLC_PREFLIGHT.md`](./SDLC_PREFLIGHT.md) — S0–S5 preflight law
- [`sentinel-plane-steward.md`](./sentinel-plane-steward.md) — Sentinel promotion (now LIVE host loop)
- S3 `sdlc-steward-poller.py` remains advisory/detect; Sentinel plane loop is the residual-driving path
