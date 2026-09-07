## Rolling the 70 zero purchase-order headers up from their own lines, without repricing a single line [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** 70 migrated purchase orders read `RM 0.00` at the header while
their own lines carry money. Traced in
`docs/bugs/0675-70-migrated-purchase-orders-carry-a-header-total-of-zero-whi.md`,
which shipped the REPORTING fix and deliberately attempted no repair: *"what the
right answer is also is not obvious... That question needs the owner, and it
needs to be asked with the document list in hand."*

**The owner ruled on 2026-09-08:** recompute the header, equal to the lines
added up. This entry is that repair.

**Root cause, restated so this entry stands alone.** Both purchase-order
importers write the header as `total_sen = SUM(qty x priceSen)` with `priceSen`
copied straight from AutoCount's `PODTL.UnitPrice`
(`import-ac-so-linked-pos.mjs:235`, `:384`). That price is **RM 0.00 on 10,810 of
the book's 18,890 PO lines** - Houzs does not price factory purchase orders in
AutoCount, and 7,591 of 9,416 purchase orders there have `NetTotal` 0.00. So the
header copied a zero faithfully. The ERP's LINE prices were set later by
something other than the import, and that repricing never rolled back up.

**Fix.** `backend/scripts/rollup-po-header-total.mjs` +
`backend/scripts/lib/po-header-rollup.mjs` +
`.github/workflows/rollup-po-header-total.yml`.

**THE ROLL-UP RULE IS THE APP'S OWN, NOT A NEW ONE.** `applyPoAmendment`
(`src/scm/lib/po-revision.ts:285-303`) re-reads the lines and writes
`subtotal_sen = SUM(line_total_sen)`, `total_sen = subtotal + tax_sen`. This
script copies that, so a rolled-up header is indistinguishable from one the app
itself would have written after an amendment. A second definition of what a
purchase order is worth is this repo's most expensive recurring bug class.

**ROLLING UP IS NOT REPRICING, and that is observable rather than asserted.**
Every line of every document about to be touched is read BEFORE the write; the
verify then re-reads all of them on a FRESH connection and compares `qty`,
`unit_price_sen` and `line_total_sen` value by value. Any movement, or any drift
in the line count, exits non-zero. The `UPDATE` itself re-derives the new figure
from the LIVE lines in the same statement rather than from the number JavaScript
computed a moment earlier.

**The currency guard is structural, not a filter.** `purchase_order_items` has
**no currency column**: a line is stated in its document's currency by
construction, so summing a document's OWN lines into its OWN header cannot mix
currencies. What the script therefore never does is compare either figure
against the book's `netTotal`, which is the LOCAL (MYR) amount - reading that
against a document-currency figure is exactly what wrote RM 13,068.55 of
fabricated discount onto a live CNY purchase order (`docs/bugs/0665`, `0666`).
`PO-009335` is CNY at rate 0.619380: book MYR 21,266.35, own-currency
34,334.90, and the ERP correctly holds 34,334.90. Every figure this prints
carries its currency and every total is per-currency; nothing sums two
currencies together, and a header with no currency at all is REFUSED rather than
assumed to be ringgit.

Four refusals, each of which stops rather than adapts:

| refusal | why |
|---|---|
| the header disagrees with its lines but is NOT zero | the owner ruled on the 70 zero-total documents. A different disagreement is a different decision; it is listed, never written |
| the header carries no currency | a currency cannot be inferred, and inferring one is the defect class above |
| `SUM(line_total_sen) <> SUM(qty x unit_price_sen)` | the LINES disagree with themselves. Rolling that up would bury a line-level defect inside a header figure |
| the zero is re-asserted inside the `UPDATE` | a header a person set between plan and apply is not overwritten, and shows up in the count |

`backend/tests/poHeaderRollup.test.mjs` pins all four plus the CNY case. It was
**proved RED on the unfixed module**: the "zero header over zero lines" case was
being folded into `header already equals its own lines`, which is arithmetically
true and would have let the 70 hide inside a several-hundred-document
"already fine" census. The test failed on that, and the bucket is now counted
first and apart.

**RE-RUN: convergent.** The population is every document whose header is still
zero over priced lines, so a second apply finds nothing left, says so, and exits
0 without writing.

**Ref.** fix/po-header-rollup-2026-09-08, 2026-09-08. The production plan and
apply runs, with their run ids and the re-measurement afterwards, are recorded
in the follow-up entry for the 2026-09-08 owner rulings.
