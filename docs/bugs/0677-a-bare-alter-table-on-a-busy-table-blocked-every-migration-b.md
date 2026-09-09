## A bare ALTER TABLE on a busy table blocked every migration behind it [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** Production deploy run **34141376280** (2026-09-07 16:14Z /
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

> **An `ALTER TABLE` is not "cheap" or "expensive". It is a LOCK REQUEST, and its
> cost is set by whatever else is touching the table.**

**Why every gate missed it.** `backend-postgres` CI applies every migration to a
real Postgres container and passed — because that container has no concurrent
writers. Lock contention is invisible to any check that runs against an idle
database, which is every check this repo has.

**Resolution.** It resolved itself: a later deploy retried, the lock had freed,
and the migration applied normally. The column exists in production with the
original body and nothing about the schema is in doubt.

**What was NOT done, and why.** The body was not rewritten with a retry loop.
That was attempted (PR #3124) and it blocked the pipeline a second time, because
by then the file had applied and an applied migration's body is immutable — see
`docs/bugs/0678-*`, which is the more valuable half of this night.

**The durable fix is guidance for the NEXT one**, recorded in
`docs/modules/delivery-order.md`: any future `ALTER TABLE` on
`scm.delivery_order_items` or `scm.delivery_orders` must bound its lock wait — a
short `lock_timeout` with retries — because these tables take continuous writes
and an unbounded wait in front of the deploy pipeline stops everyone.

**Ref.** Deploy run 34141376280. Migration added by PR #3113 (2026-09-07).
