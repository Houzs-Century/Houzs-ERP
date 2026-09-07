## The AutoCount status checker had drifted from the readiness rule it copies [medium]

<!-- area: Sales orders + pricing -->

**Symptom.** None reported — this was found by looking for it, while verifying
the two MRP allocation rules against production on 2026-09-07. That is worth
saying plainly, because a checker that measures its own copy of a rule does not
fail; it produces confident, wrong disagreement counts.

`check-stock-vs-autocount.mjs` section B compares AutoCount's hand-typed
`SO.Remark2` against the ERP's derived stock remark. It derives the ERP side
from its own transcription of `src/scm/lib/so-readiness.ts`, whose own comment
says why: *"this script must derive the SAME string the UI shows, or the status
comparison measures the script instead of the ERP."*

**Root cause (traced).** Two transcriptions had gone stale.

1. **SERVICE lines.** On 2026-08-16 the owner ruled that a service-only order is
   ready on sight — 「如果它是 service 的单，也应该直接 ready」 — and
   `so-readiness.ts` implements it by COUNTING service lines into `liveCount`
   while still excluding them from every ready/short tally. The copy kept the
   older `continue`, so its gates read `mainCount + accCount`. An order whose
   every line is a delivery fee therefore scored byte-identically to an order
   with NO lines: the ERP shows `READY`, the checker derived `""`, and the
   difference was attributed to AutoCount.
2. **The processing-date gate.** The line read `h.proceeded_at` and its comment
   said *"recomputeSoStockAllocation gates on it"*. That gate moved to
   `processing_date` on 2026-08-18 (`SO_PROCESSING_DATE_COLUMN`, whose docstring
   is that column's stop-reading step), and no shipped client writes
   `proceeded_at` when an operator sets a Processing Date. So the checker's own
   EXPLANATION for a disagreement was derived from a column the engine it
   explains no longer consults.

**Fix.** `svcCount` is counted and both gates read `liveCount`, matching
`so-readiness.ts`; the read and the explanation string moved to
`processing_date`. The header comment now records that this copy DID drift and
names the durable alternative — run the script under `tsx` and import
`summariseReadiness`, the way `scripts/probe-mrp-allocation-rules.mjs` imports
`isHardBoundLine` rather than restating it.

**Blast radius — UNKNOWN, deliberately not guessed.** How many company-1 orders
are service-only has not been measured; the number is small by construction (a
sales order with nothing but a delivery fee) but nothing here establishes it.
The `proceeded_at` half is LIKELY inert on today's data: mig 0286 consolidated
that column on 2026-08-13 and the split was measured at zero for company 1 —
519 orders with both set, 2205 with neither, none in disagreement. Neither claim
is used to argue the fix was unnecessary.
