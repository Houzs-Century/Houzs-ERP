## A view migration written against the wrong baseline stopped the production deploy [high]

**Symptom.** PR #2140 merged green and the backend never shipped. The Deploy run
concluded `failure` with `pg-migrate` red and the wrangler step **skipped**, so
production kept serving the previous Worker while `main` looked healthy. Every
migration after this one was queued behind it.

```
FAILED 0290_scm_gl_keep_reversed_originals.sql:
cannot change name of view column "line_id" to "journal_entry_id"
```

**Root cause — the migration was written against an OLD definition of the view.**
`scm.v_gl_entries` is defined by mig 0106 and opens `l.id AS line_id`. The new
migration opened `j.id AS journal_entry_id` and inserted its two new columns
BEFORE `company_id`. `CREATE OR REPLACE VIEW` allows neither: existing column
names, types and ORDER must match exactly, and new columns may only be APPENDED.
The file's own header asserted "ordering, company_id and every existing column
are untouched" — a claim about a database, made without one.

**Why nothing caught it.** The pg suite applies the specific migrations a test
names, and no test named this one — two of the five migrations in that PR had pg
tests, the view did not. `tests/setup.ts` replays a different tree entirely
(`src/db/migrations/`, the D1 mirror), and SQLite does not enforce this rule.
**Nothing anywhere replays `migrations-pg/` in order against a real Postgres**,
so a rule only PostgreSQL enforces had no gate in front of it.

**Fix.** Match mig 0106's column list exactly for the first 18 columns and append
`reversed` / `reversed_by_je` after `company_id`; the WHERE change that the
migration is actually for is unaffected. Verified mechanically: the first 18
columns now diff clean against 0106.

**The repair NOT taken, deliberately.** `DROP VIEW` + `CREATE VIEW` also fixes
the error and is the obvious move. It is wrong: a recreated view is a NEW object
with an EMPTY ACL — this is how mig 0189 took the production Sales Order list
down for every user and needed both 0190 and 0191 to restore the grants. Keeping
it a REPLACE never drops a privilege.

**Test attached** — `backend/tests-pg/glViewKeepsReversed.pg.test.ts`. It builds
mig 0106's view as its FIXTURE and applies the migration on top, which is the
only arrangement that can catch this class; a test that built the view from the
migration's own SQL would have passed while production failed. It also asserts
the fixture still reproduces the original bug, so the suite cannot pass
vacuously.

**Ref.** 2026-08-14, after PR #2140. Lesson, and it is the one this file keeps
re-learning: **a migration that edits an existing object must be written against
what is LIVE, not against the migration that first created it** — and a claim
about what a database will accept is not evidence until a database has accepted
it.
