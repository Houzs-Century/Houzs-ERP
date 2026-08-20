## The deploy uploaded secrets before deploying, and Cloudflare refused both — 8 merges stuck out of production [high]

**Symptom.** Eight consecutive `Deploy` runs failed from 2026-08-18T01:08 MYT.
Every test in every one of them passed; only the `backend` job failed. Nobody
reported it — it was found on a morning state check. `notify-failed-release` ran
and concluded `success` on each failure, so the alerts fired overnight and the
pipeline stayed broken anyway.

**Measured against production, not inferred:**

```
$ curl -fsS https://autocount-sync-api.houzs-erp.workers.dev/health
{"ok":true,"sha":"3697d41e50166ba8c2b36feceb954497dd1ef63f"}   # #2373, 00:11 MYT
```

8 commits and 75 files under `backend/src` on `main` and not live. **0 new
migrations in the stuck set** — luck, not design: `pg-migrate` runs BEFORE the
Worker deploy and kept succeeding, so a migration in that set would have left old
code on a new schema for nine hours.

**Root cause (traced).** `cloudflare/wrangler-action` uploads `secrets:` BEFORE
it runs `command:`, and the two were one step. The upload failed:

```
🚨 Secrets failed to upload
✘ [ERROR] Secret edit failed. You attempted to modify a secret, but the latest
  version of your Worker isn't currently deployed. ... [code: 10215]
```

Cloudflare refuses `secret bulk` when the Worker's newest VERSION is not the
DEPLOYED one. The action aborted, so `deploy` never ran.

**The deadlock is the finding, not the error.** The action that clears the
condition is `deploy` — and `deploy` was what the failing check was blocking. It
could not drain, which is why it survived eight merges instead of one.

**Fix.** `deploy` and the secret upload are now two steps, deploy first. That
publishes the newest version — exactly the state 10215 demands — so the upload
runs against a Worker that accepts it and the pipeline heals itself. Remedy (2)
in Cloudflare's own error text. Secrets are piped on stdin via `jq -n --arg`, so
no value reaches a logged argv.

**NOT PROVEN.** A workflow is not shipped until it has run once and reported
success, and this cannot be exercised without a real production deploy. The first
`Deploy` after this merges is the test.

**Ruled out, each refuted rather than argued away:** a newly added secret
(`FORM_INTAKE_KEY` dates to 2026-07-05, #280); a failed migration (`298
migration(s), 316 applied, 0 pending` on every failed run); our own CI creating
the stray version (`grep -rn "versions upload"` is empty); an earlier failed
deploy half-publishing (both show `backend: skipped` — a test shard failed, so
wrangler never ran); the staging deploy clobbering prod (`[env.staging]` names a
different Worker).

**Second defect, found while auditing the first.** `deploy-watchdog.yml` knew
production was stale for nine hours, said so in a `::warning::` annotation, and
concluded `success` every 15 minutes — its "deploys are failing, do not retry
into them" branch is `exit 0`. The reasoning is right and the exit code is not: a
watchdog whose green means "I looked and chose not to act" is indistinguishable
from "all is well". Third instance of that class here, after `audit:map` and the
nightly staging E2E. Left as an owner decision — see the COE.

**Still UNKNOWN:** what created a Worker version that was uploaded but never
deployed. Nothing in the repo does it. Candidates are all outside CI (Workers
Builds git integration, a dashboard edit, a hand-run `wrangler versions upload`,
a gradual rollout below 100%) and one look at the Worker's Deployments tab
settles it.

**Ref.** `docs/deploy-secret-version-deadlock-coe.md`, 2026-08-18.
