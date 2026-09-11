## Three migrated goods receipts overstate what we owe by RM 2,119.50 because the receipt inherits the purchase order's UNDISCOUNTED line price [high]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: open -->

**Symptom.** Four migrated goods receipts carry a NON-ZERO total that is not the
account book's. Measured on production, `probe-gr-pi-iv-residue.mjs` **run
`34198777922`** (2026-09-08 15:19 +08), every one of them fully priced:

| receipt x purchase order | the book | ours | difference | ours / book |
| --- | ---: | ---: | ---: | ---: |
| `GR-005363|PO-010019` | RM 3,525.00 | RM 4,700.00 | **+RM 1,175.00** | 1.3333 |
| `GR-005367|PO-009982` | RM 1,575.00 | RM 2,100.00 | **+RM 525.00** | 1.3333 |
| `GR-005368|PO-009887` | RM 1,258.50 | RM 1,678.00 | **+RM 419.50** | 1.3333 |
| `GR-005326|PO-009953` | RM 1,055.00 | RM 1,000.00 | -RM 55.00 | 0.9479 |

The first three are ours = book x 4/3 to the sen — the book took **25% off** and
we did not. **RM 2,119.50 more than the supplier billed**, on paperwork a
purchase invoice is raised from.

**Root cause (traced).** AutoCount stores `PODTL.UnitPrice` and `PODTL.SubTotal`
as two columns and the discount lives in the gap; `SubTotal` is the discounted
one. Every purchase-order importer here computes the line amount out of the
undiscounted half — `import-ac-outstanding-po.mjs:230` (`const lt = up * qty`),
`:379`, `import-ac-so-linked-pos.mjs:403` — which is
`docs/bugs/0662-autocount-po-line-discounts-are-dropped-the-erp-stores-qty-x.md`,
and `repair-po-line-discount.mjs` is the repair for it.

The RECEIPT is the half that repair deliberately leaves. Its own header says so:
*"GRNs and purchase invoices ALREADY RAISED ... `grns.ts:1872` copies
`discount_sen` off the PO line at CONVERSION time, so a receipt raised AFTER this
repair inherits the right money and one raised before it keeps its own. Those are
separate documents with their own totals; correcting them is not this script's
business."* The migrated receipts were all raised before. Same mechanism,
downstream document, no repair pointed at it. The reconcile's own PO-discount
section states the size of the class: **89 lines across 10 purchase orders,
RM 42,662.80** inside the migrated set.

`GR-005326|PO-009953` is a different shape — ours is LOWER, not 75% of anything —
and has not been traced.

**Fix.** NOT DONE. What blocks a line-by-line copy from the book is measured, not
assumed: `backfill-ac-downstream-line-keys.mjs` dry run **run `34199483652`**
refuses to key three of the four, because AutoCount itself holds two lines of one
item at one quantity with different price/location/Desc2 —
`GR-005363|PO-010019` (`AKEMI BASTION MATT (Q)` x2), `GR-005367|PO-009982`
(`AKEMI NOBILITY MATT (Q)` x2), `GR-005368|PO-009887` (`HAPPI SLEEP SOLITUDE MATT
(Q)` x2). The DOCUMENT total is decidable from the book; which of our rows
carries which of the book's two prices is not, and guessing it is money on the
wrong line. `GR-005326|PO-009953` is fully keyed and is decidable.

Recorded rather than repaired so nobody repairs it twice, and so the RM 2,119.50
is not lost. The remedy shape is `repair-po-line-discount.mjs` pointed at
`scm.grn_items.discount_sen` / `.line_total_sen` and `scm.grns.total_sen`, keyed
on `linked_ac_dtlkey`, refusing every unkeyed row and printing it. It must leave
stock alone, which it structurally does: migrated receipts are `migrated_no_stock`
with **0** inventory movements behind them (same probe run), and the FIFO trigger
is `AFTER INSERT ON inventory_movements`.

**Ref.** fix/gr-iv-pi-remainder, 2026-09-08. Full classification of all 18
goods-receipt / invoice differences:
`docs/cutover-gr-iv-pi-remainder-2026-09-08.md`.
