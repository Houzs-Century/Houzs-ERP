## the migrated goods receipt derives its receiving location from the purchase order instead of copying the book [medium]

**Symptom.** The owner, 2026-09-08 00:15 +08: *"你 GR 有跟这个 store location 吗？
Location 我都有看，我们系统也是有的。"* He reads the receiving location on every
goods receipt and asked whether the migrated ones carry AutoCount's.

**Root cause (traced).** They do not copy it. Both writers COMPUTE it:

| writer | line | rule |
|---|---|---|
| `backend/scripts/create-migrated-documents.mjs` | `:151` | `g.items[0].warehouse_id ?? g.po.purchase_location_id` |
| `backend/scripts/reshape-migrated-grns.mjs` | `:653` | `d.items.find((i) => i.poi?.warehouse_id)?.poi.warehouse_id ?? d.erpPo.purchase_location_id` |

Both read the FIRST received purchase-order line's warehouse and fall back to the
ORDER's location. Neither reads AutoCount's own `GRDTL.Location`. A migration
copies, it never computes — the same rule the delivery-order line warehouse broke
(`resolveDoLineWarehouses`, 3 of 366 lines disagreed with the book, `DO-000097`).

**Why it was possible to get wrong.** The book's answer never left the SQL
server. `export-ac-reimport.py`'s `grrefs` section already reads `GRDTL` for
every in-scope receipt and simply did not `SELECT g.Location`, so no committed
cut carried it: neither `ac-convert-edges.json.gz` (header fields
`docNo/docDate/cancelled`, line fields carry no location) nor
`ac-reconcile-truth.json.gz` (header fields add money and currency, still no
location). With nothing to copy, deriving was the only thing left — and nothing
said so.

**The trap next to it, which cost an hour.** `data/ac-stock-layers.json.gz`
carries `{ItemCode, Location, SrcDoc, Src:'GR'}` and reads exactly like a receipt
location. It is not one: the layer records where those units are NOW. Measured on
the committed cuts — of 274 (receipt, item) cells carried by BOTH the layer file
and a real `GRDTL` row, 258 agree and **16 disagree, every one of them moving
KL/PG to a DISPLAY or SERVICE location** (`PG DISP`, `KL DISP`, `SERV KL`). That
is a showroom transfer after the receipt, not a receipt. Read as receipt
locations, the layers "find" a difference on `GR-002798` that the book's own
`GRDTL` rows for that same receipt (all `PG`) contradict.

**Exposure, measured on the committed cuts (book side, 2026-09-08).** Using
direct `GRDTL` evidence only: of 1,019 in-scope receipt-to-order reference rows,
**245 have a book location — and all 245 equal the derived value. 0 differ.**
That covers 85 of the 214 in-scope receipts and 100 of the 400 receipt x order
pairs. Also 0 of the 318 in-scope purchase orders have lines in more than one
location, so the single header column is not lossy for any of them. The
remaining 300 pairs are **UNKNOWN, not agreed** — the book was never asked.

**Fix.**

1. `export-ac-reimport.py` `grrefs` now selects `g.Location`, so the next cut
   carries the receipt location for all 214 in-scope receipts.
2. New `backend/scripts/lib/ac-gr-location.mjs` loads the book's location from
   every committed cut that carries a real `GRDTL` row (`ac-gr-refs` once
   re-cut, `ac-po-line-costs.history` where `Src='GR'`, `ac-sofa-gr-po`), and
   deliberately does NOT load the stock layers. It resolves through the SHARED
   `SALESLOC` from `lib/ac-stock-compare.mjs` — never a second copy of a
   location map.
3. `create-migrated-documents.mjs` now COPIES the book's location where the book
   can answer, falls back to the old derivation where it cannot, and LOGS the
   split so a fallback reads as "the book was never asked", not as agreement. An
   ambiguous receipt (two locations, one header column) falls back rather than
   taking the first.
4. `check-gr-receipt-location.mjs` + `gr-receipt-location-check.yml` — read-only
   probe: triggers on `scm.grns` from live `pg_trigger`, movements on migrated
   receipts, stored-vs-derived, stored-vs-book, multi-location orders, and
   whether the shared map lands on real warehouses.

**No backfill was written.** Nothing measurable disagrees, and
`reshape-migrated-grns.mjs` is rebuilding these documents at the (receipt x
order) grain, so a competing UPDATE would be overwritten. The reshape carries the
same derivation and should adopt `lib/ac-gr-location.mjs`.

**Ref.** fix/gr-receipt-location, 2026-09-08.
