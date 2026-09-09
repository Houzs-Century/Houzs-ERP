## An added sofa compartment on a purchase order carried no description and no delivery date [medium]

**Symptom.** The AutoCount reconcile reads company-1 purchase-order lines that
hold NULL in `description` and `delivery_date` while the book's line states a
value — `PO-009980`, `PO-010008`, `PO-010040` among them. `description` is a
COPY field on the PO side (`import-ac-outstanding-po.mjs` writes AutoCount's own
`Description` verbatim), so a NULL is a gap, not a style choice. The same
documents read as FILLED on the sales-order side.

**Root cause (traced).** `backend/scripts/apply-sofa-compartment-corrections.mjs`
inserts an added compartment by SELECTing from the piece it is built from. Its
PO branch listed neither column:

```sql
INSERT INTO scm.purchase_order_items
  (purchase_order_id, material_kind, item_code, material_name, item_group, description2,
   qty, received_qty, unit_price_sen, line_total_sen, variants, warehouse_id, from_mrp, company_id)
```

while the SO branch fifteen lines below does set `description`. That asymmetry
is why one side of the same corrected build reads clean and the other does not.
The three documents above are all entries in
`backend/scripts/data/sofa-compartment-corrections-2026-09.json`, added
2026-09-07 "so the pair is corrected together".

This is the third field this same INSERT has been caught omitting. The comment
already standing above it records the second — `warehouse_id`, absent silently,
seven lines across six orders on 2026-08-11, repaired 2026-08-18, and a line
that lands with a NULL warehouse can never match stock because allocation
buckets by (warehouse, item, variant). The class is the same: a column-list
INSERT that copies a row is only as complete as somebody's memory of the column
list.

**Fix.**

1. The INSERT copies `description` and `delivery_date` from the source piece,
   beside `description2` and `warehouse_id` which it already copied. Both are
   the SAME book line's values — the lead already holds them — so this is a
   copy, not a guess.
2. `backend/scripts/repair-po-line-desc-deliv-from-book.mjs` +
   `.github/workflows/repair-po-line-desc-deliv.yml` repair the rows already
   written. The value comes from the BOOK, keyed on AutoCount's `DtlKey` across
   both PO export lanes — not inferred from a sibling ERP row. A line whose key
   the book does not carry is counted and left alone; 空白不覆盖 applies, so a
   line the book states nothing for and a line that already holds a value are
   both left alone. PLAN by default, convergent, and it writes two descriptive
   columns only — no money, no quantity, no stock, so migrated receipts and
   delivery notes stay `migrated_no_stock` with zero inventory movements.

**What this does NOT change.** `so_item_id` is still deliberately not copied
onto an added PO line (the dedication is one SO line to one PO line), and
`linked_ac_dtlkey` is still left to `backfill-ac-sofa-line-keys.mjs`, which keys
every compartment of a build together.

**Ref.** fix/po-align-0908, 2026-09-08. Measured against reconcile run
`34178538830`.
