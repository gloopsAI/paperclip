# Option A — Induct-only GitHub App (standing multi-org write/read)

**Principle:** Paperclip write App stays frozen to **gloopsAI/***.  
Induct product uses a **separate** App installed only on **InductAI**.

## Zach (or org admin) — create + install (~10 min)

### 1. Create App under InductAI org

1. Open: https://github.com/organizations/InductAI/settings/apps/new  
   (or user settings → Developer settings → GitHub Apps if you prefer user-owned; **org-owned is better**)
2. Name: e.g. `gloops-induct-swarm` (any unique name)
3. Homepage: your internal docs URL or `https://gloops.ai`
4. **Webhook:** uncheck Active (not needed for mint/clone/push)
5. **Repository permissions:**
   - Contents: **Read and write** (clone + push branches)
   - Pull requests: **Read and write** (open PRs)
   - Metadata: **Read-only** (required)
   - (Optional later) Checks: Read-only
6. **Where can this App be installed?** Only on this account / selected repos
7. Create App → **Generate a private key** → download `.pem`
8. Note **App ID** on the app settings page

### 2. Install on InductAI/induct

1. App settings → **Install App** → InductAI  
2. **Only select** `InductAI/induct` (add `induct-knowledge` only if agents must write there — default: induct only)  
3. Note **Installation ID** from the URL:  
   `https://github.com/organizations/InductAI/settings/installations/<INSTALLATION_ID>`

### 3. Repository numeric ID

On hermes (or any machine with `gh` that sees the repo):

```bash
gh api repos/InductAI/induct --jq .id
# known at lease time: 1044809910
```

### 4. Install secrets on hermes (root)

```bash
sudo mkdir -p /etc/paperclip-gloops/github-app-induct
sudo mv ~/Downloads/gloops-induct-swarm.*.pem \
  /etc/paperclip-gloops/github-app-induct/private-key.pem
sudo chown root:root /etc/paperclip-gloops/github-app-induct/private-key.pem
sudo chmod 0400 /etc/paperclip-gloops/github-app-induct/private-key.pem

sudo tee /etc/paperclip-gloops/github-app-induct.json >/dev/null <<'JSON'
{
  "appId": REPLACE_APP_ID,
  "installationId": REPLACE_INSTALLATION_ID,
  "repositoryId": 1044809910,
  "repository": "InductAI/induct",
  "privateKeyPath": "/etc/paperclip-gloops/github-app-induct/private-key.pem"
}
JSON
sudo chown root:root /etc/paperclip-gloops/github-app-induct.json
sudo chmod 0600 /etc/paperclip-gloops/github-app-induct.json
```

### 5. Prove mint

```bash
sudo python3 /usr/local/lib/paperclip-gloops/bin/induct-github-app.py status
# expect "ok": true, "mintRead": "ok"
```

### 6. Point lease refresh at App

```bash
# refresh prefers Induct App when config present; falls back to root gh
sudo python3 /usr/local/lib/paperclip-gloops/bin/refresh-induct-lease.py --apply --only-if-stale
```

## What this enables

| Capability | Before A | After A installed |
|------------|----------|-------------------|
| Execute on lease / admit | Yes | Yes |
| Materialize without root `gh` | Root gh only | **Induct App** |
| Agent PR push (later wiring) | No standing path | **Same App write token** |
| Paperclip gloops write App | Unchanged | **Unchanged** |

## Explicit non-goals

- Do **not** add InductAI to paperclip `github-app-credentials.py` allowlist  
- Do **not** reuse paperclip installation id for Induct  
- Do **not** install this App on all InductAI repos unless required  

## After status is green

Tell Grok Lead: “Induct App status ok” — next slice can wire agent push through this App for Induct PRs only.
