# Repo bootstrap service (C6)

Materialize allowlisted GitHub repos at an **exact 40-char SHA** into hermes
managed workspace paths — no Mac rsync.

## Allowlists

| Dimension | Values |
|-----------|--------|
| Repos | `gloopsAI/gloops-ui`, `gloopsAI/paperclip`, `gloopsAI/paperclip-gym` |
| Dest roots | `/opt/data/workspace/`, `/opt/paperclip/hermes-execution-state/workspace/` |
| Ref | **Full SHA only** (branch names rejected) |

Override dest roots for tests: `REPO_BOOTSTRAP_DEST_ROOTS=/tmp/ws`.

## Auth

Reuses GitHub App host credentials (same pattern as `github-read-broker.py` /
`github-app-credentials.py`):

- Config: `/etc/paperclip-gloops/github-app.json`  
  (`GLOOPS_GITHUB_BROKER_CONFIG_DIR` / `GLOOPS_REPO_BOOTSTRAP_APP_CONFIG`)
- Mints short-lived installation token with `contents:read`
- Token never printed; scrubbed from `git remote` after clone/fetch
- Test mode: `REPO_BOOTSTRAP_TEST_MODE=1` + optional `REPO_BOOTSTRAP_TEST_TOKEN`

If live clone is impossible, fall back to source-inventory via the read broker
for evidence only — this tool’s goal remains a **real git worktree at SHA**.

## Operator usage

```bash
cd gloops-distribution/deploy/hermes/repo-bootstrap

# Dry-run (default)
python3 bootstrap_repo.py \
  --repo gloopsAI/gloops-ui \
  --sha f5c08533aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --dest /opt/data/workspace/gloops-ui-main

# Apply
sudo python3 bootstrap_repo.py --apply \
  --repo gloopsAI/gloops-ui \
  --sha f5c08533aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --dest /opt/data/workspace/gloops-ui-main
```

Stdout/stderr JSON:

```json
{"ok": true, "dryRun": false, "repo": "gloopsAI/gloops-ui", "sha": "…", "dest": "…", "head": "…"}
```

Typed errors: `invalid_sha`, `repo_not_allowlisted`, `dest_not_allowlisted`,
`git_clone_failed`, `git_fetch_failed`, `head_mismatch`, …

## Workspace repair usage

1. Observe `head_mismatch` or missing cwd in the ordinary Paperclip run result.
2. Resolve intended full SHA from PWS catalog (C7) or packet Exact head.
3. `bootstrap_repo.py --apply --repo … --sha … --dest <PWS cwd>`.
4. Re-realize the workspace through Paperclip if the configured checkout is stale.
5. Assign the issue and use Paperclip's ordinary issue-bound wake/claim path.

Never set `repoRef` / expected head to branch name `main`.

## Tests

```bash
python3 -m unittest bootstrap_repo_test.py -v
```
