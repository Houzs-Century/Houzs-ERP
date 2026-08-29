## Balance importer computed one delta per AutoCount row — two codes on one ERP cell double-subtracted with NEG [high]

**Symptom.** The post-leveling zero-proof (run 33254607183) demanded +1,255
units right after a 206-adjustment leveling, with SQUARE PILLOW @ Balakong at
ERP **-161** against a book 31 — and the cell listed twice, once per AutoCount
code.

**Root cause (traced).** `import-ac-stock-balance.mjs` looped the AutoCount
balance ROWS and computed `delta = row.BalQty - erpOnHand` per row. 35 ERP
cells are fed by MULTIPLE AutoCount codes with live balance (the four DIVAN
ONLY supplier families, HOK/NB bedframe twins, two pillow codes...). With
NEG=1 — first enabled for the 2026-08-29 quiet-book leveling — every extra
row re-subtracted the whole cell: SQUARE PILLOW held ~192, its two book codes
read 19 and 12, and the importer applied -173 AND -180 for a true -173,
landing the cell on -161. Positive-only earlier runs never tripped it because
the first row's top-up brought the cell level and later rows' deltas read
negative — which report-only mode discarded.

**Fix.** Aggregate FIRST: AutoCount rows are summed into (mapped ERP code,
warehouse) cells, then ONE delta per cell; the zero-proof re-run after the
repair is the check. Same commit adds a loud refusal for unbalanced-paren ERP
codes (docs/bugs/0567) so a truncated mapping can never mint a garbage stock
cell. Damaged cells are restored by the same importer's positive pass on the
next apply; cost faithfulness for the over-consumed lots is reviewed per cell
(the worst-hit cells are low-value accessories).

**Ref.** fix/balance-aggregate-and-broken-rows, 2026-08-29.
