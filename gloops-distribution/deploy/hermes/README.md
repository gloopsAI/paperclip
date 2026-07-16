# Hermes dark deployment envelope

This directory installs the GLoops-owned Paperclip image on Hermes without activating it. The installer is deliberately fail-closed: it installs one immutable digest, removes the activation marker, disables legacy Paperclip/Hermes services, and masks the production service.

## Guarantees while dark

- No Paperclip container, agent, heartbeat, routine, scheduler, or related timer is running.
- The service cannot start without both an operator-created activation marker and an explicit unmask/enable action.
- Tailnet-only HTTPS 8443 is configured through Tailscale Serve without Funnel. While dark it returns an unavailable-backend response because no Paperclip container or loopback HTTP listener exists.
- Grok/xAI API credentials are neither configured nor mounted. Any later Grok execution must use the separately governed Grok CLI path.
- The bounded-pilot sidecar receives only the Ollama Cloud credential and declares no fallback provider. Codex remains available outside this isolated profile but cannot be selected or automatically reached by the pilot.
- GitHub publication uses the repository-installed `GLoops Autonomous Delivery` GitHub App. Its private key stays root-only on the host. Hermes and Paperclip independently mint, own, refresh, and revoke their own one-hour installation tokens so either service can restart without invalidating the other. Both tokens are restricted to the private `gloopsAI/gloops-paperclip-plugin` repository; the Paperclip read token is rotated only into the exact company secret declared by the trusted projector's persisted `githubTokenSecretRef` binding. Tokens are revoked and removed during shutdown. No Zach user credential or GitHub organization seat is mounted into either runtime.
- Installed Paperclip plugin packages are mounted read-only. Provider credentials are never mounted. The Hermes execution workspace alone is mounted read-only so Paperclip can independently observe Git HEAD and dirtiness; all other Hermes state remains inaccessible.
- Hermes container initialization resets the writable workspace owner. The sidecar start barrier therefore waits for authenticated health, restores only the Paperclip observer group on the workspace root, and proves uid:gid `995:985` can read the exact plugin pilot repository before Paperclip activation can pass preflight.
- Paperclip has its own bounded post-start barrier. `systemctl start paperclip-gloops.service` does not succeed until Docker health and the host loopback health boundary both pass, so an activator cannot race container creation when issuing the one authorized wake.
- The exact image is pinned by digest. CPU, memory, PID, concurrency, temporary storage, and container-log bounds are enforced at runtime. Persistent state has a 10 GiB admission ceiling and a 10 GiB host free-space reserve.
- The sidecar drops all Linux capabilities and restores only `CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETUID`, and `KILL`. `KILL` is required solely so the root s6 supervisor can signal the uid-10000 gateway child during bounded graceful shutdown; the zero-work rehearsal rejects a forced or failed stop.
- Hermes command scanning uses Tirith 0.3.3 from a root-owned, read-only mount with pinned archive and binary SHA-256 digests. It is provisioned during the explicit dark-install release step; runtime auto-download is disabled by the explicit scanner path. The execution image is a deterministic, network-free derivative of the exact upstream Hermes image with one source-guarded correction: the scanner circuit breaker obeys `tirith_fail_open: false`. Installation and every activation preflight induce the full three-failure circuit-open sequence and reject the image unless the next dangerous command remains blocked.
- Failure notifications are event-driven through the existing private Slack and AgentMail transports; no polling timer is installed.
- A claim-time task execution gate applies one atomic run, retry, token, and wall-time budget across scheduler, continuation, and recovery paths. The bounded-pilot profile permits exactly one run and zero retries, with fixed task ceilings of 50,000 input tokens, 16,000 output tokens, and 3,600,000 milliseconds. Each provider invocation is separately capped at 30,000 input tokens, 8,000 output tokens, eight turns, and 32 tool calls. An exhausted task is terminally denied before adapter invocation; only an explicit user-authored reset epoch opens a new budget.

The container receives the existing host state at
`/home/paperclip/.paperclip`, and the runtime explicitly sets
`PAPERCLIP_HOME=/home/paperclip/.paperclip`. Keep the environment and
bind-mount target in lockstep. The target intentionally matches the compiled
runtime's safe fallback as well, so logger initialization cannot escape the
writable state mount under the read-only root filesystem.
The image's `node` passwd entry and the service's explicit runtime identity are
both `995:985`, matching the host `paperclip` owner; keep all three in lockstep
so native PostgreSQL user discovery and persisted-state permissions remain valid.

## Install dark

Build the narrow Hermes execution derivative from the already present exact
base image. The build has no network and prints the immutable digest. The
release sources pin that digest; a different result is release drift and must
be reviewed before installation.

```bash
sudo ./build-hermes-execution-image.sh
sudo ./verify-hermes-command-security-image.sh \
  hermes-agent-gloops@sha256:2c1525ddfbead27aefe89754bd24fde90ed58c8ee937393b660ba89695f7764d
```

First capture and validate an offline rollback backup while both Paperclip services are inactive:

```bash
sudo ./backup-dark.sh
```

Then run:

```bash
sudo ./install-dark.sh
```

The installation succeeds only if `verify-dark.sh` proves that the service is masked, the activation marker is absent, no container or listener exists, and related services/timers remain inactive.

Release `2026.715.0-gloops.8` image `sha256:4ad5881969635daec4194f7bb78df22a1768df4f74f574cc935647d24750a23d` was built from merge `ebaa929944fbdc6bb5fd5bec11d68e20da01ab13`, passed workflow `29442561026`, and has GitHub build-provenance attestation. It retains the certified Paperclip-plugin-to-Hermes-Gateway execution seam and adds the independently accepted private GitHub App credential boundary: exact company/plugin/config-path secret binding, separate Hermes and projector token ownership, official stateless installation-token compatibility, and root-only fail-closed cleanup retention. The release remains a bounded dark-install candidate; it does not authorize Paperclip work, Hermes scheduling, provider execution, or MTE. A zero-work rehearsal must independently prove encrypted-secret rotation, restart isolation, revocation, and restoration to the fully verified dark state before any later activation.

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
