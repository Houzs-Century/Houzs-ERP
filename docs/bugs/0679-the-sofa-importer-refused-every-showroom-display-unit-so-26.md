## The sofa importer refused every showroom display unit, so 26 whole sofas the book holds were absent from the ERP [high]

**Symptom.** The 2026-09-07 stock reconcile compared sofa for the first time
(`check-stock-vs-autocount.mjs`, run 34140765109) and read **AutoCount 107 whole
sofas vs ERP 49**. 26 of the 58 missing units stand in the showrooms — 24 at
`KL DISP` (the ERP calls that warehouse BALAKONG DISPLAY; the owner calls it KL)
and 2 at `PG DISP` — and the ERP held none of them, so both display cells read
zero against a book that says otherwise.

**Root cause (traced).** TWO causes, stacked, and the second was found only
because the first fix's dry run disagreed with the measurement that motivated it
(run 34157954312 reported 8 display cells / 11 units where the snapshot said 17
/ 26).

**Cause A — two importers, and the display units fall through the gap between
them.** `import-ac-stock-balance.mjs` excludes every SOFA-category row
by the binding CSV's category column, so no sofa balance row was ever opened by
the ordinary path. `import-ac-sofa-stock.mjs` was written to cover that hole,
but it drives off RECEIVED PURCHASE ORDERS rather than off the balance — and its
own header stated the refusal: *"never creates the showroom display sofas (no
PO, no configuration, AutoCount Desc2 literally DISPLAY REF: ADJ0052/00148).
Reported only."* A display piece has no purchase order, so it matched nothing.
The refusal was documented; its SIZE never was, and the `unbacked` list it
printed summed per ITEM CODE across locations, which cannot say how many units
stand in a showroom.

Measured on the 2026-09-07 22:21 (+08) live export: 17 balance cells at a DISP
location, 26 whole sofas. All three committed snapshots — `ac-live-stock-balance`,
`ac-stock-balance` and `ac-seed-baseline-balance` — agree cell for cell on sofa
(40 cells, 107 units), so the number does not depend on which was read.

**Cause B — the sofa importer decided what a sofa IS by the item code's
SPELLING.** `const isSofaSet = (c) => /SOFA/i.test(c) && !/PILLOW/i.test(c)`.
The binding CSV's category column calls 40 balance cells / 107 whole sofas SOFA;
that name test found 29 / 87. The 11 cells it missed are all `THL-*` codes —
`THL-2379`, `THL-7226`, `THL-5142` — which simply do not contain the word, and
**9 of them stand in the showrooms**. Those items were invisible to BOTH
importers at once: `import-ac-stock-balance.mjs` excludes them because the
binding says SOFA, and this script excluded them because the code does not say
SOFA. No path could ever open them. That is
`docs/stock-reconciliation.md` D7 one layer up — never categorise stock by a
field that is not the one the reconcile uses.

**Fix.** `isSofaSet` now reads the binding CSV's category through the shared
`loadAcBinding`, so this importer, `import-ac-stock-balance.mjs` and
`check-stock-vs-autocount.mjs` agree by construction instead of by coincidence.
The pillow hazard the name test existed for does not return: measured on the same
export, ZERO codes in the binding's SOFA category spell PILLOW, and section 8
still asserts it. The run now prints how many cells the old test could not see.

Section 6b of `backend/scripts/import-ac-sofa-stock.mjs` opens them the
way the ORDINARY balance import already opens every other AutoCount balance row:
a plain `ADJUSTMENT` at (binding-target code, mapped warehouse, quantity), empty
`variant_key`, no `batch_no`, no marking of any kind. The owner refused a
"display, excluded from MRP" flag — 「你换不一样就代表我们的数据从 autocount 搬过
来的就不一样了啊」 — so nothing on the row says display; only the warehouse does,
which is what AutoCount itself says.

It does not decompose anything: it writes ONE row for the book's ONE row on the
code the binding CSV already maps that AutoCount item to, so no compartment is
invented. The cell is compared the way the reconcile compares it —
`lib/sofa-piece-fold.mjs` folded against the book — which makes the import
idempotent with no marker: the second run sees the cell already at the book's
number and opens nothing.

Opening these units can flip NOTHING to READY, and that is the correct reading:
a sofa line goes READY only through `sofa-set-coverage.findCoveringBatch`, whose
`loadSofaBatchStock` reads `.not('batch_no','is',null)`. A display unit has no
purchase order, therefore no batch, therefore no allocation. Cost is the book's
own zero — all 17 cells carry `UTDQty 0` / `UTDCost 0` in
`ac-utd-stock-cost.json.gz` and appear in no item-cost row, so they come in at
0 because AutoCount holds no cost for them, not because anything was averaged.

The same section reports, and deliberately does NOT write, the sofa still short
at the four SELLING warehouses: a configuration-less lot standing beside real
demand would show as on-hand stock on the MRP page while remaining
un-allocatable, which reads as a bug to whoever looks at it.

**Ref.** fix/ac-display-sofas, 2026-09-08.
