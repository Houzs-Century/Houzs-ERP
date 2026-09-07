## A bare ALTER TABLE on a busy table blocked every migration behind it [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** Production deploy run **34141376280** (2026-09-07 ~16:14Z /
2026-09-08 00:14 MYT) failed:

```
375 migration(s), 392 applied, 1 pending, ...
  FAILED  20260907T2340_scm_do_item_ac_substituted.sql: canceling statement due to statement timeout
```

`pg-migrate` exits 1 on the first failed file, so **every later migration was
blocked behind it** — on go-live night, with a dozen sessions merging.

**Root cause (traced).** The migration was a bare
`ALTER TABLE scm.delivery_order_items ADD COLUMN IF NOT EXISTS ac_substituted
boolean NOT NULL DEFAULT false;`.

The ALTER itself is cheap and always was: since PostgreSQL 11 an `ADD COLUMN`
with a **constant** default is metadata-only — the value lands in
`pg_attribute.attmissingval` — so there is no table rewrite. What it could not
get was the **`ACCESS EXCLUSIVE` lock**. Company 1 was mid-cutover with delivery
documents being written continuously, so the ALTER queued behind live
transactions until the server's `statement_timeout` killed it, roughly two
minutes in (16:12:16 → 16:14:17 in the run log).

So the failure was not the change being expensive. It was **asking for an
exclusive lock on a hot table with no bound on the wait, during the busiest hour
this database has ever had.**

**Why it looked safe.** `backend-postgres` CI applies every migration to a real
Postgres container and passed — because that container has no concurrent
writers. A lock-contention failure is invisible to any gate that runs against an
idle database, which is every gate we have.

**Fix.** The ALTER now asks with a short `lock_timeout` and retries, inside a
`DO` block:

- `SET LOCAL lock_timeout = '3s'` per attempt, so one live writer costs three
  seconds instead of the whole deploy;
- up to 20 attempts with `pg_sleep(2)` between — about 100s, under the file's
  `SET LOCAL statement_timeout = '180s'`;
- then it **gives up loudly** with a message saying the table is under
  continuous write load and the deploy should be re-run in a quieter window. A
  migration that hangs indefinitely on a lock is not better than one that fails.
- `COMMENT ON COLUMN` moved INSIDE the successful attempt, where the lock is
  already held, so it cannot become a second thing to queue for.
- The stray `BEGIN;` / `COMMIT;` are gone. `pg-migrate` already wraps each file
  in one transaction (`pg.begin()` in `backend/scripts/pg-migrate.mjs:304`), and
  a `COMMIT;` inside that would end the runner's own transaction early. Every
  recent migration in this tree omits them; this file had copied the older 0309
  style.

**Editing the file rather than superseding it is correct here, and only here.**
`pg-migrate` runs each file inside one transaction and rolls back on error, so
**no `_pg_migrations` row was ever written** and there is no checksum to drift
against — verified in the run log, which reports the file as `pending` on the
following attempt. Editing an **applied** file's body remains forbidden.

**Lesson.** *An `ALTER TABLE` is not "cheap" or "expensive" — it is a LOCK
REQUEST, and its cost is set by whatever else is touching the table.* The gates
in this repo all measure migrations against an idle database, so none of them
can see this class. On a table that takes live writes, bound the wait and retry;
never let an unbounded lock wait sit in front of the deploy pipeline.

**Ref.** PR (2026-09-08), fixing the migration added by #3113. Deploy run
34141376280 is the failure; the recovery run is recorded on the PR.
