## The delivery line's warehouse was inferred from the sales order, and the book states it [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The reconcile reported AutoCount's per-delivery-line `Location`
(`HQ`, `PG`, `KL`, `SRW`, `SBH`) as **`line location [NOT-C]`** — *"the book has
the column and NO importer names an ERP column for it"*. On the committed cut
that is **366 stated values landing nowhere**. Meanwhile the DESKTOP delivery-order
detail showed no per-line warehouse at all, although the API had been stamping
one on every line and the phone had been rendering it all along.

**Root cause (traced, not guessed).** Two halves, and the second is the one that
matters.

1. **`scm.delivery_order_items` had no column for it.** Verified against
   production 2026-09-07 23:06+08 (`check-currency-and-do-warehouse.mjs`, run
   34136475176): 38 columns, and the only warehouse-adjacent one is `rack_id`,
   filled on **0 of 1,007 rows**. `scm.delivery_orders` has a header
   `warehouse_id`; the LINE had nothing.
2. **The ERP was answering the question by INFERENCE, and the inference is
   wrong on some lines.** `resolveDoLineWarehouses`
   (`backend/src/scm/routes/delivery-orders-mfg.ts`) resolves SO line -> DO
   header -> company default, and the detail GET stamps `warehouse_id` +
   `warehouse_code` onto every item from it. Measured against the book cut
   (`backend/scripts/data/ac-partial-dos.json.gz`), that inference **agrees on
   363 of the 366** delivery lines that carry a location and **DIFFERS on 3**:
   `DO-000097` shipped from `HQ` against a `PG` sales-order line. Nothing about
   the derived answer says which three it gets wrong.

And the display half: the detail endpoint returned `warehouse_code` per item,
`frontend/src/mobile/MobileModuleDetail.tsx` rendered it on every DO line, and
`DeliveryOrderDetailV2.tsx` rendered it nowhere — a field served all along and
shown on one of the two surfaces this repo treats as one product.

**Owner ruling, 2026-09-07:** 「HQ PGG 就是我们的 stock warehouse location。就是
warehouse location」. So this is **not** a new concept and no second field was
invented.

**Fix.**

- Migration `20260907T2345_scm_do_item_warehouse.sql` — `warehouse_id uuid` (FK
  to `scm.warehouses`, `ON DELETE SET NULL`) + `location text`: the SAME pair
  `mfg_sales_order_items` has always carried. NULL means "not stated" and every
  reader falls back to the resolution it uses today, so the column is a **no-op
  on every line this app creates**.
- `resolveDoLineWarehouses` gained the line's own `warehouse_id` as **step 0**,
  and every call site that reads real rows now SELECTs it. Putting it in the
  SHARED resolver rather than in the detail endpoint is deliberate: a warehouse
  the screen shows and the stock movement disagrees with is worse than either
  alone.
- `backend/scripts/lib/migrated-do-writer.mjs` — the one home both
  `create-migrated-documents.mjs` and `sync-ac-delta.mjs` call — copies
  `DODTL.Location` and resolves it through `resolveWarehouse`, over the **SHARED
  `SALESLOC`** table in `lib/ac-stock-compare.mjs`, imported rather than
  re-typed. `warehouseByCode` is a REQUIRED parameter, because its absence would
  silently decide every line's warehouse to be NULL (BUG CLASS
  optional-param-noop, `docs/bugs/0098-*`). An unmapped code stores the raw text,
  leaves the uuid NULL and is COUNTED.
- `backend/scripts/backfill-do-line-warehouse.mjs` + workflow — the repair, plan
  by default, CONFIRM-gated, verified on a fresh connection by re-reading the
  VALUE (the joined warehouse CODE, not a row count). `RE-RUN: inert`.
- `export-ac-reconcile-truth.mjs` — `d.Location` appended to the line
  projection, and `ac-field-identity.mjs` now compares the DO line's location as
  **copy** with `warehouse resolved` beside it, the same split the SO line uses.
  **That export needs a re-cut to take effect.**
- `DeliveryOrderDetailV2.tsx` — the per-line warehouse chip, identical to the one
  `GoodsReceivedDetailV2` and `DeliveryReturnDetailV2` already render.

**Why the backfill matches per DOCUMENT, and why that is exact rather than
convenient.** `SoDtlKey` is null on all 369 rows of the cut, so there is no
line-level key to join on. What makes a document-level stamp safe is a property
of the data, ASSERTED at runtime rather than assumed: **all 84 delivery documents
in the cut state exactly ONE location across their lines.** A document that ever
states two is REFUSED and listed — a sofa decomposes one AutoCount line into
several ERP lines, and there is no honest way to give them different warehouses
without a key.

**Cannot move stock.** The backfill fills a NULL only, and only on documents
carrying `migrated_no_stock = true` (migration 0276) — rows that by construction
have written no inventory movement.

**The numbers, with their denominators.** Book cut: **369 delivery lines across
84 documents**, locations `KL 197, PG 130, SRW 20, SBH 16, HQ 3`, 3 blank.
Production: **828 migrated delivery lines across 171 documents**, of which the
cut can speak for **82 documents / 374 ERP lines**.

**Ref.** fix/do-line-warehouse, 2026-09-07.
