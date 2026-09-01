## The SO list Incoming PO column went blank when the detail deferred its MRP run [high]

**Symptom.** Owner, 2026-09-01, on the 2990 Sales Order list with a row expanded:

> 「明明我的 PO No. 那边是有的，可是 Incoming PO 却没有。然后这个东西明明 stock
> 显示 pending，却没显示 Incoming PO 是哪一个，并且它的 PO ETA 怎么会这样子呢？」

and, when the first answer read the current code as intent rather than checking
what had been decided:

> 「你看回去 incoming PO 还是得显示的不是吗 **之前说过了**」

He was right, twice. `docs/modules/sales-order.md` §0.8 already documents that
this column hosts **FOUR** chips — the PO delivered goods came from, `STOCK ADJ`,
the PO a READY line will draw from, and the genuinely incoming PO — and only the
fourth is gated on `stock_state === 'po'`. The first answer looked only at the
fourth and called a blank column "by design". It was not.

**Root cause (traced).** A same-day regression from #2834
(*perf: defer SO detail's inline global MRP to a new /:docNo/coverage endpoint*).
The base detail payload now hard-codes the MRP-derived fields:

```
      // coverage_po / coverage_eta are MRP-derived — unknown without the run.
      coverage_po: null,
      coverage_eta: null,
      // READY trace is MRP-derived — filled by GET /:docNo/coverage.
      ready_source_pos: [],
```

`SalesOrderDetailV2` was given the follow-up `useSoLineCoverage` call.
**`MfgSalesOrdersListV2`'s drill-down was not** — it renders `<SoSourceChips>`
straight off the base payload. Chips 3 and 4 both read those fields, so the
column could only ever be blank there. Chips 1 and 2 (`shipped_source_pos`,
`shipped_source_adj`) are not MRP-derived and kept working, which is why the
column looked half-alive rather than obviously broken.

**What this was NOT, both refuted rather than assumed:**

* *the PO not linked to the line* — checked on company 2 (the owner's screenshot):
  `154 dedicated PO lines (so_item_id set); line-level: total 154 / aligned 154 /
  disagree 0`. The links are complete.
* *by design, because the line is PENDING* — refuted by §0.8 above. A READY line
  in the same screenshot also showed a blank cell, and chip 3 exists precisely
  for that case.

**Fix.** One shared overlay, `frontend/src/vendor/scm/lib/so-coverage-overlay.ts`,
used by BOTH surfaces. The list drill-down now makes the same coverage call the
detail page makes.

Extracted rather than copied on purpose: the board and the drill-down holding two
hand-written opinions is `docs/bugs/0269-*`, the same two surfaces, and a second
merge would be the third time. `DrillItem` also gained the `id` the overlay keys
on — the payload always carried it, that shape had just never named it.

**Test.** `so-coverage-overlay.test.ts` — 6 cases, in both directions: the
incoming PO and its ETA arrive; a READY line's source POs arrive (chip 3, no ETA,
still must show); and an ABSENT or EMPTY overlay leaves the stored values alone,
because the fast first paint and an older backend's 404 both arrive that way and
blanking on those would flicker the column off on every open.

**UNTESTED in the browser.** Proven by unit test and typecheck only; not yet
observed on a running list. The check is one expand on a 2990 order that has a
PO — the cell should name it.

**Older, same column.** The comment above `DrillItem` records the owner asking
for this column on 2026-07-24: 「怎么没有每一个 line 的 stock status,还有 incoming
PO?」. It has now gone missing twice.

**Ref.** fix/so-list-incoming-po, 2026-09-01.
