## The PO line discount repair, planned but not applied: 10 live orders overstated by RM 42,662.80 [high]

**Symptom.** A migrated purchase order shows a bigger total in the ERP than the
same order in AutoCount, so we look like we owe the supplier more than we do.
`PO-009948` is the worked example: one unit of `AK-ARMOUR MATT (K)` at a unit
price of RM 1,880.00, which AutoCount totals at RM 1,410.00 — exactly 75%, a 25%
line discount — while the ERP holds RM 1,880.00.

**Root cause (traced).** Diagnosed in full in
`docs/bugs/0662-autocount-po-line-discounts-are-dropped-the-erp-stores-qty-x.md`,
which recorded the defect and the instrument that finds it and explicitly left
the repair as an owner decision. That decision was made on 2026-09-07:
**修 —— 跟 AutoCount 一模一样.** This entry is the repair.

**Measured** by the field-identity run over
`backend/scripts/data/ac-reconcile-truth.json.gz` (exported 2026-09-07T09:35:24Z)
and reproduced by the new script's own PLAN path:

```enumeration
$ node -e "Promise.all([import('./backend/scripts/lib/ac-scope.mjs'),import('./backend/scripts/lib/po-discount-plan.mjs')]).then(([S,P])=>{const z=require('zlib'),f=require('fs');const s=JSON.parse(z.gunzipSync(f.readFileSync('backend/scripts/data/ac-reconcile-truth.json.gz')).toString('utf8').replace(/^﻿/,''));const b=S.decodeSnapshot(s);const r=P.readBookDiscounts(b.PO.lines,S.buildScope(b).PO);console.log('whole book',r.whole.lines,'lines',r.whole.docs.size,'POs','RM',(r.whole.sen/100).toFixed(2));console.log('in scope  ',r.inScope.lines,'lines',r.inScope.docs,'POs','RM',(r.inScope.sen/100).toFixed(2));console.log([...r.byDoc.keys()].sort().join(' '))})"
whole book 2976 lines 533 POs RM 1760189.99
in scope   89 lines 10 POs RM 42662.80
PO-009335 PO-009887 PO-009948 PO-009982 PO-010019 PO-010021 PO-010069 PO-010072 PO-010104 PO-010165
```

> **CORRECTED 2026-09-07, same day, by the production run that shipped with it.**
> This paragraph said *"Every one of the 89 discounted lines is the same 25%"*.
> **That is false.** The reconcile run 34114514690 printed
> `PO-009335 JM-CL JAC WP MP (K) qty 240 @ RM 68.54 -> book RM 10188.55, ERP RM 16449.60 (38.1% off)`
> on the very first example line. Measured properly: **84 lines are 25.00% off
> and 5 are 38.06% off, all five on PO-009335.**
>
> How the wrong sentence got written, because that is the reusable part: the
> per-document totals were printed and nine of the ten came out at exactly 75%
> of the undiscounted figure. One rate was inferred from nine documents and the
> tenth was never looked at — the `claim-before-check` failure this repo already
> has a memory for. The cheap check (`[...new Set(lines.map(rate))]`) took
> seconds once it was actually run.
>
> **The repair is unaffected, and that is worth stating rather than assuming.**
> `planDocument` computes `discountSen = qty * unit_price_sen - <the book's own
> line amount>` in whole sen. It never derives, applies or validates a
> PERCENTAGE, so a line at 38.06% is copied exactly as faithfully as one at 25%.
> Had the script keyed on a rate, this wrong belief would have cost money.

On all ten orders the book's own header `NetTotal` equals the sum of its
discounted line amounts exactly — so there is no tax component to reconcile. All
21 item codes involved are mattresses; none decomposes into compartments the way
a sofa line does. **25 of the 89 lines already carry `TransferedQty > 0` in
AutoCount**, i.e. the goods have been received against them.

**Fix — the repair is BUILT and PLANNED, and deliberately NOT APPLIED.**
`backend/scripts/repair-po-line-discount.mjs` plus
`.github/workflows/repair-po-line-discount.yml` (plan by default; apply needs
`apply=yes` and the confirm phrase typed in full). Money on ten live documents is
the owner's call, not a script's.

**Dispatched against PRODUCTION in PLAN mode**, run
[34115066315](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34115066315),
2026-09-07T11:08Z — `89 lines to correct, 10 headers to recompute, 0 REFUSED, 0
in scope but absent from the ERP`, ending `PLAN ONLY — nothing written`. The
per-document table it printed, which is the thing to read before deciding:

| PO (ERP) | AutoCount | lines | disc | recv | ERP total now | AutoCount total | difference |
|---|---|---|---|---|---|---|---|
| HC-PO-009335 | PO-009335 | 5 | 5 | 0 | RM 34,334.90 | RM 21,266.35 | RM 13,068.55 |
| HC-PO-010069 | PO-010069 | 19 | 19 | 0 | RM 26,146.00 | RM 19,609.50 | RM 6,536.50 |
| HC-PO-010165 | PO-010165 | 13 | 13 | 0 | RM 20,110.00 | RM 15,082.50 | RM 5,027.50 |
| HC-PO-010104 | PO-010104 | 13 | 13 | 0 | RM 19,318.00 | RM 14,488.50 | RM 4,829.50 |
| HC-PO-009887 | PO-009887 | 14 | 14 | 13 | RM 17,335.00 | RM 13,001.25 | RM 4,333.75 |
| HC-PO-009982 | PO-009982 | 5 | 5 | 4 | RM 9,180.00 | RM 6,885.00 | RM 2,295.00 |
| HC-PO-010019 | PO-010019 | 8 | 8 | 4 | RM 9,008.00 | RM 6,756.00 | RM 2,252.00 |
| HC-PO-010072 | PO-010072 | 6 | 6 | 0 | RM 8,520.00 | RM 6,390.00 | RM 2,130.00 |
| HC-PO-009948 | PO-009948 | 5 | 5 | 4 | RM 7,680.00 | RM 5,760.00 | RM 1,920.00 |
| HC-PO-010021 | PO-010021 | 1 | 1 | 0 | RM 1,080.00 | RM 810.00 | RM 270.00 |
| **TOTAL** | 10 docs | 89 | 89 | 25 | **RM 152,711.90** | **RM 110,049.10** | **RM 42,662.80** |

Every AutoCount total in that table equals the book's own header `NetTotal`, and
the ERP figure equals the sum of `qty x unit_price_sen` over the same lines — the
two differ by exactly the discount and by nothing else. **Four of the ten orders
already have received lines** (13, 4, 4 and 4 of them); those receipts keep their
own totals and their stock cost does not move.

**Which of the two possible repairs, and why.** The narrow option — correct
`line_total_sen` and leave `discount_sen` at 0 — is **self-erasing**, read off
the write path rather than assumed:

| where | what it does |
|---|---|
| `mfg-purchase-orders.ts:3042` (line ADD) | `lineTotal = max(0, qty*unitPriceSen - discountSen)` |
| `mfg-purchase-orders.ts:3169` (line EDIT) | the same, from `it.discountSen ?? prev.discount_sen` |
| `mfg-purchase-orders.ts:2798` (`recomputePoTotals`) | `subtotal_sen = total_sen = SUM(line_total_sen)` |

The ERP's own invariant is `line_total_sen = qty*unit - discount`. A line total
written without the discount beside it violates that invariant, and the next
person who edits that line in the UI recomputes the total from a discount of
zero — silently restoring the overstated figure. So the repair writes
`discount_sen` AND `line_total_sen` on the line and re-sums
`subtotal_sen`/`total_sen` on the header, which is what `scm.purchase_order_items`
already had a `discount_sen` column for.

**What it does not touch**, each traced rather than assumed:

- `unit_price_sen` — AutoCount's own `UnitPrice` IS 1,880.00. Copy, never compute.
- **Stock cost.** `grns.ts:555` costs a receipt at
  `toMyrSen(unit_price_sen, rate)` — the UNDISCOUNTED unit price — so inventory
  valuation does not move in either direction. This changes what we OWE, not
  what the goods are carried at. That matters for the 25 already-received lines.
- **Receipts and invoices already raised.** `grns.ts:1872` copies `discount_sen`
  off the PO line at CONVERSION time, so a GR raised after the repair inherits
  the right money and one raised before keeps its own. Correcting those is a
  separate document's business and the script says so rather than reaching.
- `scm.po_revisions` — a data correction is not a business amendment, so no
  revision snapshot is taken.

**The owner's blank rule binds it too.** 「保留 ERP 的价钱 — 空白不覆盖」: a book
line missing its qty, unit price or amount is SKIPPED and printed, never read as
zero. Reading a blank as RM 0.00 would manufacture a 100% discount out of an
absent export column.

**Four refusals, each planted and proved RED.** `scripts/lib/po-discount-plan.mjs`
holds the decisions as a pure function precisely because every interesting one is
a refusal that cannot be exercised against production without first creating the
damage there. `backend/tests/poDiscountPlan.test.mjs` (13 cases) plants each and
requires it to fire; breaking the library four ways failed exactly the cases that
should fail and no others:

| defect planted | tests that went red |
|---|---|
| accept a decomposed group instead of refusing it | 2 (`REFUSES a decomposed group…`, `a refused line leaves the rest…`) |
| write the line total only, discount left at 0 | 1 (`writes the discount, the line total AND the header`) |
| read a blank book amount as RM 0.00 | 1 (`SKIPS a book line missing its amount…`) |
| sum the header over the discounted lines only | 2 (`re-sums the header over EVERY line…`, `a refused line leaves the rest…`) |

The decomposed-group refusal is the one that would cost real money: a sofa line
becomes one ERP row per compartment sharing `linked_ac_dtlkey`, so a discount
applied per row is subtracted once per piece. Today's ten orders are all
mattresses and none decomposes — the refusal is there for the day that stops
being true.

**All four release-discipline properties**: `MODE=plan` default, `CONFIRM="I HAVE
REVIEWED THE PO DISCOUNT PLAN"` with an exit, a re-read on a FRESH connection
that asserts the SHAPE (the `qty*unit - discount = line_total` invariant, the
line total against the book's own amount, and the header against the sum of its
lines — never a row count), and a `RE-RUN:` header line. `audit:release-discipline`
reports no new violation. Every UPDATE is guarded on the row still holding the
exact values the plan read, so a row a person edited in between is skipped, not
overwritten.

**Ref.** feat/ac-po-discount-repair, 2026-09-07. Follows
`docs/bugs/0662-autocount-po-line-discounts-are-dropped-the-erp-stores-qty-x.md`.
