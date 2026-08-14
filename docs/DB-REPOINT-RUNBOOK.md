# Runbook: re-point production to the company Supabase project

> ## ⚠️ THIS RUNBOOK IS HISTORICAL. DO NOT FOLLOW IT AS WRITTEN.
>
> **Corrected 2026-08-13.** Production has moved TWICE since this was written:
> `xxoszhxglfgkqkokvofa` → `ctbaifabbzghtsrmpirm` → **`anogrigyjbduyzclzjgn`**,
> which is what `backend/wrangler.toml:126` binds today (Hyperdrive config
> `f0f9bd0d`, SG company project). `supavisor-pooler-outage-coe.md:126` already
> flagged this document as stale and nobody acted on it.
>
> Why that matters more here than in any other doc: **§1 below tells the operator
> to put a LIVE connection string into `.dev.vars` and then run the cutover
> loader against it.** Following these steps today points a
> `DROP TABLE … CASCADE` at a project that is no longer production — or, with a
> pasted-in current DSN, at one that is. The loader now fail-closes on any
> non-loopback target unless `ACK_PROD_WIPE=yes` (see
> `prod-wipe-by-loader-coe.md`), which is the only reason this is a stale
> document and not a live hazard.
>
> Keep it for the PROCEDURE — the Hyperdrive-origin-update shape is still
> correct. Re-derive every project ref from `backend/wrangler.toml` before
> running anything.

Production currently runs on the interim Supabase project
`xxoszhxglfgkqkokvofa`. The permanent home is the company-account project
`ctbaifabbzghtsrmpirm` (org under hello@houzscentury.com, already on a paid
plan). The switch is a Hyperdrive origin update — no Worker deploy, no
frontend change, sub-second cutover.

Total time: ~15 minutes. Best window: before the workday starts.

## Prerequisites

- `ctbaifabbzghtsrmpirm` database password (Supabase dashboard ->
  Project Settings -> Database -> Reset database password).
- Confirm the company project's pooler host (Settings -> Database ->
  connection string; expect `aws-1-ap-southeast-1.pooler.supabase.com`).

## Steps (run from backend/)

1. Build the schema on the company project — point `.dev.vars` at it:
   `DATABASE_URL="postgresql://postgres.ctbaifabbzghtsrmpirm:<PW>@<pooler>:5432/postgres"`
   then:
   ```bash
   # --experimental-transform-types is REQUIRED (Node 22.7+/24): the loader
   # imports the app's own SQLite->Postgres date rules from src/db/d1-compat.ts
   # so column DEFAULTs are carried across. Without the flag it aborts at
   # startup with an explanatory error, before touching the database.
   node --experimental-transform-types scripts/load-d1-dump-to-pg.mjs   # creates all 111 tables (schema + stale data)
   # ^ ends with "DEFAULTs carried: N, skipped with a warning: M".
   #   M should be 1 (client_errors.created_at, a strftime() default that
   #   cannot be carried safely). Anything more means read the WARNING lines.
   node scripts/apply-indexes-to-pg.mjs     # 194 B-tree indexes
   node scripts/apply-sql-file.mjs src/db/migrations-pg/0001_search_trgm.sql
   ```
2. Copy LIVE data from the interim project (overwrites the stale rows
   from step 1 and carries every post-cutover write):
   ```bash
   node scripts/copy-pg-to-pg.mjs "<interim 5432 url>" "<company 5432 url>"
   ```
   Must end with "row counts verified: all match".
3. Flip Hyperdrive to the company project (instant, same binding id —
   nothing else changes):
   ```bash
   npx wrangler hyperdrive update 4e820fcfa4f945929ab77e164060e694 \
     --connection-string="postgresql://postgres.ctbaifabbzghtsrmpirm:<PW>@<pooler>:6543/postgres"
   ```
4. Smoke: login on erp.houzscentury.com, open Orders/Projects, create one
   test record; `node scripts/peek-execution-logs.mjs` after the next
   5-minute cron tick must show fresh rows (proves writes land in the
   company project).
5. Repeat step 2's verification any time with `scripts/verify-writes-landed.mjs`
   (edit the flip timestamp) or `scripts/delta-since-flip.mjs`.

## After a quiet soak (about a week)

- Remove the `[[d1_databases]]` block from backend/wrangler.toml and
  deploy — locks writes to Postgres only.
- Decommission the interim Supabase project (export a final backup first).
- Delete the old D1 database.
- `npx wrangler logout` on any machine that no longer needs deploy access.

## Rollback

`wrangler hyperdrive update` back to the interim connection string —
sub-second, data on the interim project was never touched.
