## Reverting an applied migration leaves its tracker row orphaned, and the drift guard holds staging red until the file is formally retired [medium]

**Symptom.** Every Staging Migrations run after #2889 failed (33651666423 and
siblings):

```
DRIFT   0344_acc_autocount_code_migration.sql: file deleted (stored sha256:e33104ac…)
Add a new migration instead of editing or deleting an applied one.
```

Nothing pending could apply on staging behind it — including 0346, the redo
itself — while production (which never tracked 0344) applied 0346 cleanly in
the same hour. The two environments were converging in opposite orders.

**Root cause (traced).** #2889 reverted the chart relay by deleting
`0344_acc_autocount_code_migration.sql` from the tree. Correct for
production, which had never applied it — but staging HAD (run 33642779806),
so staging's `_pg_migrations` still holds the row. pg-migrate keys history by
filename + checksum and treats an applied row whose file is gone as DRIFT,
fail-closed. The guard did its job; the revert was simply incomplete for the
one environment that had already run the file.

**Fix.** The designed channel: `scripts/lib/migration-retirements.mjs` gains
the entry — filename, `archivedChecksum` copied from staging's own DRIFT
line, `gitBlob` from the pre-revert tip (67455c29) — and the retirement
test's deliberate pins move 19 → 20. The redo (0346) is idempotent over the
state 0344 left on staging (its evidence test's second-replay case is that
exact scenario), so staging converges on the next run with no data touched.

**The rule to keep.** Reverting a migration PR is only half done when any
environment has already applied the file: the delete must ship WITH the
reviewed-retirement entry, or the drift guard rightly parks that environment.
Check `_pg_migrations`(or the latest Staging Migrations log) for the file
before calling a migration revert complete.
