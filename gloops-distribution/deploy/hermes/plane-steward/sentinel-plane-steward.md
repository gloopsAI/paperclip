# Sentinel → Plane Steward promotion stub (C5 / A1)

Status: **advisory today**. This document is the wiring contract for promoting
Sentinel (or a sibling “Plane Steward” agent) from memo-writer to allowlisted
closed-loop repair.

## Current state

| Component | State |
|-----------|--------|
| Sentinel agent | Present; heartbeat often on for observation |
| Closed-loop authority | **Off** — no automatic hostctl / wake |
| This recipe pack | Landed under `deploy/hermes/plane-steward/` |
| Product admit codes (C1–C4) | Surface `workspace_admit.*` for detectors |

## Promotion steps (when A1 authority is granted)

1. **Detect loop** (no LLM required for v0):
   ```bash
   PAPERCLIP_API_BASE=… PAPERCLIP_API_TOKEN=… \
     python3 /opt/…/plane-steward/detect.py --from-api \
     > /run/paperclip-gloops/plane-steward/last-detect.json
   ```
   Prefer binding detect to heartbeat-run `errorCode` fields, not UI copy.

2. **Map one match → one recipe** using `recommendedRecipes` and issue UUID from
   the match. Never chain more than one mutating recipe without a new detect.

3. **Param assembly** (Sentinel skill / tool):
   - `cwd` from issue `currentExecutionWorkspace.cwd` or PWS cwd
   - `expectedSha` from packet Exact head / `repoRef` (must be 40-char)
   - `issueId` + `agentId` from assignment
   - Refuse if `issueId` null → use `null-issueId-wake-reject` only after a real UUID is known

4. **Apply gate**:
   - Default: write a board comment with dry-run JSON (advisory).
   - Auto-apply (future): only if campaign flag `planeSteward.autoApply=true`
     **and** recipe id ∈ allowlist **and** exclusive-writer held.
   ```bash
   PLANE_STEWARD_EXCLUSIVE_WRITER=1 \
     python3 apply_recipe.py --apply --recipe <id> --param …
   ```

5. **Receipt**:
   - Persist apply JSON under `/var/log/paperclip-gloops/plane-steward/`
   - hostctl journal already chains READMIT mutations
   - Comment on issue: recipe id, dryRun=false, executed[]

6. **Exit criteria (A1)**: two injected faults auto-recover without human:
   - null-issueId wake → bound re-wake → `in_progress`
   - wrong workspace head → wrong-head-rebase or bootstrap+rebase → admit green

## Explicit non-goals for Sentinel

- Enabling `HEARTBEAT_SCHEDULER_ENABLED`
- Induct product unpause
- Bulk READMIT of all frozen issues
- Editing gloops-ui / paperclip product source
- Using branch name `main` as expected head

## Tool surface (future Hermes skill)

```
plane_steward.detect  → wraps detect.py
plane_steward.apply   → wraps apply_recipe.py (dry-run default; apply flag gated)
plane_steward.list    → recipes.json ids
```

Until the skill exists, operators and Lead run the Python CLIs on hermes host
(root/hostctl path) with the env gates above.
