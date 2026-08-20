## The stock reconciler excluded sofa by AutoCount's ItemGroup, so 85 units of pillows and stools read as a phantom ERP surplus [medium]

**Symptom** - the per-warehouse reconcile (`check-stock-vs-autocount.mjs`, prod
run 31419069241) reported the ERP holding 149 units MORE than live AutoCount
over the comparable cells, and named a 25-cell / 98-unit class
`CUTOVER ADJUSTMENT ONLY - seeded once and untouched since`. Twelve of those
cells claimed AutoCount held NOTHING at all against real ERP stock, the largest
being `SQUARE PILLOW @ BALAKONG WAREHOUSE: AutoCount - vs ERP 46`.

**Root cause (traced, not guessed)** - the exclusion at `:152` was
`if (g === "SOFA")`, where `g` is the AutoCount item master's `ItemGroup`.
AutoCount files 41 codes under `ItemGroup = SOFA`; only 22 of them are whole
sofa sets. The other 19 - `DSL-SQUARE PILLOW`, `AMN-LONG PILLOW`,
`HOK-SQUARE PILLOW`, `RDS-SGABELLO`, `DSL-STOOL 1`, `LV-3068 BOLSTER`, the
`THL-xxxx` single-seaters and the rest, 85 units - are pillows, bolsters and
stools that `data/autocount-erp-mapping-1561.csv` correctly categorises as
`ACCESSORY`.

`import-ac-stock-balance.mjs` excludes on that CSV category
(`isSofaFurniture`, built at `:64` from column 4), NOT on the ItemGroup. So the
importer BROUGHT THOSE 85 UNITS IN, the ERP holds them, and the checker then
refused to look at the AutoCount side of the same cells - reporting real,
correctly-imported stock as a surplus the other system did not have.

Measured against the live export: of the 85 units, **77 are present on both
sides** and 11 of the 12 cells reconcile exactly once the excluded codes are
summed. The genuine residual is **+8 units**, all on
`SQUARE PILLOW @ BALAKONG WAREHOUSE` (ERP 46 vs AutoCount 38). So the corrected
net delta over comparable cells is **+72 units, not +149** - 52% of the reported
gap was the checker's own filter.

**Fix** - exclude on the binding CSV's category column, byte-identical to
`import-ac-stock-balance.mjs:64`, and report separately how many units are
compared despite carrying `ItemGroup = SOFA`. The `g === "SOFA"` test is gone.

**The class, for next time** - this is `D7` in `docs/stock-reconciliation.md`
one layer up. D7 was "excluded accessories by matching /SOFA/ against the item
CODE"; this is "excluded accessories by matching SOFA against the item GROUP".
The invariant both violate: **a reconciler's exclusion must be the same
predicate as the importer's.** If the importer brought a row in, the ERP holds
it and it must be compared - otherwise the check manufactures the very
discrepancy it exists to find. Categorise by the field the importer used, never
by a field that merely sounds like it means the same thing.

**Ref** - 2026-08-11, PR #1942 (fix/stock-criterion-close). Found by an
independent read while closing go-live criterion 3.
