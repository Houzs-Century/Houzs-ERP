# The Drizzle schema artifact — `backend/src/db/schema.pg.ts`

**In one line:** it is GENERATED from the live database, a CI gate fails a PR
when it drifts, and hand-editing it is how the last defect happened.

## Why this file matters more than it looks

Every Drizzle read is typed from it. A column the file does not carry does not
exist — not to the compiler, not to the author writing the query, and not to any
checker that scans source code for a company predicate. That last one is what
made it dangerous rather than merely untidy.

## What went wrong (2026-08-21)

The file was hand-ported from the SQLite schema at the Postgres cutover and
never validated. Its own header said *"DRAFT ... UNTESTED until validated with
`drizzle-kit` against the live Supabase DB"*, and `src/db/schema.ts` carried the
same follow-up nobody did.

Measured against production on that date:

| claim in the artifact | production |
| --- | --- |
| `project_brands` has no `company_id` | has had it since mig **0093** — `bigint NOT NULL`, FK to `companies`, indexed |
| `project_brands` has no `logo_r2_key` | added by mig **0069** |
| `project_brands.name` is `.unique()` | only `project_brands_pkey (id)` exists. "BEDFRAME"/"Bedframe" and "SERVICE"/"Service" already exist under both companies |
| `trips`, `lorries` are tables | `relkind = 'v'` — **VIEWs** |
| `overdue_history`, `trip_locations` are tables | dropped by migs **0017** / **0055** |
| `creditors` has 19 columns | has 65 |
| `project_cost_rates.transport_pct` is `integer` | `double precision` |

The cost: the SO letterhead read the brand list through Drizzle with no company
predicate and stamped Houzs's Zanotti mark on **69 of 2990's sales orders**.
Neither `check-company-scope.mjs` nor `check-master-read-scope.mjs` could see
it — one reads supabase builder chains, the other raw SQL — and a third checker
for the Drizzle class could not be written, because the column a predicate would
name was not in the schema it would have to derive from.

It also nearly cost worse: a brief written from `0000_baseline.sql` told an
agent to add a `company_id` column that already existed. An **irreversible**
migration, avoided only because that agent checked production instead of the
file.

## How to regenerate it

```sh
DATABASE_URL=... npm --prefix backend run gen:schema-artifact
```

Locally that needs the production DSN, which you should not have. Use the
workflow instead: **Actions → Schema artifact check (read-only) → Run workflow**,
tick `regenerate`, then download the `generated-schema` artifact and commit it.
The workflow does not push — the file is code and code goes through a PR.

`gen-schema-artifact.mjs` does three things and nothing else:

1. **Derives the table list from the imports.** Every
   `import { ... } from ".../db/schema"` in `backend/src`, plus `extraTables`
   from `src/db/schema-tables.json` for a table being introduced. Never a
   hand-typed list.
2. **Runs `drizzle-kit pull`** against `public`, with
   `introspect.casing: "preserve"` so `project_brands` and `logo_r2_key` keep
   the spelling the database uses, then re-pulls to close over foreign-key
   targets (`companies` is pulled because `project_brands` references it; an FK
   whose target is filtered out emits an identifier that resolves to nothing).
3. **Applies one mechanical repair.** drizzle-kit 0.31.10 emits invalid
   TypeScript for a function-call column default — 94 columns in this database
   hit it — so `.default(to_char(timezone(\'UTC\'::text, now()), ...))` is
   rewritten to `.default(sql`...`)`. `pull` output does not compile without
   this, which is why the generator exists at all instead of a bare npm script.
   The pass is hermetically self-tested and REFUSES to write if its own fixture
   fails.

## Why it holds only the tables the app models

19 tables, not the 232 relations in `public`. The list is what `backend/src`
actually imports.

The 31 tables the old artifact declared and nothing imported were the worst of
the drift — `creditors` short 46 columns, `trips`/`lorries` typed as tables when
they are VIEWs, `overdue_history`/`trip_locations` dropped years of migrations
ago. An unused, unmaintained copy of a table that really lives in `scm` is not
documentation; it is a trap that reads as documentation. If code needs one of
them, add it to `extraTables` and regenerate — the definition then comes from
the database, not from memory.

## How it is kept true

| gate | source of truth | where it runs |
| --- | --- | --- |
| `npm --prefix backend run audit:schema-artifact` | `src/db/migrations-pg` | **`backend-typecheck`** — a REQUIRED status check, on every PR |
| `npm --prefix backend run check:schema-artifact:live` | the live catalog | dispatched: **Schema artifact check (read-only)** |

The PR-path gate needs no database, which is why it can be required. It proves
PRESENCE well — a migration added column X, so X exists — and it deliberately
does **not** report absence, because DDL wrapped in `DO $$ IF EXISTS ... END $$`
cannot be evaluated by a text scan (mig 0083 does exactly that for
`public.lorries`), several tables were loaded straight from the D1 dump with no
`CREATE` in this tree, and out-of-band DDL is documented to exist. Reporting
"not in the DB" from that would fail PRs over the checker's own blind spots.

Absence, VIEW-vs-table, and the `.unique()` lies are reported only by
`--source=live`, which reads `pg_class` rather than `information_schema` — so
**materialized views are covered**. That is not a detail: `mv_ar_aging` is
absent from `information_schema.views` and broke a deploy once.

Its grandfather baseline is `backend/scripts/schema-artifact-drift-baseline.json`
and it currently holds **zero** keys. `--update` refuses to add one, exactly as
`lint-ratchet` refuses to raise a ceiling. The way to clear a finding is to
regenerate, never to edit the JSON and never to edit the schema.

## The checker this unlocked

`backend/scripts/check-orm-read-scope.mjs` — the third company-scope class,
after `check-company-scope.mjs` (supabase builders) and
`check-master-read-scope.mjs` (raw SQL). It decides which tables are
company-scoped by reading `company_id` out of THIS file, which is the only
definition that matches what the code can actually write.

Run against the pre-regeneration artifact it exits **2** with
`TABLE-DERIVATION self-test FAILED` rather than reporting a clean run over an
empty table set. A verdict computed over nothing must never read as a pass.

## Rules

- **Never hand-edit `schema.pg.ts`.** Regenerate. The header says so and the
  gate enforces it.
- **`drizzle-kit` is for type generation and schema diffing, never the migration
  runner.** The `.sql` files in `src/db/migrations-pg` are the only thing that
  changes production. `pull` reads the catalog and writes nothing.
- **A new Drizzle table** goes in `src/db/schema-tables.json` under
  `extraTables`, then regenerate.
- **A type that looks wrong in the generated file is a finding about the
  DATABASE**, not something to correct in the artifact. Say so; do not "fix" it
  here.
