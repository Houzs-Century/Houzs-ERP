## MRP dropped 8 accessory codes from every tab because the row carried no category [high]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** The owner, 2026-09-10: 「为什么这个 order 是有 long pillow 要去 order，
可是我的 S3 那边却没有 long pillow 让我 order 的？」 A sales order asked for LONG
PILLOW, the Accessories tab of the MRP plan offered no such row, and the buyer had
nothing to raise a purchase order from. Measured on prod the same day: **EIGHT item
codes, 62 open dated sales-order lines, 110 units** were planned by the engine and
shown on no tab at all — `LONG PILLOW` (18 lines / 43 units), `JM-CL JAC WP MP (S)`
(13/19), `JM-CL JAC WP MP (SK)` (10/15), `NTYR-ERGO LTX PIL` (7/11), `AERO-MP (S)`
(6/7), `HB709NL` (4/7), `DL-HOTEL PILLOW(M)` (2/6), `DL-MP(K)` (2/2). The Accessories
tab showed 35 item codes where 43 were expected.

Nothing warned. A missing row and a genuinely-covered row look identical on this
page, which is what makes the class serious: the shortage is found on delivery day.

**Root cause (traced).** `backend/src/scm/routes/mrp.ts` decided a line's category
TWICE, with two different expressions, and only one of them had a fallback.

- The FILTER, `mrp.ts:1099` — `const cat = prod?.category ?? catFromGroup(d.item_group);`
  A line whose `item_code` is not in `mfg_products` is kept on its item GROUP.
  `catFromGroup`'s own comment (Wei Siang, 2026-06-16) says it exists "so the demand
  still SHOWS under its category tab instead of silently vanishing".
- The EMIT, `mrp.ts:1327` — `category: prod?.category ?? null,`. No fallback. So the
  engine kept the line, planned it, put a real `qtyNeeded` on it, and then shipped the
  row with `category: null`.

The frontend picks a tab's rows with `s.category === VIEW_CATEGORY[view]`
(`frontend/src/pages/scm-v2/Mrp.tsx:553`). `null` equals none of the four, so the row
belonged to no tab and disappeared from all of them.

Observed, not reasoned: the stored snapshot `scm.mrp_snapshots` (company 1, computed
2026-09-10 05:16, 682 skus) CONTAINS all eight codes with correct quantities
(`LONG PILLOW` qty 43) and `category: NULL`, while every visible code on the same tab
carries `'ACCESSORY'`. Ruled out with evidence before landing here: the service-line
skip (`SVC-` prefix only, and `mrp.ts:1104` runs before the category filter), a wrong
product category (company 1's are all `ACCESSORY`), duplicate company-2 rows, a stale
snapshot, and a rendering artefact (reproduced on a fresh reload).

**Fix.** The emit site now uses the SAME expression the filter uses — the first
non-null `catFromGroup` across the bucket's own demand rows — and still emits `null`
when the group maps to nothing, which is honest rather than a guess. Three tests in
`backend/src/scm/routes/mrp.test.ts` under *"an uncatalogued line keeps its category
on the row, not just in the filter"*: (a) `mfg_products` empty for the code, row must
still read `ACCESSORY` — **proved RED on the unfixed tree** (`1 failed | 2 passed`,
the assertion at `mrp.test.ts:1439`); (b) the catalog wins when it has a row; (c) an
unrecognised group still emits `null`, pinning that the fix invents nothing.

Checked for the same asymmetry and NOT found: the other engine,
`backend/src/scm/lib/so-stock-allocation.ts`, uses category only to detect SERVICE and
SOFA and never drops a line for a null one; the frontend has exactly one
category-equality filter and no mobile MRP surface.

**Still UNKNOWN, and deliberately out of this fix.** Why `prodByCode` lacks those
eight codes at all. Section 2 (`mrp.ts:742`) reads `mfg_products` bounded by the
demanded codes, chunked and paged, under the company predicate — so either the catalog
rows sit under a different `company_id`, or they are absent. The fallback makes the
rows VISIBLE either way, but until that is settled those lines also miss their
category LEAD TIME (`mrp.ts:1293` passes `prod?.category ?? null` to `orderByOf`), so
their order-by date is computed without one. That is a data question, not a planning
one, and it needs a read against prod.

**Ref.** fix/mrp-row-category-fallback, 2026-09-10.
