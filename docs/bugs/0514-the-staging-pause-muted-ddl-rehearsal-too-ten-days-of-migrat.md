## The staging pause muted DDL rehearsal too — ten days of migrations never rehearsed [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** Staging Supabase's `_pg_migrations` stops at
`0281_scm_so_amendment_line_remark.sql` (applied 2026-08-12 06:02Z) while
main's `migrations-pg` reached 0322 — every migration merged in those ten
days shipped to prod having never touched a second database. The first one
written against remembered-not-live vocabulary (0321, indexing a column 0307
had renamed) failed on PROD on 2026-08-22 and blocked every deploy behind it
(docs/bugs/0513, which flagged this entry as the follow-up).

**Root cause (traced).** Not a crash — a trigger. When the Staging
environment's `CLOUDFLARE_API_TOKEN` died on Cloudflare's side (2026-07-30,
`Invalid access token [code: 9109]`, see docs/staging-bench-rot-coe.md),
deploy-staging.yml was paused off `main` on 2026-07-31 to stop the
permanently-red noise. But migration application rode in that same workflow,
so the pause muted it too — even though it never needed Cloudflare:
`STAGING_DATABASE_URL` (untouched since 2026-07-01) kept working, proven by
the 2026-08-12 re-dispatches (runs 31566944717 / 31568935051), where the
"Apply or verify staging migrations" step passed and only the two wrangler
steps failed. The run list confirms the trigger story: zero runs between
2026-08-12 and 2026-08-22, workflow state `active`, nothing pushing to the
`staging` branch. One credential died; the blast radius quietly included a
dependency-free rehearsal step nobody meant to switch off.

**Fix.** Decouple the rehearsal from the deploy. New
`.github/workflows/staging-migrate.yml` applies pending migrations to the
staging Supabase on push-to-main over migration paths (plus
`workflow_dispatch`), using only `STAGING_DATABASE_URL`; it shares
deploy-staging.yml's `deploy-staging` concurrency group so the two can never
race one tracker table, and a failed rehearsal opens/updates a named issue
(mirrors deploy.yml's notify-failed-release) instead of rotting unseen in a
run list — ten days of nobody reading that list is this entry. Catch-up was
run first via re-dispatch of deploy-staging (run 32563527181): migrations
0282–0322 against staging. No test can pin a workflow trigger; the RED proof
is the ten-day ledger gap above and 0513's prod failure, the GREEN proof is
the catch-up run's migration step. deploy-staging.yml (Worker + Pages) stays
dispatch-only until a fresh Cloudflare token is minted per its own TO RESTORE
note — that half remains open and is owner-only.

**Ref.** fix/staging-ddl-rehearsal-decouple, 2026-08-22.
