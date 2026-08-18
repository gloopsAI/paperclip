# Upstream migration bridge

The GLoops fork and Paperclip upstream both began using migration numbers
`0147` and later after their common base. Those migration numbers are branch
local; they are not interchangeable identities.

The compatibility bridge preserves the exact SQL shipped in upstream
`v2026.817.0` (`213dabab4f8e1f3bb1803a2924c0fea1289fcd4c`) under
`packages/db/src/upstream-migrations/v2026.817.0/`. The reviewed manifest binds:

- all 65 upstream migration filenames, SQL SHA-256 digests, introducing
  commits, subjects, effects, destructive operations, classifications, and
  classification reasons;
- the eight overlapping fork migration filenames and SQL digests at fork base
  `fbe7c901b5a42e6e668b3911e720b527b2483db8`;
- a separately pinned canonical manifest digest.

This does **not** copy upstream rows into Drizzle's
`drizzle.__drizzle_migrations` journal and does not execute upstream SQL.
`record` creates a separate compatibility ledger only after proving that the
fork journal contains no unknown or drifted migration. Entries marked `adapt`
remain deferred until a source-controlled fork adaptation with its own schema,
data, rollback, and health proof exists. Entries marked `conflict` are recorded
and never executed by this bridge.

## Commands

Use the migration connection selected by the ordinary Paperclip database
runtime:

```sh
pnpm --filter @paperclipai/db upstream-migration-bridge verify
pnpm --filter @paperclipai/db upstream-migration-bridge record
```

`verify` is read-only. `record` is idempotent and serializes through a
transaction-scoped advisory lock. Unknown release rows, changed SQL hashes,
changed classifications, or an unknown fork-journal identity fail closed.

`rollback-classification` exists only for rehearsal and rollback of this
metadata-only slice:

```sh
pnpm --filter @paperclipai/db upstream-migration-bridge rollback-classification
```

It removes only this release's classification rows. It never rolls back an
adapted schema because this bridge cannot apply one.

## Deployment sequence

1. Produce a logical backup and its SHA-256 digest.
2. Restore the backup into a network-isolated, anonymized rehearsal database.
3. Capture the pre-bridge schema digest, fork-journal digest, and bounded row
   counts.
4. Run `verify`, `record`, replay `record`, and
   `rollback-classification`.
5. Prove the pre-bridge schema/journal/row counts after rollback, then run
   `record` once more and prove application health on the clone.
6. On the live pilot, capture the same preflight evidence and a fresh backup;
   run `record`; verify the 65 exact ledger rows and health.
7. If health regresses, run `rollback-classification`, restart the exact prior
   image/config, and receipt restored health. Any unknown journal or ledger
   state is reconciliation-required; do not retry automatically.

The receipt returned by every command binds the release, manifest, fork and
upstream heads, classification counts, destructive migration IDs, schema
digest, journal digest, bounded row counts, and a canonical receipt digest.
