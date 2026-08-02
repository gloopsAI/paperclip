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

Narrow Hermes adapter/admission changes also run through
`.github/workflows/gloops-distribution-fast.yml`. That workflow independently
classifies the complete diff, rejects mixed changes, runs package typechecks and
focused Hermes/admission/reset tests (plus comment-wake batching when
`heartbeat.ts` changes), and builds the same `gloops-production` target. On a
fast-only push to `gloops/stable` it publishes `sha-<shortsha>` and `stable`
within a 15-minute target; the full workflow remains mandatory for PR branch
protection and for schema, migration, dependency, UI, multi-package, tag, or
otherwise mixed changes. The exact operator pin and host pre-pull commands live
in [`deploy/hermes/README.md`](./deploy/hermes/README.md).

## Hermes execution-only profile

The Paperclip control plane and Hermes execution plane are separate containers
on the named `paperclip-execution` Docker network. Hermes exposes its
authenticated API only as `hermes-execution:8642` on that network and publishes
no host port. Paperclip retains only the loopback-published UI/API port.

The dark installer compiles a root-owned Hermes profile from an explicit
allowlist. Runtime access is limited to Ollama Cloud subscription credentials,
the Hermes API boundary key, and the sanitized Codex subscription credential
pool. The broad host Hermes home is never mounted or sourced at runtime. Slack,
AgentMail, email, Anthropic/OpenRouter, and Grok/xAI API credentials are absent.
Grok remains a separately governed host CLI and is never represented as an API
provider in this profile.

The current Hermes artifact is a host-provisioned image pinned by local content
digest, not a registry image. The installer verifies that exact digest before
making any filesystem or systemd change and fails closed if it is absent. Image
provisioning therefore remains an explicit host bootstrap responsibility rather
than an undeclared network pull or mutable-tag dependency.

The Docker network permits ordinary outbound transport; provider restriction is
enforced by credential capability rather than an egress proxy. This limitation
is explicit so the profile does not claim network isolation it does not provide.

Activation is deliberately two-step and is not performed by installation:

1. an operator unmasks and starts `paperclip-hermes-execution.service` with its
   dedicated approval marker;
2. the Paperclip preflight verifies that exact live sidecar before Paperclip can
   start under its separate approval marker.

Both services remain masked and both markers absent after a dark install. The
rollback path removes the sidecar profile, credentials, state, and network while
leaving all Paperclip services dark.

Verify the local checkout with:

```sh
node scripts/verify-gloops-distribution.mjs
```
