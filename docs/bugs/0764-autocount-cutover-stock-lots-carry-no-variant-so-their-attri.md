## AutoCount cutover stock lots carry no variant, so their attributes column is blank and they cannot bucket with the order line [medium]

**Symptom.** The owner, 2026-09-09, pointing at the Stock Breakdown drawer:
「从 AutoCount 来的 stock 全部，你都要跟着 AutoCount 那边去拿到它的 variant、它的
stock、COGS 跟它的那个年龄」. On a bedframe that came over in the cutover, the
ATTRIBUTES column that should read `BF-01 (PC151-01) / GAP 14" / DIVAN 8" /
LEG 2" / TOTAL H 24"` is empty. Stock is bucketed by
`(warehouse_id, item_code, variant_key)`, so a keyless lot also cannot pool with
the sales-order line that is waiting for exactly that bedframe.

**Root cause (traced).** Not a decoding failure and not missing data — the
importers never asked for it. `backend/scripts/import-ac-stock-layers.mjs`
builds each opening movement with `variant_key` bound to the literal `''`
(the `negVals` and `posVals` arrays, `:113` and `:121`), and
`import-ac-stock-balance.mjs:167` does the same for the flat balance rows. The
cutover was written to move QUANTITY, and the specification simply was not part
of the payload. AutoCount holds it the whole time: `StockDTL` reaches the
receipt's source line through `DtlKey`, and `GRDTL.Desc2` carries the text —
`HOK-1007 (K)` reads
`Col:PC151-01/M'gap:14"Inch/Divan:10"Inch No Leg/Addon Drawer Left side`,
which is a complete bedframe spec.

**I told the owner this could not be filled, and that was wrong.** The claim came
from looking at OUR tables, where the spec genuinely is absent, and never at the
book's receipt line.

**The trap inside the fix, which is the part worth reading.** The first version
of the repair took the item's NEWEST spec-bearing receipt. That reads as
reasonable and is a guess, and the export refutes it: of 276 bedframe item codes
only **85** were ever received under a single spec. 191 have two or more, and
`NB-KHJ02(Q)` has **42 distinct specs across 130 receipts** — so the newest-wins
rule would have written the wrong colour and the wrong gap onto most bedframe
lots, with nothing failing and no way to see it afterwards. The lot is now
matched to its OWN receipt through the document number the relayering recorded
in the movement note (`AC GR GR-004679 2026-05-28`); measured over the 2,339
relayered cells, 2,316 (99.0%) resolve to a receipt in the export. A lot with no
such note is filled only where the item leaves no room for a guess — every one
of its receipts decodes to the same key — and everything else is left alone and
listed in the run log.

**Fix.** `backend/scripts/fill-cutover-lot-variants-2026-09-09.mjs` plus its
`workflow_dispatch` workflow: plan by default, a confirm phrase on apply, every
UPDATE predicated on `coalesce(variant_key,'') = ''`, and a fresh-connection
verification that asserts the SHAPE (the written key matches
`key=value|key=value`, the mattress/accessory population is unchanged, and lot
count, quantities and inventory value are untouched). The key is composed by
`src/scm/shared/variant-key.ts` — the same function the API and the frontend
use, imported under `tsx`, never re-implemented — and the attribute bag is built
by `lib/parse-bedframe.mjs` / `lib/parse-sofa.mjs` assembled exactly as
`import-ac-outstanding-so.mjs` assembles it, so a lot and its document line
produce a byte-identical key. Mattresses and accessories are deliberately left
blank: `variant-key.ts` gives those groups no attribute axis, and their `Desc2`
is roadshow event text, not a spec.

**Not fixed here.** The importers still write `""`. This is a backfill of the
stock that already came over; the go-forward path is the ordinary GR flow, which
does compute a key.

**Ref.** fix/cost-zero-lots-2026-09-09, 2026-09-09.
