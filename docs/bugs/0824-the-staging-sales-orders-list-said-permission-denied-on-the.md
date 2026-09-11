## The staging Sales Orders list said permission denied on the payment-totals view for three weeks, and the repo-level STAGING_DATABASE_URL secret points at production [high]

<!-- area: Deploy, CI, migrations -->
<!-- status: open -->

**Symptom.** The staging rehearsal (`staging-e2e.yml`) had been red on every run
since 2026-08-21. After redeploying today's `main` to staging (run
34626351932, `/health` answering `72c21a2`) it stayed red at the same
assertion, `so-list.spec.ts:73`. The Playwright screenshot on run 34627320170
shows the Sales Orders page with the grid reading **"Failed to load —
permission denied for view mfg_sales_orders_with_payment_totals"**. Production
serves the same list from the same view without error.

**What was RULED OUT first.** The first hypothesis, written into
docs/bugs/0824 (the staging-data entry, #3701), was that an EMPTY staging list
never rendered its empty state. The screenshot refuted it: the request came
back with a permission error, not an empty result. That entry keeps the wrong
guess on the record; this one carries the observation.

**Root cause (traced).** *The view.* PROVEN by the screenshot that the role the
staging runtime reads the view with lacks SELECT. Production reads it through
the same route (`mfg-sales-orders.ts`, `sb.from('mfg_sales_orders_with_payment_totals')`,
supabase-js = `service_role`) and works, so the grantee set differs between
the two databases. All three recreations since the 0189 outage — 0325
(merged 2026-08-22, the day after the last green rehearsal), 20260909T1001,
20260911T1500 — used `CREATE OR REPLACE VIEW`, which keeps the ACL, so what
staging's ACL held BEFORE 0325 is the open question. Which role exactly is
missing is **UNKNOWN**: the read-only catalog check (`dump-scm-schema.yml`,
target staging) could not be run — see the second half — so the fix is
written to be self-adapting and to PRINT the grantee list before and after,
making the staging-migrate log the observation.

*Why production survives DROP + CREATE at all — PROVEN in source, found by
the gate below going red on three applied files.* 0305, 0307 and
20260906T1500 each `DROP VIEW` and re-grant nothing (their only
`role_table_grants` mention is inside a comment), yet prod serves those views.
`0217_app_role_regrants.sql:16-17` set `ALTER DEFAULT PRIVILEGES IN SCHEMA
public|scm GRANT SELECT ... ON TABLES TO service_role`, so every object CREATED
afterwards gets PostgREST's role automatically. That default binds to the role
that RAN 0217 (no `FOR ROLE`), i.e. the migration runner's login — so a
database whose migrations ran as a different role never received it, which is
one concrete way staging can hold an ACL prod does not. Hyperdrive roles are
not in the default at all; prod does not notice because the SO list reads via
PostgREST.

*The secret — PROVEN, and the more dangerous of the two.* Dispatching
`dump-scm-schema.yml` with its default `target: staging` failed with
`pg_dump: error: connection to server at "db.anogrigyjbduyzclzjgn.supabase.co"
... Network is unreachable` (run 34627822684). That host is **production**. The
workflow has no `environment:` line, so `secrets.STAGING_DATABASE_URL`
resolved at REPO scope — and `gh secret list` shows a repo-level
`STAGING_DATABASE_URL` (2026-07-06) beside the Staging-environment one
(2026-07-01). The repo-level value points at the production project's direct
host. 96 workflows read `STAGING_DATABASE_URL` without `environment: Staging`
(enumerate: `for f in $(grep -l STAGING_DATABASE_URL .github/workflows/*.yml); do
grep -q "environment: Staging" $f || echo $f; done`), among them `apply-*`,
`repair-*`, `fix-*` and `merge-*` scripts whose "staging" option therefore
targets production. The only reason none has written prod: the value is the
direct IPv6 host, which GitHub runners cannot reach, so every such "staging"
run has failed with the same network error. That is luck, not a guard.

**Fix (this PR).**
- `20260912T0130_scm_regrant_so_payment_totals_view.sql` — 0191's
  self-adapting copy widened: sibling grantees + owner, `service_role`
  outright, every `hyperdrive%` role present, with `RAISE NOTICE` of the
  grantee list before and after. Idempotent; a no-op on production if it
  already holds every grant.
- `backend/tests/viewDropCarriesGrantRestore.test.ts` — bug class H's first
  check (docs/bug-classes.md listed it as "no check yet"): every migration
  that `DROP VIEW`s must carry a grant-restore (0191's `role_table_grants`
  block, or an explicit GRANT on the view it drops). Light project, so it gates
  the merge. Population asserted non-empty (7 files today); 0084 and 0189
  grandfathered with the reason in the file.

**Still open — owner action.** The repo-level `STAGING_DATABASE_URL` secret
must be DELETED (or repointed at staging's pooler) in GitHub → Settings →
Secrets; only the Staging environment should carry that name. Until then the
96 workflows above are one reachable host away from writing production.
`staging-refresh-data.yml` (#3701) is not among them: its restore job runs
under `environment: Staging` and refuses any URL that is not project
`minnapsemfzjmtvnnvdd`.

**Verification owed before `fixed`.** The `NOTICE ... AFTER:` line in the
staging-migrate run that applies this migration, and a green
`so-list.spec.ts` on the following rehearsal.

**Ref.** `fix/staging-so-view-grant`, 2026-09-12.
