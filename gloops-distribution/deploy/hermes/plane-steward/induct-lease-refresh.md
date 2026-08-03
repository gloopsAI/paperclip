# Induct lease refresh (baked thrash-killer)

## When
Before minting any Induct implement GLO, or when workspace-admit fails with
`head_mismatch` / `dirty_tree` on the Induct PWS.

## One command (no manual rsync)

```bash
# dry-run
sudo python3 /usr/local/lib/paperclip-gloops/bin/refresh-induct-lease.py

# apply: re-materialize if needed + patch board PWS to full SHA
sudo python3 /usr/local/lib/paperclip-gloops/bin/refresh-induct-lease.py --apply

# apply only when host tip drifted
sudo python3 /usr/local/lib/paperclip-gloops/bin/refresh-induct-lease.py --apply --only-if-stale
```

Output includes `tipSha` and `exactHeadLine` — paste that line into the packet.

## Why not expand the paperclip GitHub App

`github-app-credentials.py` freezes write App scope to **gloopsAI/** repos only.
InductAI/induct is intentionally outside that boundary. Expanding it is a
governance change (new installation + allowlist code + security review), not a
host toggle. Refresh uses **root `gh`** which already has private Induct access.

## Optional timer (low thrash)

```ini
# paperclip-induct-lease-refresh.timer — OnUnitActiveSec=60m
# ExecStart=.../refresh-induct-lease.py --apply --only-if-stale
```

Prefer timer for background freshness; always run once before a campaign window.
