## The POS KPI item revenue row was hardcoded to zero long after the machinery it waited for had landed [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** Reported from the sales floor 26 Aug 2026: "KPI item sales revenue"
read **RM 0** on the POS My-Orders board — on both the Showroom and the Personal
card, for every salesperson, in both companies, while Products and Service
showed real figures. A developer tracing the data flow from
`OrderStatus.tsx:924` could not find where the number came from and got stuck.

They got stuck because there was nothing to find.

**Root cause (traced).** `backend/src/routes/pos.ts` returned a literal:

```ts
kpi: 0,
products: toMyr(goods),   // = goods (item-KPI split deferred → #19)
```

behind a comment saying the item-KPI split "needs the HR commission machinery,
which has no Houzs home yet (#19)". That was true when it was written and had
stopped being true well before this report: `scm.hr_item_kpi` /
`hr_commission_config` / `hr_salesperson_profiles` arrived in mig **0123**, were
company-scoped by **0089**, extended by **0150**; `scm/lib/kpi-units.ts` and
`scm/routes/hr.ts` are ported and mounted; `unitKpiExcludedSen` is implemented
and tested in `scm/shared/hr-commission.test.ts`; and HR Settings already
exposes the flag CRUD. Every part existed except this one read.

The comment is what made it invisible. It named a blocker, so each reader
concluded the work was upstream and moved on — including the reader who ported
the blocker.

**Fix.** `/sales-stats` now resolves the flags through the same
`loadKpiUnitsByDoc` that `/hr/commission` uses, so the dashboard and the
commission run cannot answer differently. The route reads the doc numbers its
own predicate matched (same `WHERE`, same binds as the aggregate, so the two
cannot describe different order sets), and the money split moved into
`scm/lib/pos-kpi-split.ts` — pure, 11 tests, covering the carve-out
(KPI comes OUT of Products, never on top), the clamps (KPI ≤ goods so Products
can't go negative; Service ≥ 0 when goods exceed the total), and NaN inputs.

A KPI read failure returns **500** rather than falling through to "no flags",
mirroring `hr.ts` — answering 0 on an error is indistinguishable from "nothing
is flagged", which is the exact ambiguity this endpoint spent months in.

`getSupabaseService(c.env)` rather than the `supabase` middleware: `/api/pos` is
session-authed and mounted pre-auth, so it has no Supabase context to read and
adding `supabaseAuth` would change its auth model.

**What this does NOT do.** It does not invent data. With `scm.hr_item_kpi` empty
for a company, every card there still reads RM 0 — correctly, and identically to
2990's own API. **Zero now means "nothing is flagged" instead of "not
implemented"**, and the fix for a company that wants non-zero numbers is to flag
items in HR Settings.

**The lesson.** A stale blocker comment outlives its blocker and reads as
current on every visit. When a comment defers work to another issue, it needs
re-checking against the tree, not trusting — `#19` had been closed by the very
port that made this fix a twenty-line wiring job.

**A local-only failure, recorded because the conclusion was wrong at first:**
`tests/doStockLeavesOnConfirm.test.ts` failed here on clean `origin/main` too,
so it read as a pre-existing repo break — but CI's `backend-tests` shards pass
it. The difference is the environment: this worktree's `node_modules` is
junctioned from a clone that trails `main`, so a local run can fail on a
dependency the repo has already moved past. **CI is the authority; a local
red reproduced on `origin/main` proves the environment, not the tree.**

**Ref.** feat/pos-kpi-item-revenue, 2026-08-26.
