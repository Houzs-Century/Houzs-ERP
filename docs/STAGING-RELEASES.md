# Staging Releases — runbook

Backend changes that touch the schema, bind a new R2/AE/KV resource, or carry
risk get verified on STAGING first, then promoted to prod. This runbook
covers the staging path; prod stays as today (push-to-`main` → `deploy.yml`).

## Topology

| | Prod | Staging |
|---|---|---|
| Worker name | `autocount-sync-api` | `autocount-sync-api-staging` |
| Wrangler env block | root config | `[env.staging]` in `backend/wrangler.toml` |
| Hyperdrive | prod (id in root) | staging (id in `[env.staging.hyperdrive]`) |
| Supabase project | prod | minnapsemfzjmtvnnvdd (per wrangler comment) |
| R2 buckets | `houzs-erp` (POD_BUCKET / SO_ITEM_PHOTOS / PUBLIC_ASSETS, key-prefixed) | same — `houzs-erp` reused, key prefixes isolate |
| Crons | enabled | `crons = []` (must never run prod jobs) |
| Deploy workflow | `.github/workflows/deploy.yml` (push to `main`) | `.github/workflows/deploy-staging.yml` (push to `staging`) |
| GitHub Environment | `Production` | `Staging` |

## One-time setup (per repo)

The staging workflow needs these GitHub secrets / vars. Add at
**Settings → Secrets and variables → Actions** (and scope to the `Staging`
GitHub Environment if you want to gate them behind reviewers later).

### Secrets

| Name | What |
|---|---|
| `STAGING_DATABASE_URL` | Direct connection string for the **staging** Supabase. Format: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require` — same shape as prod's `DATABASE_URL`, different project. Used by `pg-migrate.mjs` in the staging job. **Never reuse the prod URL.** |
| `CLOUDFLARE_API_TOKEN` | Already in repo as prod's deploy token; reused for staging (same Cloudflare account, same `wrangler deploy` action). If you'd rather isolate, add `CLOUDFLARE_API_TOKEN_STAGING` and swap the reference in `deploy-staging.yml`. |
| `CLOUDFLARE_ACCOUNT_ID` | Already in repo; reused. |

### Repo variables (optional)

| Name | What | Default |
|---|---|---|
| `STAGING_SMOKE_URL` | Overrides the smoke-check base URL if the staging Worker sits behind a custom domain. | `https://autocount-sync-api-staging.houzs-erp.workers.dev` |

### GitHub Environment

Create **Settings → Environments → Staging** (if not present). Recommended:
- No required reviewers (staging is meant to be fast). Promote-to-prod is the
  gate, not staging-deploy.
- Scope `STAGING_DATABASE_URL` to this environment so it can't leak into the
  prod workflow.

## Cutting a staging release

1. **Branch off `main`** for the work as usual:
   ```bash
   git checkout main && git pull
   git checkout -b feat/whatever
   # …code changes, including the migration in backend/src/db/migrations-pg/…
   ```
2. **Push to a feature branch + open a PR against `main`** — same as today.
3. **Send the same commit to staging** to deploy:
   ```bash
   git checkout -B staging
   git merge --ff-only feat/whatever     # or just hard-reset staging to the PR's tip
   git push origin staging --force-with-lease
   ```
   The push triggers `.github/workflows/deploy-staging.yml`:
   - Typecheck + tests
   - Apply pending migrations against `STAGING_DATABASE_URL`
   - `wrangler deploy --env staging`
   - Smoke check against the staging Worker URL
4. **Verify on staging.** Run the PR's acceptance checks against the staging
   stack. For UI work, point a local frontend at the staging Worker
   (`VITE_API_URL=https://autocount-sync-api-staging.houzs-erp.workers.dev npm
   run dev` in `frontend/`).
5. **Promote to prod.** Get explicit sign-off, then merge the PR to `main` —
   the existing `deploy.yml` runs prod migrations + deploys prod Worker.

### Renumbering a migration that already went to staging

Staging deploys before `main`, and migration numbers here are assigned at merge
time against current `main`. So the common sequence is: `0165_x.sql` [renumbered] is pushed
to `staging`, applied and tracked in the staging database, and then renumbered
to `0167_x.sql` [renumbered] because an unrelated PR took 0165 before this one merged.
Staging's `_pg_migrations` now holds a filename that will never exist again.

The runner handles this automatically **only when the rename is byte-identical**
— it matches the orphaned tracker row to the pending file by checksum and
repoints the row without re-running the SQL. So:

- Renumber with `git mv` and nothing else.
- Do not write the migration's own number inside the file. A header comment
  that says "migration 0165" has to change when the file becomes 0167, the
  checksum moves, and the automatic path is lost.

If the content did change, the deploy stops with `DRIFT … probable_renumber`
naming both filenames and printing the exact `UPDATE _pg_migrations …` to run.
That is a deliberate stop: from checksums alone, a renumbered migration and an
edited applied migration look the same, and only one of them is safe. Read the
diff before running the statement it suggests.

## Rollback

Staging is meant to fail fast and absorb the damage. If a staging deploy
breaks something:

- **Worker only**: `wrangler rollback --env staging` (one previous version).
- **Schema**: `pg-migrate.mjs` is forward-only (no `--revert` flag — by
  design, to keep the prod path one-directional). Prefer a new, reviewed
  forward-repair migration. If an incident requires a down script, keep it
  **outside** `backend/src/db/migrations-pg/` and run it directly against
  staging only after snapshot + approval:
  ```bash
  psql "$STAGING_DATABASE_URL" \
    -f backend/src/db/recovery-pg/<NNN>_<name>_down.sql
  ```
  Never delete or edit `_pg_migrations` ad hoc: checksum history is immutable,
  and removing a row makes the forward runner replay that file. Never place a
  `*_down.sql` file in `migrations-pg/`; the runner treats every top-level SQL
  file there as a forward migration. If no separately reviewed recovery script
  exists, the Supabase-snapshot path below is the only safe undo.
- **Worst case**: restore from a Supabase snapshot taken before the staging
  deploy. **Take a snapshot before any migration that's not trivially
  reversible** — Supabase Dashboard → Database → Backups.

## What stays on prod-only

- `deploy.yml` triggers, scope, and prod-only env vars are unchanged.
- The prod env block in `wrangler.toml` is untouched.
- Crons run on prod only (`[env.staging.triggers] crons = []`).
- Nothing in this workflow can target the prod Supabase or prod Worker name —
  `--env staging` flag forces the staging block, and `STAGING_DATABASE_URL`
  is a separate secret.

## Why two environments at all

Two reasons:
1. **Destructive schema work** (migrations adding non-nullable columns,
   renames, new tables with FKs) needs to be exercised against a real
   Postgres before prod. Local SQLite mirrors catch syntax, not the runtime
   shape.
2. **R2 / AE / Hyperdrive bindings** that the type system can't verify
   (env-shape only known at deploy time) need a runtime smoke against the
   actual bound resource.

For trivial, additive frontend-only PRs the staging detour is overkill —
merge straight to `main` per usual.
