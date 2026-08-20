## A Sales Order with a Processing Date was refused stock forever — the mfg-sales allocation gate read a field no client writes [high]

**Symptom.** A Sales Order given a Processing Date locked, appeared on the
delivery board and pushed to AutoCount as `PDate` — and never became READY. Every
line was forced `PENDING` with the goods physically in the warehouse. No error, no
log, nothing on screen. Owner, this morning: *"明明这个东西没有 ready,可是我的 MRP
却 show 不出来"* and *"明明那个东西是没有货的,可是状态却去 show STATUS: READY"*.

**Root cause (read, not inferred).** `so-stock-allocation.ts` built its
`allocGated` set from `orders.filter((o) => !o.proceeded_at)`, while every path
that sets a Processing Date writes `processing_date`:

| path | writes `processing_date` | stamps `proceeded_at` |
| --- | --- | --- |
| CREATE (`mfg-sales-orders.ts`, `processing_date: dateOrNull(body.processingDate)`) | always | only when `autoProceed` — the date PLUS the paid + full-address gate |
| header PATCH (the detail screen's save) | yes | never |
| `PATCH /:docNo/status` → `IN_PRODUCTION` | ensures one, 422 if it cannot | yes |

`grep -rn "proceededAt" frontend/src` returns **0 hits**: no shipped client sends
it. So the ordinary act of setting a Processing Date produced `processing_date`
set / `proceeded_at` NULL — gated, silently, forever. The gate's own comment
claimed to implement *"有 processing date 才来分配"*, and the rule was right; the
column was not.

**Both directions were wrong, and the test caught the second one.** On the
pre-fix code the new test fails TWICE: an order with a Processing Date stayed
`PENDING` (refused stock it should get), and an order with a bare `proceeded_at`
and NO Processing Date came back `READY` (took stock it should not) — the second
being the shape the owner saw as a false READY.

**Fix.** The gate reads `processing_date`, via `SO_PROCESSING_DATE_COLUMN` so the
next rename has one home. It reads that column **alone**: consulting both "to be
safe" would give the rule a second home, which is exactly how it acquired a wrong
one. This is the stop-reading step for `proceeded_at` and its last reachable
decision.

**Blast radius on production: UNKNOWN, and deliberately not invented.** The
measurement needs `probe-proceed-split.yml` (branch
`feat/processing-date-has-one-storage`, not yet on the default branch, so
`workflow_dispatch` 404s). `unify-processing-date.yml` IS dispatchable and would
answer it, but it prints document numbers into logs that are public on this repo,
so it was not run. What IS established from source: the flip can only *regress* an
order whose date sits in `proceeded_at` with `processing_date` NULL, and **no live
path can create that row** — `autoProceed` requires a date, and the
`IN_PRODUCTION` transition refuses without one. The historical population was
migrated on 2026-08-13 (mig 0286 header: 519 company-1 orders moved, both
companies verified at zero split). Run the probe once its branch lands.

**Deferred, with reason — not fixed here.** `delivery-planning.ts` and
`frontend/src/vendor/scm/lib/so-detail-gates.ts` still pass/read `proceeded_at`,
but both go through the `soProcessingLocked` shape, which returns false as soon as
`processing_date` is NULL and only falls back to `proceeded_at` when `status` is
absent. Neither refuses anything today, so neither is bleeding. The dashboard
summary endpoint also still ships `proceeded_at` to the client for bucketing
(`mfg-sales-orders.ts`, `?summary=1`) — a display inconsistency, not a stock
refusal. All three belong with the `proceeded_at` retirement.

**The doc blessed the bug, which is why it survived.** `docs/modules/sales-order.md`
described this exact behaviour and called it *"intended … the single most common
'why is my order not READY'"*. The frequency it observed was real; the explanation
was not, and anyone who read it went hunting for a missing proceed instead of a
gate on the wrong column. That bullet now carries a dated correction quoting what
it used to say.
