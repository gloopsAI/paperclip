# Public GitHub webhook runbook

This boundary admits one public GitHub event into the private Paperclip pilot:
`POST https://hermes.gloops.ai/github-webhooks/paperclip-check-suite` with
`X-GitHub-Event: check_suite`. The existing Hermes dashboard remains protected
by Basic Auth. The receiver binds only to `127.0.0.1:8766`, verifies the exact
request body with GitHub's `X-Hub-Signature-256` HMAC, rejects empty, malformed,
non-completed, or structurally invalid check-suite payloads before Paperclip
persistence, and forwards only to the allowlisted local Paperclip plugin
webhook. Paperclip persists `X-GitHub-Delivery` under a unique
plugin/endpoint/delivery boundary. Its pending claim, bounded worker RPC, and
terminal audit update share one database transaction: concurrent duplicates
serialize behind the unique key, while a crash rolls the uncommitted pending
claim back instead of leaving a tombstone. Successful duplicates return the
existing audit row without a second worker dispatch; one failed row may be
atomically reclaimed for provider redelivery. `X-GitHub-Delivery` is also the
stable plugin `requestId`, so the plugin's atomic delivery claim suppresses a
replayed side effect if the worker completed immediately before a host crash.

## Authority and secrets

- Use a freshly generated HMAC for each install or rollback rehearsal.
- Pass the HMAC on standard input to the deployer and configure the identical
  value in Paperclip and the one-repository GitHub webhook. Never place it in a
  command argument, log, receipt, shell history, or repository file.
- The source file is root-only at `/etc/paperclip-gloops/github-webhook-hmac`;
  systemd presents a private credential copy to the dynamic receiver user.
- This receiver grants no generic HTTP proxy, shell, GitHub API, repository, or
  Paperclip API authority.

## Community alignment and retirement

Upstream [Paperclip PR #5067](https://github.com/paperclipai/paperclip/pull/5067)
proposes a host-owned GitHub HMAC prefilter for plugin webhooks. It is open and
is not present in the selected GLoops base. This localhost receiver is therefore
a thin downstream transport and pre-persistence rejection boundary, not a new
orchestrator. Retire it when the selected upstream base ships equivalent
pre-persistence body-size and signature enforcement and the pilot proves the
direct Caddy-to-plugin path with the same invalid-signature, genuine-delivery,
duplicate, rollback, and dashboard-isolation evidence.

## Install

Use files from one reviewed, merged Paperclip commit. Copy them to root-readable
temporary files on the pilot, then run:

```sh
umask 077
read -r -s WEBHOOK_HMAC
printf '%s' "$WEBHOOK_HMAC" | sudo python3 github-webhook-receiver-deploy.py install \
  --transaction-id "tx-$(date -u +%Y%m%dT%H%M%SZ)-public-webhook" \
  --receiver-source ./github-webhook-receiver.py \
  --unit-source ./paperclip-github-webhook-receiver.service \
  --route-source ./github-webhook-caddy-route.txt
unset WEBHOOK_HMAC
```

The deployer validates the complete Caddy candidate before effects, durably
captures exact bytes and metadata before service mutation, starts and checks the
localhost receiver, reloads Caddy, and writes a root-only receipt beneath
`/var/lib/paperclip-gloops/webhook-receiver-transactions/`.

## Acceptance

All of the following are required:

1. `systemctl is-active paperclip-github-webhook-receiver.service` is active.
2. Local `GET http://127.0.0.1:8766/healthz` returns `{"status":"ready"}`.
3. The existing dashboard still challenges an unauthenticated request.
4. An invalid signature at the exact public path returns 401 and creates no
   Paperclip delivery.
5. A genuine GitHub `check_suite` delivery returns 200, appears once in the
   Paperclip plugin dashboard, and its duplicate delivery ID remains idempotent.
6. No other public path bypasses the existing Basic Auth boundary.

A hand-crafted signed request proves cryptographic plumbing but does not replace
the genuine GitHub delivery requirement.

## Rollback

Use the transaction ID printed by the install receipt:

```sh
sudo python3 github-webhook-receiver-deploy.py rollback \
  --transaction-id tx-YYYYMMDDTHHMMSSZ-public-webhook
```

The rollback claim is exclusive and durable before effects. Rollback restores
or removes every receiver, unit, secret, and Caddy artifact with its exact prior bytes, uid, gid, and mode; reloads systemd and Caddy; restores prior receiver
enablement/activity; then writes a `restored` receipt. Any mismatch produces a
root-only `rollback_failed` receipt and blocks a success claim.

Delete the GitHub webhook and the corresponding Paperclip secret when the
receiver is rolled back. Retain the transaction directory and the separate
Paperclip/GitHub delivery evidence as the operational receipt package.
