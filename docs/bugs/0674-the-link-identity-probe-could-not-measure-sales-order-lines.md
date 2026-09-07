## The link-identity probe could not measure sales-order lines, and compared a colour key nothing writes [medium]

**Symptom.** `probe-link-identity.mjs`, dispatched against production for the
first time (run 34137796488, 2026-09-07 23:22 local), concluded `success` and
printed two answers that were not answers:

```
   SO  mfg_sales_order_items  — NOT COUNTABLE: column h.id does not exist
   DO->SO  delivery_order_items.so_item_id
        0 pairs where BOTH sides carry a colour code
        0 rows disagree, across 0 documents
        0 of those documents are a PERFECT COLOUR PERMUTATION — an exact swap
```

The second one is the dangerous shape: **three zeros that read exactly like a
clean result**, on every one of the six edges, when in fact nothing had been
compared. The probe was written to hunt links that look valid and are not, and
its own colour section was a check that looked green and measured an empty set.

**Root cause (traced).**

1. **`h.id` does not exist on a sales-order header join.** The probe assumed
   every line table reaches its header by an id foreign key
   (`fk: "sales_order_id"`). `mfg_sales_order_items` carries `doc_no` and joins
   `mfg_sales_orders` on `h.doc_no = i.doc_no` — the shape used by
   `backfill-ac-line-keys.mjs:105` and `audit-special-addon-prices.mjs:134`. So
   the ONE table the whole incident is about produced no number, and the run
   still exited 0 because a per-table failure is caught and reported rather than
   thrown. That part worked as designed; the assumption underneath it did not.
2. **The colour is not in `variants->>'colourCode'`.** The importers write
   `colourId` (the `fabric_colours` row) and `colourLabel` (the text) —
   `import-ac-outstanding-so.mjs:302-304`. `colourCode` appears in the codebase
   but is not what these rows carry, so the `WHERE` clause excluded every row and
   the section reported over an empty set.

**Why it matters beyond this file.** The probe exists to measure the
key-without-identity class (`docs/bugs/0672`), whose signature is a check that
answers a different question from the one asked. Both defects here are that same
shape, in the instrument built to find it — which is the argument for running a
probe against production before quoting it, not for trusting it because it was
written carefully.

**Fix.** `DOC` now carries `fk` (the line column) AND `pk` (the header column it
matches), written out per document type instead of assumed, so the sales-order
join is `h.doc_no = c.doc_no`. The colour test reads
`coalesce(variants->>'colourId', variants->>'colourLabel', variants->>'colourCode')`
and **prints the number of comparable pairs beside every answer**, so an empty
result can never again be read as a clean one. The duplicate-DtlKey count is also
split by whether the sharing rows name the same product, because the first run
could not tell one book line legitimately expanded into several sofa-compartment
lines (benign) from a genuine key collision (not benign).

**Verified.** Re-run 34139187692, 2026-09-07 23:37 local, `success`. The
sales-order lines are now measured (14,764 of 15,613 carry a DtlKey) and the
colour section compares 295 / 252 / 976 / 38 / 94 real pairs on its five live
edges instead of zero.

**A THIRD one, found by the fix.** The duplicate-DtlKey split added here — "of
those, how many carry rows naming DIFFERENT products" — was supposed to separate
a sofa's compartments from a real key collision. It answered 295 of 296 and 98 of
98, and it is worthless: **a sofa's compartments have different item codes by
construction** (`MODEL-1S`, `MODEL-2S`, `MODEL-CNR`). It is the same defect as the
`colourCode` one, one layer up, and it is recorded rather than quietly replaced
because the pattern is the point: three checks in one file, each written
carefully, each answering a question next to the one asked. The discriminator
that WOULD work is the model prefix — the code before the first dash — and it is
not written yet. Do not quote 295 or 98 as collisions.

**Ref.** fix/link-identity-probe-corrections + docs/link-identity-run2, 2026-09-07.
