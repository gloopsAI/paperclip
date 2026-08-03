# Plane Steward recipe pack (C5)

Allowlisted, fail-closed repairs for workspace-plane failures on hermes.
Humans and **Sentinel** (today advisory) use this pack so product agents stop
dying on dirty trees, wrong heads, ACLs, null-issueId wakes, and READMIT thrash.

## Authority bounds

| Allowed | Forbidden |
|---------|-----------|
| `hostctl apply` (READMIT **one** UUID; force scheduler false) | Free product code edits |
| Board issue PATCH (`executionPolicy.resourceBudget` only) | Whole-company unfreeze |
| Agent wakeup with **`payload.issueId`** | Induct unpause |
| Local git reset/clean/checkout on **allowlisted** cwd | Naked / null-issueId wake |
| ACL fix for **node uid 995** on allowlisted cwd | `HEARTBEAT_SCHEDULER_ENABLED=true` |

Hard rules:

1. **Dry-run default.** Mutations require `--apply`.
2. **Issue-bound wake only** — `payload.issueId` must be a UUID.
3. **HEARTBEAT_SCHEDULER stays false** under controlled-swarm.
4. **Path allowlist** — only under:
   - `/opt/data/workspace/`
   - `/opt/paperclip/hermes-execution-state/workspace/`  
   (override for tests: `PLANE_STEWARD_PATH_ROOTS=root1:root2`)
5. **Exclusive-writer** for local git/ACL recipes — set  
   `PLANE_STEWARD_EXCLUSIVE_WRITER=1` after confirming hostctl / campaign pin.
6. Prefer **heartbeat-run `errorCode`** over UI `company_frozen` text (W8).

## Recipes

| id | When | Action |
|----|------|--------|
| `dirty-tree-clean` | `workspace_admit.dirty_tree` | `git reset --hard` + `git clean -fdx` |
| `wrong-head-rebase` | `head_mismatch` / branch-as-ref | detach checkout **exact 40-char SHA** |
| `acl-fix` | cwd not readable by runner | chmod + setfacl for uid **995** |
| `readmit-budget-bound-wake` | budget / bankruptcy / cancel&lt;5s | attach budget → hostctl READMIT one UUID → bound wake |
| `never-enable-global-heartbeat-scheduler` | scheduler true / death spiral | force **false** only; refuse enable |
| `null-issueId-wake-reject` | null issueId / false company_frozen | re-issue bound wake; **no** company unfreeze |

Machine catalog: [`recipes.json`](./recipes.json) (canonical). Human twin: [`recipes.yaml`](./recipes.yaml).

## Detect

```bash
# From a heartbeat-run snapshot (preferred — has errorCode)
python3 detect.py --run-json /tmp/run.json

# From free-text logs
python3 detect.py --log-file /var/log/paperclip-gloops/….log

# From events JSON/JSONL
python3 detect.py --events-file /tmp/events.jsonl

# Optional live API (needs PAPERCLIP_API_BASE [+ TOKEN])
PAPERCLIP_API_BASE=https://… python3 detect.py --from-api
```

Stdout: JSON report with `matches[]` and `recommendedRecipes[]`.

## Apply (dry-run default)

```bash
cd gloops-distribution/deploy/hermes/plane-steward

python3 apply_recipe.py --list

# Dry-run dirty tree
PLANE_STEWARD_PATH_ROOTS=/opt/data/workspace \
PLANE_STEWARD_EXCLUSIVE_WRITER=1 \
python3 apply_recipe.py --recipe dirty-tree-clean \
  --param cwd=/opt/data/workspace/gloops-ui-main

# Apply wrong-head (exact SHA required)
PLANE_STEWARD_PATH_ROOTS=/opt/data/workspace \
PLANE_STEWARD_EXCLUSIVE_WRITER=1 \
python3 apply_recipe.py --apply --recipe wrong-head-rebase \
  --param cwd=/opt/data/workspace/gloops-ui-main \
  --param expectedSha=f5c08533aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

# READMIT + budget + bound wake
PAPERCLIP_API_BASE=https://board… \
PAPERCLIP_API_TOKEN=… \
python3 apply_recipe.py --apply --recipe readmit-budget-bound-wake \
  --param issueId=a2b3db2c-9fbe-457f-96bd-bb6c643029b3 \
  --param agentId=<wren-agent-uuid> \
  --param 'hostctlIdentity={"agentSlug":"plane-steward","sessionId":"s1","missionId":"c5"}'

# Null issueId — re-issue bound wake only
PAPERCLIP_API_BASE=https://board… \
python3 apply_recipe.py --apply --recipe null-issueId-wake-reject \
  --param issueId=… --param agentId=…
```

Hostctl binary: `../paperclip-hostctl.py` (override `PLANE_STEWARD_HOSTCTL`).
Runtime env for READMIT lists: `/etc/paperclip-gloops/runtime.env`
(`PLANE_STEWARD_RUNTIME_ENV` override).

## Sentinel wiring (advisory → closed loop)

Today Sentinel is **advisory** (`heartbeat.enabled: false` until A1 authority).
Promotion path is documented in [`sentinel-plane-steward.md`](./sentinel-plane-steward.md).

Summary:

1. Sentinel heartbeat (or cron) runs `detect.py --from-api` / log tail.
2. For each `recommendedRecipes` entry, Sentinel proposes **one** recipe with
   params filled from the matched issue/run (never bulk).
3. Gate: human or allowlisted auto-apply policy calls  
   `apply_recipe.py --apply --recipe …` **only** for catalog ids.
4. Receipt: stdout JSON + hostctl journal + board comments.
5. Sentinel must **not** call Induct, unfreeze whole company, or enable scheduler.

## Related

- Track A1 charter: swarm plane operational (Sentinel promotion)
- Track C workspace admit checklist (product C1–C4)
- C6 `../repo-bootstrap/` — materialize repo@SHA when fetch fails
- C7 `../pws-catalog/` — standing PWS refresh to full SHAs
- Hostctl: `../paperclip-hostctl.py` + `../HOST_WRITER_LOCK.md`

## Tests

```bash
python3 -m unittest detect_test.py apply_recipe_test.py -v
```
