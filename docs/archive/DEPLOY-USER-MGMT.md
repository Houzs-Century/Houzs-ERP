> **ARCHIVED 2026-08-13.** One-shot runbook for deploying the `migrate/d1-to-supabase` branch, which merged **2026-06-13**; that branch no longer exists. Current release path: `docs/STAGING-RELEASES.md` and `.github/workflows/deploy.yml`. Kept for history; do not follow it as a current instruction.

# Deploy runbook — User Management (positions + access matrix)

Everything is merged into **`migrate/d1-to-supabase`** (the live integration branch),
37/37 tests green, typecheck + build + bundle clean. These steps put it in prod and
create the test accounts. Run from the repo root. Pick **Path A (CI)** unless you have
a reason to deploy by hand.

> Do it in a low-traffic window. Each Worker deploy resets the Hyperdrive pool, which on
> the SG micro can cause a brief cold-pool stall — the keep-warm cron + retry self-heal,
> but don't deploy repeatedly back-to-back.

## Path A — via CI (recommended; gets the frontend's VITE_API_URL right)
1. Merge `migrate/d1-to-supabase` → `main` (PR or fast-forward). Pushing `main` triggers
   `deploy.yml`: it typechecks + tests, deploys the Worker, runs the post-deploy smoke,
   then builds + deploys the frontend (Pages) with `VITE_API_URL` from the repo var.
2. Apply the DB migration (creates the positions tables):
   ```
   cd backend && node scripts/pg-migrate.mjs
   ```
3. Seed positions + matrix + the 17 test accounts:
   ```
   node scripts/seed-user-management.mjs        # --dry-run first to preview
   ```

## Path B — manual (no main merge)
```
cd backend && npm run deploy                    # Worker
node scripts/pg-migrate.mjs                      # tables
node scripts/seed-user-management.mjs            # positions + matrix + test accounts
cd ../frontend
VITE_API_URL=https://autocount-sync-api.houzs-erp.workers.dev npm run deploy
```
(The frontend build MUST have `VITE_API_URL` set or the bundle won't know the API origin.)

## Verify after deploy
- Backend health (no login, no PII):
  ```
  curl -s https://autocount-sync-api.houzs-erp.workers.dev/api/auth/status   # {"has_users":true}
  curl -s https://autocount-sync-api.houzs-erp.workers.dev/api/positions -H "Authorization: Bearer $DASHBOARD_API_KEY"
  ```
- **Existing users unaffected** (this is the thing to eyeball): log in as a normal current
  user and confirm they still see their usual pages. The route guards moved from
  permission-verbs to the position matrix; un-migrated users fall back to their role matrix,
  so this should be a no-op — but confirm once.
- **Per-position view**: log into the test accounts (password `houzs1234`) and check each
  only sees its pages:
  `sales_director@example.my`, `sales_manager@example.my`, `sales_executive@example.my`,
  `sales_person@example.my`, `sales_trainee@example.my`, `ops_director@example.my`,
  `ops_manager@example.my`, `ops_executive@example.my`, `purchasing@example.my`,
  `logistic@example.my`, `storekeeper@example.my`, `hr_manager@example.my`,
  `finance_manager@example.my`, `admin_assistant@example.my`, `super_admin@example.my`.
  `driver@example.my` / `helper@example.my` route to the driver mobile portal (by design).
- Edit a position's pages live: User Management → **Positions** tab → pick a position → toggle
  none/view/edit/full → Save.

## Rollback
- Worker: `cd backend && wrangler rollback` (or redeploy the previous version).
- The migration is additive (new tables only) — safe to leave. Remove test accounts anytime:
  `node backend/scripts/seed-user-management.mjs --remove-tests`.

## Notes
- All prod-mutating steps above are gated by the assistant's safety classifier, so they're
  for you / IT to run — the assistant can't deploy or write to prod.
- Pending (not in this deploy): PIC visibility auto-expiry when a project ends (owner to
  decide); tidy duplicate roles (Purchaser / Logistic Purchasing / Logistic).
