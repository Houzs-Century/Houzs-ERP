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
137 invoice lines, of which 110 are linked to a receipt line and 27 carry no link at all
 12 of the linked lines, on 9 documents, hold variants = null while the RECEIPT LINE holds the full object
```

*(A first pass at this count said "137 lines, every one linked" and "18 on 11
documents". That was a parsing mistake of mine, not a fact: the diagnostic prints
`receipt line: NONE (grn_item_id is null)` for an unlinked row, which my ad-hoc
reader matched as a link. The repair's own plan run, which reads the database
rather than a log, is the number above — and the six lines that fall out of the
larger figure are exactly the unlinked ones, where there is nothing to copy
FROM: `PI-007761` x3, `PI-007894` x2 and `HC-PI-007875`'s extra
`CELENE 2.0 (A)(F)-(Q)`.)*

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

**Measured against production.** Plan run
[34379677063](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34379677063):
`PLAN: 12 invoice line(s) on 9 document(s) would take their receipt line's colour
and heights`, `PLAN DIGEST: f2c6f29cc76610c2`. The withholding fired on four of
them and is in the log — `WITHHELD from the copy: specials` on `PI-007703` and
`PI-007910`, `specialsRecorded` on `PI-007811` and `PI-007875`. Apply run
[34379825762](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34379825762):

```
APPLIED: 12 of 12 invoice line(s) filled.
VERIFIED on a fresh connection: 12 invoice line(s) hold the receipt's own values,
every one still a jsonb OBJECT, and item code, quantity and receipt link
unchanged on all of them.
```

**What it moved, on the instrument that reported it.** `diag-doc-differ-cause
TYPE=PI` before (34373997010) and after (34379924920, scoped re-read
34380127934):

```
before   IDENTICAL 35 · DIFFER 159 · CANNOT COMPARE 2   of 196 compared
after    IDENTICAL 39 · DIFFER 155 · CANNOT COMPARE 2
```

Four documents left the DIFFER column outright — `HC-PI-003230`, `HC-PI-006244`,
`HC-PI-007555`, `HC-PI-007797` — and the specification axes closed on two more
that still differ for an unrelated reason: `HC-PI-007811` went from
`T.Heights, colour / fabric, divan height, gap, leg height, specials` to
`specials`, and `HC-PI-007875` from the same five plus `line count, specials` to
`line count, specials`.

**Where it did NOT reach, and why.** `HC-PI-007761` (3 lines), `HC-PI-007894`
(2 lines) and `HC-PI-007875`'s extra `CELENE 2.0 (A)(F)-(Q)` carry no
`grn_item_id` at all — there is no receipt line to copy from, so they still read
`(blank)` and this repair is not the answer for them. `HC-PI-007702`,
`HC-PI-007893`'s fourth line and `HC-PI-007917` point at a receipt line whose
own `variants` is empty as well; those are the 59 blank-on-both-sides lines, and
filling them would mean parsing the BOOK's Desc2 onto an invoice, which is a
different and riskier writer.

**Proved RED.** `backend/tests/variantRefreshOwnedKeys.test.ts` asserts the fill
predicate sits on the purchase-invoice statement and on NO other statement in
`lib/variant-merge.mjs`. Deleting that one line gives `1 failed | 24 passed`;
restoring it passes 25 of 25. `specialsRecordedNeverPriced.test.ts` gains this
script on its allow-list — the first WRITER on that list, admitted because it
names the key only to withhold it.

**Ref.** fix/pi-last-38, 2026-09-09. The classification this came out of is
`docs/bugs/0768-the-last-38-purchase-invoice-differences-and-which-of-them-t.md`;
the other 121 differences are `docs/bugs/0767-the-purchase-invoices-differ-because-a-receipt-spans-purchas.md`.
