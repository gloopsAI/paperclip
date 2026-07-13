# GLoops Paperclip distribution

GLoops treats `paperclipai/paperclip` as an upstream source dependency, not as
an operational authority boundary. The runtime used by GLoops is built from the
owned `gloops/stable` branch and is deployed only by immutable container digest.

## Branch contract

- `master` mirrors upstream and is never the GLoops deployment target.
- `gloops/stable` is the reviewed downstream release line.
- integration work enters `gloops/stable` through a pull request.
- upstream synchronization also enters through a pull request and never
  auto-deploys.

## Patch contract

Every downstream patch is recorded in `manifest.json` with its exact source
base and head, patch digest, integrated commits, owner, retirement condition,
and upstream PR when one exists. Upstream PRs stay open until upstream accepts
or rejects them. Their state does not block a GLoops release. Distribution-only
release policy can remain downstream without a fabricated upstream dependency.

A patch is removed only when all of the following are true:

1. the selected upstream base contains an equivalent replacement;
2. unique-diff verification shows no GLoops-only behavior was lost;
3. the affected GLoops canaries pass against the candidate base; and
4. an independent exact-head reviewer accepts the patch retirement.

## Release contract

`gloops/v<distribution-version>` tags build
`ghcr.io/gloopsai/paperclip-gloops`. CI publishes multi-architecture images with
an SBOM and provenance attestation. Runtime configuration must pin the resulting
`sha256:` digest; mutable tags are discovery aids only.

The GLoops image builds the dedicated `gloops-production` target. It contains
the Paperclip control plane and its runtime dependencies, but deliberately does
not contain coding-agent CLIs or provider credentials. Provider execution stays
in separately governed workers, outside the control-plane trust boundary.

The release manifest names a versioned OpenVEX document under `security/`.
Release acceptance evaluates the exact digest together with its SBOM,
provenance, secret scan, vulnerability scan, and VEX. A release is rejected if
any reachable critical vulnerability remains unmitigated; package-version-only
scanner matches require source and test evidence in the VEX, not a blanket
ignore rule.

Publishing an image does not activate Paperclip. Production restart, schedules,
heartbeats, agent wakes, provider credentials, MTE activation, and live mutation
remain separate operator-controlled actions.

Verify the local checkout with:

```sh
node scripts/verify-gloops-distribution.mjs
```
