# Hermes dark deployment envelope

This directory installs the GLoops-owned Paperclip image on Hermes without activating it. The installer is deliberately fail-closed: it installs one immutable digest, removes the activation marker, disables legacy Paperclip/Hermes services, and masks the production service.

## Guarantees while dark

- No Paperclip container, agent, heartbeat, routine, scheduler, or related timer is running.
- The service cannot start without both an operator-created activation marker and an explicit unmask/enable action.
- Tailnet-only HTTPS 8443 is configured through Tailscale Serve without Funnel. While dark it returns an unavailable-backend response because no Paperclip container or loopback HTTP listener exists.
- Grok/xAI API credentials are neither configured nor mounted. Any later Grok execution must use the separately governed Grok CLI path.
- Installed Paperclip plugin packages are mounted read-only; provider credentials and host workspaces are not mounted.
- The exact image is pinned by digest. CPU, memory, PID, concurrency, temporary storage, and container-log bounds are enforced at runtime. Persistent state has a 10 GiB admission ceiling and a 10 GiB host free-space reserve.
- Failure notifications are event-driven through the existing private Slack and AgentMail transports; no polling timer is installed.

## Install dark

First capture and validate an offline rollback backup while both Paperclip services are inactive:

```bash
sudo ./backup-dark.sh
```

Then run:

```bash
sudo ./install-dark.sh
```

The installation succeeds only if `verify-dark.sh` proves that the service is masked, the activation marker is absent, no container or listener exists, and related services/timers remain inactive.

Release `2026.713.0-gloops.2` is accepted for a later bounded pilot, not proven by one. Its compiled control-plane runtime contains no coding-agent CLI or build/test toolchain. The exact digest's raw Trivy inventory contains 26 HIGH/CRITICAL occurrences (16 unique IDs): all four application CRITICAL matches and three application HIGH matches are stale `0.3.1` metadata for repaired source paths with named regression tests, while the two remaining operating-system CRITICAL matches are not affected because Archive::Tar is absent and the published runtimes are 64-bit. The versioned OpenVEX ledger preserves those dispositions without hiding the raw scan. There is no known reachable, unmitigated critical finding; remaining HIGH operating-system matches stay visible for continuing base-image maintenance. This security acceptance does not activate Paperclip or satisfy the separate quality-first SDLC pilot.

## Rollback evidence

Validate a backup without mutating the host:

```bash
sudo ./rollback.sh --check /opt/paperclip/backups/dark-install-YYYYMMDDTHHMMSSZ
```

`--restore` is a reserved operator action. It restores the prior state and legacy unit definition but intentionally leaves every Paperclip service disabled.

## Reserved pilot activation

Activation is not part of dark installation. A later operator-approved quality pilot must, in order:

1. pass the backup, release, and dark-state receipts;
2. record the vulnerability reachability/fixability disposition and show no unmitigated activation-blocking finding;
3. re-verify tailnet-only HTTPS on port 8443, with no Funnel exposure;
4. prove Maximum Token Efficiency remains default-off and remove or disable every Grok/xAI API configuration; later Grok work may use only the separately governed CLI path;
5. create `/etc/paperclip-gloops/ACTIVATION_APPROVED` containing the approval receipt identifier;
6. unmask and start `paperclip-gloops.service` explicitly;
7. prove authenticated health, zero initial agent/routine activity, and failure-alert delivery before issuing work.

The activation marker alone is insufficient because the unit remains masked after installation.
