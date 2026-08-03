# Standing PWS catalog + refresh (C7)

Catalog of project workspaces that product issues should bind to, with a
refresh loop that resolves **full 40-char SHAs** (never branch names as
expected head for implement packets).

## Catalog

| id | name | repo | default branch | cwd |
|----|------|------|----------------|-----|
| `gloops-ui-main` | gloops-ui@main | gloopsAI/gloops-ui | main | `/opt/data/workspace/gloops-ui-main` |
| `paperclip-pin` | paperclip@pin | gloopsAI/paperclip | gloops/stable | `/opt/data/workspace/paperclip-pin` |
| `paperclip-gym` | paperclip-gym | gloopsAI/paperclip-gym | main | `/opt/data/workspace/paperclip-gym` |

- Canonical machine file: [`catalog.json`](./catalog.json)
- Human twin: [`catalog.yaml`](./catalog.yaml)

Set `pinSha` on `paperclip-pin` to the controlled-swarm exclusive-writer pin when
a campaign is COMMISSIONED so refresh does not float the pin out from under
hostctl.

## Refresh

```bash
cd gloops-distribution/deploy/hermes/pws-catalog

# Dry-run (default): resolve SHAs + plan bootstrap, no mutation
python3 refresh_pws_catalog.py

# One entry
python3 refresh_pws_catalog.py --only gloops-ui-main

# Apply: materialize via ../repo-bootstrap/bootstrap_repo.py
python3 refresh_pws_catalog.py --apply --only gloops-ui-main
```

Report shape:

```json
{
  "ok": true,
  "dryRun": true,
  "entries": [
    {"name": "gloops-ui@main", "sha": "f5c0…", "cwd": "/opt/data/workspace/gloops-ui-main", "ok": true, "error": null}
  ]
}
```

## systemd timer sketch

```ini
# /etc/systemd/system/paperclip-pws-catalog-refresh.service
[Unit]
Description=Refresh Paperclip standing PWS catalog materializations
After=network-online.target

[Service]
Type=oneshot
# root: needs GitHub App key + write under /opt/data/workspace
ExecStart=/usr/bin/python3 /usr/local/lib/paperclip-gloops/pws-catalog/refresh_pws_catalog.py --apply
Nice=10
```

```ini
# /etc/systemd/system/paperclip-pws-catalog-refresh.timer
[Unit]
Description=Timer for PWS catalog refresh (30m default; per-entry policies differ)

[Timer]
OnBootSec=5m
OnUnitActiveSec=30m
Persistent=true

[Install]
WantedBy=timers.target
```

Do **not** enable this timer until dest roots, App credentials, and exclusive-writer
policy are confirmed on hermes. Prefer manual `--apply` during controlled-swarm
windows for `paperclip-pin`.

## Cron alternative

```cron
*/30 * * * * root /usr/bin/python3 /usr/local/lib/paperclip-gloops/pws-catalog/refresh_pws_catalog.py --apply --only gloops-ui-main >>/var/log/paperclip-gloops/pws-catalog.log 2>&1
```

## Operating rules

1. **Never** put branch name `main` in packet Exact head / `repoRef` / `defaultRef`.
2. After refresh, copy the reported `sha` into PWS `repoRef` + implement packet.
3. Product gloops-ui issues must bind `gloops-ui-main` PWS — not gym inheritance.
4. Plane steward `wrong-head-rebase` / repo-bootstrap if a lease drifts.

## Tests

```bash
python3 -m unittest refresh_pws_catalog_test.py -v
```
