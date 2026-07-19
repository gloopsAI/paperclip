# Hermes route-receipt overlay

This directory is the downstream GLoops Gate 2.25 overlay for the pinned Hermes
source identified in `hermes-source-lock.json`. It is not an upstream Hermes
fork and does not authorize a live provider call.

The lock binds:

- the upstream repository, commit, tree, and immutable GitHub archive digest;
- every touched source/test preimage and postimage digest; and
- the exact patch digest.

Apply to a clean pinned source checkout:

```sh
python3 apply-hermes-route-receipt.py \
  --root /path/to/hermes-agent \
  --mode source
```

The checkout must expose the exact locked Git commit and tree. If the target
does not contain Git metadata, provide the immutable upstream archive whose
whole-file SHA-256 equals `upstream.archiveSha256`:

```sh
python3 apply-hermes-route-receipt.py \
  --root /path/to/hermes-agent \
  --mode source \
  --source-archive /path/to/9de9c25f620ff7f1ce0fd5457d596052d5159596.tar.gz
```

Apply only runtime files to the pinned derivative image source tree:

```sh
python3 apply-hermes-route-receipt.py \
  --root /opt/hermes \
  --mode runtime \
  --source-archive /build-inputs/9de9c25f620ff7f1ce0fd5457d596052d5159596.tar.gz
```

The applicator refuses source drift, patch/lock inventory disagreement,
duplicate patch paths, unsafe paths, symlink targets, hunk fuzz, and postimage
digest disagreement. It accepts source identity only from the exact locked Git
commit+tree or the verified whole-source archive digest. It validates every
selected preimage and rendered postimage before writing any target.

Application is one crash-recoverable transaction. The applicator stages and
fsyncs every postimage and rollback preimage, publishes a durable journal,
renames targets one at a time with directory fsyncs, and records commit
progress. A later non-verify invocation detects an interrupted journal,
restores the complete preimage, and then reapplies. `--verify-only` never
recovers or mutates an interrupted transaction; it fails closed until a normal
apply performs recovery.

Offline verification:

```sh
python3 apply_hermes_route_receipt_test.py
python3 apply-hermes-route-receipt.py \
  --root /path/to/already-patched/hermes-agent \
  --mode source \
  --verify-only
```

The overlay makes completed `/v1/runs` fail closed unless Hermes can return one
frozen terminal projection with:

- exact received request byte length and SHA-256;
- the actual Ollama Cloud subscription route and every provider-call attempt;
- explicit input/output/cache usage presence and non-negative values;
- turn/tool-call totals and terminal status; and
- a domain-separated canonical semantic digest shared by terminal SSE and
  final GET status.

Receipt-governed runs suppress raw request dumps and raw pre/post provider
observers. They also bypass request and execution middleware. A route outside
the Ollama Cloud subscription boundary is rejected before attempt publication
or provider invocation; an accepted attempt is recorded immediately before the
provider call; and a response without an authoritative model fails closed.
Prompts and raw provider response bodies are not copied into middleware,
callbacks, dumps, or this evidence surface. Hermes does not place
`rawPayloadDisposition` inside its semantic projection: Paperclip records
`rawPayloadDisposition=not_retained` only after its independent response
hashers and parsers have finalized.

The derivative-image build downloads the exact locked upstream archive by
commit and checksum, then applies the runtime subset only when every touched
file matches its locked upstream preimage. This certifies the overlay's source
boundary without claiming whole-image source provenance for the pre-existing
Hermes base image.
