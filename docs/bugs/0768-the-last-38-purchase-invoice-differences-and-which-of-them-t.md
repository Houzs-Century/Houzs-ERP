## The last 38 purchase-invoice differences, and which of them the ERP can even answer [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** The purchase-invoice tally reads **196 documents, 159 differ**
after run 34372044049 created 141 migrated invoices from the book's own invoice
lines. `diag-doc-differ-cause TYPE=PI` (run **34373997010**) splits those 159 —
plus the 2 that cannot be compared — into 161 documents by cause. **121** carry
`a book line we do not have, document total`, which is the cutover's
outstanding-only scope plus a total the owner has ruled need not match. The
other **40** are the subject of this entry.

The 121 have their own entry, written the same night by the lane that owns them
— `docs/bugs/0767-the-purchase-invoices-differ-because-a-receipt-spans-purchas.md`.
Its measurement and this one agree and neither is a re-derivation of the other:
it traces the missing lines to purchase orders the cutover did not bring in
(*in-scope receipts 211, of which 124 carry lines from an out-of-scope purchase
order*), and hands over "about 38 documents", which is this set.

**Root cause (traced).** The 40 are three separate stories and only one of them
is a defect in the invoice.

**1. `transfer from` — 20 documents, 59 lines. NOT REPAIRABLE, and it is the
same scope decision as the 121.** `repair-transfer-chain-links.mjs` with
`TYPES=PI`, plan run **34374001809**:

```
479 keyed ERP line(s) read; 59 on 20 document(s) are what the tally LOCKS
     59  parent_line_not_held
CLOSES 0 document(s) on the transfer-from axis
0 link(s) to write, over 0 document(s)
PLAN DIGEST: e3b0c44298fc1c14
```

Every one of the 59 refuses with *"the book raised it from line NNNNNN and no
ERP row carries that AutoCount line key"*. That refusal is a GLOBAL statement,
not a local one: the resolver's `parents(keys)` query for PI scans every
`scm.grn_items` row of company 1 under a non-cancelled receipt
(`repair-transfer-chain-links.mjs`, `EDGES.PI.parents`). So there is nowhere in
our goods receipts for these invoice lines to point.

`diag-transfer-chain-56.mjs` (run **34374232159**) shows why at line grain. On
18 of the 20 the book's source receipt has no ERP counterpart at all — 21
receipts across those 18 invoices, every one of them answering
`CANDIDATES on GR-004991: 0 ERP line(s)` and the same for GR-005068, GR-005081,
GR-005132, GR-005164, GR-005261, GR-005262, GR-005272, GR-005276, GR-005277,
GR-005280, GR-005284, GR-005285, GR-005286, GR-005288, GR-005291, GR-005294,
GR-005295, GR-005296, GR-005298, GR-005318. On the remaining two we hold the
receipt but not the LINE: `PI-007895` is raised from `GR-005241`, our
`GR-005241` carries lines 904063 / 904065 and the book's invoice line is raised
from **904067**, and `PI-007893`'s fourth line is the same shape on `GR-005244`.
That is the outstanding-only scope showing up at line grain rather than document
grain. **PR #3392's own plan closed the 12 of these that were closable; the 20
that remain are what is left after it.**

**2. The specification axes — 9 documents, plus 2 single-axis neighbours. A
REAL DEFECT, and it is on the invoice.** `T.Heights`, `colour / fabric`,
`divan height`, `gap` and `leg height` on HC-PI-003230, 006244, 007555, 007761,
007797, 007702, 007811, 007875 and 007893 — and `colour / fabric` alone on
HC-PI-007917, `seat size` alone on HC-PI-001793: the book states a value and the
ERP line is `(blank)` on every axis at once.

`diag-pi-line-provenance.mjs`, run **34377138255**, prints our line beside the
receipt line it was built from. Over the 40 documents: **137 invoice lines,
every one linked to a receipt line**, and

```
18 lines on 11 documents hold variants = null while the RECEIPT LINE holds the full object
59 lines are blank on both sides
60 lines already carry values
```

`HC-PI-006244` is the clean case. Our invoice line reads `variants=null, d2=""`;
its receipt line `HC-GR-004126` key 745317 reads
`{"gap":"12\"","colourId":"PC151-14","legHeight":"2\"","divanHeight":"10\"","totalHeight":"24\"", ...}`
— value for value what the reconcile reports the book stating and us missing.

**It is not the creator's bug.** `create-migrated-invoices.mjs` `writePi` has
carried `variants: l._row.variants` since the file's first commit
(`git log -S "variants: l._row.variants"` -> 76962abb7, and only that commit),
and the invoices made most recently prove it still works: every line of
`HC-PI-007968` carries its receipt's variants verbatim. So the invoice took a
faithful SNAPSHOT of a receipt line that was EMPTY at the time, and the receipt
was filled afterwards — the fabric and height backfills of 2026-09-02..09 — with
nothing carrying the new value onto the invoice raised from it. That is
docs/bugs/0687's class exactly: `repair-invoice-item-from-parent.mjs` fixed the
ITEM CODE half of it and says in its own header that it leaves `variants` alone,
because docs/bugs/0672 then recorded the colour comparison as invalid. It no
longer is (docs/bugs/0755, docs/bugs/0756).

**3. The specials — 7 documents, and NEITHER writer can reach them.** HC-PI-
007702, 007811, 007824, 007854, 007875, 007894 and 007917 carry the shape *"the book asks for
Nylon Fabric and the line does not carry it"* — and note that the two Desc2
strings printed either side of the finding are IDENTICAL. The request text is on
the line; the resolved CODE is not. `variants.specials` folds into the
authoritative unit price, and the owner ruled on 2026-08-11 that a historical
document may not be repriced by stamping a priced code. The two writers that
know that — `backfill-specials-into-variants.mjs` and
`record-priced-specials-on-migrated-lines.mjs` — both declare
`TABLES = [["so", "mfg_sales_order_items"], ["po", "purchase_order_items"]]`
and **neither touches `scm.purchase_invoice_items`**. So there is no
money-guarded path to a purchase-invoice line today. Writing one by hand is
exactly the third writer `repair-so-variant-from-book.mjs` refuses to become.

**Fix.** Two things, in two PRs.

First the measurement that was missing: `diag-pi-line-provenance.mjs`,
read-only, pinned with `default_transaction_read_only`, printing our invoice
line, the receipt line it was copied from, and the book's own source line with
its Desc2 — the three sides nobody had put next to each other. It decides
nothing; `check-ac-erp-reconcile.mjs` remains the only thing here that says two
values differ (docs/bugs/0689, docs/bugs/0708).

Then the repair for story 2 only:
`repair-migrated-invoice-variants-from-receipt.mjs` + workflow. It copies the
receipt line's own `variants` onto the invoice line, and ONLY where the invoice
line has none — the UPDATE carries
`COALESCE(variants,'{}'::jsonb) = '{}'::jsonb`, so a line somebody has since
filled keeps its value. It writes one column, restricted to
`OWNED_PI_SNAPSHOT_KEYS`, a THIRD owned-key list rather than a widening of
either sweep's (docs/bugs/0755). `specials` and `special` are deliberately
absent from it and that absence is the money guard: a priced add-on folds into
the authoritative unit price, so stamping one on a historical line reprices the
document on its next edit, which the owner ruled out on 2026-08-11. A parent key
in neither the owned nor the withheld list makes the row REFUSE rather than be
copied in part. `description2` is REPORTED and never written: it is what the
sofa decoder reads, so filling it can move a `sofa build` verdict, and that is
the owner's lane.

Proved RED: `variantRefreshOwnedKeys.test.ts` asserts the fill predicate is on
the purchase-invoice statement and on no other; deleting that one line from
`lib/variant-merge.mjs` fails it (`1 failed | 24 passed`), and restoring it
passes 25 of 25.

**Owner's, not ours.** `sofa compartments` (HC-PI-007968, 008023, 008024 — the
book's one sofa line decomposes to two pieces and we hold one) and `sofa build
not verifiable` (HC-PI-001793, 007114, 007817, 007894, 007917, plus 000946 and
007251 inside the 121) need his drawing; docs/bugs/0765 records why the
refusal is right. `lines could not be matched` on HC-PI-005959 and HC-PI-007252
is the AMBIGUOUS verdict — one book sofa, our side folding to between one and
two whole sofas — which is docs/bugs/0690's class and must not be forced.
HC-PI-007918 is not ambiguous but contradictory: the book has `DSL-8030 SOFA`
qty 1 at RM 3,630.00 and we have `9058` qty 1 at RM 3,630.00, a different MODEL
at the same money. HC-PI-007928's `item code` finding reads as two swapped pairs
— DtlKey 915115 `AK-IMMORTAL MATT (K)` against our `AKEMI ULTIMATE MATT (K)`,
915132 the exact mirror — and **that reading is wrong.** Run 34374232159 dumps
the document at line grain: **11 of our 12 rows carry `key=NONE`**, only 915112
is stamped, so the reconcile is pairing IMMORTAL and ULTIMATE by its own
value-then-order fallback and the "swap" is the fallback's ordering, not a key
sitting on the wrong row. It is docs/bugs/0690's class exactly, and it is what
`repair-so-variant-from-book.mjs` already refuses in words — *"this document was
migrated without line keys ... REPORTED, not guessed"*. Nothing here should be
written until the rows carry keys.

**Ref.** fix/pi-last-38 (#3478 and its follow-up), 2026-09-09.
