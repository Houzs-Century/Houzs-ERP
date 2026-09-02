## A nullable company id in .eq() matched nothing and minted duplicates [high]

<!-- area: Fleet, trips, TMS -->

**Symptom.** Nothing reproducible on demand — it only appears while the active
company cannot be resolved (a companies-master blip, `companyContext.ts:296-317`).
In that window the Fleet workshops list comes back **empty**, editing a workshop
answers **"workshop not found"** over a row that plainly exists, and — the one
that leaves damage behind — a newly created workshop, breakdown case, work order
or component is minted with a **duplicate code**.

**Root cause (traced).** Five sites in
`backend/src/scm/routes/fleet-maintenance.ts` hand-rolled the company filter past
a nullable value:

```
:1991  mintWorkshopCode   .eq("company_id", companyId)            <- companyId is number | null
:2001  mintRecordNo       .eq("company_id", companyId)            <- same
:2010  GET  /workshops    .eq("company_id", activeCompanyId(c) ?? null)
:2086  PATCH /workshops/:id  .eq("company_id", activeCompanyId(c) ?? null)
```

PostgREST renders that as `company_id=eq.null`, i.e. `company_id = NULL`, which
is never true. **The query matches nothing.** That is not a wide read and it is
not a refusal — it is a silent empty answer, and which direction it breaks
depends on what the caller was asking:

| caller | what a null company produced |
| --- | --- |
| a LIST (`GET /workshops`) | an empty page over rows that exist |
| an EDIT (`PATCH /workshops/:id`) | a phantom 404 over a real row |
| **a MINT** (`mintWorkshopCode`, `mintRecordNo`) | **zero existing codes read, the sequence restarts at 1, a DUPLICATE is issued** |

The mint case is the damaging one, and the comment sitting directly above
`mintWorkshopCode` is *about not minting duplicates* — it explains why the read
must fetch every code rather than an ordered `LIMIT`. The line underneath it
could fetch none.

`scm/lib/companyScope.ts` has had the purpose-built helpers all along, and its
own docstring names this exact mistake (`:136`): *"would otherwise write
`.eq('company_id', null)` — which is a malformed filter, not 'no company', and
matches nothing."*

**Fix.** Each site now uses the helper whose failure direction is right for it:

- the two **workshop** handlers → `scopeToCompany(query, c)`. Workshops ARE
  per-company (mig 0241, and the file's own `company-scope-file:` note says so),
  so failing CLOSED when the context is resolved is correct.
- the two **mints** → `scopeToCompanyIdOrOpen(query, companyId)`. Falling OPEN is
  the safe error here: the mint then sees MORE codes and skips past them, where
  seeing none collides.

A tree-wide sweep found no other occurrence of the shape in `backend/src`.

**Test.** `backend/tests/companyEqNullFilter.test.ts` walks every non-test file
under `backend/src` and fails on the pattern. It carries a self-test, and that
self-test earned its place twice while being written:

1. the first matcher used `[^)]*`, which cannot cross the `)` in
   `activeCompanyId(c)` — so it matched **nothing** and reported the tree clean.
   The self-test caught it. This is CLAUDE.md's *"a checker that cannot match
   reports a clean run"*, live, in the guard written to prevent a different
   silent-nothing bug.
2. it then tripped on the explanatory comments left at the repaired sites, which
   deliberately quote the broken expression. Both comment forms are now stripped
   before scanning — a guard that trips on the note explaining the repair is a
   guard someone deletes.

Proved RED by putting the broken expression back into `mintWorkshopCode`.

**DELIBERATELY NOT TOUCHED — and it is the bigger question, so read this before
"fixing" the module.** `GET /fleet-maintenance/dashboard` (`:574-587`) reads
`lorry_compliance_documents`, `lorry_maintenance_plans`,
`lorry_breakdown_cases`, `lorry_work_orders` and `lorry_work_order_parts` with
**no company predicate at all**, while twelve by-id handlers on those same
tables **do** call `scopeToCompany`. So the dashboard lists a row that
`PATCH`/`DELETE` then 404s.

The file's own `company-scope-file:` marker (`:186-198`) says the module is a
UNIFIED FLEET — migrations 0202, 0203, 0204 and 0238 each state that
`company_id` is *"STAMPED on insert for provenance but NOT used to scope
reads"*, *"one shared lorry fleet across ALL companies"* — and it predicts this
exact failure in words: *"scoping only the WRITERS would leave the dashboard
listing a row that PATCH/DELETE then 404s."* Two docs then disagree with each
other (`MULTICOMPANY-MODULE-MAP.md:204-215` says SEPARATE;
`MULTI-COMPANY-SCOPE-MODEL.md:67-71` says CENTRALISED, provenance-only).

By the migrations and the marker, **the twelve `scopeToCompany` calls are the
deviation, not the dashboard** — which means the fix is to REMOVE scoping, and
that widens who can edit what. That is not a change to make on a reading of the
tree.

> **Owner decision owed.** Are maintenance records shared like the lorries
> themselves, or per-company like `scm.workshops`? The 2026-07-14 ruling was that
> lorries, drivers and helpers are one shared fleet, which points at un-scoping
> the twelve. Whichever way it goes, the file marker and the two contradicting
> docs must be corrected in the same PR.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
