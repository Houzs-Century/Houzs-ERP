> **ARCHIVED 2026-08-13.** The production deploy this hands off was done; prod has run on Supabase Postgres via Hyperdrive since **2026-06-13**. Superseded by `docs/CODEBASE-MAP.md` §4. Kept for history; do not follow it as a current instruction.

# HANDOFF — Houzs ERP: finish the D1 → Supabase cutover

**One-line status:** the database migration AND all the app code changes are
**done and validated against the real Supabase DB (16/16 live tests)**. The
*only* thing left is the **production deploy** (Hyperdrive + flip the live
Worker). Everything below the "REMAINING" line is what you do.

- **Repo:** `hello-houzs/Houzs-ERP`
- **Branch:** `migrate/d1-to-supabase`
- **What runs today:** live ERP at `erp.houzscentury.com` / `houzs-erp.pages.dev`
  — still on Cloudflare **D1**. Nothing is broken; the cutover has NOT flipped.
- **Target:** Supabase Postgres, project ref `xxoszhxglfgkqkokvofa`, region
  Singapore (`aws-1-ap-southeast-1`).

---

## How to pick up the work (do this first)

1. **Get the branch**
   ```bash
   git clone https://github.com/hello-houzs/Houzs-ERP.git
   cd Houzs-ERP
   git checkout migrate/d1-to-supabase
   ```
2. **Get `backend/.dev.vars`** — it is **gitignored** (holds the Supabase
   password), so it is NOT in the repo. Get it from the owner, or recreate it:
   ```
   DATABASE_URL="postgresql://postgres.xxoszhxglfgkqkokvofa:<DB_PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
   ```
   `<DB_PASSWORD>` is in Supabase → Project Settings → Database. Port **5432**
   (session pooler) for local scripts.
3. **Install + sanity-check the wiring**
   ```bash
   cd backend
   npm install
   npx tsc --noEmit -p .                       # must print 0 errors
   npx tsx scripts/test-supabase-shim.ts        # must be 12/12 passed
   npx tsx scripts/test-supabase-drizzle.ts      # must be 4/4 passed
   ```
   If those pass, the code is good and you are ready to deploy.

---

## What is already DONE (context — you do NOT need to redo)

- **Data:** all **110 tables / 51,413 rows** exported from D1 and loaded into
  Supabase, then verified row-for-row (`scripts/load-d1-dump-to-pg.mjs`,
  `scripts/verify-load.mjs`).
- **App code ported to Postgres** (TypeScript typecheck went 120 errors → **0**):
  - `src/db/pg.ts` — postgres.js connection (Hyperdrive in prod, pooler locally).
  - `src/db/d1-compat.ts` — a shim that keeps the ~685 legacy
    `env.DB.prepare(...)` call sites working over Postgres. It rewrites `?`→`$n`
    and the SQLite-isms (julianday, date/datetime('now',…), strftime, instr,
    char) and returns D1-shaped results (`meta.changes` via real affected-row
    count, `meta.last_row_id` via `RETURNING *`).
  - `src/db/client.ts` — Drizzle over postgres-js; `getDb()` plus a `.get<T>(sql)`
    helper. `src/db/schema.ts` re-exports the Postgres schema `schema.pg.ts`.
  - `src/middleware/db.ts` — injects the shim as `env.DB` per request, and
    `withPgDb()` does the same for the cron path. Mounted in `src/index.ts`.
  - Drizzle `sql\`\`` fragments that bypass the shim were fixed at the source
    (datetime('now'), GROUP_CONCAT→string_agg, INSERT OR IGNORE/REPLACE→ON
    CONFLICT, etc.).
- **Validated live against real Supabase: 16/16** — SLA julianday math,
  date/strftime, upserts, affected-row counts, last_row_id, Drizzle selects +
  alias joins all return correct results over real data (55 users, 613
  assr_cases, 381 projects).
- **Safety net in place:** D1 is still bound in `wrangler.toml` (commented target
  for Hyperdrive sits next to it), so a rollback is a one-line revert.

---

## REMAINING — the production deploy (THIS IS THE JOB)

> Needs the **Cloudflare account `Hello@houzscentury`** (login or an API token)
> for Hyperdrive + deploy + the fresh D1 export. Pick a low-traffic window —
> there is a short moment where you re-sync data and flip.

### Step 1 — Create the Hyperdrive (Cloudflare → Supabase pooler)
```bash
wrangler hyperdrive create houzs-erp-pg \
  --connection-string="postgresql://postgres.xxoszhxglfgkqkokvofa:<DB_PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres"
```
Note the **6543** port here (transaction pooler — Hyperdrive needs it, NOT the
5432 used locally). It prints a **hyperdrive id**.

### Step 2 — Bind it in `backend/wrangler.toml`
Uncomment the `[[hyperdrive]]` block and paste the id:
```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<id-printed-in-step-1>"
```

### Step 3 — Re-sync the FRESH D1 data (do this right before the flip)
The Supabase copy is a few hours/days stale (the app has kept writing to D1).
Re-export D1 and reload so nothing is lost at cutover:
```bash
cd backend
wrangler d1 export autocount-sync --remote --output=houzs-d1-full.sql
node --experimental-transform-types scripts/load-d1-dump-to-pg.mjs   # rebuilds + reloads all tables (reads .dev.vars)
node scripts/verify-load.mjs             # row counts must match
```
`houzs-d1-full.sql` is gitignored (live data — never commit it). This reload
truncates+rebuilds the Supabase tables, which is fine because the app is still
on D1 until Step 4.

### Step 4 — Deploy the Worker
```bash
cd backend
wrangler deploy
```
`predeploy` runs `typecheck && test` and will block a broken build. After deploy
the live Worker reads/writes Supabase via Hyperdrive. The frontend (Pages) is
unchanged — it calls the same API.

### Step 5 — Verify in production
- Open `erp.houzscentury.com`, log in, confirm lists load (orders, projects,
  ASSR), then **create one test record and confirm it persists**.
- Watch the Worker logs (`wrangler tail`) for DB errors.

### Step 6 — Lock D1 out (so future data can ONLY go to Supabase)
Once verified, **remove** the `[[d1_databases]]` block from `wrangler.toml` and
`wrangler deploy` again. Now the app physically cannot write to D1.

### Step 7 — Cleanup
- **DELETE the Cloudflare API token** if one was created for this (security).
- Keep the D1 database for a week as a safety net, then delete it.

### Rollback (if anything goes wrong in Step 5)
Revert `wrangler.toml` to the D1 binding (re-add `[[d1_databases]]`, remove
`[[hyperdrive]]`), `wrangler deploy`. The D1 data was never touched. ~1 minute.

---

## Optional polish (not blocking)
- `npx drizzle-kit pull` to reconcile `schema.pg.ts` with the exact loaded
  column types (loader used bigint/identity; the hand-written schema may differ
  cosmetically — does not affect runtime).
- A full `wrangler dev` end-to-end run (auth + a few real routes) — lower risk
  now that both data paths are proven, but nice for confidence.
- `/sync-wiki` to record this architecture change in the Obsidian wiki.

## Do NOT
- Do NOT commit `backend/houzs-d1-full.sql` [generated] or `backend/.dev.vars` (data +
  password — both gitignored; keep it that way).
- Do NOT move `better-sqlite3` / `sql.js` from devDependencies into
  dependencies — they are native and would break the Worker build.
- **AutoCount is intentionally OUT of scope here.** Its data is a re-syncable
  mirror pulled from the `.NET middleware + ngrok + it-houzs.dev` route and does
  NOT need migrating. The AutoCount API rework is a separate future task.

## Credentials / access the next person needs
| Thing | Where |
|---|---|
| Repo write + branch `migrate/d1-to-supabase` | GitHub `hello-houzs/Houzs-ERP` |
| `backend/.dev.vars` (DATABASE_URL + password) | from owner / Supabase dashboard — NOT in git |
| Cloudflare account for Hyperdrive + deploy | `Hello@houzscentury` login or API token |
| Supabase project | ref `xxoszhxglfgkqkokvofa`, region ap-southeast-1 |
