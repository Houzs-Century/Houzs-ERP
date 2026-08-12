> # ⚠ DO NOT FOLLOW AS WRITTEN — verified against the code 2026-08-13
>
> Every command in this runbook targets the WRONG Hyperdrive config, and the
> D1→Postgres cutover it describes is already complete. Read before touching it:
>
> 1. **Step 3 and the Rollback both update `4e820fcfa4f945929ab77e164060e694`.**
>    `backend/wrangler.toml:136` records that id as the OLD, ABANDONED config
>    ("left stuck on 6543; spare"). The live binding is
>    `f0f9bd0d6b924496981b97b9ebcfe898` (`:137`). Running these steps changes a
>    config the Worker does not read — **and the rollback would appear to
>    succeed while doing nothing.**
> 2. **Its connection string uses port 6543** — the transaction pooler that
>    caused the 2026-06-13 production outage. `wrangler.toml:127-135` records
>    that recovery came from moving to the **5432** session pooler. This command
>    would re-apply the failed configuration.
> 3. **Neither project id matches.** The runbook names `xxoszhxglfgkqkokvofa`
>    (interim) and `ctbaifabbzghtsrmpirm` (permanent); `wrangler.toml:126`
>    records the live config pointing at SG project `anogrigyjbduyzclzjgn`.
> 4. Steps 1-2 call scripts that REFUSE any non-loopback target without
>    `ACK_PROD_WIPE=yes` (`load-d1-dump-to-pg.mjs:47-49`,
>    `copy-pg-to-pg.mjs:42-48`). The runbook never sets it.
> 5. Both depend on `backend/houzs-d1-full.sql`. That file does not exist in the
>    tree — it is git-ignored — and the runbook never says how to obtain it.
> 6. Its final step ("remove the `[[d1_databases]]` block") was done on
>    2026-06-13 — `wrangler.toml:106`.
>
> Owner decision pending (task chip raised): rewrite against the live config,
> or move to the historical section beside `MIGRATION-D1-TO-SUPABASE.md`.

# Runbook: re-point production to the company Supabase project

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
