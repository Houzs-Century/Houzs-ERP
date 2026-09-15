# Module: Product code rename (SKU Master)

Per-module technical doc for changing a SKU's code — what the one request does,
which tables follow the new code, which deliberately keep the old one, and the
test that stops the two lists going stale.

> **Written 2026-09-15**, for the owner's question 「如果我要换 product code
> 应该怎么样呢」. Everything below was read out of the tree and production's
> catalog on that date (read-only runs 34965615433 and 34970682915).
>
> **Line numbers are deliberately absent.** Resolve a route with
> `npm --prefix backend run gen:route-locator`, then grep
> `docs/generated/route-locator.md`.

---

## 1. How staff do it

Products -> SKU Master, edit the code on the row, save. That sends
`PATCH /api/scm/mfg-products/:id` with `{ code }` (gate: `scmAreaGuard("scm.procurement.products")`,
see `docs/generated/route-capability-matrix.csv`). The response carries
`renamed: { "<table>.<column>": <rows re-pointed> }` for every column it touched.

## 2. What the request does, in order

`patchMfgProductHandler` in `backend/src/scm/routes/mfg-products.ts`:

1. Loads the SKU **in the active company only**; a SKU of another company is 404.
2. Asks whether another SKU of the same company already has the new code. A
   failed read REFUSES (409 `duplicate_check_failed`); a taken code is 409
   `duplicate_code`. Nothing has been written yet.
3. For each column in `PRODUCT_CODE_CASCADE`
   (`backend/src/scm/lib/product-code-rename.ts`): `UPDATE ... SET col = new WHERE col = old AND company_id = active`,
   plus `material_kind = 'mfg_product'` on tables that also hold fabrics and raw
   materials. An error whose message says something "does not exist" is skipped
   (meant for a fresh database without the table; it would also skip a missing
   column, which is why the guard in section 5 checks every column exists on
   production). Any other error aborts with 500 `rename_cascade_failed` BEFORE
   the SKU row changes.
4. Updates `scm.mfg_products.code` last.

Not transactional (supabase-js), but retryable: the SKU keeps its old code until
step 4, and a retry finds already-renamed rows matching nothing.

There is no foreign key to `scm.mfg_products.code` and no trigger on it
(run 34965615433) — step 3 is the only thing that moves the code.

## 3. Columns that FOLLOW the new code

All in schema `scm`, all carrying `company_id`.

| group | columns |
| --- | --- |
| Sales documents | `mfg_sales_order_items.item_code`, `mfg_so_price_overrides.item_code`, `delivery_order_items.item_code`, `sales_invoice_items.item_code`, `delivery_return_items.item_code` |
| Purchase documents (`material_kind` scoped) | `purchase_order_items`, `grn_items`, `purchase_invoice_items`, `purchase_return_items` (`item_code`) |
| Consignment | `consignment_sales_order_items`, `consignment_delivery_order_items`, `consignment_delivery_return_items`; `purchase_consignment_order_items`, `purchase_consignment_receive_items`, `purchase_consignment_return_items` (these three `material_kind` scoped) |
| Amendments | `so_amendment_lines.new_item_code`, `po_amendment_lines.new_item_code` — a pending amendment applies this code onto the line later |
| Stock | `inventory_movements`, `inventory_lots`, `inventory_lot_consumptions`, `stock_transfer_lines`, `stock_take_lines`, `warehouse_rack_items`, `warehouse_rack_movements` (`item_code`) |
| Masters and prices | `supplier_material_bindings.item_code` (`material_kind` scoped), `master_price_history.item_code`, `mfg_product_price_history.item_code` (dated selling price), `product_dept_configs.item_code`, `hr_item_kpi.ref`, `pwp_codes.trigger_item_code`, `pwp_codes.redeemed_item_code`, `addons.service_sku` (a service add-on's SVC-* SKU) |

Ten of these were added 2026-09-15 — the two amendment columns, the six
consignment tables, `mfg_product_price_history` and `addons.service_sku`:
`docs/bugs/0939-renaming-a-sku-code-left-pending-amendments-consignment-line.md`.

## 4. Columns that KEEP the old code, and why

`PRODUCT_CODE_KEEPS_VALUE` in the same file carries the reason per column. In short:

- `scm.mfg_so_item_deletions.item_code` — forensic record of a deleted line as it was.
- AutoCount's own codes: `scm.supplier_material_bindings.ac_item_code`,
  `public.assr_cases.item_code`, `public.assr_items.item_code`,
  `public.purchase_orders.item_code` (AutoCount outstanding-PO snapshot),
  `public.stock_items.item_code` (AutoCount StockItem cache). AutoCount does not
  rename when the ERP does.
- The supplier's model code: every `supplier_sku`.
- Other entities' own keys: `scm.product_models.model_code`, `scm.products.sku` /
  `model_code` (POS retail catalogue), `scm.purchase_order_lines.sku`.
- Typed text in legacy modules: `public.sales_entry_items.item_code`,
  `public.project_defects.item_code`.
- 35 pre-SCM copies of scm tables left in `public`: no `company_id`, no reader,
  0 rows on 2026-09-15.

Also not touched: JSON inside `variants`, `pwp_rules.trigger_size_codes` /
`reward_size_codes` (size codes, not SKU codes), and text that merely mentions a
code (Description 2, remarks). Printed documents that were already issued keep
what they printed.

## 5. The guard

`backend/tests/productCodeRenameCoverage.test.ts` fails when:

- a column in `backend/tests/fixtures/product-code-columns.snapshot.json`
  (production's text columns named `*item_code` / `*product_code` /
  `*material_code` / `*sku` / `*model_code`, plus `hr_item_kpi.ref`) is in
  neither list;
- a migration in `backend/src/db/migrations-pg/` sorting after the snapshot's
  `newestMigrationAtCapture` creates, adds or renames to such a column and it is
  in neither list;
- a kept column no longer exists on production, or a column is in both lists;
- a cascaded column is missing on production, has no `company_id`, or sits on a
  table with `material_kind` without the `kind` scope.

Refresh the snapshot: on a branch, point a manual read-only workflow step at
`node scripts/probe-product-code-columns.mjs` with `DATABASE_URL` (the 2026-09-15
capture ran it as a temporary step of `probe-category-constraints.yml`, run
34970682915, removed before merge), upload the file it writes on the runner,
`backend/product-code-columns.snapshot.json` [external], as an artifact, and copy
it over the fixture. The run log also prints each column's row count and how many
rows hold a live SKU code, which is the evidence for deciding a new column.

`backend/tests/destructiveGuardsRefuseUnreadableProbe.test.ts` drives the real
handler: the duplicate probe refusals, and a rename that flips the added columns
while `supplier_sku`, `ac_item_code`, the delete audit, a fabric row and another
company's line stay.

## 6. Open

- **UNKNOWN:** whether documents carrying a renamed SKU still post to AutoCount
  without an AutoCount item of the new code. The ERP does not rename AutoCount's
  item; this was not measured.
