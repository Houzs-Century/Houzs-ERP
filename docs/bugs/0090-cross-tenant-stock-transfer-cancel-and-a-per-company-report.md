## Cross-tenant stock-transfer cancel, and a per-company report that returned both companies [high]

**Symptom** - two holes of the same class, found 2026-08-13 by an external
full-module code audit and each verified against the source before being touched.

1. `PATCH /stock-transfers/:id/cancel` had no company scoping anywhere: the
   before-read was `.eq('id', id)` and the CANCELLED flip was
   `.update(...).eq('id', id).neq('status','CANCELLED')`. A caller in company A
   holding company B's transfer UUID could cancel B's POSTED transfer — and the
   handler then calls `reverseMovements(sb, 'STOCK_TRANSFER', id, ...)`, so B's
   stock moved back. **This is a WRITE**, unlike the seven read-side `/:id/linked`
   leaks fixed the day before.
2. `GET /inventory/reconcile` called `reconcileLedger(sb)` with no second
   argument, so the operator-facing report returned BOTH companies' GRN, DO,
   transfer and consignment document numbers and statuses.

**Root cause (traced, not guessed)** - both are missed call sites, not missing
mechanisms. The 2026-07-22 owner audit scoped every sibling flow;
`stock-takes.ts:437-440` carries that fix with a comment naming this exact class
("the sibling /cancel /reverse /post already do requireActiveCompanyId; align")
— the stock-transfer cancel was simply never aligned. And `reconcileLedger`
(`scm/lib/reconcile-ledger.ts:46-51`) has ALWAYS taken `companyId?`, with its
own comment stating the operator endpoint is per-company "so the report can't
surface the other company's doc numbers"; only `systemHealth.ts:297` is meant to
run cross-company. The guard existed and the caller skipped it.

**Fix** - the cancel now takes `requireActiveCompanyId` and scopes BOTH the
before-read and the flip, returning `NOT_THIS_COMPANY` (404) on a foreign id;
`/reconcile` passes `activeCompanyId(c)`. Verified: backend typecheck clean,
companyScopeHardening passes (16 tests).

**What this is really about** - the day before, a documentation sweep found 7
cross-company leaks and I reported "7 bugs, none in the money path, this is not
a bad system". That was a statement about what MY question could find. A sweep
that asks "do the docs match the code" surfaces documentation defects; it does
not go looking for missed guards. The audit that asked "find the bugs" returned
**56 cross-company scope misses, 27 of them high**. Same codebase, same day,
different question. **The size of a finding set is a property of the question,
not of the system** — and a clean result from one lens must never be reported as
a verdict on the whole.

**Ref** - docs/staging-truth-and-map-refresh, 2026-08-13

---
