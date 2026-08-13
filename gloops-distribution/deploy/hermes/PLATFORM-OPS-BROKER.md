# Platform Operations Broker

Root-owned Unix-socket broker for governed host operations: deploy, restart,
health, capacity, and rollback.  No generic shell, SSH, sudo, path, service,
or image-tag inputs are accepted.

## Architecture

```
Hermes agent (uid 10000)
  |
  | Unix socket /run/paperclip-platform-ops-broker/broker.sock
  |
  v
platform-ops-broker.py (root, pid 1 child)
  |
  +-- allowlist: /etc/paperclip-gloops/platform-ops-allowlist.json
  +-- state:    /var/lib/paperclip-gloops/platform-ops-broker/broker.sqlite3
  +-- commands: systemctl, docker, df, free, uptime, du, find, curl
```

The broker enforces:
1. **Allowlist** - only predeclared service names, cache paths, and disk paths
2. **Pinned images** - deploy requires `registry/path@sha256:64hex`, never tags
3. **Idempotent receipts** - every mutating action writes a durable, hash-chained receipt
4. **Credential-free** - no tokens, keys, or secrets in any response
5. **Peer authentication** - socket verifies `SO_PEERCRED` uid 10000 (Hermes)

## Installation

The broker is installed by `install-dark.sh` alongside the existing GitHub
brokers:

```sh
install -m 0555 -o root -g root platform-ops-broker.py /usr/local/lib/paperclip-glops/
install -m 0644 -o root -g root platform-ops-allowlist.json /etc/paperclip-gloops/
install -m 0644 -o root -g root paperclip-platform-ops-broker.service /usr/local/lib/systemd/system/
install -m 0555 -o root -g root platform-ops-tool.mjs /usr/local/lib/paperclip-gloops/tools/
install -m 0555 -o root -g root verify-platform-ops-broker.py /usr/local/lib/paperclip-gloops/
install -d -m 0700 -o root -g root /var/lib/paperclip-gloops/platform-ops-broker
systemctl daemon-reload
systemctl enable --now paperclip-platform-ops-broker.service
```

## Hermes Profile Wiring

Add to the Hermes execution profile mount list so the socket is available
inside the Hermes container:

```
--mount type=bind,src=/run/paperclip-platform-ops-broker,dst=/run/paperclip-platform-ops-broker
```

And install the client tool at `/opt/data/bin/platform-ops-tool.mjs` (read-only,
root-owned, mode 0555).

## Allowlist Schema

```json
{
  "schemaVersion": "gloops.platform-ops-allowlist.v2",
  "allowedServices": {
    "<unit.service>": {
      "healthUrl": "http://... or null",
      "container": "docker-name or null",
      "imageEnv": "ENV_VAR or null",
      "frontDoorHealth": {
        "publicUrl": "https://.../",
        "publicBodyContains": "<div id=\"root\"></div>",
        "apiHealthUrl": "https://.../api/health",
        "protectedUrl": "https://.../api/companies",
        "websocketUrl": "https://.../api/companies/<probe-id>/events/ws"
      },
      "rollbackProof": {
        "listenerPorts": [3100]
      }
    }
  },
  "allowedCachePaths": {
    "<cache-name>": "/absolute/path"
  },
  "cacheThresholdPercent": 85,
  "maxReceiptAgeDays": 30
}
```

## Operations

### Read-only

| Operation | Parameters | Description |
|---|---|---|
| `service-status` | `service` | systemctl show for one allowed unit |
| `service-health` | `service` | active state + optional HTTP health |
| `front-door-health` | `service` | fail-closed public browser, API JSON, protected-route, and websocket-upgrade matrix |
| `disk-usage` | `path` (optional, default `/`) | df for allowed paths only |
| `memory-usage` | none | free -m |
| `cpu-usage` | none | uptime |
| `cache-inspect` | `cache` | du -sb for one allowed cache path |
| `list-receipts` | `limit` (optional) | recent receipt entries |
| `get-receipt` | `receiptId` | single receipt with evidence |

### Mutating (require `actor` and `idempotencyKey`)

| Operation | Parameters | Description |
|---|---|---|
| `service-restart` | `service` | systemctl restart + pre/post health receipt |
| `cache-reclaim` | `cache` | find -delete on cache contents + before/after size |
| `deploy-pinned-image` | `service`, `image` | docker pull + systemctl restart |
| `rollback-rehearsal` | `service` | verify rollback script and backups exist |
| `rollback-proof` | `service`, `mode`, optional `expectedPriorImage` | durable terminal proof: listener/container absence or exact prior image + front-door restoration |

`service-status` and `service-health` remain narrow diagnostics. They are not
deployment acceptance. `front-door-health` is the credential-free release gate:
the browser route must return HTML containing its allowlisted application-root
marker, `/api/health` must return JSON with
`status=ok`, the representative protected route must reject an anonymous caller,
and the websocket route must either upgrade (`101`) or reach its authentication
boundary (`401`/`403`). A generic 200 page cannot satisfy the API probe.
The client exits nonzero when a health response has `healthy=false` or a
receipt is failed, so shell and agent gates cannot mistake inspectable failure
evidence for success.

`rollback-proof --mode absent` succeeds only when the unit is inactive, every
allowlisted listener is absent, and the named runtime container artifact is
absent. `rollback-proof --mode restored` requires the expected prior pinned
image in `approved-image` and `runtime.env`; the running container's configured
reference must match it; and Docker must resolve that pinned reference to the
same immutable image ID as the running container, with the reference present in
`RepoDigests`. The listener and full front-door matrix must also pass. Candidate
deploy acceptance applies the same configured-reference, immutable-image-ID,
and `RepoDigests` binding. Failed proofs are retained as failed, hash-chained
receipts; an uninspectable listener, container, or image reference fails closed.

Read-only calls have a 30-second client deadline. Mutating calls allow 180
seconds so image pulls, migrations, and post-restart health checks can settle
and return their durable receipt. If a caller disconnects after an operation
commits, the broker retains the receipt and continues serving; a lost response
never terminates the broker process.

## Client Usage

```sh
# Read-only
node /opt/data/bin/platform-ops-tool.mjs --operation service-status --service paperclip-gloops.service
node /opt/data/bin/platform-ops-tool.mjs --operation front-door-health --service paperclip-gloops.service
node /opt/data/bin/platform-ops-tool.mjs --operation disk-usage --path /
node /opt/data/bin/platform-ops-tool.mjs --operation cache-inspect --cache hermes-cache

# Mutating (idempotent)
node /opt/data/bin/platform-ops-tool.mjs --operation service-restart \
  --service paperclip-gloops.service --actor wren-agent --idempotencyKey restart-001

node /opt/data/bin/platform-ops-tool.mjs --operation deploy-pinned-image \
  --service paperclip-gloops.service \
  --image ghcr.io/gloopsai/paperclip-gloops@sha256:abc... \
  --actor wren-agent --idempotencyKey deploy-001

node /opt/data/bin/platform-ops-tool.mjs --operation rollback-proof \
  --service paperclip-gloops.service --mode restored \
  --expectedPriorImage ghcr.io/gloopsai/paperclip-gloops@sha256:abc... \
  --actor wren-agent --idempotencyKey rollback-proof-001
```

## Verification

```sh
# Verify broker configuration
python3 /usr/local/lib/paperclip-gloops/verify-platform-ops-broker.py

# Run focused tests from this source directory
python3 platform_ops_broker_test.py
node --test platform_ops_tool_test.mjs
```

## Security Boundary

- The broker rejects any service name, cache name, or path not in the allowlist.
- Image deployment requires a pinned SHA-256 digest; tags are rejected.
- Disk usage is limited to `/`, `/opt`, `/var`, `/tmp`, `/opt/paperclip`.
- No shell injection: all commands use `subprocess.run` with argument lists,
  never `shell=True`.
- Receipts are hash-chained: tampering with any journal entry breaks the chain.
- The socket verifies `SO_PEERCRED` to ensure only uid 10000 (Hermes) can
  connect.
