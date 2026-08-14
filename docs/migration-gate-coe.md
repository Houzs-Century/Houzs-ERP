# Houzs ERP — Migration Gate COE (Correction of Error)

**Date:** 2026-08-14, ~02:24–03:0x MYT.
**Trigger:** Nobody reported anything, which is the recurring shape of this
class. PR #2140 merged with both required checks green, `main` looked healthy,
and the backend Worker in production stayed on the previous release. The
frontend job in the same run succeeded, so for the duration the two halves of
the product were on different versions.
**Status:** Recovered by #2163. The migration was corrected, a regression test
now covers it, and one gate that made the safe choice look unsafe was fixed. The
structural gap the incident exposed is **NOT** closed — see §5.

---

## 1. Incident

The `Deploy` run for the #2140 merge (31763447528) concluded `failure`:

```
FAILED 0290_scm_gl_keep_reversed_originals.sql:
cannot change name of view column "line_id" to "journal_entry_id"
```

`backend` job steps: 1–10 `success`, `pg-migrate` **failure**, then
`wrangler-action` **skipped** and `smoke-check` **skipped**. `0289` APPLIED;
`0290` FAILED; `0291`, `0292`, `0293` never ran.

Because `pg-migrate` runs **before** wrangler, a failing migration does not
merely skip itself — it stops the whole backend release and queues every later
migration behind it. Any PR merged into that window would also not have shipped.

## 2. Root cause, traced

`scm.v_gl_entries` is defined by **mig 0106** (`0106_report_views_company_id.sql`)
and its first column is `l.id AS line_id`. Mig 0290 was written against an
**older** shape: it opened `j.id AS journal_entry_id` and inserted its two new
columns **before** `company_id`.

`CREATE OR REPLACE VIEW` in PostgreSQL permits neither. Existing column names,
types and ORDER must match exactly, and new columns may only be **appended**. So
three separate violations of a rule that no static check, no TypeScript type and
no SQLite test can see — only a live PostgreSQL rejects it.

The file's own header asserted *"ordering, company_id and every existing column
are untouched"*. That was a claim about what a database would accept, written
without asking one.

## 3. Why nothing caught it

This is the part worth keeping.

| layer | why it was blind |
| --- | --- |
| `backend-typecheck` (required) | SQL is not typechecked |
| `tests/setup.ts` D1 replay | replays `src/db/migrations/` — **a different tree** (the D1 mirror, 148 files), and SQLite does not enforce the CREATE OR REPLACE VIEW column rule anyway |
| `backend-postgres` (`tests-pg/`) | runs against a real postgres:16 — but each test applies only the migrations it **names**. Two of #2140's five migrations had pg tests; the view did not |
| `migrationNumbers.test.ts` | catches duplicate NUMBERS. This was not a collision |

**Nothing in this repository replays `migrations-pg/` in order against a real
PostgreSQL.** A rule only PostgreSQL enforces therefore had no gate in front of
it, and the first execution of that SQL against a real database was the one
against **production**.

## 4. Fixes shipped

| PR | change | effect |
| --- | --- | --- |
| #2163 | 0290 matches mig 0106's column list exactly; the two new columns are appended after `company_id` | the migration applies; the WHERE change it exists for is unaffected |
| #2163 | `backend/tests-pg/glViewKeepsReversed.pg.test.ts` | builds **mig 0106's view as the fixture** and applies 0290 on top — the only arrangement that catches this class. Includes a case asserting the fixture still reproduces the original GL bug, so the suite cannot pass vacuously |
| #2163 | `release-discipline` reads SQL, not comments | see §4a |
| #2163 | 11 migration references corrected across 5 files | they had resolved to the **wrong** migration, not to nothing |

### 4a. A gate that recommended the dangerous repair

The obvious fix for the error is `DROP VIEW` + `CREATE VIEW`. It is wrong: a
recreated view is a NEW object with an **empty ACL**, which is exactly how mig
0189 took production's Sales Order list down for every user and needed both 0190
and 0191 to restore grants nobody had written down.

0290 therefore stayed a REPLACE, and its header explains that choice by naming
the rejected alternative. `check-release-discipline` then matched the string
`DROP VIEW` in that prose and failed the file, under a message instructing it to
do the thing it had just rejected. The rule asks what a migration **does**, so it
now blanks comments before testing. Three cases were added and the middle one is
the point — a **RED** case proving a real `DROP VIEW` still fails, so the guard
is shown armed rather than assumed to be.

## 5. Deferred — and this is the one that matters

**No in-order replay of `migrations-pg/` against a real PostgreSQL exists.**

This section first listed three options, "full in-order replay into a scratch
database" among them, and recommended it. **That option was then built, run, and
disproved.** It is recorded here as ruled out rather than deleted, because it is
the obvious idea and the next person will have it too.

### RULED OUT: replay from an empty database — PR #2164, 2026-08-14

Four CI runs, each refuting a different assumption. The first three were fixable
and two of the fixes are worth keeping; the fourth is disqualifying.

| run | result | what it refuted |
| --- | --- | --- |
| 1 | step ran **0s and skipped itself** | a gate whose trigger is a diff can ship having never executed its own main path. Fix: put `ci.yml` in its own trigger set |
| 2 | died in **0.059s** on TLS | `pg-migrate.mjs` hardcoded `ssl: "require"`. Fixed loopback-only and fail-closed in `scripts/lib/pg-ssl-mode.mjs`; production connections byte-identical |
| 3 | `290 migration(s)`, then `FAILED 0001: relation "sales_orders" does not exist` | the claim that the tree is self-contained. `pg-migrate.mjs:63` EXCLUDES the baseline by design — *"the 0000 baseline, which the loader owns"* |
| 4 | baseline applied first, then `FAILED 0001_search_trgm.sql: column "organizer" does not exist` | **the design.** The FIRST migration needs a column the baseline does not have |

**Why run 4 cannot be fixed by trying harder.** Production is **110 tables**
built by `load-d1-dump-to-pg.mjs` from a one-shot D1 export.
`0000_baseline.sql` is a Drizzle approximation of **57**, and
`docs/pg-migration-dropped-defaults-coe.md` already recorded that the loader
`DROP TABLE … CASCADE`s every table in `public` and rebuilds from pragma
metadata — *"the good baseline was dropped by the lossy loader that ran after
it."* The migration tree was written against the loader's output, so it does not
apply to the baseline, and the first migration is where that shows.

The loader cannot close the gap either. Its own header: *"This is a ONE-SHOT
environment builder. It is NOT run by deploy.yml or by any CI workflow and must
never become part of one: it DROPs every table in `public`."* It also needs the
authoritative D1 export, which is not in this repository.

**So there is no reproducible path from an empty database to production's
schema.** That is a fact about this repo worth more than the gate would have
been, and it removes option 2 permanently.

### What remains

1. **A committed schema SNAPSHOT of production, with migrations replayed on top.**
   A read-only `workflow_dispatch` dumps production's structure (no rows) using
   `secrets.DATABASE_URL` — the pattern CLAUDE.md already prescribes for facts
   that live only in production — the snapshot is committed, and CI loads it into
   a scratch container before running `pg-migrate`. Fidelity is exact at snapshot
   time, which is the question a migration gate must answer: *will this apply to
   the database it is about to meet?* With the real `v_gl_entries` in the
   snapshot, mig 0290 fails in CI instead of in the deploy. **Owner calls:
   committing a production schema dump, and how it gets refreshed.**
2. **Require a `tests-pg` case for every new migration.** Statically checkable, no
   container, enforceable in the required job. Weaker, and the weakness is
   precisely this incident: the author builds the fixture, and the author is the
   person who already has the wrong idea of the current schema.
3. **Nothing** — the status quo that let this through.

Until one is chosen, the working rule is the one in §6.

## 6. What this COE rules OUT

- **Not a number collision.** The three prior deploy-blocking migrations
  (0171 / 0230 / 0284) were duplicate numbers. `migrationNumbers.test.ts` was
  green here; there was no collision. Same symptom, different mechanism — do not
  reach for the collision playbook.
- **Not an edit to applied history.** The deploy log proves `0290` FAILED and was
  never recorded, so correcting it in place is legal. Had it applied, the file
  would be immutable and this would have needed a new migration.
- **No data was at risk.** A view holds no rows. `0289`, the one migration that
  did apply, is unaffected and was not re-run.
- **Not caused by the strict-up-to-date branch rule or by auto-merge.** The PR
  was current and was merged manually.

## 7. Lessons

1. **A migration that edits an existing object must be written against what is
   LIVE, not against the migration that first created it.** Read the object's
   current definition — `\d+`, or the latest migration that defines it — and
   diff your column list against it before writing a word of prose about what
   you did not change.
2. **A claim about what a database will accept is not evidence until a database
   has accepted it.** The header said ordering was untouched. Postgres disagreed,
   and Postgres is the only opinion that counts here.
3. **`CREATE OR REPLACE VIEW` may only append.** Names, types and order of
   existing columns are fixed. If you need to rename or reorder, you need a DROP
   — and then you owe the grants, in writing, in the reversal note.
4. **A gate that punishes the safe choice for explaining itself teaches people to
   stop explaining.** Scan what runs, not what is written about what runs.
5. **`skipped` on the deploy's `backend` job is a failed deploy.** It was caught
   here within minutes only because someone was watching the run. Required
   checks gate the merge; nothing gates the deploy that follows.

## See also

- `docs/deploy-collision-coe.md` — the deploy pipeline silently not shipping; a
  different mechanism with the same symptom (main green, production stale)
- `docs/ci-capacity-coe.md` — why adding a job to `backend-postgres` is a budget
  decision and not a free one
- `BUG-HISTORY.md` — the per-bug entry for this incident
- `CLAUDE.md`, *Migrations* and *Release discipline* — the rules this incident
  was a violation of, and the one it added
