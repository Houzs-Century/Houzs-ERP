## A migrated goods receipt was priced from the purchase order, but AutoCount prices the receipt [high]

**Symptom.** Two shapes, both on the `document total` axis of the goods-receipt
reconcile, run
[34300012504](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34300012504)
(book cut `2026-09-09T00:18:49Z`):

```
HC-GR-005326-PO-009953   AutoCount RM 1055.00  vs ERP RM 1000.00
HC-GR-005363             AutoCount RM 3525.00  vs ERP RM 4700.00
HC-GR-005367             AutoCount RM 1575.00  vs ERP RM 2100.00
HC-GR-005368             AutoCount RM 1258.50  vs ERP RM 1678.00
```

and, separately, **65 migrated receipts holding RM 0.00** which the reconcile
excuses under the owner's 2026-09-08 decision 「GR 0 没关系」.

**Root cause, traced. AutoCount prices the RECEIPT; we priced it from the
ORDER.** Measured on the committed cut, no database needed:

| | priced | of | |
| --- | --- | --- | --- |
| `GRDTL` lines carrying a unit price | 19,833 | 21,746 | **91.2%** |
| `PODTL` lines carrying a unit price | 8,080 | 18,890 | **42.8%** |

`reshape-migrated-grns.mjs:727-728`:

```js
} else if (poi) {
  price = n0(poi.unit_price_sen);
```

and `lib/ac-reconcile-erp-sql.mjs` declares it plainly — *"grn_items.
unit_price_sen is taken from the PURCHASE ORDER line by design, not from
GRDTL.UnitPrice"*. So a receipt the book prices lands at RM 0.00 whenever its
order line is blank, and 57% of order lines are.

**Where the order IS priced, the book's own discount is dropped.** The reshape
writes `lineTotal = qty x price - discount` and takes `discount` only from money
the ERP already held; a migrated line has none. `GR-005363` line `926907` reads
`UnitPrice 1050.0000 / SubTotal 787.50` in the book — AutoCount's own 25% — and
we wrote 1050. All three of those receipts are exactly **book x 4/3**, which is
that same 25% four times over. Offline, `audit-gr-reshape-money.mjs` shows the
same gap in aggregate: `sum(GRDTL SubTotal) = RM 562,140.93` against
`sum(qty x GRDTL UnitPrice) = RM 564,846.45`.

**And the 「GR 0 没关系」 exemption is being applied to the output of that
defect.** `splitErpZeroMoney` (`lib/ac-not-a-difference.mjs:166`) admits a row
only when `Number(r.erpSen ?? 0) === 0 && Number(r.bookSen ?? 0) !== 0` — the
book stating a value is the *entry condition*. The three gates after it read
`migrated_no_stock` and a movement count and nothing else; **no gate anywhere
asks whether the book states a price we failed to copy.** So by construction
every one of the 65 excused receipts is one the book prices. It is not an
exemption; it is 65 unposted values wearing an owner ruling. At the reconcile's
own grain, 309 of the 386 in-scope (receipt x order) pairs carry a book price
against a purchase-order line of RM 0.00, worth **RM 351,313.43**.

**Fix.** `backend/scripts/repair-gr-money-from-book.mjs` +
`.github/workflows/repair-gr-money-from-book.yml`. It copies `GRDTL.SubTotal`
into `line_total_sen` and `GRDTL.UnitPrice` into `unit_price_sen`, unchanged,
and writes `discount_sen` as the gap the book itself states between them —
`migration-copy-never-compute`, nothing derived from a quantity, a percentage or
the order. Lines are paired on the book's own `DtlKey`
(`grn_items.linked_ac_dtlkey`), never on position: `PO-009081` ordered two
identical bedframes and two receipts each took one, where a position-based test
failed 6 of 8 and the key-based one passed 8 of 8 (`docs/bugs/0690`).

The decision itself lives in `backend/scripts/lib/gr-money-from-book.mjs` so the
test exercises the function the repair calls, and it was **proved RED against
the importer's own rule** before it was written green: with `total = qty x
unitPrice` restored, `GR-005363` plans RM 4,772.00 where the book states
RM 3,525.00, and 5 of 11 assertions fail. The suite also pins the decoded field
names (`subTotalSen` / `unitPriceSen`) before any figure is asserted — a name
that does not exist reads as zero everywhere, and that is how a measurement once
reported "18,890 of 18,890 order lines have no price".

**No exemption code changed, and none needed to.** Once a receipt holds the
book's figure it no longer satisfies `erpSen === 0`, so the excuse stops
applying on its own. Fixing the classifier instead would have moved 65
documents from "excused" to "differ" without correcting a single ringgit.

**「库存先不看」 is enforced by the script, not by the operator.** A receipt that is
not `migrated_no_stock`, or that any `scm.inventory_movements` row names, is
REFUSED and the ringgit it would have moved is printed beside the refusal — a
receipt with costed layers hanging off its price is an on-hand VALUE. A
foreign-currency receipt is refused rather than converted, because an exchange
rate looks exactly like a discount and mistaking one wrote RM 13,068.55 of fake
discount onto a CNY purchase order (`docs/bugs/0721`).

**AND THE FIRST VERSION OF THIS REPAIR HAD ITS OWN DEFECT, WHICH THE PLAN
CAUGHT.** A sofa is ONE line in the account book and one ERP row per
COMPARTMENT, and the module gave every row sharing a line key that line's whole
`SubTotal`. Plan run
[34302355074](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34302355074)
printed it on the first document it reached:

```
HC-GR-000815 (GR-000815): RM 2867.43 -> RM 8602.29  (RM 5734.86)
    5527-Console  unit RM 0.00 -> RM 3373.45   line RM 0.00 -> RM 2867.43
    5527-1A(LHF)  unit RM 0.00 -> RM 3373.45   line RM 0.00 -> RM 2867.43
...
money: RM 87595.43 -> RM 286827.79  (RM 199232.36)
```

One sofa's price three times over, across 105 receipts and **RM 199,232.36 of
money that does not exist in the book**. Nothing was written — `MODE=plan` is the
default and the plan is what caught it, which is the whole reason the gate
exists. The rows are now GROUPED by the book's line key and the figure lands on
the group's LEAD row with every other row zeroed, which is this repo's own sofa
convention (`apply-sofa-compartment-corrections.mjs`: *"the lead piece keeps the
lead row's own unit_price_sen and its own total column verbatim; every other
piece is 0 in both"*), and the document total is summed over DISTINCT book lines
rather than over rows. Pinned by two tests built from `GR-000815`'s real book
line, proved RED against the defect before the fix:

```
✖ three compartment rows of ONE sofa take the book's price ONCE, on the lead
  AssertionError: every other compartment is zero in both columns
    actual: 286743, expected: 0
✖ a receipt whose sofa already carries the book's money on its lead plans nothing
  AssertionError: the book prices this receipt and the ERP does not hold that figure
    actual: 'write'
```

**What the same plan run also settled.** `HC-GR-005326-PO-009953` is planned
correctly at `RM 1,000.00 -> RM 1,055.00` — the RM 55.00 the owner said to copy
without chasing the cause. The other three he ruled on —
`HC-GR-005363`, `-005367`, `-005368` — are **REFUSED**, every one for the same
reason: *"2 of 2 line(s) carry no AutoCount line key, so they cannot be paired to
a book line"*. `backfill-ac-downstream-line-keys.mjs` has to run on those
receipts before this repair can reach them, and the refusal names it. 29
receipts are refused that way; 0 are refused for real stock movement.

**APPLIED, AND MEASURED.** Run
[34307013844](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34307013844)
wrote it:

```
agree already 291 · would change 77 · refused for real stock movement 0 · refused for a missing line key 29 · refused as foreign currency 0
money: RM 25369.43 -> RM 84865.93  (RM 59496.50)
```

**77 goods receipts now carry the account book's own money, RM 59,496.50 of it
that we had never copied.** Every one of the 77 is migrated paperwork with zero
inventory movements — `refused for real stock movement 0` is that gate reporting
it had nothing to refuse — so 「库存先不看」 was never engaged.

That run exited 3 on a verify that was itself wrong (`docs/bugs/0742`), so the
write was proved a different way, on a fresh connection, by re-planning
immediately afterwards — run
[34307484738](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34307484738):

```
agree already 368 · would change 0
money: RM 0.00 -> RM 0.00  (RM 0.00)
```

291 + 77 = 368. The repair is idempotent and the data now matches the book.

**The effect on the tally**, run
[34307767004](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34307767004):
`HC-GR-005326-PO-009953` left the `document total` axis — the RM 55.00 the owner
said to copy — and goods receipts went from 11 differing to 10. The other 65
receipts the exemption was excusing now hold the book's figure and are clean on
their own merits rather than by a ruling.

**The three the owner also ruled on are still open, for a reason the run
names.** `HC-GR-005363`, `-005367` and `-005368` are REFUSED: *"2 of 2 line(s)
carry no AutoCount line key"*. And `backfill-ac-downstream-line-keys.mjs` cannot
supply them — plan run
[34305097913](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34305097913)
returns `0 to stamp` for the whole goods-receipt side and names these documents
explicitly: *"the book has 2 lines of this item at this quantity and they are NOT
identical (2 distinct price/location/Desc2 combinations), and the build texts do
not match one-to-one either, so which is which is unknowable"*. The two candidate
book lines differ only by the roadshow VENUE written in their Desc2 and carry the
SAME `UnitPrice` and `SubTotal`, so the money is identical whichever way they
pair — but proving that is a new matching rule, and inventing a pairing is the
class `docs/bugs/0690` cost this project real money on.

**The stopgap / root distinction, said plainly.** This repairs the DATA. The
importer's price precedence is still order-first, so a future re-run of
`reshape-migrated-grns.mjs` would re-introduce it on any receipt it rewrites.
Changing that precedence without re-running the reshape changes nothing, and
re-running it is a whole-corpus operation that also moves delivery orders and
invoices — another lane's figures. It is recorded here so the next person to
touch that reshape does not rediscover it.

**Ref.** fix/ac-align-so-po-gr, 2026-09-09.
