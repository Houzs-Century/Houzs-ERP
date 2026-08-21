## Delivery Planning board listed other companies' Service Cases [high]

**Symptom.** The Delivery Planning board showed Service Cases belonging to a
company the signed-in person holds no grant for, while the Service Cases list
(`/api/assr`) correctly hid those same cases from the same person. Shown this,
the owner ruled on 2026-08-21: 「这个也不可以啊」.

**Root cause (traced).** The board's ASSR union in
`backend/src/scm/routes/delivery-planning.ts` (section 7b of `GET /`) read
`public.assr_cases` through a raw `c.env.DB.prepare()` template literal whose
`WHERE` filtered on `closed_at` / `archived_at` / a driving date and NOTHING
else. `/api/assr` scopes the identical table with `assrCompanySql` (the caller's
granted companies) on every read. The raw-SQL path is the mechanism: the
supabase-js scoping helpers — `scopeToAllowedCompanies` — cannot reach a
`DB.prepare()` string, so the predicate has to be added by hand, and the raw-SQL
caveat at the foot of `scm/lib/companyScope.ts` says exactly that. It went
unnoticed because the statement was an inline template literal in the middle of a
3,000-line handler, where nothing could assert it. A stale comment beside it
(`"no scm company_id yet"`) also asserted the column did not exist;
`public.assr_cases.company_id` is `bigint NOT NULL` and has been scoped on since
2026-07-20 — verified against production on 2026-08-21 (run 32467665635).

The paired WRITE had the same hole: the ASSR branch of `PATCH
/delivery-planning/:type/:id/schedule` guarded on `id = ? AND closed_at IS NULL
AND archived_at IS NULL` with no company term, so an out-of-scope case could be
given a date and wired onto a lorry by id — the read only shows a row, the write
consumes fleet capacity.

**Fix.** The two statements moved into exported builders, `assrBoardUnionSql()`
and `assrOpenCaseGuardSql()`, which append `assrCompanySql` imported from
`routes/assr.ts` — the same function `/api/assr` uses, never a local copy (the
`routes/search.ts` drift is the precedent for why a copy is not acceptable). An
out-of-scope case now 404s on the schedule write exactly as `/api/assr`'s own
`caseInCallerScope` answers. ASSR board rows also gained the `company_code` chip
the SO rows already carried.

`backend/tests/deliveryBoardAssrScope.test.ts` pins both statements, comparing
against `assrCompanySql` by value rather than a hand-written string so a third
copy of the rule cannot pass. Proved RED on the unfixed tree — with the predicate
stripped, 5 of 8 assertions failed (`expected 'SELECT id FROM assr_cases…' to
contain ' AND company_id IN (1)'`); 8 of 8 green with it restored.

Not touched, deliberately: the row-level visibility rule
(`assrVisibilityPredicateSql`) — the ruling was about the company boundary — and
the PMS project union in the same handler, which its own comment documents as
company-blind because the fleet is shared.

**Ref.** `fix/delivery-board-company-scope`, 2026-08-21.
