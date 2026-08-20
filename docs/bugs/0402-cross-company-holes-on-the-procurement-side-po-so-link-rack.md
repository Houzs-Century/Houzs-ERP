## Cross-company holes on the procurement side: PO SO-link, rack create, supplier binding [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 三个跨公司漏洞，同一个根因(服务角色连线绕过隔离，写入必须自带公司条件)。
(1) 建采购单(PO)时，「新建 PO 带销售单来源」这条路读取来源销售单行(soItemId)没带
公司条件，然后把它连上本公司的 PO、复制它的照片、还回写它的「已下单数量」——等于把另一
间公司的销售单行认成自己的。(2) 建货架(Rack)时，只对「全部仓库」那条分支做了公司过
滤；直接传仓库 id 的分支没验证仓库属不属于本公司，于是会把货架建到另一间公司的仓库上
(货架盖本公司公司章，仓库却是别家的)。(3) 给供应商加绑定(binding)时，绑定盖上本公司
公司章，却没检查这个供应商本身属不属于本公司。

**Symptom.** Three service-role writes on the procurement side accepted a
caller-supplied id (SO line / warehouse / supplier) from another company and
wrote against it. Found by the same 2026-08-19 cross-tenant audit, traced on
`origin/main`.

**Root cause (traced, PROVEN by reading the handlers).** Same boundary as above —
the `company_id` predicate is the only isolation.
- **PO create** (`mfg-purchase-orders.ts`, POST `/` ~L1166): the bare-create path
  (desktop "New PO from SO" / MRP convert) read `mfg_sales_order_items .in('id',
  soItemIds)` with no company predicate, then linked `so_item_id` (~L1282), copied
  `photo_urls` (~L1369) and rolled `po_qty_picked` forward via `recomputeSoPicked`
  (`.eq('id', soItemId)`, ~L2902). A foreign `soItemId` re-parented another
  company's SO line. The add-line path already gated it via `soLinkTargetRefusal`.
- **Rack create** (`warehouse.ts`, POST `/racks`): `resolveRackTargets` scoped only
  the `allWarehouses` branch; the `warehouseId` / `warehouseIds` branches trusted
  the caller-supplied uuid, and the racks stamp `company_id = active` while pointing
  `warehouse_id` at a foreign warehouse.
- **Supplier binding** (`suppliers.ts`, POST `/:id/bindings` + `/bindings/batch`):
  the binding row stamped `company_id = active` but never verified the `:id`
  supplier belonged to the active company — unlike the scoped scorecard/edit/delete
  paths.

**Fix.** PO create: scope the SO-item read with `scopeToCompany(...)` and refuse
any `soItemId` not in the caller's company (404 `so_line_not_found`) before it is
linked; the photo read is scoped too. Rack create: `resolveRackTargets` now
intersects the requested warehouse ids with the company's own warehouses (foreign
uuid resolves to nothing). Supplier binding: verify the supplier belongs to the
active company (`scopeToCompany` + `detailMissResponse` 404) before inserting, on
both the single and batch paths. Handlers exported for the test. Coverage in
`tests/crossTenantUncoveredLeaks.test.ts` (both directions; proven red before fix).

**Ref.** this PR, 2026-08-19.
