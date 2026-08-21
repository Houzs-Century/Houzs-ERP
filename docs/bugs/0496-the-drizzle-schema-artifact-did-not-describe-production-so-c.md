## The Drizzle schema artifact did not describe production, so company-scope checkers were blind to Drizzle reads [high]

**Symptom.** 69 of 2990's sales orders printed Houzs's Zanotti letterhead. The
read that caused it — the brand list, with no company predicate — was reported
clean by every automated check the repo has, and a brief written a week later
from `0000_baseline.sql` told an agent to add a `company_id` column to
`project_brands` that has existed since mig 0093. An irreversible migration,
avoided only because that agent checked production instead of the file.

**Root cause (traced).** `backend/src/db/schema.pg.ts` was hand-ported from the
SQLite schema at the Postgres cutover and never validated against the database.
Its own header still said *"DRAFT ... UNTESTED until validated with
`drizzle-kit` against the live Supabase DB"*, and `src/db/schema.ts` carried the
same follow-up nobody did.

Measured against the live catalog on 2026-08-21 (run 32469796553,
`check-schema-artifact-drift.mjs --source=live`, reading `pg_class`): **199
disagreements across 45 of the 49 tables it declared.** On `project_brands`
alone the artifact had no `company_id` (production: `bigint NOT NULL`, FK to
`companies`, indexed, since mig **0093**), no `logo_r2_key` (mig **0069**), and
a `.unique()` on `name` that production does not have — only
`project_brands_pkey (id)` exists, and "BEDFRAME"/"Bedframe" and
"SERVICE"/"Service" are live under both companies. It also typed `trips` and
`lorries` as tables when production has them as `relkind = 'v'` VIEWs, and
declared `overdue_history` and `trip_locations`, which migs 0017 and 0055
dropped.

**Why that made the leak invisible, which is the part worth keeping.** A Drizzle
predicate can only name a column the schema carries. So the missing `company_id`
did not merely mistype the read — it removed the vocabulary a checker would use
to judge it:

- `check-company-scope.mjs` reads supabase-js builder chains. A Drizzle chain is
  not one.
- `check-master-read-scope.mjs` reads raw SQL. Its own self-test asserts that a
  builder call does **not** match its needle
  (`/\.prepare\(|\bsql`|\bdb\.query\(/`).
- A third checker for the Drizzle class could not be written, because the only
  honest definition of "company-scoped table" for Drizzle is "the artifact
  declares `company_id`" — and it declared it for none of the tables that
  mattered.

Verified rather than assumed: with the old artifact in place, both existing
checkers were re-run and neither names either Drizzle statement.
`check-master-read-scope` reports `POST /import/csv -> projects` (a raw-SQL
write in the same handler) and says nothing about the `project_brands` read four
lines above it.

**Fix.** The artifact is now GENERATED —
`DATABASE_URL=... npm --prefix backend run gen:schema-artifact` runs
`drizzle-kit pull` against the live catalog, restricted to the tables
`backend/src` actually imports, with `introspect.casing: "preserve"`. Three
gates keep it true, each proved RED on the unfixed tree first:

| gate | on the STALE artifact | after |
| --- | --- | --- |
| `npm --prefix backend run audit:schema-artifact` (in the REQUIRED `backend-typecheck`) | **exit 1**, 25 disagreements incl. `project_brands.company_id` and `.logo_r2_key` | exit 0, baseline holds **zero** keys |
| `check-orm-read-scope.mjs` (new, third class) | **exit 2** — `TABLE-DERIVATION self-test FAILED`, refuses to report a clean run over an empty table set | exit 0, 5 Drizzle statements on company-scoped tables, 1 grandfathered |
| `check-schema-artifact-drift.mjs --source=live` (dispatched) | 199 findings | re-run after regeneration |

Two real leads surfaced the moment the artifact was true, both invisible before:
`routes/projects.ts POST /import/csv` validated CSV brands against BOTH
companies' lists while stamping every created row with the active company —
**fixed**; and `routes/users.ts PUT /:id/brands`, which is grandfathered rather
than changed because narrowing it would silently drop a user's other-company
brands, and that is a judgement for the owner.

Three statements the new checker flagged were verified SCOPED and cleared —
`sales.ts GET /entries/export` and both queries in `notifications.ts GET /`
build their predicate into a `conds[]`/`scopeConds[]` array many lines above the
`.from()`. The checker now resolves those arrays per file rather than being
loosened; the one that survives even that (`notifications.ts:123`, split off its
`.where` by `.$dynamic()`) carries a `// company-scope:` annotation naming the
line the predicate lands on.

**Two things the fix had to learn, both caught by a self-test rather than by
review.** `drizzle-kit` 0.31.10 emits invalid TypeScript for a function-call
column default (94 columns here), so `pull` output does not compile as it comes
out and the generator carries one mechanical repair pass. And the artifact
parser originally required two or more whitespace characters of indentation,
which is one tab short of what `pull` emits — it saw ZERO columns in a
regenerated file and every check built on it reported an empty table set. Both
fixtures are pinned in `backend/scripts/lib/schema-artifact.mjs`.

**Ref.** `fix/schema-artifact-and-rate-card`, 2026-08-21. Full description in
`docs/schema-artifact.md`.
