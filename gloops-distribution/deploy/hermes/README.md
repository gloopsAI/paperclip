# Hermes dark deployment envelope

This directory installs the GLoops-owned Paperclip image on Hermes without activating it. The installer is deliberately fail-closed: it installs one immutable digest, removes the activation marker, disables legacy Paperclip/Hermes services, and masks the production service.

## Guarantees while dark

- No Paperclip container, agent, heartbeat, routine, scheduler, or related timer is running.
- The service cannot start without both an operator-created activation marker and an explicit unmask/enable action.
- Tailnet-only HTTPS 8443 is configured through Tailscale Serve without Funnel. While dark it returns an unavailable-backend response because no Paperclip container or loopback HTTP listener exists.
- Grok/xAI API credentials are neither configured nor mounted. Any later Grok execution must use the separately governed Grok CLI path.
- The bounded-pilot sidecar receives only the Ollama Cloud credential and declares no fallback provider. Codex remains available outside this isolated profile but cannot be selected or automatically reached by the pilot.
- GitHub reads use Paperclip's root-projected, repository-scoped installation token. GitHub writes use a separate root-owned one-run/one-push broker. Hermes receives neither a GitHub token nor the GitHub App key: its uid-10000 client submits one content-addressed commit closure over a peer-authenticated Unix socket, and a uid-10001 sandboxed worker receives a sealed, short-lived installation credential only after the broker binds live Paperclip run, issue, workspace, repository, branch, and authorization facts. The exact allowed ref is `refs/heads/paperclip/<run-id>/calibration`; force, deletion, multi-ref, default-branch, pull-request, and second-push mutations are denied. Root reconciles uncertain outcomes against GitHub and posts prepared plus terminal receipts back to Paperclip for atomic settlement. No Zach user credential or GitHub organization seat is mounted into either runtime.
- Installed Paperclip plugin packages are mounted read-only. Provider credentials are never mounted. The Hermes execution workspace alone is mounted read-only so Paperclip can independently observe Git HEAD and dirtiness; all other Hermes state remains inaccessible.
- Hermes container initialization resets the writable workspace owner. The sidecar start barrier therefore waits for authenticated health, restores only the Paperclip observer group on the workspace root, and proves uid:gid `995:985` can read the exact plugin pilot repository before Paperclip activation can pass preflight.
- Paperclip has its own bounded post-start barrier. `systemctl start paperclip-gloops.service` does not succeed until Docker health and the host loopback health boundary both pass, so an activator cannot race container creation when issuing the one authorized wake.
- The isolated handshake does not publish a Docker host port: Docker omits host publication when a container is attached only to an `--internal` bridge. Its readiness barrier instead proves the bridge is still internal, the container still owns fixed address `172.30.241.4`, and the host can reach `/api/health` directly over that bridge while preserving the allowed loopback Host value. The first-position handshake firewall admits only conntrack-proven responses from that fixed address and port to a host-initiated health request; unsolicited Paperclip traffic remains terminally rejected. The release workflow rehearses this exact bridge-plus-firewall path and proves removing the response grant makes readiness fail.
- The handshake control plane sets `PAPERCLIP_OPERATOR_ONLY_MODE=true`. It keeps the existing authenticated bind and embedded database available for explicit board requests while preventing startup reconciliation, heartbeat/routine scheduling, plugin coordinators and workers, automatic backups, company deletion, and telemetry. A normal activation does not inherit this handshake-only override.
- The exact image is pinned by digest. CPU, memory, PID, concurrency, temporary storage, and container-log bounds are enforced at runtime. Persistent state has a 10 GiB admission ceiling and a 10 GiB host free-space reserve.
- The sidecar drops all Linux capabilities and restores only `CHOWN`, `DAC_OVERRIDE`, `SETGID`, `SETUID`, and `KILL`. `KILL` is required solely so the root s6 supervisor can signal the uid-10000 gateway child during bounded graceful shutdown; the zero-work rehearsal rejects a forced or failed stop.
- Hermes command scanning uses Tirith 0.3.3 from a root-owned, read-only mount with pinned archive and binary SHA-256 digests. It is provisioned during the explicit dark-install release step; runtime auto-download is disabled by the explicit scanner path. The execution image is a network-free derivative of the exact upstream Hermes image with one source-guarded correction: the scanner circuit breaker obeys `tirith_fail_open: false`. The accepted image is distributed as a root-only, SHA-256-pinned Docker archive and copied into every cold rollback backup, so installation does not depend on a mutable tag or a locally reproducible rebuild. Installation and every activation preflight induce the full three-failure circuit-open sequence and reject the image unless the next dangerous command remains blocked.
- Failure notifications are event-driven through the existing private Slack and AgentMail transports; no polling timer is installed.
- A claim-time task execution gate applies one atomic run, retry, token, and wall-time budget across scheduler, continuation, and recovery paths. The controlled-swarm profile permits three runs and two retries per task, with fixed task ceilings of 50,000 input tokens, 16,000 output tokens, and 3,600,000 milliseconds. Each provider invocation is separately capped at 30,000 input tokens, 8,000 output tokens, eight turns, and 32 tool calls. A transaction-level company gate permits no more than four running heartbeats, and a fixed campaign cutoff makes all older issues ineligible across assignment, queued-run, scheduler, continuation, watchdog, and recovery paths. An exhausted task is terminally denied before adapter invocation; only an explicit user-authored reset epoch opens a new task budget.
- The global heartbeat/routine scheduler remains disabled. The single-flight bounded execution-recovery driver is installed but remains disabled for inert activation; enabling it requires a later independently reviewed commissioning slice after queue reconciliation. When commissioned, it may only reap stale running rows, promote already-admitted scheduled retries, and drain already-admitted queued runs. Company queue pumps remain serialized for their full duration so slow drains cannot defeat cross-agent round-robin fairness; claim-time cancellation defers its follow-on drain until the owning pump and agent lock can release, preventing self-reentrant deadlock. The driver does not tick agent timers, routines, issue monitors, watchdogs, productivity reviews, or other broad reconciliation paths. The issue-created cutoff prevents historical work from becoming eligible.
- Every queued-to-running transition must obtain a receipt from the root-owned campaign deadman over its read-only Unix-socket mount. The first eligible claim atomically writes a root-owned, mode-0600, immutable epoch with an exact 24-hour deadline; later claims reuse that deadline, and service, process, host, marker, or partial-result restarts cannot renew it. Missing, malformed, mismatched, or expired receipts roll the database claim back before adapter invocation. The execution units are bound to the broker lifecycle, and its independent host monitor removes activation markers and stops Paperclip and Hermes at expiry. A new execution window requires a new operator-granted campaign identifier and a new dark-install/review cycle.
- The controlled swarm may diagnose, implement, test, independently review, and prepare rollback-ready repairs to its own runtime. It cannot mutate the root deadman state, campaign identity, service definition, credentials, authority ceilings, security boundary, or production promotion gate. Self-repair therefore produces an independently accepted promotion packet; it does not silently self-promote.
- A source change that affects the runtime ships with `PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=true`. Live preflight refuses activation until a separate release-pin change binds the accepted source merge to its published immutable image digest and flips that interlock to `false`. Source canaries are not installation proof.
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

## Disposable adapter reference certification

`pnpm smoke:hermes-gateway-reference` runs the built-in `hermes_gateway`
adapter through fresh Hermes containers and fresh Paperclip agent/issue
lifecycles against an operator-started disposable Paperclip instance and the
local OpenAI-compatible reference mock. The matrix defaults to 20 strict cold
starts and an 11-second onboarding interval so the harness respects Paperclip's
invite abuse control. It writes a non-secret JSON receipt and stops on the first
failed lifecycle. It never starts Paperclip, enables worktree execution, or
activates a production service; those remain explicit operator gates.

The 2026-07-16 upstream/fork matrix evidence is recorded in
`gloops-distribution/security/hermes-reference-certification-2026-07-16.json`.
That receipt certifies only the disposable adapter path. It deliberately does
not claim that the hardened distribution, a real provider handshake, or an SDLC
pilot has passed.

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

First capture and validate an offline rollback backup while both Paperclip
services are inactive. Backup refuses any surviving controlled-swarm
commissioning rollback journal before it creates a staging directory, because
the database and journal are one transaction boundary and the journal is not
part of the cold archive:

```bash
sudo ./backup-dark.sh
```

Then run:

```bash
sudo ./install-dark.sh
```

The installation succeeds only if `verify-dark.sh` proves that the service is masked, the activation marker is absent, no container or listener exists, and related services/timers remain inactive.

Release `2026.719.0-gloops.27` Paperclip image `sha256:3222a49849cf17c1f0a17b981369ffb59b029b6442bb726e9bf9910e1e879083` was built from merge `b7dda2871dc373dd6083291fd3c94d21fd97cc52`, passed workflow `29697134738` attempt 1, and has GitHub build-provenance attestation `36055606`; mutable tag `sha-b7dda28` is a discovery aid only. Its Hermes execution image remains `sha256:153a30048d122dfe84bc69d7710d9de77544eac7a1073caca77bdaac1e824aca`, retained in the root-only archive whose SHA-256 is `3cc435332944f18ef2e4ad043c152dfb86eaac560b9be4886876450b2e21d4d2`. This release adds the root-owned, one-run/one-push GitHub broker: Hermes receives no GitHub token; credential-free immutable-pack validation rejects symlinks and gitlinks before mint; the one write token exists only in memory; uncertain writes reconcile without replay; and the terminal broker receipt joins provider evidence in atomic settlement. It retains atomic settlement, prepared request acknowledgement, authoritative Hermes route-and-usage receipts, terminal evidence reconciliation, and the certified execution, repository, credential, WIP, historical-isolation, recovery, inert activation, exact-topology rehearsal, successor campaign identity, and fail-dark boundaries. It is a bounded dark-install candidate and does not itself authorize Paperclip work, agent unpause, provider execution, GitHub mutation, recurring autonomy, or MTE.

## One-run GitHub write broker

The broker is installed and masked with the rest of the controlled swarm. The
activation script starts it before either Paperclip or Hermes, and every stop,
deadman, rollback, and dark-install path stops and masks it. Its durable
allocation and hash-chained journal live under
`/var/lib/paperclip-gloops/github-push-broker`; ingress packs and the Unix socket
live only under `/run/paperclip-github-broker`.

The root authorization is a single-use, exact-fact receipt. It names one
Paperclip heartbeat run, company, issue, workspace, repository, mutation class,
branch ref, expected old object id, and expiry. The broker-issued lease adds the
content-addressed expected new object id and exact bundle manifest. The
accepted mutation class is `create_one_branch_ref`; the
branch must be `refs/heads/paperclip/<run-id>/calibration`, and the expected old
object id must be zero. The broker independently retrieves current Paperclip
facts before accepting the request and the GitHub App installation before
minting a credential. A durable allocation prevents another authorization or
run from claiming the same branch.

The client packs exactly the new commit and its reachable closure without
retaining ingress. Before token mint, a network-denied validation worker indexes
the root-owned, read-only pack into a disposable bare repository; it proves that
the object set is exactly the manifest set, that the declared commit resolves,
and that every tree entry is a regular file, executable file, or directory
(symlinks and gitlinks are rejected). A fresh push worker repeats those checks
against the same immutable pack and then makes one exact isomorphic-git push.
A network exception does not imply failure. The write token exists only in
broker memory and the push worker's sealed, RAM-backed systemd credential; it
is never written to durable state. Normal completion revokes it. Crash recovery waits until its
recorded expiry, mints a separate repository-scoped `contents:read` token, and
only queries the remote ref—never retries the push—before recording exactly one
terminal disposition:
`reconciled_success`, `bounded_failure`, or `conflict`. Paperclip consumes that
terminal receipt in the same atomic settlement transaction as provider
evidence, budget, cost, and run state.

This broker is not a general GitHub shell, credential vending endpoint, PR
creator, branch updater, or merge path. Expanding its mutation class, repository,
ref namespace, or invocation count is a new authority decision and requires a
separate accepted release.

## Rollback evidence

Validate a backup without mutating the host:

```bash
sudo ./rollback.sh --check /opt/paperclip/backups/dark-install-YYYYMMDDTHHMMSSZ
```

`--restore` is a reserved operator action. It restores the prior state and legacy unit definition but intentionally leaves every Paperclip service disabled.

## Controlled-swarm rehearsal and activation

Activation is not part of dark installation. After the accepted source is
published and a separate release-pin change binds its immutable digest, run the
root-only controls in this order:

```bash
sudo /usr/local/lib/paperclip-gloops/rehearse-campaign-deadman.py
sudo PAPERCLIP_ZERO_WORK_OBSERVE_SECONDS=60 \
  /usr/local/lib/paperclip-gloops/rehearse-zero-work.sh
# Write a root:root 0600, four-hour-or-shorter approval receipt bound to the
# exact approved image and rehearsal receipt path + SHA-256.
sudo /usr/local/lib/paperclip-gloops/activate-controlled-swarm.sh
```

The accelerated deadman rehearsal executes the exact installed broker against
an isolated harmless transient systemd target. It proves the logical 24-hour
epoch is root-owned, immutable, non-renewing across restart, stops the target at
expiry, and denies later admission without starting Paperclip or invoking a
provider. Activation accepts only a recent receipt bound to the exact installed
broker, stop actuator, and approved image. It consumes the one-use operator
approval only after Paperclip, Hermes, and the deadman pass their live
readiness barriers.

The activation approval schema is
`gloops.controlled-swarm-activation-approval.v1`. It authorizes only
`activate_inert_control_plane`, names campaign
`controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139`,
binds the exact approved image and rehearsal receipt path/digest, and carries
`authorizedAt` plus an `expiresAt` no more than four hours later. Dark install
and every activation attempt consume it, including failed attempts; it cannot
cross a release, rehearsal, or retry boundary.

The successor campaign identity is distinct from the preserved, expired
`controlled-swarm-20260717` epoch. Every dark verification, execution preflight,
and deadman start requires that predecessor evidence to remain root-owned,
mode `0600`, immutable, integral, expired, and bound to its original identity.
The date component is the successor identity's mint date, not its validity
window or deadline; the random suffix prevents collision with another bounded
campaign minted on the same day. The successor identity is consumed only when
its epoch file is first created at Gate 3. If this release is superseded before
that file ever exists, the unchanged identity may carry forward; after the file
exists, the identity is permanently non-renewable.

The successor release also advances the issue-creation admission floor to
`2026-07-18T23:12:22.000Z`. Work created before that instant remains
mechanically ineligible even if it was left open by the predecessor campaign.

`observe-controlled-swarm.py` is read-only. `stop-controlled-swarm.sh` removes
the runtime markers, stops the execution units, preserves any production epoch
as evidence, masks the governed units, and requires the complete dark verifier
to pass. Neither control creates work, unpauses agents, changes the roster, or
arms the campaign epoch. Inert activation also keeps
`PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false`, so explicit authenticated
admission and adapter invocation remain mechanically denied while the
activation receipt is produced. A separate independently reviewed commissioning
slice must flip that barrier after roster, queue, and provider reconciliation.

`commission-controlled-swarm.sh` is that one-use transition. It requires a
root-owned `0600` `CONTROLLED_SWARM_COMMISSIONING_APPROVED` receipt, binds it to
campaign
`controlled-swarm-repair-cell-20260718-3b40dca4278ca8b49782b623dcd9e139`,
the exact installed image, and governance
merge `3a5820722e8c6f55d6a1a730cada1cb4f1a1df77`, and verifies the exact
sixteen-identity company roster: twelve admitted Hermes roles, two paused burst
roles, the paused Fourth Pilot Engineer, and the pending Reflection Coach. Every
admitted role must have the exact timer-disabled/on-demand/concurrency-one
profile. Before unpause it replaces each admitted role's accumulated legacy
prompt with an exact role-specific compact charter and terminal protocol through
the authenticated board API. It replaces each adapter configuration with only
the gateway-native route fields, a required per-agent secret reference, and the
compact charter, removing legacy payload templates, token aliases, unused model
claims, and instruction-bundle paths. The gateway route is bound to the
execution-only Hermes sidecar; commissioning verifies the exact installed
sidecar config and policy digests that pin Ollama Cloud and
`kimi-k2.7-code`. Grok/Codex burst identities remain excluded. The image binds
those charters and route evidence. Before the first adapter
mutation, commissioning durably journals every prior adapter configuration in a
root-owned `0600` transaction file, fsyncs the file and parent directory, and
only then issues the first board API mutation. It revalidates every charter byte and route
field and records per-agent before/after sizes, content digests, aggregate
reduction, the instruction-set digest, gateway authentication shape, and
sidecar evidence. It writes a root-owned commissioning
receipt, atomically flips only the commissioning barrier, restarts Paperclip,
proves the container received `true`, revalidates the complete live roster,
charters, and route after restart, and requires the campaign epoch to remain
unarmed. Any ordinary failure or recovered interrupted transaction restores
every prior adapter configuration exactly, restores `false`, invalidates the
receipt and approval, durably removes the journal, and restarts the inert
control plane. Preflight accepts
`true` only with the fully validated receipt; Paperclip's post-start gate also
requires the exact live charter and route. Dark installation and verification
refuse an unresolved rollback journal rather than deleting it. Install, manual
stop, and deadman stop invalidate the one-use commissioning authority and
atomically restore `false` before dark verification. Only the first eligible
admitted assignment may arm the epoch.

Commissioning keeps a root-owned, mode-`0600`, versioned phase journal through
every durable transaction boundary: journal capture, configuration
apply/verification, receipt write, barrier enablement, control-plane restart,
and final live verification. Each transition atomically replaces and fsyncs
the journal before execution advances. If the commissioner child exits or is
killed while the journal remains, its root-owned wrapper starts only
`paperclip-controlled-swarm-commissioning-recovery.service`. That unit is
conditioned on the orphan journal; it does not require a pre-existing false
barrier. Under the activation lock, the bounded recovery path atomically
stops Paperclip and verifies it inactive, atomically persists false, restarts
Paperclip dark, inspects the effective barrier as false, and only then parses
or restores the journal. Invalid journals
refuse rollback after the runtime fence; failed rollback leaves both barriers
false and preserves the journal for operator reconciliation.

Before minting live commissioning authority, rehearse the exact installed
commissioner, wrapper, and recovery-unit bytes:

```bash
sudo /usr/local/lib/paperclip-gloops/rehearse-controlled-swarm-commissioning-recovery.py
```

The rehearsal SIGKILLs a subprocess after every durable phase, creates a new
commissioner instance for recovery, repeats recovery to prove idempotency,
refuses a corrupt journal, and induces a rollback failure to prove the system
remains dark. The default root rehearsal retains that source harness and the
installed-unit phase-state matrix, then adds the conjunctive proof: for every
durable phase it invokes the exact installed wrapper and commissioner on the
real inert topology with `--rehearsal-crash-after-phase`. The commissioner
really receives SIGKILL, the surviving wrapper must start the exact installed
root-owned recovery unit, and the rehearsal verifies a new systemd invocation,
the journal condition, one-shot success, repeated no-journal skip, exact
configuration restoration, and both persisted and effective false barriers.
The final Gate 2 claim is emitted only when both earlier matrices, all seven
exact-host wrapper phases, corrupt-journal refusal, and rollback-failure-dark
proofs pass. It also binds the effective enabled recovery unit to the
independently pinned SHA-256 of the canonical release asset, permits no
drop-ins, and requires the exact normalized command argv, sole condition,
timeout, writable paths, and security directives both on disk and in the
systemd manager's loaded `ExecStart`, `Conditions`, timeout, path, and security
properties. Both start and stop timeouts are explicit 180-second release
contracts and are compared after normalizing the loaded systemd durations to
microseconds. The effective-properties digest is computed only from those loaded
values, so a canonical file that has not been daemon-reloaded cannot pass. The release verifier
recomputes that pin from the source asset so a changed expected digest cannot
bless drift. The proof also binds the Paperclip unit, runtime configuration,
and installed GitHub credential broker. After every crash phase the rehearsal
closes the active Paperclip and Hermes credential lifecycle, requires
command-specific successful `revoke-projector` evidence (not an unrelated
successful `ExecStopPost` command), snapshots and validates the complete
hash-chained history from one strict UTF-8 byte read. Its JSON decoder rejects
duplicate object keys and non-finite numbers, while canonical history hashing
refuses to serialize them. Active credential receipts use the same protected,
single-read strict snapshot; their semantics and SHA-256 are derived from the
exact same bytes, including nested permissions. The proof requires the post-stop history to be the byte-logical
exact prior prefix plus one new terminal record for that active lifecycle and
projector fingerprint, and starts a globally unique new read-only lifecycle
that appears in neither history nor an earlier phase. The rehearsal temporarily mutates
adapter configuration and the barrier, but performs no provider call and no
repository-content mutation, and restores the exact starting configs. A failed
proof attempts the Paperclip stop and false-barrier write independently,
requires Paperclip to be inactive before accepting the persisted false fence,
invalidates all one-use approval files, and preserves any unresolved journal
for reconciliation. The root-owned `0600` result is content-addressed under
`/var/lib/paperclip-gloops/rehearsals/`.

For local tests, `--allow-source-root` runs only the isolated crash harness.
Its receipt says `source_harness_passed`, records both installed proofs as
false, and does not claim exact-topology proof. A successful root receipt says
`exact_host_conjunctive_passed` and records
`gate2ExactTopologyClaimed=true`; a root run cannot reach that outcome from the
split matrices alone. Gate 2 remains open until the exact content-addressed
receipt and installed artifact are independently accepted.
