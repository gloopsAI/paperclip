# Induct SDLC preflight (S0–S5)

Fail-closed platform law for **Induct product implement** work on the gloops/hermes plane.

Agents **never** open campaigns, enable `HEARTBEAT_SCHEDULER`, multi-UUID READMIT, or bulk hostctl.

## Slices

| Slice | Artifact | Role |
| --- | --- | --- |
| **S0** | `bin/verify-induct-sdlc-preflight.sh` | Host probes: campaign epoch deadline, scheduler, commissioned, health, induct-app, lease, pin |
| **S1** | `server/src/services/sdlc-preflight.ts`, `GET /api/plane-status` | Pure env evaluator + mode + induct target + create/assign gate helpers |
| **S2** | `server/src/routes/issues.ts` | Enforce gate on Induct implement **create** and **assign** |
| **S3** | `plane-steward/detect.py`, `recipes.json`, `sdlc-steward-poller.py` | Signals → recipes; optional lease auto-apply **off** by default |
| **S4** | `systemd/paperclip-induct-lease-refresh.{service,timer}` | 15m oneshot lease refresh when commissioned |
| **S5** | `bin/campaign-deadline-alert.py` + timer | T−4h once-per-epoch alert |

## Authority bounds

**Allowed**

- Read-only plane probes
- Board/agent-visible `GET /api/plane-status`
- Deny create/assign for Induct implement when gate fails
- Recommend recipes on workspace-admit failure (log only)
- Host lease refresh via allowlisted recipe / timer when commissioned
- Once-per-epoch deadline alert (log + optional Slack)

**Forbidden**

- Open / renew campaigns from agents
- `HEARTBEAT_SCHEDULER_ENABLED=true`
- Multi-UUID READMIT / whole-company unfreeze
- Auto hostctl from the Paperclip server process
- Expanding frozen GitHub App allowlists

## Env knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERCLIP_SDLC_PREFLIGHT` | `enforce` (off under vitest/test) | `enforce` \| `observe` \| `off` |
| `PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS` | `452c8800-8270-4ca1-b384-8a677a39b826` | Comma UUID list of Induct PWS |
| `PAPERCLIP_CAMPAIGN_DEADLINE_AT` | unset | ISO deadline for **server** plane evaluator (host epoch is S0) |
| `PAPERCLIP_SDLC_REQUIRE_DEADLINE_AT` | unset | If `true` and commissioned, server requires deadline env |
| `SDLC_PREFLIGHT_MIN_CAMPAIGN_HOURS` | `6` | Critical threshold |
| `SDLC_PREFLIGHT_WARN_CAMPAIGN_HOURS` | `12` | Warning threshold |
| `SDLC_PREFLIGHT_LEASE_CWD` | induct-main host path | Lease path for S0 |
| `SDLC_STEWARD_AUTO_APPLY_LEASE` | unset/off | Poller may apply lease refresh only when sole recipe is `induct-lease-refresh` |
| `SDLC_CAMPAIGN_ALERT_HOURS` | `4` | S5 alert window upper bound |
| `PAPERCLIP_SUBSTRATE_SLACK_CHANNEL` + `SLACK_BOT_TOKEN` | optional | S5 Slack (best-effort) |

After arming a campaign epoch, operators may export the deadline for server gates:

```bash
sudo /usr/local/lib/paperclip-gloops/bin/export-campaign-deadline-to-runtime.sh
```

There is no agent-callable open-campaign path; operators open windows via deadman / controlled-swarm activation.

## Critical codes (fail-closed)

- `campaign.deadline_lt_6h`
- `campaign.missing_epoch` (host: commissioned without epoch; server optional via `PAPERCLIP_SDLC_REQUIRE_DEADLINE_AT`)
- `scheduler.true`
- `commissioned.false` (when swarm/campaign expected)
- `hermes.unhealthy` / `paperclip.unhealthy` (host S0)
- `induct_app.not_ok` (host S0)
- `lease.dirty_or_missing` (host S0)
- `pin.mismatch`

Warning (ok still true): `campaign.deadline_lt_12h`

Gate-only codes: `sdlc.missing_project_workspace`, `sdlc.missing_exact_head`, `sdlc.plane_not_ok`

## Operator recipes

```bash
# Host preflight (S0)
sudo /usr/local/lib/paperclip-gloops/bin/verify-induct-sdlc-preflight.sh

# Detect signals (S3)
cd /usr/local/lib/paperclip-gloops/plane-steward
python3 detect.py --log-file /path/to/log

# Optional poller (auto-apply off)
python3 sdlc-steward-poller.py --run-preflight

# Enable lease auto-apply ONLY when intentionally desired
SDLC_STEWARD_AUTO_APPLY_LEASE=1 python3 sdlc-steward-poller.py --run-preflight

# Campaign T-4h alert dry-run
python3 /usr/local/lib/paperclip-gloops/bin/campaign-deadline-alert.py
```

Timers (install under systemd when promoting host pack):

- `paperclip-induct-lease-refresh.timer`
- `paperclip-campaign-deadline-alert.timer`

## Server integration

- `evaluatePlaneStatusFromEnv` / `evaluateInductSdlcGate` pure functions
- `POST /companies/:companyId/issues` and children: Induct implement gate before create
- PATCH assign: gate after Dispatch thrash policy for implement-shaped induct targets
- Checkout workspace-admit failure logs `recommendedRecipes` (no auto hostctl)
