# Emergency production deploy (outside GitHub Actions)

`scripts/emergency-deploy.mjs` is the **only** sanctioned way to deploy prod
without GitHub Actions. It exists for one scenario: **Actions cannot run**
(minutes exhausted, GitHub outage) and a release cannot wait. For anything
else, merge to main — `deploy.yml` is the release pipeline.

Never run bare `wrangler deploy` / `wrangler pages deploy` against prod. Four
separate incidents (see `deploy-watchdog.yml`'s header and
`docs/deploy-collision-coe.md`) came from exactly that: ambient credentials +
a stale clone + no trail. The watchdog now treats any unstamped Worker as a
rogue deploy and redeploys over it.

## Standing security posture (why the token lives nowhere)

- Every machine is `wrangler logout`-ed. No ambient OAuth anywhere.
- The **deploy token** (scoped to this account's Worker + Pages deploys) lives
  in the password manager only. It is fetched per-use, set as an env var in
  one shell, and discarded with that shell.
- The prod `DATABASE_URL` (Supabase direct connection string) is handled the
  same way — needed only when migrations are pending.
- GitHub Actions holds its own copies as repo secrets; those never leave CI.

## Running it

```powershell
# 1. Fresh checkout of main (the script hard-refuses anything else)
git checkout main; git pull --ff-only

# 2. Credentials for THIS shell only (from the password manager)
$env:CLOUDFLARE_API_TOKEN = "<deploy token>"
$env:DATABASE_URL = "<prod connection string>"   # only if a migration merged recently

# 3. Deploy
node scripts/emergency-deploy.mjs --reason "Actions minutes exhausted; #1234 must ship"

# 4. Close the shell (kills the credentials)
```

The script refuses to start unless **all** of these hold, in this order:

1. `CLOUDFLARE_API_TOKEN` is set (ambient OAuth is rejected by omission).
2. `git fetch` works and `HEAD == origin/main` tip — the stale-clone guard.
3. The working tree is clean — you ship main, not main-plus-whatever.
4. No `deploy.yml` run is queued or in progress (override:
   `--ignore-active-runs`, only for quota-stuck queues you cannot cancel).
5. Backend scope has `DATABASE_URL`, or you explicitly passed
   `--skip-migrations` (only safe when no migration merged since the last
   successful deploy — check `migrations-pg/` against the last Deploy run).

Then it mirrors `deploy.yml` step for step: `npm ci`, `audit:routes`,
typecheck, tests, `pg-migrate`, `wrangler deploy --var GIT_SHA:<sha>` (the
stamp deploy-watchdog verifies), Pages build with the same `VITE_*` repo
variables CI uses (fetched via `gh variable get`), both smoke checks.

## The trail (how everyone else finds out)

Cloudflare records direct uploads but notifies nobody — the 7-23 rogue deploy
was only found by manually diffing the dashboard against GitHub. So after any
deploy (including a partial failure), the script:

- pushes an annotated tag `emergency-deploy/<YYYYMMDD-HHmm>` at the deployed
  commit, and
- opens a GitHub issue titled `Emergency deploy <stamp> — <sha> (<scope>)`
  with commit, scope, reason, operator, and whether migrations/tests ran.

Repo watchers get notified by the issue. **If prod ever looks ahead of or
different from what CI last shipped, check for `emergency-deploy/*` tags
before starting a rogue-deploy hunt.**

## Flags

| flag | use when |
|---|---|
| `--backend-only` / `--frontend-only` | the emergency touches one side only |
| `--yes` | scripted/unattended run (skips the typed `deploy` confirmation) |
| `--skip-tests` | local vitest flakes (miniflare temp-dir issue) — main already passed PR CI, but say so in `--reason` |
| `--skip-migrations` | backend deploy with no `DATABASE_URL` — ONLY when no migration merged since the last successful deploy |
| `--ignore-active-runs` | Deploy runs are quota-stuck in the queue and cannot be cancelled |

## Aftermath

Nothing to clean up. The next merge to main redeploys normally over the
emergency deploy; the watchdog stays green because the Worker's `GIT_SHA`
stamp matches main. Leave the tag and issue in place — they are the audit
record.
