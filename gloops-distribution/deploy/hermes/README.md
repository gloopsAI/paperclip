# Hermes dark deployment envelope

This directory installs the GLoops-owned Paperclip image on Hermes without activating it. The installer is deliberately fail-closed: it installs one immutable digest, removes the activation marker, disables legacy Paperclip/Hermes services, and masks the production service.

## Guarantees while dark

- No Paperclip container, agent, heartbeat, routine, scheduler, or related timer is running.
- The service cannot start without both an operator-created activation marker and an explicit unmask/enable action.
- No host port is opened. Paperclip HTTP will bind to loopback only when a later pilot is approved.
- Grok/xAI API credentials are neither configured nor mounted. Any later Grok execution must use the separately governed Grok CLI path.
- Installed Paperclip plugin packages are mounted read-only; provider credentials and host workspaces are not mounted.
- The exact image is pinned by digest. CPU, memory, PID, concurrency, temporary storage, and container-log bounds are enforced at runtime. Persistent state has a 10 GiB admission ceiling and a 10 GiB host free-space reserve.
- Failure notifications are event-driven through the existing private Slack and AgentMail transports; no polling timer is installed.

## Install dark

First capture and validate an offline rollback backup. Then run:

```bash
sudo ./install-dark.sh
```

The installation succeeds only if `verify-dark.sh` proves that the service is masked, the activation marker is absent, no container or listener exists, and related services/timers remain inactive.

Dark installation is not release-security acceptance. The 2026-07-13 Trivy inventory contains high/critical version matches that require a recorded reachability/fixability disposition. Several Paperclip application advisories match the stale `0.3.1` package metadata even though their repaired authorization paths and regression tests are present in this source and artifact; operating-system and bundled-tool findings remain separate. No pilot may activate this digest while any reachable, unmitigated critical finding remains unresolved.

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
3. configure tailnet-only HTTPS on port 8443, with no Funnel exposure;
4. prove Maximum Token Efficiency remains default-off and remove or disable every Grok/xAI API configuration; later Grok work may use only the separately governed CLI path;
5. create `/etc/paperclip-gloops/ACTIVATION_APPROVED` containing the approval receipt identifier;
6. unmask and start `paperclip-gloops.service` explicitly;
7. prove authenticated health, zero initial agent/routine activity, and failure-alert delivery before issuing work.

The activation marker alone is insufficient because the unit remains masked after installation.
