## The healed stock verdict reached the browser and was thrown away [high]

<!-- area: Sales orders + pricing -->

**Symptom.** The owner, 2026-09-02, on a Sales Order line: 「为什么明明还没有货，
它却显示 ready？可是 Incoming PO 那边是有 PO 的，而且是有 date 的」 — a line
rendering the stock pill **READY** beside an Incoming chip naming a purchase
order with an ETA six weeks in the past. The two cells sit on one row and
disagree, and the pill never changed no matter how long the page stayed open.

**Root cause (traced).** `GET /:docNo/coverage` recomputes the line verdict with
the live allocation state and returns it as `stock_status_effective` — the whole
purpose of the endpoint #2834 introduced. `overlaySoLineCoverage` then wrote that
value into the WRONG field:

```
stock_status: cov.stock_status_effective ?? l.stock_status,   // before
```

`soLineStockPill` (`components/SoSourceChips.tsx:72`) reads
`l.stock_status_effective` FIRST and only falls through to `stock_status` when
that is nullish. The base detail payload always populates
`stock_status_effective` — `mfg-sales-orders.ts:2888` calls
`effectiveLineStockStatus(stored, null, gates)`, which returns one of
`READY`/`PARTIAL`/`PENDING` and **never null** (`so-line-effective-stock.ts:97`).
So the `??` always short-circuited, the fallback branch reading `stock_status`
was dead on both call sites, and the healed verdict was fetched over the wire and
discarded. `stock_status_effective` was not even declared on
`CoverageOverlayFields`, so the overlay could not have written it.

Both surfaces the overlay serves were affected — the SO list drill-down
(`MfgSalesOrdersListV2.tsx:882`) and the SO detail
(`SalesOrderDetailV2.tsx:585`) — so the pill on each was permanently the STORED
snapshot while the Incoming chip beside it was purely live. That is the
disagreement the owner was looking at.

Not the same defect as `0603` (`#2862`, "still loading rendered as an answer") or
`0596`/`#2849` (the missing fetch). Both of those are upstream of this one and
both are correct: the request is made, the loading state is honest, and the
answer arrives — and is then dropped on the floor.

**Why six existing tests were green over it.** `so-coverage-overlay.test.ts`
asserted the overlay's OUTPUT FIELDS (`r.stock_status`, `r.coverage_po`), which
is the shape of assertion that cannot see a field-name mismatch: writing the
right value to the wrong key passes every one of them. The invariant is what the
PILL renders, and nothing pinned that.

**Fix.** Declare `stock_status_effective` on `CoverageOverlayFields` and write it
from the coverage row. `stock_status` keeps being written too, deliberately —
`SalesOrderDetailV2.tsx:955` sorts and exports its Stock column on
`stock_state ?? stock_status`, and dropping that write would re-stale that column
instead. Four new tests assert the pill's label through
`soLineStockPill(overlay(...))` rather than the field name: a stale READY
corrected down to PENDING, a stale PENDING promoted to READY, and the two
leave-it-alone cases (no coverage yet, coverage with no verdict of its own).

**Proved RED on the unfixed tree**: with the one added line removed, the two
correction tests fail and the eight pre-existing ones still pass — which is the
measurement that shows the old suite could never have caught this.

**Ref.** `fix/system-self-contradiction`, 2026-09-02.
