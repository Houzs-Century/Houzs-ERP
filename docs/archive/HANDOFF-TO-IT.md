> **ARCHIVED 2026-08-13.** Both Cloudflare asks were completed at the **2026-06-13** cutover — Hyperdrive config `f0f9bd0d` is live in `backend/wrangler.toml`. Superseded by `docs/CODEBASE-MAP.md` §4. Kept for history; do not follow it as a current instruction.

# Houzs ERP — D1 -> Supabase migration: what I need from you (IT)

We're moving the Houzs backend database from Cloudflare **D1 (SQLite)** to
**Supabase Postgres (Singapore)**, fronted by Hyperdrive — the same path Hookka
took. The hard parts are done and on a branch. Two things need your Cloudflare
access. Both are quick.

## What's already done (branch `migrate/d1-to-supabase`)

- Supabase project created: **`houzs-erp`**, region **ap-southeast-1 (Singapore)**,
  in the `weisiang329-eng` Pro org. Project ref `xxoszhxglfgkqkokvofa`. Healthy.
- Connection layer `backend/src/db/pg.ts` (postgres.js, Hyperdrive + pooler).
- D1-compat shim `backend/src/db/d1-compat.ts` (so the ~685 `env.DB.prepare()`
  call sites keep working on Postgres with minimal edits).
- Postgres schema: `backend/src/db/schema.pg.ts` + `migrations-pg/0000_baseline.sql`.
  **57 of ~107 tables already created in Supabase** and verified.
- Full runbook: `MIGRATION-D1-TO-SUPABASE.md`. Table reference: `reference/Database-Reference.md`.

`backend/.dev.vars` holds `DATABASE_URL` (session pooler, 5432). It is gitignored —
ask me / the owner for it, or reset the DB password in Supabase
(Settings -> Database) and share the new pooler URI.

## What I need from you — Step 1: export the live D1 (one command)

The remaining ~50 tables (the `assr_*` rebuild chains, portals, fleet, lookups)
and **all the live data** are only in the D1 database `autocount-sync`, which
lives in your Cloudflare account. Please run, from the repo root:

```bash
wrangler d1 export autocount-sync --remote --output=houzs-d1-full.sql
```

That single file (schema + data) lets me (a) finish the schema to 107/107 with
the authoritative DDL, and (b) load all the data into Supabase. Send me the
`.sql` file (or drop it in the repo / a shared drive).

If it's huge and you'd rather split:
```bash
wrangler d1 export autocount-sync --remote --no-data   --output=houzs-d1-schema.sql
wrangler d1 export autocount-sync --remote --no-schema --output=houzs-d1-data.sql
```

## What I need from you — Step 2: cutover (later, after data loads + tests pass)

Once the app code is repointed to Postgres and tests are green:

1. Create a Hyperdrive config over the Supabase pooler connection string:
   ```bash
   wrangler hyperdrive create houzs-erp-pg --connection-string="postgresql://...:6543/postgres"
   ```
2. Add the binding to `backend/wrangler.toml`:
   ```toml
   [[hyperdrive]]
   binding = "HYPERDRIVE"
   id = "<the id wrangler prints>"
   ```
3. Deploy: `npm run deploy` (from `backend/`).
4. Smoke-test login, invite, ASSR, fleet, and the AutoCount cron, then remove
   the `[[d1_databases]]` binding.

## Notes / coordination

- This is a large data-layer change. Please tell me if you have in-flight work
  on `backend/` so we sequence the merge and avoid conflicts.
- Nothing here touches the live D1 or the running app until Step 2. The export
  in Step 1 is read-only.
- R2 (`POD_BUCKET`) is unaffected.

Ping me when the export is ready and I'll finish the schema + load the data.
