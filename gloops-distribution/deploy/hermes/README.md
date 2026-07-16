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
- The isolated handshake does not publish a Docker host port: Docker omits host publication when a container is attached only to an `--internal` bridge. Its readiness barrier instead proves the bridge is still internal, the container still owns fixed address `172.30.241.4`, and the host can reach `/api/health` directly over that bridge while preserving the allowed loopback Host value. The first-position handshake firewall admits only conntrack-proven responses from that fixed address and port to a host-initiated health request; unsolicited Paperclip traffic remains terminally rejected. The release workflow rehearses this exact bridge-plus-firewall path and proves removing the response grant makes readiness fail.
- The handshake control plane sets `PAPERCLIP_OPERATOR_ONLY_MODE=true`. It keeps the existing authenticated bind and embedded database available for explicit board requests while preventing startup reconciliation, heartbeat/routine scheduling, plugin coordinators and workers, automatic backups, company deletion, and telemetry. A normal activation does not inherit this handshake-only override.
- The exact image is pinned by digest. CPU, memory, PID, concurrency, temporary storage, and container-log bounds are enforced at runtime. Persistent state has a 10 GiB admission ceiling and a 10 GiB host free-space reserve.
- The sidecar drops all Linux capabilities and restores only `CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETUID`, and `KILL`. `KILL` is required solely so the root s6 supervisor can signal the uid-10000 gateway child during bounded graceful shutdown; the zero-work rehearsal rejects a forced or failed stop.
- Hermes command scanning uses Tirith 0.3.3 from a root-owned, read-only mount with pinned archive and binary SHA-256 digests. It is provisioned during the explicit dark-install release step; runtime auto-download is disabled by the explicit scanner path. The execution image is a network-free derivative of the exact upstream Hermes image with one source-guarded correction: the scanner circuit breaker obeys `tirith_fail_open: false`. The accepted image is distributed as a root-only, SHA-256-pinned Docker archive and copied into every cold rollback backup, so installation does not depend on a mutable tag or a locally reproducible rebuild. Installation and every activation preflight induce the full three-failure circuit-open sequence and reject the image unless the next dangerous command remains blocked.
- Failure notifications are event-driven through the existing private Slack and AgentMail transports; no polling timer is installed.
- A claim-time task execution gate applies one atomic run, retry, token, and wall-time budget across scheduler, continuation, and recovery paths. The bounded-pilot profile permits exactly one run and zero retries, with fixed task ceilings of 50,000 input tokens, 16,000 output tokens, and 3,600,000 milliseconds. Each provider invocation is separately capped at 30,000 input tokens, 8,000 output tokens, eight turns, and 32 tool calls. An exhausted task is terminally denied before adapter invocation; only an explicit user-authored reset epoch opens a new budget.
- Provider transport certification uses separate `paperclip-hermes-handshake` and `paperclip-gloops-handshake` units. The exact Hermes profile resolves the API-server surface to zero tools, pins the accepted model context length so initialization performs no Ollama metadata probe, and enforces one turn with one total provider attempt: one application attempt, zero SDK retries, and zero primary-transport recovery attempts. A handshake-only, read-only Python guard applies the total ceiling at httpx's sync and async per-request transport chokepoints, rejects every non-Ollama remote HTTP destination, and disables Hermes' otherwise automatic final primary-client recovery cycle; any recovery path requesting a second actual transport is rejected locally, and general execution never mounts that guard. Both handshake containers run at fixed addresses on a dedicated IPv4-only Docker `--internal` network with unusable external DNS, exact `/etc/hosts` peers, forwarding denied outside that subnet, and host access denied except from Hermes to one proxy port. The dynamically sandboxed host proxy accepts one tunnel only from the fixed Hermes address, requires the exact `CONNECT ollama.com:443` authority, parses the first TLS ClientHello, requires exact `ollama.com` SNI, resolves only that name to one global IPv4 address, and then relays the tunnel. Pre-claim concurrency is capped at four in-process and again by systemd task, memory, CPU, and file-descriptor ceilings. This governs subprocess/background traffic without trusting proxy compliance or a shared destination IP. The egress service is bound to the handshake lifecycle; its firewall chains, internal network, state, and listener are removed fail-closed on stop, dark install, and rollback. Cleanup first proves Docker topology is inspectable, and the Hermes unit retries reconciliation after its container is removed so an unexpected proxy exit cannot strand the boundary. The handshake has no repository, workspace, session, or GitHub mount, persists no runtime state, publishes no host port, and stops after at most 15 minutes. The matching Paperclip unit mounts no execution workspace and never invokes the GitHub credential broker. All three units consume one-use approval markers or their dependency, clean active state on every terminal path, conflict with their general-execution counterparts, are independently masked while dark, and cannot become general execution workers.

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

`build-hermes-execution-image.sh` is a release-authoring helper, not an install
dependency. Release authors use it to build the narrow derivative with no
network and then export one accepted candidate to the exact root-only archive
pinned by `load-hermes-execution-image.sh`. Operators do not rebuild during
installation; the archive is the content-addressed release and recovery
artifact.

```bash
sudo ./load-hermes-execution-image.sh
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

Release `2026.716.0-gloops.9` image `sha256:877b53e68de2fb2ab8935cebc9e590f6e63db41406cc8a030b7e0dc0c494a664` was built from merge `ed0c817217d00f41e9eaf13f389a28c855ad6b65`, passed workflow `29516407171`, and has GitHub build-provenance attestation. It retains the certified execution and private GitHub App credential boundaries while adding the independently accepted internal-only handshake control-plane reachability path, operator-only startup suppression, conntrack-scoped firewall response admission, and live bridge/firewall regression proof. The release remains a bounded dark-install candidate; it does not authorize Paperclip work, Hermes scheduling, provider execution, recurring autonomy, or MTE. A zero-provider handshake rehearsal must prove host reachability, coordinator/worker inertness, zero created work, zero provider traffic, graceful shutdown, and restoration to the fully verified dark state before one separately chartered provider handshake may be considered.

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
