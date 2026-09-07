## A bare ALTER TABLE on a busy table blocked every migration behind it — and the "fix" blocked them again [high]

<!-- area: Deploy, CI, migrations -->

**Two failures here, and the SECOND one is the one worth reading.**

### 1. The original failure

Production deploy run **34141376280** (2026-09-07 16:14Z / 2026-09-08 00:14 MYT):

```
375 migration(s), 392 applied, 1 pending, ...
  FAILED  20260907T2340_scm_do_item_ac_substituted.sql: canceling statement due to statement timeout
```

`pg-migrate` exits 1 on the first failed file, so every later migration was
blocked behind it, on go-live night.

**Root cause (traced).** The migration was a bare
`ALTER TABLE scm.delivery_order_items ADD COLUMN IF NOT EXISTS ac_substituted
boolean NOT NULL DEFAULT false;`. Since PostgreSQL 11 an `ADD COLUMN` with a
**constant** default is metadata-only (`pg_attribute.attmissingval`), so there was
no table rewrite. What it could not get was the **`ACCESS EXCLUSIVE` lock** —
company 1 was mid-cutover with delivery documents being written continuously, so
the ALTER queued behind live transactions until `statement_timeout` killed it,
about two minutes in (16:12:16 → 16:14:17 in the run log).

> **An `ALTER TABLE` is not "cheap" or "expensive". It is a LOCK REQUEST, and its
> cost is set by whatever else is touching the table.**

`backend-postgres` CI applies every migration to a real Postgres container and
passed, because that container has no concurrent writers. **Lock contention is
invisible to every gate this repo has**, since all of them run against an idle
database.

### 2. The self-inflicted second failure — the expensive lesson

The response was to rewrite the migration's body with a `lock_timeout` + retry
loop, on the stated grounds that *"the file never applied, so there is no
checksum to drift against"*. That claim came from **reading
`pg-migrate.mjs`** — each file runs inside `pg.begin()` and rolls back on error,
so a failed file records nothing — and from one failed run's log. It was never
checked against the tracker table.

It was wrong. Between the failure and the rewrite, a later deploy **retried and
succeeded**: the lock had freed on its own. The tracker row existed. The next
deploy therefore reported:

```
376 migration(s), 393 applied, 1 pending, ...
Migration drift detected. Applied migration history is immutable:
  DRIFT   20260907T2340_scm_do_item_ac_substituted.sql: stored sha256:546ba4e8…, current sha256:c7e15ccd…
```

So the "fix" blocked the deploy pipeline **a second time**, for a problem that
had already resolved itself. Recovered by restoring the file to its original
bytes — `git checkout e13aff6a4 -- <file>` — and PROVING the restore against the
stored value before pushing:

```
restored body checksum: sha256:546ba4e883f5a78c94bb3437f26a0c42a8c2bf24a39aed8047a3f0d48c478c43
MATCHES PROD TRACKER  : true
```

**This is CLAUDE.md's "reading code is not evidence about production" trap,
exactly as written.** The reasoning about `pg.begin()` was correct in itself;
what it could not know was whether some *other* run had since succeeded. The
cheap observation that would have refuted it — read `_pg_migrations` for that
filename, or grep the intervening deploy logs for `APPLIED` — was never made,
and the deploy log line `393 applied` (up from `392`) was on screen and
misread as unrelated.

**Rule this buys: before editing ANY migration file that has ever been
dispatched, prove it is not in `_pg_migrations` — do not infer it from the
runner's source.** A failed run is evidence about *that run*, not about the
file's state.

### Where things stand

- The column **exists in production** with the original body; nothing about the
  schema is in doubt.
- The migration file is back to its original bytes and the checksum matches, so
  the pipeline is unblocked.
- The lock-bounding advice is still correct, and is recorded in
  `docs/modules/delivery-order.md` for **future** `ALTER TABLE`s on
  `scm.delivery_order_items` / `scm.delivery_orders`, which take continuous
  writes. It is deliberately NOT applied retroactively to this file: an applied
  migration's body is immutable, which is the whole point of the drift check.

**Ref.** Failure: deploy run 34141376280. Wrong fix: PR #3124. Recovery: this
PR (2026-09-08). Migration added by #3113.
