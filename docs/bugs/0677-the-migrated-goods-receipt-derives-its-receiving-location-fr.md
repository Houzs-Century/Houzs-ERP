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

**Exposure, measured 2026-09-08 by the shipped resolver itself**
(`resolveAcReceiptLocation` over the committed cuts, not an ad-hoc script):

| grain | answered by the book | agree with the derived value | DIFFER |
|---|---|---|---|
| receipt-to-order reference rows | 238 of 1,019 | 238 | **0** |
| receipt x order pairs | 97 of 400 | 97 | **0** |
| AutoCount receipts | 82 of 214 | 82 | **0** |

Why the book cannot answer for the rest, at receipt grain: **129 of 214** have no
GRDTL location on this cut (the export never selected it), and **3 of 214** used
more than one location for one receipt — `GR-003512` (KL + SRW), `GR-004812`
(KL + PG), `GR-005062` (KL + PG + SRW). Those three are a real structural limit,
not a gap: `scm.grn_items` has no warehouse column, so an ERP receipt header
holds ONE location and cannot represent them. The resolver refuses them by name
rather than taking the first.

Also **0 of 318** in-scope purchase orders have received lines in more than one
location, so the single header column is not lossy on the order side. The 129
unanswered receipts are **UNKNOWN, not agreed** — the book was never asked.

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

5. `reshape-migrated-grns.mjs` — the writer that will actually run — adopts the
   same resolver. Its PLAN now prints how many documents take the warehouse from
   the book and how many fall back, and names the first few that could not be
   answered.
6. `backend/tests/acGrLocation.test.mjs` pins the rule: the refusal on a
   two-location receipt, the refusal when the book was never asked, and the
   shared-map resolution (10 tests).

**No backfill was written, deliberately.** Nothing measurable disagrees, and the
receipts are about to be rebuilt by `reshape-migrated-grns.mjs` (PR #3123,
merged; its workflow had never been dispatched when this was written, verified
against the Actions API) — so a competing UPDATE would simply be overwritten.
Fixing the writer before it runs is the durable fix; a backfill would have been
the patch.

**Ref.** fix/gr-receipt-location, 2026-09-08.
