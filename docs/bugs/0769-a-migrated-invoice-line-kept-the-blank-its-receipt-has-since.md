## A migrated invoice line kept the blank its receipt has since filled in [medium]

<!-- area: Cutover + migrated data -->

**Symptom.** Nine of the purchase invoices the tally locks differ on every
specification axis at once — `T.Heights`, `colour / fabric`, `divan height`,
`gap`, `leg height` — with the book stating a value and the ERP holding
`(blank)`. `HC-PI-006244`, from run 34373997010:

```
T.Heights:      AutoCount "24"" vs ERP "(blank)"
colour / fabric: AutoCount "PC151-14" vs ERP "(blank)"
divan height:   AutoCount "10"" vs ERP "(blank)"
gap:            AutoCount "12"" vs ERP "(blank)"
leg height:     AutoCount "2"" vs ERP "(blank)"
```

**Root cause (traced).** A migrated purchase-invoice line is a COPY of the
goods-receipt line it was raised from: `create-migrated-invoices.mjs` `writePi`
writes `l._row.variants`, `l._row.description2` and `l._row.item_code` straight
off the receipt row. Nobody had ever printed the receipt side beside the invoice
side, so the obvious reading — "the receipt is blank too, this belongs to the
receipt lane" — was available and wrong.

`diag-pi-line-provenance.mjs` (#3478) prints all three sides. Run
**34377138255**, over the 40 purchase invoices the tally locks for a reason
other than the cutover's outstanding-only scope:

```
137 invoice lines, every one linked to a receipt line
 18 lines on 11 documents hold variants = null while the RECEIPT LINE holds the full object
 59 are blank on both sides
 60 already carry values
```

`HC-PI-006244` again, with the receipt beside it:

```
ERP  key=749140 item=HILTON (A)-(K) qty=1 grp=bedframe
     variants=null   d2=""
     receipt line: HC-GR-004126 [POSTED] ac=GR-004126 key=745317 item=HILTON (A)-(K)
       gr variants={"gap":"12\"","colourId":"PC151-14","fabricId":"PC151",
                    "legHeight":"2\"","divanHeight":"10\"","totalHeight":"24\"", ...}
```

Value for value what the reconcile reports the book stating and us missing.

**It is not the creator's bug, and that was CHECKED rather than assumed.**
`git log -S "variants: l._row.variants" -- backend/scripts/create-migrated-invoices.mjs`
returns one commit, `76962abb7`, the file's first — so the copy has been there
from the beginning and was never removed. The invoices made most recently prove
it still works: every line of `HC-PI-007968` carries its receipt's variants
verbatim. So the invoice took a FAITHFUL SNAPSHOT of a receipt line that was
EMPTY at the time, and the receipt was filled afterwards — the fabric and height
backfills of 2026-09-02..09 — with nothing carrying the new value onto the
invoice raised from it.

That is `docs/bugs/0687`'s class exactly, where a sofa-compartment correction
reached `grn_items` and not the invoice.
`repair-invoice-item-from-parent.mjs` fixed the ITEM CODE half and says in its
own header that it leaves `variants` alone, because `docs/bugs/0672` then
recorded the colour comparison as invalid. It no longer is (`docs/bugs/0755`,
`docs/bugs/0756`). This is the other half.

**Fix.** `repair-migrated-invoice-variants-from-receipt.mjs` + its workflow.
It copies the receipt line's own `variants` onto the invoice line and ONLY where
the invoice line has none: the UPDATE carries
`COALESCE(variants,'{}'::jsonb) = '{}'::jsonb`, so a line somebody has since
filled keeps its value and is reported as skipped. One column, restricted to
`OWNED_PI_SNAPSHOT_KEYS` — a THIRD owned-key list, not a widening of either
sweep's or the book correction's (`docs/bugs/0755`). `specials`, `special`,
`specialsRecorded` and `customSpecials` are WITHHELD by name with their reasons,
and that is the money guard: a priced add-on folds into the authoritative unit
price, so stamping one onto a historical line reprices the document on its next
edit, which the owner ruled out on 2026-08-11. A parent key in neither the owned
list nor the withheld map makes the row REFUSE rather than be copied in part.
No quantity, price, discount, cost, item code, link, status or header total.
`description2` is REPORTED and never written — the sofa decoder reads it, so
filling it can move a `sofa build` verdict, and that is the owner's lane.

**Proved RED.** `backend/tests/variantRefreshOwnedKeys.test.ts` asserts the fill
predicate sits on the purchase-invoice statement and on NO other statement in
`lib/variant-merge.mjs`. Deleting that one line gives `1 failed | 24 passed`;
restoring it passes 25 of 25. `specialsRecordedNeverPriced.test.ts` gains this
script on its allow-list — the first WRITER on that list, admitted because it
names the key only to withhold it.

**Ref.** fix/pi-last-38, 2026-09-09. The classification this came out of is
`docs/bugs/0768-the-last-38-purchase-invoice-differences-and-which-of-them-t.md`;
the other 121 differences are `docs/bugs/0767-the-purchase-invoices-differ-because-a-receipt-spans-purchas.md`.
