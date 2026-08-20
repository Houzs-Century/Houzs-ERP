## Staging carried no build stamp, so two weeks of green nightly E2E proved a two-week-old build [high]

**Symptom** - `Staging E2E (smoke)` reported `success` every night from at least
2026-08-04 to 2026-08-11, ~90s each, running real login / SO-list / company-
isolation proofs. Staging had not been built from `main` since **2026-07-29
16:20 UTC**, by then 775 commits and 59 production migrations behind. Every
assertion was true and none of them were about current code.

**Root cause (traced, not guessed)** - two independent facts had to meet.
(1) The Staging `CLOUDFLARE_API_TOKEN` **worked for four weeks and then died**:
last successful deploy 2026-07-29 16:20 UTC (run 30470280714), first failure
2026-07-30 06:00 (run 30518266259), already carrying `Invalid access token
[code: 9109]` while the GitHub secret's `updated_at` stayed 2026-07-01 — so the
credential was revoked or expired on Cloudflare's side. On 2026-07-31 `main` was
correctly removed from the trigger so the permanent red would stop training
people to ignore red — after which the workflow simply stopped being invoked,
because the `staging` branch it still triggers on last moved 2026-07-14.
(2) `staging-e2e.yml` also runs on a nightly `schedule`, which needs no deploy.
It pointed at the still-running old stack and passed. Nothing made the gap
visible: prod stamps `--var GIT_SHA:${{ github.sha }}` and has a watchdog
comparing it to `main` every 15 minutes, but `deploy-staging.yml` never added
the stamp, so staging `/health` answered `{"ok":true,"sha":null}`. Reproduced on
demand: run 31566944717, dispatched from `main` on 2026-08-12, passed typecheck,
tests and build and failed at `cloudflare/wrangler-action` — the token is still
bad.

**Fix** - `deploy-staging.yml` now stamps `--var GIT_SHA`, and `staging-e2e.yml`
reports the deployed commit against the commit it checked out, warning when they
differ or when the stamp is absent. Deliberately a warning, not a failure: the
suite proves an environment, and failing it while the deploy is paused would
recreate the permanently-red workflow the pause was right to remove. Restoring
`main` to the trigger is blocked on the owner issuing a new token. Full write-up
and the ruled-out theories: `docs/staging-bench-rot-coe.md`.

**Ref** - `docs/staging-truth-and-map-refresh`, 2026-08-12
