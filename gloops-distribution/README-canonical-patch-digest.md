# Canonical GLoops patch digest

The GLoops distribution records a SHA-256 digest for every patch so that
operators and CI can verify the exact source code that goes into a release.

## Computing the digest

Use the repository-owned helper so the result does not depend on any local
Git configuration:

```sh
node gloops-distribution/scripts/canonical-patch-digest.mjs \
  --base  <40-char-sha> \
  --head  <40-char-sha> \
  [--repo <path-to-clone>]
```

The helper:

- Requires full 40-character `sourceBase` and `sourceHead` SHAs.
- Runs `git diff --no-color --full-index sourceBase..sourceHead`.
- Ignores `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` so `core.abbrev` cannot
  change the output.
- Emits the SHA-256 of Git's byte-exact stdout, including its final newline.

## Why full-index?

Without `--full-index`, `git diff` emits abbreviated object IDs whose width
depends on `core.abbrev`. The same patch can produce different digests across
machines or Git versions. `--full-index` always emits 40-character IDs, making
the digest reproducible.

## Compatibility note for existing manifests

Manifests created before this convention used the default `git diff` output,
which on this repository historically produced 8-character abbreviated index
lines. Those old digests are not silently reinterpreted: when a patch entry is
migrated to the full-index convention its `patchDiffSha256` value is recomputed
with the canonical helper and the manifest change is committed explicitly.
Entries whose base/head revisions are no longer reachable in the local clone
cannot be recomputed and are left unchanged until the revisions are restored.
Those entries declare `patchDiffAlgorithm=git-diff-default-sha256-v0` and are
accepted only through a code-owned identifier/digest allowlist. The verifier
fails once both revisions become reachable, forcing migration instead of
silently retaining the legacy value. All migrated and new entries declare
`patchDiffAlgorithm=git-diff-no-color-full-index-sha256-v1`.

At this migration, the sole legacy exception is `real-plugin-host-version`
with digest `8c475e0aa67fa1cbbfc27dea407402cb0783f5b0f5bcc3a6c92427274451cb22`.
