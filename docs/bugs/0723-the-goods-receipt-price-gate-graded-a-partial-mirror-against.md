## The goods-receipt price gate graded a partial mirror against a whole invoice [high]

**Symptom.** `stamp-migrated-source-prices.mjs` computed the right price for nine
migrated goods receipts to the sen and then refused to write any of them. Run
`34231092897` (2026-09-08 13:17 UTC, PLAN mode, company 1) printed 28 invoices
under *"LEFT ALONE — AutoCount invoice(s) whose ERP side cannot reach the billed
total"*, including:

```
PI-007287      AutoCount  RM 11,247.00  ours would be   RM 3,200.00   HC-GR-004909
PI-007765      AutoCount   RM 4,580.00  ours would be   RM 2,230.00   HC-GR-005169
PI-007771      AutoCount   RM 9,284.00  ours would be   RM 4,850.00   HC-GR-005171-PO-009344 + HC-GR-005171-PO-009553
```

The reason it printed, and which was then repeated to the owner as fact: *"our
receipt mirrors ONE purchase order and AutoCount's receipt spans several, so the
invoice bills more than our lines cover. A price cannot fix that."* Those nine
were the whole of the goods-receipt `document total` difference in the tally
(run `34232437946`: **GOODS RECEIPTS — 10 differ**, nine on money and
`HC-GR-005334` on an item code).

The owner rejected the reading: 「PI 是from multiple的PO 所以GR的吧? 没有啊 我们一
张GR to 一张PI — 可是GR 会from multiple PO啊 — 所以你要去GR 每个line的amount 都对
齐啊 — PO GR PI的line information去吧要对其啊」

**Root cause (traced).** Not the multi-order receipt. `stamp-migrated-source-prices.mjs`
already worked at (receipt x order) grain — `loadReceipts` sets
`acScopeNo = purchase_orders.linked_ac_docno` and filters `bookLines` to that one
order — and the schema models it correctly: `scm.grns.purchase_order_id` is NOT
NULL and names ONE order, while `scm.grn_items.purchase_order_item_id` is per
line and NULLABLE.

The defect was one comparison, in the gate underneath:

```js
if (acTotal != null && after === acTotal) accepted.push(row); else shortOfInvoice.push(row);
```

`acTotal` is the WHOLE invoice's `NetTotal`. The migration carried the
OUTSTANDING population (the owner's rule), so an ERP receipt deliberately mirrors
only SOME of the (receipt x order) pairs an invoice bills — the rest belong to
purchase orders that were already fully received and were never imported.
Against that yardstick a partial mirror can never reconcile, and no price can
make it. The sentence in the report explained a document-total measurement with
a line-level story; this repo's named defect, a checker counting its own guess.

Measured on the committed snapshot `backend/scripts/data/ac-reconcile-truth.json.gz`
(2026-09-08 cut) — **131 of the 192** live purchase invoices touching an in-scope
receipt bill at least one line whose purchase order was never migrated,
**RM 625,213.71 across 892 lines**. Attributed by document link only (PIDTL
`FromDocNo` -> receipt, GRDTL `FromDocNo` -> order; nothing paired by position
or name), the three above account for every sen:

| invoice | book NetTotal | pairs the ERP holds | pairs never carried |
|---|---|---|---|
| PI-007287 | RM 11,247.00 | `GR-004909\|PO-009017` RM 3,200.00 | `GR-004909\|PO-009033` 3,070.00 + `GR-004914\|PO-008984` 3,300.00 + `GR-004914\|PO-009074` 1,677.00 |
| PI-007765 | RM 4,580.00 | `GR-005169\|PO-009475` RM 2,230.00 | `GR-005169\|PO-009469` 2,350.00 |
| PI-007771 | RM 9,284.00 | `GR-005171\|PO-009344` 2,330.00 + `GR-005171\|PO-009553` 2,520.00 = RM 4,850.00 | `GR-005171\|PO-009365` 1,444.00 + `GR-005171\|PO-009516` 2,990.00 |

RM 3,200.00 / RM 2,230.00 / RM 4,850.00 are exactly the "ours would be" figures
the tool printed. It had the right number and was grading it against the wrong
total. **No money is missing.** `PO-009033`, `PO-008984`, `PO-009074`,
`PO-009469`, `PO-009365` and `PO-009516` each read `Qty == TransferedQty` on
every line and are raised for no in-scope sales order, so they fail both lanes of
`SCOPE.PO` in `lib/ac-scope.mjs` — out of scope is the outstanding rule working.

**Two things found while proving it, both kept:**

- **A receipt is not always billed by one invoice, nor in full.** Book-wide,
  5,269 receipts are billed for exactly what they hold, 4 for slightly less (two
  by one sen, two genuinely part-invoiced), and 0 for more. Of the 5,300
  (invoice x receipt) edges, 52 bill only part of a receipt. Every one of the
  **189 in-scope receipts is billed exactly**, which is the precondition that
  makes attribution by document link exact for the documents we act on — so it
  is asserted at run time, not assumed.
- **20 live purchase invoices have a line sum that does not equal their header,
  and all 20 are CNY.** The line export carries DOCUMENT currency and the header
  export LOCAL: `PI-001222` lines 1,635,817 sen, header 2,641,055 sen,
  `1,635,817 / 0.61938 = 2,641,055`. Both exports state that same rate. Reading
  that gap as a discount is `docs/bugs/0665` / `docs/bugs/0721` exactly
  (RM 13,068.55 of imaginary money on a CNY purchase order), so
  `invoiceIdentity` reports it as `commensurable: false` and REFUSES rather than
  converting. None of the 20 touches an in-scope receipt.

**Fix.** New `backend/scripts/lib/ac-chain-line-grain.mjs` — the single place
that states what the book owes an ERP document, keyed only on links AutoCount
itself wrote. `stamp-migrated-source-prices.mjs` now asks it, so the yardstick is
the book's own money for exactly the pairs we hold; the two-export cross-check is
not lost but MEASURED per document instead of assumed. The report now prints what
an invoice bills that was never ours, named and counted, so the difference
between a NetTotal and our documents is never again read as a defect.

`backend/tests/acChainLineGrain.test.mjs` pins it — 21 cases, 18 planted defects
and 3 over the committed book. **Proved RED first**: the library was written with
the old whole-invoice rule restated in it, and the four tests that describe the
defect failed (`ACCEPTS a partial mirror that matches the book on the pairs it
holds`, and three more) while the nine keyed-attribution tests passed. A
module-not-found red would have proved nothing.

**Ref.** `fix/gr-line-align`, 2026-09-08.
