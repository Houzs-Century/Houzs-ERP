# COE — the deploy step uploaded secrets before deploying, and Cloudflare refused both

**Status: RESOLVED 2026-08-18.** Production was un-deployed for nine hours and is
now current on main. The outage numbers below were measured on
2026-08-18 at 10:28 MYT and will move — re-run the commands, do not quote them.

---

## Date · Trigger

**2026-08-18, 01:08 MYT.** Nobody reported this. It was found on the Tuesday
morning state check, because the last five `Deploy` runs on the dashboard were
red while every test in them was green.

That is the uncomfortable part of this one: `notify-failed-release` ran and
concluded `success` on each failure, so the alerts fired overnight and the
pipeline stayed broken anyway.

## What was actually happening

The `backend` job of `.github/workflows/deploy.yml` failed. Every other job in
the run passed:

```
changes: success      backend-tests (1-4): success
frontend: success     backend: failure
```

Measured against production, not inferred from the logs:

```
$ curl -fsS https://autocount-sync-api.houzs-erp.workers.dev/health
{"ok":true,"sha":"3697d41e50166ba8c2b36feceb954497dd1ef63f"}
```

`3697d41e` is #2373, deployed 2026-08-18T00:11 MYT.

| measured 2026-08-18 10:28 MYT | |
| --- | --- |
| consecutive failed `Deploy` runs | **8** |
| commits on `main` and not in production | **8** |
| files under `backend/src` changed and not live | **75** |
| new migrations in the stuck set | **0** |
| frontend | deploying normally throughout |

The zero is the one piece of luck. `pg-migrate` runs BEFORE the Worker deploy and
kept succeeding (`298 migration(s), 316 applied, 0 pending`), so had the stuck set
contained a migration, production would have been running old code against a new
schema for nine hours. It did not. That was chance, not design.

## Root cause, traced

`cloudflare/wrangler-action` uploads the `secrets:` it is given **before** it runs
the `command:` it is given. The two were one step:

```yaml
command: deploy --var GIT_SHA:${{ github.sha }}
secrets: |
  FORM_INTAKE_KEY
  SHEET_SYNC_KEY
```

The upload failed, and the action aborted before the deploy ran:

```
🔑 Uploading secrets...   secrets: FORM_INTAKE_KEY
🚨 Secrets failed to upload
✘ [ERROR] A request to the Cloudflare API
  (/accounts/***/workers/scripts/autocount-sync-api/secrets-bulk) failed.
  Secret edit failed. You attempted to modify a secret, but the latest version of
  your Worker isn't currently deployed. ... [code: 10215]
```

Cloudflare refuses `secret bulk` whenever the Worker's newest VERSION is not the
DEPLOYED one.

**The deadlock is the finding, not the error.** The action that clears the
condition is `deploy` — and `deploy` was the thing being blocked, by the check
that ran before it. So the failure could not drain. It was self-sustaining rather
than transient, which is why it survived eight merges instead of one.

## What the audit RULED OUT

Each of these was a live suspicion, and each was refuted rather than argued away.

| suspicion | how it was refuted |
| --- | --- |
| **A newly added secret broke it.** | `FORM_INTAKE_KEY` was added 2026-07-05 by #280 (`git log -S`). It has ridden every deploy for six weeks. |
| **A migration failed and blocked the deploy** — the shape of `deploy-collision-coe.md`. | The deploy log shows `pg-migrate` succeeding on every failed run: `298 migration(s), 316 applied, 0 pending`. The DB is ahead of the code, not behind it. |
| **Our own CI created the undeployed version.** | Nothing in the repo runs `wrangler versions upload`; `grep -rn "versions upload" .github/workflows backend/wrangler.toml` is empty. |
| **An earlier failed deploy uploaded a version and died before activating it.** | The two earlier failures that day (runs `32034805881`, `32031259098`) both show `backend: skipped` — a test shard failed, so wrangler never ran at all. |
| **The staging deploy clobbered production.** | `[env.staging]` in `backend/wrangler.toml` names a different Worker, `autocount-sync-api-staging`. |
| **The deploy watchdog was broken.** | It ran every 15 minutes and concluded `success` every time — correctly, by its own rules. See below; this is a reporting defect, not a broken check. |

## The second defect, found while auditing the first

`deploy-watchdog.yml` compares the live `/health` stamp against `main` every 15
minutes and redeploys on a mismatch. It carries this branch:

```sh
if [ "$LAST" != "success" ]; then
  echo "::warning::last completed Deploy concluded '$LAST' — skipping auto-redeploy, fix the pipeline first"
  exit 0
fi
```

The reasoning is right — a watchdog that retries into a failing pipeline produces
a retry storm. **The `exit 0` is not.** For nine hours the watchdog knew
production was stale, said so in an annotation nobody opens, and reported the
run as green.

**A watchdog whose green means "I looked and chose not to act" is
indistinguishable, at a glance, from "all is well".** That is the same class as
`staging-bench-rot-coe.md`, where a nightly check passed for two weeks against a
build nobody had deployed. The watchdog is the one job in this repo whose colour
is supposed to mean production is healthy, and on the one morning it was not, it
was green.

## Fixes

| PR | Effect |
| --- | --- |
| this one | Splits the single wrangler-action step in two: `deploy` first, then a separate step that uploads the secrets. `deploy` publishes the newest version, which is exactly the state 10215 demands, so the secret upload now runs against a Worker that accepts it. The pipeline heals itself instead of wedging. This is remedy (2) in Cloudflare's own error text. |

The secret upload is built with `jq -n --arg` and piped on **stdin**, so no value
reaches an argv the runner logs. Actions masks these anyway; this is the second
belt, and this repo has already put a DSN into a transcript once (2026-07-22) by
trusting one layer of redaction.

**The trade, stated rather than hidden.** If a release adds a NEW secret that the
new code reads, there is now a brief window where the code is live and the secret
is not. Add the secret out-of-band before merging the code that needs it —
shipping code that cannot run without a simultaneously-created secret was never
safe in either order.

**PROVEN 2026-08-18, by the first run after merge.** Deploy run `32092465770`
concluded `success` with `backend: success` (not `skipped` — the pair that
matters). Wrangler logged `Deployed autocount-sync-api triggers` /
`Current Version ID: b5b241e5-…`, the new `Upload Worker secrets` step ran AFTER
it and succeeded, and `/health` moved from `3697d41e` to `34f264f1` — main's tip.
Nine consecutive failures, then one success, with no manual intervention at
Cloudflare. The self-healing property was the claim; this is the observation.

## Deferred

| item | owner |
| --- | --- |
| **What created a Worker version that was uploaded but never deployed.** UNKNOWN. The repo cannot answer it by reading itself — nothing here does it. Candidates are all outside CI: the Cloudflare Workers Builds git integration, a dashboard quick-edit, a hand-run `wrangler versions upload`, or a gradual rollout left below 100%. **There is now a check rather than an instruction to go and look:** Actions → **Worker version check (read-only)** → Run workflow (`backend/scripts/check-worker-versions.mjs`). It prints every version above the active deployment with its `metadata.source` and author, which is the field that names the culprit. | owner to dispatch |
| ~~**The immediate unblock.**~~ **RESOLVED 2026-08-18.** Merging the fix below deployed the Worker before touching secrets, which published the newest version and cleared 10215 by itself. Deploy run `32092465770` concluded `success` with `backend: success`; `/health` went from `3697d41e` to `34f264f1` (main tip), catching production up on all 8 stuck commits. No manual dashboard action was needed. | — |
| **Should the watchdog stay green when it declines to act?** Options: exit non-zero on a knowingly-stale production, or split "stale and I am handling it" from "stale and a human must look". Changing it trades a real alarm against alert fatigue. | owner |

## Lessons

1. **A guard that runs before the thing it guards can deadlock it.** Ordering is
   part of a gate's design, not a detail of the tool. Ask what clears the
   condition, and whether the check can prevent that from running.

2. **Green from a check that chose not to run is the most expensive green there
   is.** Third time in this repo: `audit:map` crashing for three weeks, the
   nightly staging E2E passing against an undeployed build, and now the deploy
   watchdog. In all three the check was working exactly as written.

3. **Measure production, do not read the pipeline.** The logs said "the deploy
   failed". One `curl` on `/health` said *which commit is actually serving*, and
   that is the number that mattered — it is what turned "some red runs" into
   "eight merges and 75 backend files are not live".

4. **We were lucky about migrations, and luck is not a control.** `pg-migrate`
   runs before the Worker deploy and kept succeeding. A migration in the stuck
   set would have left old code on a new schema for nine hours. Nothing in the
   pipeline prevents that pairing; it just did not happen this time.
