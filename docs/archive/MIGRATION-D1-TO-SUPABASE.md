> **ARCHIVED 2026-08-13.** The D1 -> Supabase cutover completed **2026-06-13**; `backend/wrangler.toml` records the D1 binding as removed and prod now runs on Supabase Postgres through Hyperdrive. Superseded by `CLAUDE.md` (Migrations) and `docs/CODEBASE-MAP.md` §4. Kept for history; do not follow it as a current instruction.

# D1 -> Supabase Postgres migration runbook

Move the Houzs backend from Cloudflare D1 (SQLite) to Supabase Postgres
(Singapore region), fronted by Cloudflare Hyperdrive. Reuses the proven
Hookka ERP migration toolkit rather than inventing one.

Branch: `migrate/d1-to-supabase`. Do not merge to `main` until Phase 5
passes the full test suite. No users are on the system yet, so we cut over
in prod directly once verified — no parallel run required.

---

## Current state (what we are moving off)

| Thing | Value |
|---|---|
| Worker | `autocount-sync-api` (`src/index.ts`) |
| DB | Cloudflare D1 / SQLite, binding `DB`, name `autocount-sync` |
| ORM | Drizzle `drizzle-orm/d1`, sqlite-core schema (`src/db/schema.ts`) |
| Drizzle call sites | 22 files via `getDb(env)` |
| Raw SQL call sites | 685 `env.DB.prepare(...)` across 60 files (SQLite dialect) |
| Schema migrations | 93 hand-written `.sql` in `src/db/migrations/` |
| R2 | `POD_BUCKET` (POD photos) — unaffected by this migration |
| Crons | `*/5`, `*/30`, `0 2` (AutoCount sync + daily batch) — must keep working |
| Tests | vitest (backend) + Playwright (`e2e/`); `predeploy` runs typecheck + test |

## Target

- Supabase Postgres, region `Southeast Asia (Singapore)`.
- Cloudflare Hyperdrive in front (warm pooled connection, no per-request TLS).
- Driver: `postgres` (postgres.js), same version as Hookka (`^3.4.9`).
- Connection layer: `src/db/pg.ts` (added in this branch).

## Reused from Hookka (do not reinvent)

| Hookka file | Use |
|---|---|
| `src/api/lib/db-pg.ts` | connection layer — already ported to `src/db/pg.ts` |
| `scripts/d1-to-postgres.mjs` [external] | D1 schema/data -> Postgres conversion |
| `scripts/import-d1-data-to-supabase.mjs` [external] | load converted data into Supabase |
| `scripts/apply-postgres-migrations*.mjs` | Postgres migration runner |
| `scripts/backup-supabase.mjs` [external] | logical backups (Tier 2) |

Hookka's `db-pg.ts` carries three production lessons that are already encoded
in `pg.ts`: `prepare:false` (pooler rejects prepared statements), no `ssl` on
the Hyperdrive branch (Hyperdrive terminates TLS), and no `connect_timeout` on
the Hyperdrive branch (a 10s cap fast-failed slow-but-working queries and
blanked lists under load).

---

## SQLite -> Postgres differences to fix (measured in this codebase)

| SQLite construct | Count | Postgres replacement |
|---|---|---|
| `datetime('now')` / `strftime` | 375 | `now()` / `CURRENT_TIMESTAMP` / `to_char` |
| `AUTOINCREMENT` | 90 | `GENERATED ALWAYS AS IDENTITY` (schema-side) |
| `INSERT OR REPLACE` / `INSERT OR IGNORE` | 51 | `INSERT ... ON CONFLICT (...) DO UPDATE / DO NOTHING` |
| `?` positional placeholders | ~all 685 | `$1, $2, ...` (shim translates — see below) |
| `result.meta.last_row_id` | (D1 insert id) | `INSERT ... RETURNING id` |
| boolean stored as `0/1` | varies | `boolean` true/false (or keep integer columns) |
| `json_extract(col, '$.x')` | 2 | `col->>'x'` (jsonb) |
| type affinity (TEXT holds anything) | n/a | explicit Postgres types in schema |

## Strategy for the 685 raw-SQL call sites

Two paths. Recommend A for speed and lower blast radius.

**A. D1-compatibility shim (recommended).** A thin wrapper that exposes the
D1 surface the call sites already use:
`prepare(sql).bind(...args).all() / .first() / .run()`, backed by `pg.ts`.
It auto-translates `?` -> `$n` and normalizes result shape
(`.all()` -> `{ results }`, `.run()` -> `{ meta: { last_row_id, changes } }`
via `RETURNING`). Call sites keep their structure; we only fix SQL *dialect*
per query (datetime, INSERT OR REPLACE, RETURNING). Convert route-by-route,
run that route's tests, commit. This is the same incremental discipline the
repo already uses for the Drizzle conversion.

The shim does NOT fix dialect for you. `datetime('now')`, `INSERT OR REPLACE`,
and `last_row_id` must still be edited in each query. The shim only removes
the mechanical `?`->`$n` and result-shape churn (the bulk of the 685).

**B. Full rewrite to `sql\`...\`` tagged templates.** Cleaner end state,
much more work, higher risk in one pass. Defer; can happen gradually after
cutover.

Drizzle call sites (22) convert with the schema (Phase 2): once `schema.ts`
is pg-core and `client.ts` points at `drizzle-orm/postgres-js`, most Drizzle
queries work unchanged.

---

## Phase plan

### Phase 0 — Provision (USER, tonight)
1. supabase.com -> New project, name `houzs-erp`, set a DB password (save it).
2. Region: `Southeast Asia (Singapore)`.
3. Settings -> Database -> Connection pooling -> copy the `postgresql://...`
   pooler URI (transaction mode, port 6543).
4. Put it in `backend/.dev.vars` (gitignored):
   `DATABASE_URL="postgresql://...:6543/postgres"`
5. Send the connection string so the tested phases can run.
   (Prod Hyperdrive is created later, in Phase 5 — needs the Cloudflare
   account that owns the `houzs-erp` Pages/Worker.)

### Phase 1 — Connection layer (DONE in this branch)
- `src/db/pg.ts` added (postgres.js, Hyperdrive + direct, bigint coercion,
  no camelCase transform because Houzs reads snake_case columns).
- `postgres` added to `package.json`.
- `client.ts` repoint to `drizzle-orm/postgres-js` happens in Phase 2.

### Phase 2 — Schema + migrations
- Convert `src/db/schema.ts` sqlite-core -> pg-core (types, identity, jsonb,
  timestamptz). Generate a single Postgres baseline.
- Convert/replay the 93 `.sql` migrations into a `migrations-postgres/`
  baseline (mirror Hookka's layout). Numbered, immutable.
- Repoint `getDb()` in `client.ts` to postgres.js + pg schema.
- `drizzle.config.ts`: dialect `postgresql`.

### Phase 3 — Raw SQL (the bulk)
- Add the D1-compat shim, wire `env.DB` to it (keep the `c.env.DB.prepare`
  surface).
- Convert dialect per route (datetime, INSERT OR REPLACE -> ON CONFLICT,
  last_row_id -> RETURNING). Run that route's vitest after each.
- Track progress: 60 files / 685 calls. Commit per file.

### Phase 4 — Data
- Export D1 (`wrangler d1 export autocount-sync`), convert types with the
  Hookka script, import into Supabase. Verify row counts per table.

### Phase 5 — Cutover (prod)
- Create Hyperdrive over the Supabase pooler URL; bind `HYPERDRIVE` in
  `wrangler.toml` (keep `[[d1_databases]]` until verified, then remove).
- `npm run typecheck && npm test` + Playwright e2e green.
- Deploy. Smoke-test login, invite, ASSR, fleet, AutoCount cron.
- Remove D1 binding + sqlite schema once stable.

## Rollback
Until Phase 5 removes the D1 binding, reverting the branch restores D1. Keep a
fresh `wrangler d1 export` as a snapshot before cutover.

## Risks
- AutoCount sync crons hit the DB every 5 min — validate they write correctly
  to Postgres before removing D1.
- `nodejs_compat` + `compatibility_date` may need bumping for postgres.js on
  Workers; verify in `wrangler dev` against the pooler.
- This is the IT's actively-developed repo. Coordinate the merge so Phase 3's
  wide diff does not collide with in-flight work.

## Status (this branch)
- [x] Phase 0 Supabase project — `houzs-erp`, ap-southeast-1 (Singapore), Pro org.
      Project ref `xxoszhxglfgkqkokvofa`. DATABASE_URL in gitignored `.dev.vars`.
- [x] Phase 1 connection layer (`pg.ts`, `postgres` dep)
- [x] Phase 2 + 4 DONE — full DB migrated from the authoritative D1 export
      (`scripts/load-d1-dump-to-pg.mjs`): **110 tables + 51,413 rows in Supabase**,
      verified per-table vs the dump (`scripts/verify-load.mjs`) — 0 mismatches.
      Tables are rebuilt from D1 column metadata (bigint, identity PKs); FK/CHECK/
      defaults/indexes intentionally omitted for the load and can be re-added.
- [x] Phase 3 keystone: D1-compat shim (`d1-compat.ts` + tests)
- [~] `schema.pg.ts` (Drizzle, 57 tables) — superseded as the migration source by the
      D1 export, kept as the Drizzle-side reference for Phase 3 app-code reconciliation.
- [ ] Phase 3 app code: point `client.ts` at `drizzle-orm/postgres-js`, wire `env.DB`
      to the shim, fix the ~131 raw-SQL dialect sites, run vitest/Playwright. Coordinate
      the wide diff. Re-add indexes (193 in the dump) + FKs as a follow-up.
- [ ] Phase 5 Hyperdrive bind + cutover + remove D1

## Tooling note
`better-sqlite3` + `sql.js` are devDependencies used only by the migration scripts.
Keep them OUT of `dependencies` — `better-sqlite3` is native and would break the Worker build.
The 61 MB `houzs-d1-full.sql` export is gitignored (live data). Delete the Cloudflare
API token used for the export once you're done.
