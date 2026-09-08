## Editing an already-applied migration broke every production backend deploy [critical]

**Symptom.** From 2026-09-08 00:30 MYT every push to `main` failed its backend
deploy. Run [34143840138](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34143840138),
migration step 00:39:55 MYT:

```
376 migration(s), 393 applied, 1 pending, 0 checksum(s) to backfill, ...
Migration drift detected. Applied migration history is immutable:
  DRIFT   20260907T2340_scm_do_item_ac_substituted.sql: stored sha256:546ba4e8…, current sha256:c7e15ccd…
Add a new migration instead of editing or deleting an applied one.
```

`pg-migrate` exits 1 on drift, so the one genuinely pending migration
(`20260907T2345_grn_linked_ac_gr_docno.sql`, #3123) could not apply either, and
the Worker was never published.

**Root cause (traced, not guessed).** #3113 added
`20260907T2340_scm_do_item_ac_substituted.sql`. Its FIRST production run,
[34141376280](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34141376280)
at 00:14 MYT, failed on `canceling statement due to statement timeout` — the
bare `ALTER TABLE` queued for the `ACCESS EXCLUSIVE` lock behind live cutover
writes for about two minutes. That diagnosis was right, and #3124 was written to
bound the lock wait.

What #3124 could not know is that the *next* deploy,
[34142011201](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34142011201),
had already succeeded at 00:20 MYT:

```
  APPLIED 20260907T2340_scm_do_item_ac_substituted.sql (4 statements, sha256:546ba4e8…)
```

The lock contention had passed on its own. By the time #3124 merged at 00:30 the
file was applied AND checksummed, so editing its 56 lines changed the file's
canonical SQL, and `planMigrationChecksums` classified it `content_changed`
(`backend/scripts/lib/migration-checksum.mjs:125`) — drift, not an improvement.

The rule this breaks is already in CLAUDE.md: *"Before renaming an applied
migration, check whether it has run."* Editing counts the same as renaming, and
the check is the deploy log's own `APPLIED <file>` line.

**Fix.** Restore the file to the bytes production applied. Verified locally with
the repo's own checksum function before pushing — the restored file hashes to
`sha256:546ba4e883f5a78c94bb3437f26a0c42a8c2bf24a39aed8047a3f0d48c478c43`, byte
for byte the `stored` value the drift error names, so the next run sees no drift
and moves on to the pending `T2345`.

Nothing is lost by reverting: the SQL #3124 wanted to bound has already run to
completion. If the lock-wait guard is wanted for FUTURE `ALTER TABLE`s, it
belongs in a new migration or in the authoring guidance — never in a file the
tracker has already signed.

**Ref.** Reverts the `.sql` half of #3124 only; its bug note 0677 and its
`docs/modules/delivery-order.md` guidance stay. Fourth outage in this class —
the three before it are the table in CLAUDE.md, *"`main` IS protected now"*.
