## A stock lot stores the variant key, a document line computes it, and the diagnostic asked the wrong one [low]

**Symptom.** `diag-variant-fabric-code.mjs` was written to settle whether the
cutover-lot variant fill writes the same fabric vocabulary our own order lines
use. Its first production dispatch (run 34371244462) died three queries in:

```
PostgresError: column i.variant_key does not exist
```

It had already printed the half that mattered most, so the run was not wasted —
but the comparison it exists to make never ran.

**Root cause (traced).** The two sides of that comparison do not store the same
thing, and the script assumed they did.

- `scm.inventory_lots` HAS a `variant_key` column. It is the bucket identity, so
  it is materialised: `scm.v_inventory_lots_open` selects `l.variant_key`, and
  the cutover importers write it (`import-ac-stock-layers.mjs:113`, `:121`).
- `scm.mfg_sales_order_items` does NOT. A document line stores the `variants`
  jsonb and its key is derived on read through
  `computeVariantKey(itemGroup, variants)` in
  `backend/src/scm/shared/variant-key.ts`.

So `SELECT ... i.variant_key FROM scm.mfg_sales_order_items i` cannot resolve,
and no amount of SQL on that table would have answered the question. The
document side has to be computed in the script, with the real function.

**What the failed run established before it died**, because it is the reason the
fill is not blocked on this: `PC151-01` is one of OUR `colour_id` values.
`scm.fabric_colours` for company 1 holds `PC151-01` through `PC151-18`, none of
them carrying a supplier code. So the fill's `fabriccode=pc151-01` is our own
vocabulary and not the book's raw text, and the `BF-01` in the owner's Stock
Breakdown screenshot is a different fabric family rather than a second name for
this one.

**Fix.** The script now runs under `tsx` and imports the real
`computeVariantKey` to derive the document side, the same way
`check-status-disagreement-why.mjs` and `check-golive-parity.mjs` do. Read-only
throughout.

**Lesson, which is the part worth keeping.** "Both sides carry a variant key"
was true as a sentence about the system and false as a sentence about the
schema. The check that would have caught it costs nothing — dispatch the
read-only workflow once before believing it — and CLAUDE.md already requires it:
a `workflow_dispatch` workflow is not shipped until it has been dispatched once
and reported success.

**Ref.** chore/variant-fabric-check, 2026-09-09.
