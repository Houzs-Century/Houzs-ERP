## The staging rehearsal had been red every night since 2026-08-21 and nobody was told — an empty staging list renders no empty state, and staging carried no production-shaped data [high]

<!-- area: Deploy, CI, migrations -->
<!-- status: open -->

**Symptom.** Owner, 2026-09-12: 「有没有什么办法模拟和 prevent 有问题先？…还是你
查看我们有没有 staging」. Checked with `gh run list --workflow=staging-e2e.yml`
rather than the docs: the nightly staging E2E had concluded `failure` on every
run since the last `success` on 2026-08-21 — three weeks of red — and
`staging-e2e.yml` carries no `if: failure()` notification step, so no person
was ever told. `deploy-staging.yml` had last succeeded on 2026-09-08 at
`c9d3ea6`, 430 commits behind `main`, because it deploys only on `push` to the
dead `staging` branch (3,866 commits stale) or by hand. This is
`docs/staging-bench-rot-coe.md` / docs/bugs/0083 in its mirror form: 0083 was a
GREEN nobody verified; this is a RED nobody read.

**Root cause (traced, two halves).**

*The red itself — LIKELY, not yet proven.* Run 34526187376, `so-list.spec.ts:73`:
the assertion wants EITHER a document cell OR the visible empty state, and
Playwright found the empty-state text only in the phone `CardsGrid`
(`MfgSalesOrdersListV2.tsx:359`, inside `<div className="md:hidden">`, so hidden
at desktop width). The desktop `DataTable` renders its `emptyLabel` only when
`!effectiveLoading && !error && sortedRows.length === 0`
(`DataTable.tsx:2580`), and `effectiveLoading = loading || searchBusy` where
`searchBusy` folds in `search.searching` and `searchDraftPending`
(`DataTable.tsx:632-634`). The staging database has been seeded only with a
login account and one showroom (`staging-seed-account.mjs`; the last seed run
was 2026-07-28), so the list is genuinely EMPTY there. What has NOT been
observed: whether the desktop table stays in its loading skeleton on an empty
result (a real bug: an empty list never shows its empty state) or whether the
request never returned. The observation that settles it is the next
`staging-e2e` run after staging carries production-shaped data — if the SO list
turns green on rows, the empty-state path is the suspect and gets its own
entry.

*Why nobody knew — PROVEN by reading the workflow.* `staging-e2e.yml` has no
step gated on `failure()`; the schedule fires at 02:00 MYT and the result goes
only to the Actions tab. The same shape as 0083 and
`docs/staging-bench-rot-coe.md`: a rehearsal whose verdict reaches no one is
not a rehearsal.

*Why staging had no data — by design, now retracted by the owner.* The only
seed was the login account. The owner's ruling on 2026-09-12: 「data 也是要部署
过去」.

**Fix (this PR — first half).** `.github/workflows/staging-refresh-data.yml`:
a two-job, two-environment copy of production data into staging. `dump` runs
under `Production` and holds only `DATABASE_URL` (read-only `pg_dump
--data-only`, `public` + `scm`, migration tracker excluded); `restore` runs
under `Staging` and holds only `STAGING_DATABASE_URL` (truncate, load under
`session_replication_role = replica`, reset every serial to `max(id)` per
docs/bugs/0532, then MASK every phone / mobile / email text column except staff
login identity, re-seed the known login, and fail if any of the six document
tables is empty). Both jobs assert the project id in the URL before touching
anything, so a mis-scoped secret refuses rather than writes. Safety is by
construction: masked data cannot reach a real customer even if a messaging
secret is ever set on the staging Worker (`wrangler secret list --env staging`
could not be read from this machine — the local Cloudflare login is a
different account — so that list is UNKNOWN and the masking does not depend on
it).

**UNTESTED at the time of writing.** The workflow has been parsed
(`js-yaml`) and passes `audit:workflow-consistency`, but per CLAUDE.md a
`workflow_dispatch` workflow is not shipped until dispatched once with a
successful run. The first dispatch and its run URL belong in the PR body and
in this entry's Ref before the status tag moves to `fixed`.

**Still open after this PR (second half, separate PR).** A `failure()`
notification on `staging-e2e.yml`; auto-deploy of staging on every merge to
`main`; and an E2E that walks SO -> PO -> GR -> DO -> SI on both surfaces —
today the six specs cover login, isolation, one list, one service case and a
smoke.

**Ref.** `chore/staging-rehearsal-data-copy`, 2026-09-12.
