## The SO board and the drill-down answered stock from two different engines, and the stale one won [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-08-16, reported as two bugs: *"why does 2608-002 and 003
show READY in status when the item is pending and there is no incoming PO"* and
*"why is my Stock Status not following the rule I set?"*. Live on production,
`GET /api/scm/mfg-sales-orders/:docNo`: `2990-SO-2608-002`'s mattress line
carried STORED `stock_status = PENDING` and LIVE `stock_state = "stock"` — the
goods were in the warehouse — while the header rolled up to short.
`2990-SO-2608-003`'s bedframe was genuinely short with a covering PO and an ETA,
and its label was correct.

> The strings he quoted (`SHORT: MATTRESS`) belong to the one-day #2295 window;
> #2334 restored the what-IS-ready vocabulary hours later, so the same order now
> shows a BLANK cell. The WORDING was never this defect — #2334 fixed that. What
> is left, and what this entry is about, is that the label was being fed a stale
> input, and that the board and the drill-down read different inputs entirely.

**Root cause (traced, one bug wearing two faces).** The label rule
(`so-readiness.ts`, the owner's own ruling the same day) was fine and is
untouched. Its INPUT was stale, and the two surfaces read different inputs:

1. *Two engines, one screen.* The list rolled up the STORED per-line
   `stock_status`; the drill-down pill rendered the LIVE `stock_state` from
   `computeMrp`. `soLineStockPill` says READY when EITHER says so, so the same
   order read READY on the drill and short on the board — which is exactly the
   "status says ready while the item is pending" half of the report. This half
   is INDEPENDENT of the label vocabulary and survived #2334 untouched.
2. *`ok: true` for work that did not happen.* `recomputeSoStockAllocation` is
   the only writer of the stored column. It claims a single-flight lease, and on
   losing that race returned `{ ok: true, reason:
   'another_recompute_in_progress' }`. All ~34 best-effort triggers write `await
   recomputeSoStockAllocation(sb)` and discard the result, and a best-effort
   trigger writes NO queue row — so the five-minute cron found nothing pending
   and returned `completed: true`. It was a backstop for the four durable call
   sites, never a repair loop. Two GRNs posted close together therefore left the
   second one's lines stale DETERMINISTICALLY, not on a crash — and goods
   arriving is precisely when the operator looks.
3. *One value, three renderings.* `stock_remark` was drawn as a designed
   mint/amber pill on `ConsignmentOrders.tsx`, as grey `text-ink-secondary` body
   text on `MfgSalesOrdersListV2.tsx` (the column the owner actually has on
   screen), and with a third pair of hard-coded hexes on
   `DeliveryPlanningBoard.tsx`. That is why he described it as the system
   "writing words" rather than as a warning appearing. Same class as the
   `READY (PARTIAL)` leak, and #2334 had already had to hand-carry a vocabulary
   change into ConsignmentOrders' private copy while the other two kept theirs.

**Fix.** `scm/lib/so-line-effective-stock.ts` — ONE union verdict over (stored,
live), which is the rule the drill-down pill already rendered. The list rolls it
up; both line-detail handlers stamp it as `stock_status_effective`; the desktop
and mobile pills prefer that field. It costs no extra query: the list handler
already awaits one `computeMrp` for the source-PO union, and `mrpLineCoverage` is
a pure flatten. `null` live state is REQUIRED, not optional, and means "stored
value stands" — so a failed MRP fails soft to the old behaviour exactly.
`recomputeSoStockAllocation` now enqueues its own retry row whenever a sweep it
entered did not finish (lock skip, throw, or headers left under an edit lease),
which turns the existing cron into a real repair loop for all ~38 triggers;
`queuedForRetry: false` is logged at error level when even that row cannot be
written. `components/StockRemarkPill.tsx` is now the one renderer for all three
surfaces, carrying #2334's colours (including its deliberate negative branch:
anything not exactly `READY` is amber, so a new token cannot read as fine), its
sort direction and the export value; `DataTable` gained an optional `sortValue`
so the SO list can order by how much of the order is IN while its CSV and column
funnel keep the real words. The label vocabulary is NOT touched by this PR.

**NOT fixed, and stated so in the module guide:** a Worker that dies BEFORE
reaching the recompute still leaves no row and no retry. Only a queue write
inside the source write's own transaction covers that — the `runScmPgCommand`
conversion the SCOPE header in `stock-allocation-job.ts` already describes.
Allocation is still not durable in general.

**Test.** `backend/tests/soLineEffectiveStock.test.ts` (the union rule, both
reported orders reproduced, and source assertions that the list and both detail
handlers go through it), `backend/tests/stockAllocationSkipLeavesTrace.test.ts`
(a lock skip leaves a durable row and says so; a finishing sweep leaves none),
`frontend/src/components/StockRemarkPill.test.tsx` (a not-ready remark paints as
a warning, an unknown token cannot render as fine, the sort leads with the
fullest orders). The backend suite asserts NO label strings — only that the two
feeds disagree and that the ship gate flips — so a third vocabulary ruling cannot
break it. Each was proved to bite by reverting the source.

**Measurement.** `backend/scripts/probe-so-stock-status-stale.mjs` +
`.github/workflows/probe-so-stock-status-stale.yml` count the live lines showing
PENDING while stock sits in their own bucket, as a floor/ceiling bracket. NOT YET
DISPATCHED — per CLAUDE.md a `workflow_dispatch` workflow is not shipped until it
has run once and reported success.

**Ref.** PR #TBD, fix/so-stock-status-one-source, 2026-08-17.
