## Renaming a SKU code left pending amendments, consignment lines, price history and service add-ons on the old code [high]

**Symptom.** Owner, 2026-09-14: 「如果我要换 product code 应该怎么样呢」. An earlier review
listed code-bearing columns the SKU rename (Products -> SKU Master, PATCH
/mfg-products/:id with `code`) might not re-point. Nobody had checked production.

**Root cause (traced).** The code is stored as TEXT with no foreign key (read-only run
34965615433: no foreign key or trigger references `scm.mfg_products`), so the rename
works only through the hand-written column list in `scm/routes/mfg-products.ts`. That
list held 22 columns. Production's catalog (runs 34965615433 and 34970682915, every
text column named `*item_code` / `*product_code` / `*material_code` / `*sku` /
`*model_code` in `scm` and `public`, 84 in all) has more that store a live SKU code
and were never in it:

| column | rows holding a live SKU code (2026-09-15) | what broke after a rename |
| --- | --- | --- |
| `scm.so_amendment_lines.new_item_code` | 143 of 143 | a pending amendment applies a code that no longer exists |
| `scm.po_amendment_lines.new_item_code` | 71 of 71 | same, on purchase orders |
| `scm.purchase_consignment_receive_items.item_code` | 10 of 10 | consignment receipts stranded under the old code |
| `scm.mfg_product_price_history.item_code` | 2 of 2 | the as-of selling price resolver loses the SKU's dated prices |
| `scm.addons.service_sku` | 5 of 18 | a service add-on books its line under a SKU that is gone (409 on save) |
| `scm.purchase_consignment_order_items.item_code`, `..._return_items.item_code`, `scm.consignment_sales_order_items.item_code`, `..._delivery_order_items.item_code`, `..._delivery_return_items.item_code` | 0 today | the same stranding the day those tables fill |

`public.sales_entry_items.item_code` (named in the review) is EMPTY; `purchase_orders.item_code`
exists only as `public.purchase_orders`, an AutoCount outstanding-PO snapshot.

**Fix.** The list moved to `backend/src/scm/lib/product-code-rename.ts` with the ten
columns above added (company-scoped; the three purchase-consignment tables also
`material_kind = 'mfg_product'`), and every other code-bearing column is recorded in
`PRODUCT_CODE_KEEPS_VALUE` with why it keeps its value: the delete audit
`mfg_so_item_deletions`, AutoCount's own codes (`ac_item_code`, ASSR cases,
`public.purchase_orders`, `public.stock_items`), the supplier's model codes
(`supplier_sku`), a model's own code, the POS `scm.products` catalogue, typed text in
legacy modules, and 35 empty pre-SCM copies in `public`.
`backend/tests/productCodeRenameCoverage.test.ts` fails when a column in the production
snapshot (`tests/fixtures/product-code-columns.snapshot.json`, from
`backend/scripts/probe-product-code-columns.mjs`) or in a migration newer than it is in
neither list, when a cascaded column lacks `company_id`, or when a table holding
`material_kind` is renamed without that scope. RED on the old 22-column list with no
keep list (62 undecided live columns listed, the ten above among them), GREEN after. A handler test in
`destructiveGuardsRefuseUnreadableProbe.test.ts` renames through the real PATCH and
checks the new columns flip while `supplier_sku`, `ac_item_code`, the delete audit, a
fabric row and another company's line do not; RED on the old route, GREEN after.

**Ref.** fix/product-code-rename-cascade-gaps, 2026-09-15.
