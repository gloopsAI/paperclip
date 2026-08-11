# Induct publication path

There is exactly one authorized path: the ADR-0019 registered root-owned GitHub
push broker. There is no host poller, root CLI bypass, lease-root request file,
or direct token-minting publisher.

## Preconditions

Paperclip must durably create the root authorization for one canonical run. It
binds the issue/company/agent/run identities, repository, expected old commit,
leased non-default branch, deadline, and optional **draft-only** pull request.
After reconciling that authorization with live Paperclip facts and the client's
validated object closure, the broker issues a one-use lease binding the exact
new commit, nonce, and idempotency allocation. The broker—not the agent—owns
branch and PR metadata. Missing, expired, replayed, or disagreeing
authorization fails before token mint.

## Agent step (inside the assigned Hermes run)

After committing and verifying the exact worktree head:

```bash
test -n "$PAPERCLIP_RUN_ID"
git -C "$CWD" status --porcelain=v1 --untracked-files=all  # must be empty
git -C "$CWD" rev-parse HEAD                              # exact authorized head
node /opt/data/bin/github-push-tool.bundle.cjs client \
  --run-id "$PAPERCLIP_RUN_ID" \
  --repo-dir "$CWD"
```

The unprivileged client receives no credential. It packages the exact object
closure and calls the Unix-socket broker. The broker independently resolves
Paperclip and root authorization, validates the closure, journals the leased
mutation, mints a memory-only token, reconciles uncertain responses without a
second write, and emits the durable push/draft-PR receipt.

## Forbidden paths

- writing a pending request under a repository or lease root;
- a host timer/poller that infers repository, branch, or PR authority;
- running a publisher as root against an agent-controlled checkout;
- direct App token minting, `git push`, `gh pr create`, non-draft PR, merge, or
  default-branch mutation.

Host operators may observe broker health and receipts. They do not execute the
mutation for an agent.

## P3 verify
```bash
sudo /usr/local/lib/paperclip-gloops/bin/verify-induct-lease.sh
```
