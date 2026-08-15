> **ARCHIVED 2026-08-13.** The 1:1 SCM clone landed: `frontend/src/pages/scm-v2/` is the canonical `/scm/*` surface, the native `frontend/src/pages/scm/` tree is deleted, and no `-v2` routes remain in `App.tsx`. Superseded by `docs/CODEBASE-MAP.md` §3-4. Kept for history; do not follow it as a current instruction.

# Houzs ← 2990s SCM — 1:1 Clone Program

> Durable spec for the multi-week clone. Read this first every session; it is
> the brain that survives context compaction. Update the **Status log** at the
> bottom as slices land.

## Decision (2026-06-17, owner)

Clone 2990s's **Supply Chain super-module 1:1 (frontend + backend, "直接 copy
paste")** into Houzs, and eventually **delete the AutoCount core**. The earlier
adapted/trimmed SCM (the `scm_*` island) was rejected and is being removed.

**Strategy 2 — locked by owner:** Houzs is **NOT** the same furniture business as
2990s (different products / not pure furniture). So:

- **Clone VERBATIM:** the SCM *document-flow* tables, routes, business logic, and
  pages — Suppliers, PO, GRN, Purchase Invoice/Return, Inventory/FIFO, Warehouse,
  Transfers, Stock Take, MRP, Sales Order/DO/SI/Delivery Return, Consignment.
- **Do NOT clone:** the furniture engine — sofa/bedframe/mattress configurators,
  Sofa Combo pricing, fabric-tier surcharges, PWP, `mfg-pricing`/`sofa-*` shared
  packages, the Products catalog *pricing editor*. These are dead weight for Houzs.
- **Product layer → Houzs's own data.** 2990s couples SCM to its catalog by **TEXT
  `material_code` + `material_kind`, NOT hard FKs** (verified: `material_code:
  text(...)`). So Houzs just puts its own product/stock codes there; the furniture-
  only `price_matrix` jsonb stays nullable/empty. This makes Strategy 2 light.

**Excluded entirely:** TRANSPORTATION group ("transportation 不需要" — keep Houzs's
existing Logistics/trips).

## Repos & the DB seam (the good news)

| | Source — 2990s | Target — Houzs |
|---|---|---|
| Path | `C:\Users\User\Desktop\2990s` (READ-ONLY, shared live tree — never write) | `C:\Users\User\Desktop\Houzs-ERP-cutover` |
| Monorepo | pnpm + turbo; `apps/api` (Hono), `apps/backend` (React admin SPA), `apps/pos`, `packages/{db,shared,design-system}` | npm; `backend/` (Hono), `frontend/` (React SPA), out-of-tree `shared/` |
| ORM/DB | Drizzle + **Postgres (pg-core)**, `postgres-js`, `casing:'snake_case'` | Drizzle + **Postgres (pg-core)** via Hyperdrive, `getDb(env)` |
| Schema | `packages/db/src/schema.ts` (~87 tables / 27 enums, source of truth) | `backend/src/db/schema.pg.ts` (re-exported by `schema.ts`) |

**Both sides are pg-core Drizzle on Postgres** → table defs, column types, and
`pgEnum`s transfer almost verbatim (no dialect translation). This is what makes a
real 1:1 feasible.

Branch: **`scm-clone-2990s`**. Staging-first, then prod. Staging Supabase
`minnapsemfzjmtvnnvdd` / Hyperdrive `b776100058d04d609bb6e19182263683`.

## Canonical adaptation rules (the only allowed deviations from verbatim)

Apply these *consistently* at every seam so ported routes/pages compile unchanged:

1. **Table names:** use 2990s's names verbatim (`suppliers`, `purchase_orders`,
   `grns`, ...). NOT the rejected `scm_` prefix.
2. **Drizzle style:** copy 2990s's table defs verbatim — **camelCase property keys
   + explicit snake_case column strings + `pgEnum`s** (e.g. `whatsappNumber:
   text('whatsapp_number')`). Ported routes reference `.whatsappNumber`, so keep the
   keys. Houzs's existing tables use snake_case keys; mixed conventions per-table is
   fine in Drizzle. Columns are explicitly named so `getDb` (no `casing` option)
   still emits correct SQL.
3. **DB client:** `import { getDb } from "../db/client"` then `const db =
   getDb(c.env)`. (2990s uses a per-request `createClient(databaseUrl)`.)
4. **Auth/RBAC:** 2990s verifies a Supabase JWT (`middleware/auth.ts`) + RLS role
   helpers + `staff` table. Houzs uses Bearer token + `requirePermission(...)` +
   `users` table. **Map `staff` → Houzs `users`; `created_by` = users.id (integer).**
   Gate SCM routes with Houzs's permission middleware (start Owner-only `"*"`, then
   add real permission keys in the Auth/seam phase).
5. **Money:** keep 2990s's `*_centi` integer columns verbatim. (Houzs's AutoCount
   money is mixed; the cloned SCM stays centi-internal.)
6. **Frontend styling:** bring the **`.module.css` files VERBATIM** alongside each
   page (Vite supports CSS Modules out of the box — most faithful, least work). Do
   NOT rewrite to Tailwind. Pull 2990s `packages/design-system` tokens as needed.
7. **Frontend data:** 2990s uses TanStack Query + a typed api client. Houzs has
   TanStack under its `useQuery` hook + `frontend/src/api/client.ts` (reads
   `VITE_API_URL`). Re-point ported pages at Houzs's client; keep query shapes.
8. **Shared Zod:** 2990s schemas live in `packages/shared/src/schemas`. Houzs uses
   out-of-tree `shared/` via `@shared/*` alias. Port the SCM Zod schemas into
   `shared/` and **alias `zod` in all 4 toolchains** (tsconfig paths ×2, vite
   resolve.alias, wrangler `[alias]`, vitest resolve.alias) — the out-of-tree bare
   `import {z} from "zod"` broke CI 2× before; this is mandatory.
9. **Imports:** 2990s `@2990s/db|shared|design-system` and `@/...` → Houzs relative
   / `@shared/*` equivalents.
10. **Dialogs/notifications:** `window.confirm` / `window.alert` / bare
    `confirm(...)` / `alert(...)` → Houzs **in-app** hooks, NEVER the native
    primitives. Gate actions with `const dialog = useDialog()` (from
    `frontend/src/hooks/useDialog`) → `if (!(await dialog.confirm({ ... }))) return;`
    (make the enclosing handler `async`); surface validation/error/success messages
    with `const toast = useToast()` (from `frontend/src/hooks/useToast`) →
    `toast.error(...)` / `toast.success(...)` / `toast.warning(...)`. Hooks are called
    at component top level (hoist out of nested row/onClick callbacks). This matches
    **2990s production (migrated off window.confirm in PR #657)** and the owner's
    standing **"no naked edits — use in-app ConfirmDialog, never window.confirm"**
    rule. (Earlier slices intentionally kept the native primitives "1:1"; that was
    superseded by this rule — see the 2026-06-18 status entry. `window.prompt` has no
    Houzs equivalent yet and is left as-is where 2990s used it.)

## Collision map (Houzs already has these)

- **`purchase_orders`** (Houzs AutoCount, schema.pg.ts:398) ⟂ 2990s `purchase_orders`.
- **`warehouses`** (Houzs AutoCount, :279) ⟂ 2990s `warehouses` (richer, + racks).
- **`creditors`** (Houzs AutoCount suppliers, :421) ↔ 2990s `suppliers` (different
  name, conceptual overlap).
- **`sales_orders`** (Houzs AutoCount, :330, ~2695 live rows) ↔ 2990s
  `mfg_sales_orders` (different name). Referenced by Logistics(trips)/ASSR/Projects.
- **`order_details`**, **`purchase_order_docs`** — AutoCount SO/PO children.
- These AutoCount tables are removed only at the **gated cutover** (task #71), never
  on the branch casually. On the branch, 2990s tables are added under their own
  names and coexist until cutover.
- The rejected **`scm_*` island** (the `scm_*` table block in `schema.pg.ts`) is dead/unreferenced and
  is dropped by migration `0023` + removed from schema.pg.ts (Phase 0).

## Phase order → tracked tasks

Vertical slices (each = schema + migration + route + page(s) + wiring + **staging
e2e test**), mirroring the owner's own proven sequencing. Task IDs in the tracker:

| # | Slice | Task |
|---|---|---|
| 0 | Drop `scm_*` island + establish canonical pattern | #56 |
| 1 | Suppliers + material bindings | #57 |
| 2 | Products & Maintenance (→ Houzs product layer) | #58 |
| 3 | Purchase Orders | #59 |
| 4 | Goods Receipt + inventory-in | #60 |
| 5 | Purchase Invoices + Purchase Returns | #61 |
| 6 | Warehouse + Inventory (FIFO/moves/valuation) | #62 |
| 7 | Stock Transfers + Stock Takes | #63 |
| 8 | MRP · Stock Status | #64 |
| 9 | Sales Orders + SO Detail | #65 |
| 10 | Delivery Orders + Sales Invoices + Delivery Returns | #66 |
| 11 | Consignment (sales + purchase) | #67 |
| 12 | Auth/seam integration + wiring all modules | #68 |
| 13 | Rewire Logistics/ASSR/Projects → new SO model | #69 |
| 14 | Staging end-to-end acceptance | #70 |
| 15 | **(GATED)** Prod cutover — delete AutoCount + data migration | #71 |

Dependency: 1→3→4→5 (procurement chain); 6 underpins 4/7/9/10; 9→10→11; 12 after
modules exist; 13 before 15; 15 needs owner sign-off + written data plan.

## Source file locations (2990s)

- Backend routes: `apps/api/src/routes/*.ts` — suppliers, products, product-models,
  maintenance-config, categories, mrp-lead-times, purchase-orders (verify name),
  grns, purchase-invoices, purchase-returns, inventory, warehouse, stock-takes,
  stock-transfers, state-warehouse-mappings, mfg-sales-orders (verify), scan-so,
  so-dropdown-options, so-settings, delivery-orders-mfg, sales-invoices,
  delivery-returns, consignment-notes, consignment-returns, purchase-consignment-*,
  outstanding, document-flow, accounting (AP/AR posting — port the SCM-relevant bits).
- Backend logic: `apps/api/src/lib/*.ts` — po, po-pricing (strip furniture),
  recost, inventory-movements, grn-rack-sync, check-stock-availability,
  so-delivery-sync, so-readiness, so-stock-allocation, so-audit, current-doc,
  doc-no, my-time, postgrest-search. Port per-slice as imported.
- Frontend pages: `apps/backend/src/pages/*.tsx` (+ `.module.css`) — Suppliers,
  SupplierDetail, Products/ProductModels, Mrp, PurchaseOrders, PurchaseOrderFromSo,
  GrnFromPo/GrnNew/GoodsReceivedList, PurchaseInvoice*/PurchaseInvoicesList,
  PurchaseReturnsList, Inventory/StockCard/StockAdjustments/Warehouses,
  StockTransfers/StockTakes, MfgSalesOrdersList/SalesOrderDetail*/sales-order/*,
  Mfg* DO/SI/DR lists+details + *FromSo/*FromDo, Consignment*/PurchaseConsignment*.
- Schema: `packages/db/src/schema.ts`. SCM table line map (approx): suppliers 860,
  supplier_material_bindings 911, purchase_orders 948, purchase_order_items 979,
  grns 1057, grn_items 1083, purchase_invoices 1129, purchase_returns 1778,
  warehouses 2348, inventory_movements 2424, inventory_lots 2456, stock_transfers
  2488, stock_takes 2529, mfg_sales_orders 1210, delivery_orders 1575, sales_invoices
  1647, delivery_returns 1725. **Re-glob/grep per slice — the route list truncates.**

## Migration conventions (Houzs)

- Dir `backend/src/db/migrations-pg/`, name-sorted, applied once, tracked in
  `_pg_migrations`. Next free number after 0023 = **0024**.
- Runner `backend/scripts/pg-migrate.mjs`: **splits on `;\n`**, strips `--` comment
  lines, runs each statement via `tx.unsafe` inside ONE transaction. So: each
  statement ends with `;` on its own line; **no `BEGIN/COMMIT`** (runner wraps);
  must be **idempotent** (`IF NOT EXISTS` / `ON CONFLICT` / `IF EXISTS`).
- Hand-written `.sql`, immutable after deploy. Schema source of truth = schema.pg.ts.
- `deploy.yml` runs `pg-migrate.mjs` against **PROD** on push to `main` — so a merge
  applies all pending migrations to prod. Keep them safe on prod data.

## Cutover gating (task #71) — non-negotiable

Deleting AutoCount drops ~2695 live sales_orders + delivery/PO/creditors/warehouses
and breaks Logistics/ASSR/Projects FKs. This happens **only** after: (a) all modules
cloned + rewired (task #69), (b) a written data-migration plan, (c) explicit owner
sign-off. Never on the branch casually; never blindly. Prefer reversible steps.

## Proven pattern + findings (Suppliers slice, 2026-06-17)

**MAJOR FINDING — 2990s routes use the Supabase PostgREST query builder, NOT
Drizzle queries.** (`supabase.from().select().eq().or()`...). Houzs has no
Supabase-JS client — it is Drizzle-over-Hyperdrive. So **every route port is a
faithful PostgREST→Drizzle TRANSLATION**, not a copy: keep endpoints, request
bodies, response JSON shapes, status codes, and business rules identical; rewrite
only the query mechanism. Drizzle returns camelCase rows, so add
`toXResponse()` mappers to emit the snake_case wire shape the 2990s frontend
expects. (Schema/migrations DO transfer near-verbatim; only the runtime queries
need translation.)

**Per-slice verification gates (both must be EXIT 0 before a slice is "done"):**
- Backend: `npm --prefix backend run typecheck` (`tsc --noEmit`).
- Frontend: `npm --prefix frontend run build` (`tsc -b` + vite).
- **Staging e2e is BATCHED at task #70**, not run per-slice (deploying 16× is
  wasteful). "Slice done" = code-complete + both gates green + reviewed. Live
  staging acceptance happens once, at the end, under #70.

**Import-rewrite map (reuse every slice):**
| 2990s | Houzs |
|---|---|
| `@2990s/db` tables/enums | `../db/schema` (re-exports `schema.pg.ts`) |
| per-request `createClient(url)` / `c.get('supabase')` | `import { getDb } from "../db/client"` → `getDb(c.env)` |
| PostgREST `.from().select().eq().or().order()` | Drizzle `db.select().from().where(and/or/eq/ilike).orderBy(asc/desc)` |
| Supabase JWT/RLS middleware | `import { requirePermission } from "../middleware/auth"` → `app.use("*", requirePermission("*"))` |
| `lib/postgrest-search` `escapeForOr` | inline (small) |
| `import type { Env, Variables } from '../env'` | `import type { Env } from "../types"` (no `Variables`) |
| `export const x = new Hono(...)` | `const app = new Hono<{ Bindings: Env }>(); export default app;` |
| FE `lib/*-queries` `authedFetch` | `../api/client` `api.{get,post,patch,del}` + `@tanstack/react-query` |
| `@2990s/design-system` `Button` (has `size`) | `../components/Button` (variant only) |
| 2990s `DataGrid` | plain `<table>` + the verbatim `.module.css` `.table*` classes |
| `react-router` | `react-router-dom` (same hooks) |
| furniture libs (mfg-products, product-models, SofaComboTab, FabricTracking, MoneyInput, PhoneInput, localities) | drop / replace with plain text inputs (Strategy-2 product layer) |
| `./X.module.css` | identical — copy verbatim (Vite supports CSS Modules) |

## Collisions / decisions for UPCOMING slices

- **`warehouses`** — Houzs AutoCount `warehouses` (schema.pg.ts:279) collides with
  2990s `warehouses`. Since the owner re-enters data and AutoCount is deleted at
  cutover, the end state is 2990s's warehouses. Resolve in the Warehouse slice.
  Until then, cross-slice warehouse refs (PO `purchaseLocationId`, GRN/inventory
  `warehouse_code`) use **nullable SOFT refs (no FK)**; tighten when warehouses lands.
- **`/po` + `PurchaseOrders.tsx`** — Houzs ALREADY has an AutoCount PO page at
  `/po`. Mount the 2990s PO clone at a DISTINCT route (e.g. `/purchase-orders`) so
  both coexist until cutover; don't overwrite the existing page.
- **Cross-slice refs to not-yet-cloned tables** (warehouses, mfg_sales_orders via
  PO `soItemId`) → nullable soft refs initially; this is a documented sequencing
  deviation from 2990s's hard FKs (behaviourally identical; tighten later).

## Status log

- **2026-06-17:** Program defined. Strategy 2 locked. 16 tasks (#56–71) tracked.
- **2026-06-17 — Phase 0 DONE (#56):** `scm_*` island removed from schema.pg.ts +
  migration `0023` drops the physical tables; backend typecheck green.
- **2026-06-17 — Suppliers slice DONE (#57):** verbatim clone of 2990s
  suppliers + supplier_material_bindings (migration `0024`, real pgEnums) + route
  (PostgREST→Drizzle) + Suppliers/SupplierDetail pages (CSS Modules verbatim) +
  wiring (App.tsx `/suppliers`, Sidebar "Supply Chain" group). Backend typecheck
  AND frontend build both EXIT 0. Owner re-enters data → no migration of vendor
  data. Material bindings use TEXT codes (plain-text inputs; product picker
  deferred to Products slice). Scorecard is a zero-shape stub until PO/GRN land.
  Migration `0024` NOT yet applied to any DB (batched for staging at #70).
- **2026-06-17 — PO slice DONE (#59):** verbatim clone → tables
  `mfg_purchase_orders`/`_items`/`_lines` (AutoCount owns bare `purchase_orders`),
  `po_status` enum, route at `/api/purchase-orders`, pages in `pages/scm/`, nav
  under Supply Chain. Furniture pricing dropped (line = qty×unit−disc); variant
  columns kept in schema. From-SO + GRN-downstream stubbed (TODO when those land).
  `created_by` = `users.id` from auth (`c.get("user")`). Both gates EXIT 0.
- **NAMING CONVENTION (decided):** when a 2990s table name collides with a live
  AutoCount table, the clone takes a distinct physical name reusing 2990s's `mfg_`
  vocabulary — `purchase_orders`→`mfg_purchase_orders`, `warehouses`→`mfg_warehouses`.
  The Drizzle export key stays 2990s's camelCase key (route code verbatim) UNLESS
  that identifier already exists in schema.pg.ts — a single-word name like
  `warehouses` is identical in snake/camel and AutoCount already exports it, so the
  export key ALSO takes the prefix (`mfgWarehouses`), imported in routes as
  `mfgWarehouses as warehousesTable` so handler bodies stay verbatim. (`purchaseOrders`
  camel ≠ AutoCount's `purchase_orders` snake, so PO kept the bare camel key.)
  Rename to the bare name at cutover (#71). Non-colliding tables (grns, purchase_invoices,
  inventory_*, stock_*, mfg_sales_orders, delivery_orders — Houzs has none of these)
  use bare names.
- **SLICE REORDER:** Inventory/Warehouse (#62) moves BEFORE GRN (#60): GRN / purchase-
  return / transfer / stocktake POSTs all write into the inventory ledger, so the
  ledger + `inventory-movements` lib must exist first. Order now: Suppliers ✓ → PO ✓
  → **Inventory/Warehouse (#62)** → GRN (#60) → PI/PR (#61) → Transfers/Stocktake
  (#63) → Products (#58) → MRP (#64) → SO (#65) → DO/SI/DR (#66) → Consignment (#67).
- **2026-06-17 — Inventory + Warehouse DONE (#62):** migration `0026` (11 tables:
  `mfg_warehouses` + inventory_movements/lots/lot_consumptions + stock_transfers/
  _lines + stock_takes/_lines + warehouse_racks/_items/_movements; `inventory_movement_type`
  enum; 3 single-line plpgsql FIFO fns + `trg_inventory_movement_fifo` trigger + 4
  product-free views; KL/PJ seed). Routes `/api/inventory` + `/api/mfg-warehouses`;
  lib `inventory-movements.ts`; pages in `pages/scm/`. Catalogue-coupled views
  (`v_inventory_all_skus`, `v_inventory_product_totals` — CROSS JOIN mfg_products)
  NOT created → `/inventory?showAll` + `/inventory/products` return empty until
  Products slice. Both gates EXIT 0.
  - **`inventory-movements` lib API (GRN/PR/transfer/stocktake call this):**
    `writeMovements(db, rows: MovementInput[])` (fires the DB FIFO trigger — lots/
    consumptions/COGS auto-maintained; never touch lots directly),
    `reverseMovements(db, sourceDocType, sourceDocId, performedBy)`,
    `defaultWarehouseId(db)`, `resolveWarehouseLotBatches(db, whId)`,
    `resolveWarehouseLotCosts(db, whId)`. `MovementInput` = `{ movement_type
    'IN'|'OUT'|'ADJUSTMENT'; warehouse_id; product_code; variant_key?; product_name?;
    qty; unit_cost_sen?; source_doc_type 'GRN'|'DO'|'DR'|'PURCHASE_RETURN'|...;
    source_doc_id?; source_doc_no?; batch_no?; reason_code?; performed_by?: number }`.
- **2026-06-18 — GRN slice DONE (#60):** verbatim clone → tables `grns`+`grn_items`
  (BARE names, no AutoCount collision), `grn_status` enum (POSTED/CLOSED/CANCELLED),
  migration `0027_grns.sql`, route at `/api/grns`, lib `grn-rack-sync.ts`, pages
  GoodsReceivedList/GrnNew/GrnFromPo/GoodsReceivedDetail + `grn-queries.ts` in
  `pages/scm/`, routes in App.tsx (`/grns`, `/grns/new`, `/grns/from-po`, `/grns/:id`),
  nav "Goods Received" under Supply Chain. GRN POST flow wired faithfully: (a)
  `writeMovements(db, ... source_doc_type:'GRN', batch_no=source PO no)` for IN; (b)+(c)
  `recomputePoReceived` recounts `mfg_purchase_order_items.received_qty` + re-evaluates
  parent PO status (SUBMITTED→PARTIALLY_RECEIVED→RECEIVED); (d) `placeGrnLinesOnRacks`.
  Cancel reverses (OUT + rack reversal + PO recount). All over-receipt guards +
  child-lock + downstream-consumption guard + line-edit inventory deltas + warehouse
  relocation ported. Both gates EXIT 0.
  - **PO route un-stubbed:** `poHasDownstream` (PO locks once it has a non-cancelled
    GRN), list+detail `has_children`, per-line `receipts` (poLineReceipts), and
    `/:id/linked` `grns` now query the real grns/grn_items. SO stubs
    (recomputeSoPicked, so_drift, so_doc_no) kept stubbed (SO slice pending).
  - **SEAM/deviations (documented in files):** `grns.purchase_order_id` made NULLABLE
    (2990s declares NOT NULL but the route inserts null for manual GRNs — schema/route
    mismatch in 2990s); `warehouse_id`→real FK to `mfg_warehouses`; `created_by`→int
    soft-ref (users.id); dropped furniture engine (buildVariantSummary, recostFromGrn,
    mfg_products/maintenance-config variant editors, per-line rack picker UX) +
    so-stock-allocation (SO slice) per Strategy-2; rack-sync idempotency keyed on
    `source_doc_no` (= GRN no) since warehouse_rack_items has no source_grn_id column
    in 2990s's schema.ts. Convert-to-PI/PR actions dropped (PI/PR slices pending).
  - Migration `0027` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — PI + PR slice DONE (#61):** verbatim clone → tables
  `purchase_invoices`+`purchase_invoice_items` (`purchase_invoice_status` enum
  POSTED/PARTIALLY_PAID/PAID/CANCELLED) + `purchase_returns`+`purchase_return_items`
  (`purchase_return_status` enum POSTED/COMPLETED/CANCELLED), all BARE names (no
  AutoCount collision); migration `0028_purchase_billing.sql`; routes at
  `/api/purchase-invoices` + `/api/purchase-returns`; query hooks `flow-queries.ts`;
  pages PurchaseInvoicesList/New/FromGrn/Detail + PurchaseReturnsList/New/Detail in
  `pages/scm/`; App.tsx routes (`/purchase-invoices[/new|/from-grn|/:id]`,
  `/purchase-returns[/new|/:id]`, all `<Guard perm="*">`); nav "Purchase Invoices"
  (Receipt) + "Purchase Returns" (Undo2) under Supply Chain. Both gates EXIT 0.
  - **PI = FINANCE record, NO stock impact** (inventory landed at GRN time). POST
    creates POSTED; payment endpoint moves UNPAID→PARTIALLY_PAID→PAID
    (`paid_centi` vs `total_centi`); cancel releases. On every PI write path
    `recomputeGrnInvoiced` recounts `grn_items.invoiced_qty` from live PI lines
    (per-GRN-line cap = accepted − invoiced − returned, + post-insert race verify).
    From-GRN convert paths (`/from-grn`, `/from-grn-items`) + manual create ported.
  - **PR = return-to-supplier, OUTBOUND stock.** On post `writePurchaseReturnMovements`
    writes inventory **OUT** via `writeMovements(db, ... movement_type:'OUT',
    source_doc_type:'PURCHASE_RETURN', source_doc_id=PR id, qty=qty_returned,
    batch_no=source GRN's dye-lot)`, per-line warehouse-resolved (source GRN line's
    warehouse → primary GRN → default); then `adjustGrnReturnedQty` recounts
    `grn_items.returned_qty` from live PR lines + calls `recomputePoReceived(db,
    [poItemId])` (net received drops → PO re-opens). Line CRUD writes compensating
    delta movements (`writePrLineDeltaMovement`: add/+qty → OUT, reduce/delete → IN
    at the OUT's stamped cost/batch). **Cancel reverses via `reverseMovements(db,
    'PURCHASE_RETURN', id, userId)`** (signed-net-per-bucket IN) + releases
    returned_qty. Complete (with CN ref) POSTED→COMPLETED. From-GRN converts
    (`/from-grns` rejected-qty batch, `/from-grn` whole-GRN) ported.
  - **PO route un-stubbed:** `/:id/linked` `invoices`/`returns` now query the real
    `purchase_invoices`/`purchase_returns` tied to the PO (were `[]` after GRN slice).
  - **GRN route un-stubbed:** detail `/:id` per-line `downstream` PI/PR breakdown
    (new `grnLineDownstream` Drizzle helper, cancelled docs excluded) + `/:id/linked`
    `invoices`/`returns` now query real tables (were `[]`). `grnHasDownstream`
    child-lock already READ invoiced/returned qty — now those counters are actually
    WRITTEN by the PI/PR routes, so GRN edit-lock fully engages.
  - **GL/accounting OUT OF SCOPE (Houzs GL differs):** 2990s's AP→GL posting
    (`reversePiAccounting`/`resyncPiAccounting` on PI, AP post on PR) is DROPPED with
    a `// TODO: AP→GL posting is out of SCM clone scope` at each site; the PI/PR docs
    + payment-status stay fully functional. The 2990s Costing-B re-cost chain
    (`recostForPi`/`recostFromGrn` → DO/SI margin) is NOT cloned (SO/DO/SI slices
    pending) → dropped with `// TODO`. SO-allocation re-walk
    (`recomputeSoStockAllocation`, fired by 2990s after a PR moves stock) likewise
    `// TODO` (SO slice pending).
  - **SEAM/deviations (documented in files):** `created_by`→int soft-ref (users.id);
    `purchase_order_id`→real FK to `mfg_purchase_orders` (nullable, as 2990s);
    `grn_id`/`grn_item_id`/`supplier_id`→real FKs; dropped `buildVariantSummary`
    (description2 passes the client value through; variant columns persisted for
    fidelity); New pages use plain-text manual lines (no furniture variant editor /
    mfg-products / supplier-binding lookup / auto-due-date) per Strategy-2. `sql`
    import unused → removed from PR route; unused `navigate` removed from detail pages.
  - Migration `0028` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — Stock Transfers + Stock Takes slice DONE (#63):** verbatim clone
  of 2990s `stock-transfers.ts` + `stock-takes.ts` (PostgREST→Drizzle). Routes at
  `/api/stock-transfers` + `/api/stock-takes` (mounted in index.ts, owner-only
  perm `"*"`); pages StockTransfers/New/Detail + StockTakes/New/Detail in
  `pages/scm/` + query hooks `stock-transfers-queries.ts` + `stock-takes-queries.ts`;
  App.tsx routes (`/stock-transfers[/new|/:id]`, `/stock-takes[/new|/:id]`, all
  `<Guard perm="*">`, static `/new` before `/:id`); nav "Stock Transfers"
  (ArrowLeftRight) + "Stock Takes" (ClipboardList) under Supply Chain. List pages
  use plain `<table>` + `Inventory.module.css` verbatim (StockAdjustments pattern,
  2990s DataGrid dropped); New/Detail pages use a slice-local `StockDoc.module.css`
  reproducing 2990s's `SalesOrderDetail.module.css` look (SO slice not cloned).
  **NO migration needed** — `0026` already created `stock_transfers`/`_lines` +
  `stock_takes`/`_lines` with columns IDENTICAL to 2990s's schema.ts (verified
  field-by-field); the only diffs are the already-applied seams (`created_by`
  integer, FKs→`mfg_warehouses`, `variance` generated). Both gates EXIT 0.
  - **Transfer→inventory wiring (faithful):** POST creates POSTED + inline writes,
    per line: (1) direct `db.insert(inventoryMovements)` of an **OUT@from**
    (`source_doc_type:'STOCK_TRANSFER'`, source dye-lot stamped via the lib's
    `resolveWarehouseLotBatches` when the source bucket sits in ONE batch), then
    **RE-QUERY** that row's `total_cost_sen` (the FIFO trigger stamps cost via a
    separate UPDATE that INSERT…RETURNING can't see — the 2990s C-1 fix), then
    (2) `writeMovements(db, [IN@to])` with `unit_cost_sen = OUT.total/OUT.qty` so
    the destination lot opens at the consumed basis (+ mirrored batch_no). Cancel
    (POSTED→CANCELLED, gated, idempotent) → `reverseMovements(db,'STOCK_TRANSFER',
    id,userId)` (signed-net-per-bucket reversal). `/post` = legacy no-op.
  - **Stocktake→inventory wiring (faithful):** create snapshots `system_qty` per
    in-scope SKU then inserts OPEN lines (counted_qty NULL); `/lines` bulk-updates
    counted_qty (OPEN only); **`/post`** (OPEN→POSTED, gated) writes ONE
    `movement_type:'ADJUSTMENT'` of the SIGNED `(counted−system)` variance per
    non-zero line via `writeMovements(db, …, source_doc_type:'STOCK_TAKE',
    reason_code:'COUNT')` so the ledger reconciles to the counted figure; `/reverse`
    (POSTED→CANCELLED, gated) writes the opposite-signed ADJUSTMENT per forward
    movement; `/cancel` (OPEN) + `/delete` (OPEN) terminal. SO-allocation re-walk
    is a no-op stub (SO slice pending), call sites kept.
  - **SEAM/deviations (documented in files):** `created_by`→int (users.id from
    `c.get("user")`); from/to warehouses must differ (CHECK already exists).
    **Stocktake snapshot source SWAPPED** — 2990s reads `v_inventory_all_skus`
    (CROSS JOIN mfg_products, NOT created in Houzs) → Houzs snapshots from
    `inventory_balances` (movement rollup, product-free, exists): ALL =
    every product_code with a balance row at the wh; CODE_PREFIX = filtered by
    `product_code ILIKE prefix%`; **CATEGORY = zero rows** (no category column in
    Houzs balances → server returns `scope_empty`; kept in the UI dropdown for
    fidelity, preview shows 0, TODO when a product layer + categories land).
    StockTakeNew preview reads `inventory_balances` (showAll=false) — the SAME
    source the server snapshots from — so ALL/CODE_PREFIX previews are honest.
    Dropped per Strategy-2: `useMfgProducts` (SKU-picker datalist + auto-name +
    prefix suggestions) → plain text inputs; `buildVariantSummary` → "Description 2"
    shows stored description2 (none on Houzs transfer/take lines) else em-dash;
    `fmtDateOrDash`/`SkeletonDetailPage` inlined / replaced with plain loading text
    (done-slice precedent). window.confirm/alert kept verbatim (1:1 fidelity; done
    slices kept it). No migration `0029`.
  - Nothing applied to any DB (no migration; batched for staging at #70).
- **2026-06-18 — Sales Orders slice DONE (#65):** the biggest slice. Verbatim
  clone of 2990s's `customers` + `mfg_sales_orders` + `mfg_sales_order_items` +
  the SO audit / payment tables (BARE names — Houzs has `sales_orders` (AutoCount,
  different name) + no `customers`/`mfg_*`). Migration `0029_sales_orders.sql`
  (`mfg_so_status` enum CONFIRMED..CANCELLED + `slip_state` enum; `currency_code`
  reused from 0024). Route at `/api/mfg-sales-orders` (mounted in index.ts,
  owner-only `"*"`). Libs `so-audit.ts` + `so-readiness.ts` + `so-stock-allocation.ts`
  + `so-delivery-sync.ts` + `service-sku.ts` in `backend/src/lib/`. Pages
  MfgSalesOrdersList/SalesOrderNew/SalesOrderDetail + query hooks
  `sales-orders-queries.ts` in `pages/scm/`; App.tsx routes (`/sales-orders[/new|
  /:docNo]`, all `<Guard perm="*">`, static `/new` before `/:docNo`; DISTINCT from
  the live AutoCount `/orders` + `/sales`); nav "Sales Orders" (ShoppingBag) at the
  top of the Supply Chain group. Both gates EXIT 0.
  - **SO→inventory wiring (the headline):** `so-stock-allocation.ts` allocates live
    `inventory_balances` to PENDING SO lines (FIFO by delivery-date → doc_no →
    created_at, per-warehouse bucket, partial→PARTIAL) and auto-advances/regresses
    the header (all-MAIN-READY → READY_TO_SHIP; a MAIN line back to PENDING →
    CONFIRMED). Fired on SO create / line add-edit-delete / status change AND from
    every done stock-mutating slice (see un-stubs below). `stock_status` + `stock_qty_ready`
    columns added to `mfg_sales_order_items`; the manual PATCH `/stock-status` flip +
    auto-advance ported verbatim.
  - **Un-stubbed across done slices:** (a) PO route `recomputeSoPicked` now recounts
    `mfg_sales_order_items.po_qty_picked` from live non-MRP PO lines (1:1 w/ 2990s),
    and PO detail `so_doc_no` + `so_drift` now read the real SO line (drift spec via
    description2, see deviation). (b) The 4 local `recomputeSoStockAllocation` no-op
    stubs (inventory.ts manual-adjust, stock-transfers.ts, stock-takes.ts) + the
    removed call-sites (grns.ts post, purchase-returns.ts post/line-delta/cancel) all
    now import + call the REAL `../lib/so-stock-allocation` so a GRN-IN / PR-OUT /
    transfer / stocktake / adjustment re-walks SO readiness (READY↔PENDING flips).
  - **Strategy-2 — DROPPED (the most furniture-coupled slice):** the ENTIRE furniture
    pricing engine (computeMfgLinePrice/recomputeFromSnapshot/mfgPricingDriftExceeds,
    sofa-combo/fabric-tier/variant pricing, allowed-options + variant-completeness
    checks, PWP / free-gift / TBC sofa-exchange handlers, cross-category delivery-fee
    engine, the 6813-line route's ~1700 lines of TBC-swap + ~1700 lines of create-
    recompute). SO lines use the GENERIC model (product_code/group/qty/unit_price/
    discount/total, plain inputs) — same as PO/GRN/PI. Variant columns KEPT (nullable)
    in the schema for fidelity; no configurator UI. recomputeTotals ported minus the
    sofa-combo COST spread. Customer directory = clean 1:1 clone.
  - **DEFERRED / stubbed (await DO·SI·MRP·Products slices, all `// TODO`):**
    `so-delivery-sync` async wrapper (DO→SO Delivered reconcile — the pure
    `isSoFullyCovered` IS ported); the DO/SI-dependent list+detail aggregates
    (delivery_state / lifecycle_state / current_doc_no / deliverable-remaining /
    per-line delivered breakdown / MRP coverage) return faithful empties; `soHasDownstream`
    child-lock is a no-op (no DO/SI table) so nothing locks yet; customer-credits
    (SO-cancel→credit + the credit-balance lookup) stubbed to 0; the slip-upload R2
    plumbing on POST /payments dropped (no R2 binding); `mfgSoStatusChanges` legacy
    timeline kept alongside the unified `mfg_so_audit_log`. The 2990s `/mine`,
    `/customer-search`, `/debtors/search`, payments, overrides, status, stock-status,
    audit-log endpoints ARE all ported.
  - **SEAM/deviations (documented in files):** ALL staff.id (uuid) refs (created_by /
    salesperson_id / changed_by / approved_by / actor_id / collected_by) → Houzs
    users.id INTEGER soft-refs from `c.get("user")` (rule #4; so-audit snapshots
    `users.name`); `venue_id`/`hub_id`/`customer_po_id` → nullable columns, FK DROPPED
    (no venues/delivery_hubs masters); `warehouse_id` (per-line) → real FK to
    `mfg_warehouses` (nullable soft); `customer_id` → real FK to the cloned `customers`.
    PO `so_item_id` LEFT SOFT (no FK, as prior slices) — `recomputeSoPicked` joins it
    logically. so_drift spec-compare uses description2/description (2990s's
    `buildVariantSummary` is furniture, dropped). doc_no = SO-YYMM-NNN (max+1).
    Roles/admin-gate for price-override + POS-tablet drift collapse to the module's
    owner-only `"*"` mount. Pages use plain inline RM↔centi editors + `<table>` +
    Suppliers/PurchaseOrderDetail CSS modules (DataGrid + configurator dropped);
    window.confirm/alert kept (done-slice precedent).
  - Migration `0029` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — Native dialogs → in-app (cross-slice cleanup):** converted every
  `window.confirm` / `window.alert` / bare `confirm(...)` / `alert(...)` in
  `frontend/src/pages/scm/*.tsx` to Houzs's in-app `useDialog` (confirm gate) +
  `useToast` (error/success/warning) — see canonical rule #10. This SUPERSEDES the
  earlier "window.confirm/alert kept verbatim (1:1 fidelity)" notes in the Stock
  Transfers/Takes (#63) and Sales Orders (#65) entries above, and applies the
  no-naked-edits rule + 2990s PR #657 across the whole SCM page surface. 60
  call-sites across 17 files: PurchaseOrders(2), PurchaseOrderNew(4),
  PurchaseOrderDetail(9), GoodsReceivedList(1), GrnNew(5), GrnFromPo(1),
  GoodsReceivedDetail(4), PurchaseInvoicesList(1), PurchaseInvoiceNew(5),
  PurchaseInvoiceFromGrn(1), PurchaseInvoiceDetail(6, prompt left), PurchaseReturnsList(1),
  PurchaseReturnNew(3), PurchaseReturnDetail(5, prompt left), Inventory(1), Warehouses(1),
  StockAdjustmentNew(3), StockTransferNew(3), StockTransferDetail(2), StockTakeNew(3),
  StockTakeDetail(15), MfgSalesOrdersList(2), SalesOrderNew(4), SalesOrderDetail(11).
  Exact message text + control flow preserved; handlers/onClick made `async` where a
  confirm gates them; hooks hoisted to component top in nested cases (Warehouse drawer,
  SalesOrderDetail PaymentsPanel, line-row delete buttons). `window.prompt` (PI/PR
  detail payment + credit-note ref) left as-is — no Houzs equivalent yet. Backend
  typecheck + frontend build both EXIT 0; final `window.confirm|window.alert` grep in
  `pages/scm` = 0 executable calls (8 remaining matches are descriptive comments,
  refreshed to say "in-app, never window.confirm/alert"). No DB / backend touched.
- **2026-06-18 — DO + SI + DR slice DONE (#66, order-to-cash downstream):**
  verbatim clone of 2990s `delivery-orders-mfg.ts` + `sales-invoices.ts` +
  `delivery-returns.ts`. Tables `delivery_orders`/`_items`/`_payments` +
  `sales_invoices`/`_items`/`_payments` + `delivery_returns`/`_items` (8 tables,
  BARE names — Houzs has none; the bare `/api/delivery` is the AutoCount logistics
  route, untouched). Enums `do_status` / `sales_invoice_status` /
  `delivery_return_status` (EXACTLY 2990s's names + values). Migration
  `0030_delivery_billing.sql` (runner-safe: single-line enum DO-guards, idempotent,
  no BEGIN/COMMIT). Routes `/api/mfg-delivery-orders` + `/api/sales-invoices` +
  `/api/delivery-returns` (mounted in index.ts, owner-only `"*"`). Lib
  `so-downstream.ts` (SO↔DO/SI/DR aggregates) + `so-delivery-sync.ts` COMPLETED
  (was a stub). Pages DeliveryOrdersList/FromSo/Detail + SalesInvoicesList/FromDo/
  Detail + DeliveryReturnsList/FromDo/Detail + `delivery-billing-queries.ts` in
  `pages/scm/`; App.tsx routes (`/delivery-orders[/from-so|/:id]`, `/sales-invoices
  [/from-do|/:id]`, `/delivery-returns[/from-do|/:id]`, all `<Guard perm="*">`,
  static /from-* before /:id); nav "Delivery Orders" (Truck) + "Sales Invoices"
  (Receipt) + "Delivery Returns" (Undo2) under Supply Chain (sales side, after SO).
  **NOTE: the schema column set was rebuilt from the LIVE 2990s ROUTE field-set
  (migrations 0100/0101/0102/0165 folded in) — packages/db/src/schema.ts is the
  PRE-rebuild version (driver/m3 only) and is NOT the source of truth for these
  tables; the routes are (the documented "ledger ≠ schema.ts" gap).** Both gates
  EXIT 0; `window.confirm|window.alert|window.prompt` grep in the new pages = 0.
  - **DO → inventory (the headline):** DO create / from-sos / status-to-shipped =
    ship stock OUT via `writeMovements(db, … source_doc_type:'DO', qty shipped,
    warehouse per SO line)` → `restampDoActualCost` (line cost ← real booked FIFO
    cost) → `recomputeSoStockAllocation` → `syncSoDeliveredFromDo` (SO advances to
    DELIVERED on full coverage). A line edit/add/delete on a SHIPPED DO writes
    DELTA movements (`resyncInventoryForDo`). Cancel → positive ADJUSTMENT per
    bucket (`reverseInventoryForDo`, idempotent) + SO releases DELIVERED→READY.
    Line-level partial delivery (`soDeliverableRemaining` = qty − delivered +
    returned, same-customer + over-remaining + race guards). Per-line warehouse =
    the SO line's warehouse (stock never crosses warehouses).
  - **DR → inventory:** DR create / from-dos = return stock IN via `writeMovements
    (… source_doc_type:'DR', movement_type:'IN', unit cost from the line)`, per-line
    warehouse traced do_item→so_item→warehouse. Line edit/delete/cancel → one signed
    ADJUSTMENT delta per bucket (`resyncInventoryForReturn`, CANCELLED target = net
    0; the three rollback paths share one code path). Every DR mutation re-walks SO
    allocation + `reopenSoFromReturn` (DELIVERED→READY_TO_SHIP). "No DO, no return"
    + service-lines-not-returnable + over-return + race guards ported.
  - **SI = AR finance doc, NO stock impact** (inventory landed at DO ship). POST /
    from-dos create SENT; payment ledger rolls SENT→PARTIALLY_PAID→PAID
    (`recomputePaid`); cancel releases the qty to the invoiceable pool; reopen
    (CANCELLED→SENT) re-validates the pool. Line-level partial invoice
    (`doLineRemaining` = delivered − invoiced − returned).
  - **SO route un-stubbed (the deferred hooks):** (a) `soHasDownstream` now queries
    delivery_orders/sales_invoices by so_doc_no (child-lock engages); (b) list
    aggregates `has_children` / `delivery_state` (none/partial/full) / `lifecycle_state`
    (latest-event-wins) / `current_doc_no` (furthest-forward doc) / `has_undelivered`
    now computed via lib/so-downstream (were hardcoded empties); (c) detail
    aggregates + per-line `deliveries`/`delivered_qty`/`remaining_qty` now live; (d)
    `syncSoDeliveredFromDo` async reconcile fully ported (delivered/returned netting
    + bidirectional DELIVERED↔READY_TO_SHIP + line READY flip + dual audit write).
  - **SEAM/deviations (documented in files):** created_by / salesperson_id /
    collected_by → users.id INTEGER soft-ref (rule #4); so_doc_no → real FK
    mfg_sales_orders(doc_no); delivery_order_id / so_item_id / do_item_id /
    sales_invoice_id → real FKs; warehouse_id → mfg_warehouses(id) (SET NULL);
    driver_id / venue_id → nullable columns, FK DROPPED (no drivers/venues master).
    Dropped per Strategy-2: catalog itemCode guard (validateItemCodes), soft
    stock-availability check + confirmShortStock gate, ALL sofa guards
    (findSofaLinesWithoutCompleteBatch / findIncompleteSofaSets / loadSofaBatchStock)
    + the sofa dye-lot batch (allocated_batch_no) on movements, buildVariantSummary
    (description2 passes through). **GL/AR posting OUT OF SCOPE (Houzs GL differs):**
    2990s's `postSiRevenue`/`reverseSiRevenue`/`resyncSiRevenue` (journal_entries) +
    customer-credits (apply-on-create / cancel-with-payment / overpay reconcile)
    dropped with a `// TODO` at each site; the SI returns `revenue:{posted:false,
    status:"out_of_scope"}` and customer_credit_centi:0. `restampDoActualCost` KEPT
    (generic — real FIFO cost, no sofa-batch dimension). Pages use plain inline
    RM↔centi editors + `<table>` + Suppliers/PurchaseOrderDetail CSS modules
    (DataGrid + configurator + jsPDF print dropped); in-app useDialog/useToast (rule
    #10), never window.confirm/alert/prompt.
  - **DEFERRED:** MRP coverage on the SO detail per-line (`coverage_po`/`coverage_eta`
    → null, MRP slice #64 not cloned). Manual blank-DO/SI/DR create-from-scratch
    forms (the convert-from picker is the primary path, matching 2990s). Migration
    `0030` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — CONSIGNMENT slice (#67) — schema+migration (ALL) + PURCHASE side
  DONE; SALES side DEFERRED.** The last document-flow group. 14 consignment tables
  + the CO audit log appended to `schema.pg.ts` (BARE names — Houzs has none);
  migration `0031_consignment.sql` (runner-safe: 6 single-line enum DO-guards, 15
  idempotent CREATE TABLE, no BEGIN/COMMIT). Both gates EXIT 0; `window.confirm|
  alert` grep in the new pages = 0 (one `window.prompt` for the CN credit-note ref,
  kept exactly as the PI/PR slices per rule #10). Migration NOT applied (batched #70).
  - **Enums created (6):** `consignment_so_status` (CO, CONFIRMED..CANCELLED),
    `consignment_do_status` (CN, LOADED..CANCELLED), `consignment_dr_status` (CR,
    PENDING..CANCELLED), `purchase_consignment_order_status` (PCO, SUBMITTED..
    CANCELLED), `purchase_consignment_receive_status` (PCR, POSTED/CLOSED/CANCELLED),
    `purchase_consignment_return_status` (PCT, POSTED/COMPLETED/CANCELLED).
  - **Tables (14 + 1):** SALES — `consignment_sales_orders`/`_items`/`_payments`
    (clone mfg_sales_orders) + `consignment_so_audit_log` (clone mfg_so_audit_log,
    FK → CO so CS- doc numbers don't collide with mfg_sales_orders) +
    `consignment_delivery_orders`/`_items`/`_payments` (Consignment Note, clone
    delivery_orders) + `consignment_delivery_returns`/`_items` (Consignment Return,
    clone delivery_returns). PURCHASE — `purchase_consignment_orders`/`_items`
    (clone mfg_purchase_orders) + `purchase_consignment_receives`/`_items` (clone
    grns) + `purchase_consignment_returns`/`_items` (clone purchase_returns).
  - **schema.ts-vs-route STALENESS (confirmed + cloned the routes):** 2990s's
    `packages/db/src/schema.ts` has essentially NO consignment tables — only comment
    lines (the documented "ledger != schema.ts" gap, same as DO/SI/DR). EVERY column
    set below was reconstructed from the LIVE ROUTES (consignment-*.ts +
    purchase-consignment-*.ts; migrations 0153/0154/0056/0057 folded in). The routes
    are the source of truth; cloned what's live.
  - **PURCHASE-consignment DONE (routes + pages):** routes
    `purchase-consignment-orders.ts` (clone mfg-purchase-orders), `…receives.ts`
    (clone grns), `…returns.ts` (clone purchase-returns) — full PostgREST→Drizzle
    translation, mounted `/api/purchase-consignment-orders|receives|returns`
    (owner-only `"*"`). Pages in `pages/scm/`: PurchaseConsignmentOrders/OrderNew/
    OrderDetail, PurchaseConsignmentReceives/ReceiveFromOrder/ReceiveNew/
    ReceiveDetail, PurchaseConsignmentReturns/ReturnFromReceive/ReturnNew/
    ReturnDetail + query hooks `consignment-purchase-queries.ts` (+ reused supplier/
    warehouse option hooks). App.tsx routes (static /new + /from-* before /:id) +
    Sidebar "PC Orders/Receives/Returns" (Handshake) under Supply Chain.
  - **Consignment → inventory wiring (the headline, via lib/inventory-movements):**
    PC Receive POST/from-pcos/line-CRUD → `resyncReceiveInventory` (self-healing
    delta-reconcile, mirrors DO's resyncInventoryForDo): first IN per product::variant
    bucket = `writeMovements(… source_doc_type:'PC_RECEIVE', batch_no=source PCO no,
    warehouse=header)`; later increase / decrease / cancel → `'STOCK_TRANSFER'` IN/OUT
    deltas driving the net to target (cancel → net 0). PC Return POST/from-pc-
    receive(s)/line-CRUD → `resyncPcReturnInventory` (OUT-primary): first OUT per
    bucket = `source_doc_type:'PC_RETURN'` (per-line warehouse traced
    receive_item→receive, dye-lot via resolveWarehouseLotBatches); deltas/cancel →
    `'STOCK_TRANSFER'` (cancel → IN gives stock back). PC Order writes NO inventory
    (order only). Rollups: PC Receive recounts `purchase_consignment_order_items
    .received_qty` (net of returned) + re-evaluates PCO status (SUBMITTED→PARTIALLY_
    RECEIVED→RECEIVED); PC Return recounts `purchase_consignment_receive_items
    .returned_qty` (clamped to accepted) + nets the PCO back down. `recomputeSo
    StockAllocation` fired after every consignment stock move (SO readiness re-walk).
  - **SEAM/deviations (documented in schema.pg.ts + the route headers):** created_by /
    salesperson_id / collected_by / actor_id → users.id INTEGER soft-ref (rule #4);
    customer_id → FK customers(id); supplier_id → FK suppliers(id); warehouse_id /
    purchase_location_id → FK mfg_warehouses(id) (SET NULL); consignment_so_doc_no →
    FK consignment_sales_orders(doc_no); all intra-consignment parent links → real
    FKs; rack_id → FK warehouse_racks(id); venue_id / hub_id / customer_po_id /
    driver_id → nullable, FK DROPPED (no masters); money kept centi. Strategy-2:
    DROPPED `buildVariantSummary` (description2 passes through), variant columns
    persisted for fidelity; no `validateItemCodes`/mfg_products catalog lookups; pages
    use plain-text manual lines + the convert-from pickers (no furniture variant
    editor); in-app useDialog/useToast (rule #10). GL/accounting OUT OF SCOPE (no
    2990s consignment route posts to a GL — nothing to stub).
  - **DEFERRED (follow-up agent — a clean continuation point):** the SALES-consignment
    routes + pages — `consignment-notes.ts` (Consignment Note, clone delivery-orders-
    mfg; CS_DO ship-out OUT + CS_DR-on-cancel via resyncNoteInventory),
    `consignment-returns.ts` (Consignment Return, CS_DR IN), and `consignment-orders.ts`
    (CO upstream order — the most furniture-coupled; clone mfg-sales-orders with the
    ENTIRE pricing engine stripped per Strategy-2, like the SO slice; uses the cloned
    `consignment_so_audit_log` + `recordSoAudit`-style audit). The TABLES for all of
    these are ALREADY created (migration `0031`), so the follow-up is routes+pages
    only. ~20 sales-side pages (Consignment Orders/Notes/Returns lists + details +
    From-pickers). Both verify gates must stay EXIT 0.
- **2026-06-18 — CONSIGNMENT slice (#67) — SALES side DONE → #67 COMPLETE.** The
  deferred sales-consignment routes + pages are now built; the whole consignment
  group (purchase + sales) is finished. **NO migration needed** — every column the
  routes touch already exists in `0031`/`schema.pg.ts` (verified field-by-field);
  no `0032`. Both gates EXIT 0; `window.confirm|alert|prompt` grep in the new
  `pages/scm/Consignment*.tsx` = 0. Nothing applied to any DB (batched for #70).
  - **Routes (3, PostGREST→Drizzle, mounted owner-only `"*"`):**
    `consignment-orders.ts` → `/api/consignment-orders` (clone mfg-sales-orders,
    Strategy-2 pricing-engine-stripped); `consignment-notes.ts` →
    `/api/consignment-notes` (clone delivery-orders-mfg); `consignment-returns.ts`
    → `/api/consignment-returns` (clone delivery-returns). All three mounted in
    index.ts after the PC block.
  - **CO (Consignment Order) — NO stock.** Generic line model
    (item_group/code/qty/unit_price/discount, plain text — the SAME stripping the
    SO slice did: no recomputeFromSnapshot / sofa-combo / fabric-tier / variant
    pricing / allowed-options / validateItemCodes / customer-resolve RPC / state
    derive / R2 photos). Variant cols KEPT nullable, passed through; description2 =
    client value (buildVariantSummary dropped). Audit → `consignment_so_audit_log`
    via a route-local `recordCoAudit` (mirror of lib/so-audit, FK so_doc_no → CO).
    Endpoints ported: list (+item_categories/has_children/payment_methods_summary
    aggregates), `/mine`, `/debtors/search`, detail (+per-line `deliveries`),
    create (CONFIRMED), `/status`, `/audit-log`, header PATCH (partial IDENTITY
    lock once a Note exists), line CRUD, `/items/:id/override`, payments ledger.
    doc_no = CS-YYMM-NNN (max+1). Dropped vs source: PWP/free-gift, the per-line R2
    photo upload/proxy/sign endpoints (no SO_ITEM_PHOTOS binding), cross-category
    delivery-fee, allowed-options. coHasDownstream queries
    `consignment_delivery_orders` by consignment_so_doc_no (the CO's real downstream).
  - **CN (Consignment Note) → inventory OUT (the headline).** UNIFIED model: a Note
    ships goods OUT (FIFO consumed, COGS leaves) via one self-healing
    `resyncNoteInventory` (translated from the 2990s source; mirrors DO
    resyncInventoryForDo + the PC-Receive resync) — first OUT per
    warehouse/product/variant/batch bucket = `writeMovements(… source_doc_type:
    'CS_DO', batch_no from resolveWarehouseLotBatches)`, later increase/decrease =
    `'STOCK_TRANSFER'` OUT/IN deltas, cancel → status CANCELLED → net driven back to
    0 via IN. Fires on create / status→shipped (DISPATCHED..INVOICED) / line CRUD /
    cancel; per-line ship-from warehouse = the linked CO line's warehouse → header →
    default. `recomputeSoStockAllocation` after every move. Status starts DISPATCHED
    on create. From-order picker (`/from-orders`, outstanding = ordered − delivered,
    one-customer) + manual create. doc_no = CN-YYMM-NNN. Child-lock vs a
    non-cancelled Consignment Return. Payments ledger ported. DROPPED the SO-remaining
    over-pick guard + short-stock/sofa guards (a loaner ships what's on the shelf).
  - **CR (Consignment Return) → inventory IN.** Goods back via one IN-primary
    `resyncReturnInventory` (mirror of the DR resync) — first IN per bucket =
    `source_doc_type:'CS_DR'` (cost = line snapshot, else on-hand avg via
    resolveWarehouseLotCosts so no 0-cost lot), deltas/cancel = `'STOCK_TRANSFER'`
    (cancel → OUT removes the returned stock). "No DO, no return" is RELAXED per the
    2990s source — lines may reference a CN line OR be free-entry. Status starts
    RECEIVED; lifecycle RECEIVED→INSPECTED→REFUNDED/CREDIT_NOTED/REJECTED + Cancel;
    terminal states (CANCELLED/REFUNDED/CREDIT_NOTED) lock line edits. From-note
    picker (`/from-notes`, remaining = delivered − returned) + manual create.
    doc_no = CR-YYMM-NNN. recomputeSoStockAllocation after every move.
  - **Pages (11 + query hooks) in `pages/scm/`:** ConsignmentOrders/OrderNew/
    OrderDetail, ConsignmentNotes/NoteFromOrder/NoteNew/NoteDetail, ConsignmentReturns/
    ReturnFromNote/ReturnNew/ReturnDetail + `consignment-sales-queries.ts` (Houzs api
    client + react-query, wire shapes match the routes). Strategy-2: plain `<table>` +
    Suppliers/PurchaseOrderDetail CSS modules (DataGrid + furniture configurator
    dropped); inline RM↔centi editor; in-app useDialog/useToast (rule #10), never
    window.*. App.tsx routes (static /new + /from-* before /:id|/:docNo, all
    `<Guard perm="*">`); Sidebar "Consignment Orders/Notes/Returns" (Handshake) under
    Supply Chain after the PC entries.
  - **SEAMS/deviations:** created_by/salesperson_id/collected_by/actor_id → users.id
    INTEGER soft-ref (rule #4); CN/CR per-line warehouse traced via the cloned
    consignment_* FKs; inventory via lib/inventory-movements (CS_DO/CS_DR already in
    the MovementInput union from 0026). GL/accounting OUT OF SCOPE (no 2990s
    consignment route posts to a GL — nothing to stub). `inventory-movements.ts`
    `source_doc_type:'CONSIGNMENT_NOTE'` JSDoc comment still references
    schema.pg.ts:1357 — informational only, the actual writes use CS_DO/CS_DR.
  - Migration: NONE (no `0032`). Nothing applied to any DB (batched for staging #70).
- **2026-06-18 — MRP · Stock Status slice DONE (#64):** verbatim clone of 2990s
  `mrp.ts` (the PURE CALCULATOR) + `mrp-lead-times.ts`. Migration `0032_mrp_lead_times.sql`
  (the ONE persisted MRP table `mrp_category_lead_times`, BARE name, clone of 2990s
  migration 0099; runner-safe: idempotent CREATE + 5 single-line seed INSERTs ON
  CONFLICT DO NOTHING, no BEGIN/COMMIT, RLS policies dropped). Table added to
  `schema.pg.ts` (`mrpCategoryLeadTimes`). Routes `/api/mrp` (pure read) +
  `/api/mrp-lead-times` (GET map + PUT upsert) mounted in index.ts, owner-only `"*"`.
  Page `pages/scm/Mrp.tsx` + `Mrp.module.css` (copied VERBATIM) + query hooks
  `mrp-queries.ts`; App.tsx route `/mrp` (`<Guard perm="*">`); nav "MRP · Stock
  Status" (Gauge) after Sales Orders under Supply Chain. Both gates EXIT 0;
  `window.confirm|alert|prompt` grep in the new page = 0.
  - **Demand/supply sources wired (faithful):** DEMAND = open `mfg_sales_order_items`
    (joined `mfg_sales_orders`, `cancelled=false`, header status NOT
    DELIVERED/INVOICED/CLOSED/CANCELLED, qty>0, has a delivery date unless
    `includeUndated`) MINUS delivered-net-of-returns via the SHARED
    `soDeliverableRemaining` (imported from `routes/delivery-orders-mfg`, the same
    helper the DO convert flow uses — MRP can never disagree with SO remaining).
    SUPPLY = on-hand from the `inventory_balances` VIEW (read via raw `sql`, same
    as routes/inventory.ts — it's a view, not a Drizzle table) + open
    `mfg_purchase_order_items` (joined `mfg_purchase_orders`, status ≠ CANCELLED,
    `qty − received_qty > 0`, ETA = line delivery_date ?? po.expected_at).
    Greedy allocation by delivery date per (warehouse_id, product_code, variant_key)
    bucket — stock first, then earliest-ETA PO, leftover = shortage; legacy
    empty-variant PO pool folded in. Per-SKU suppliers from
    `supplier_material_bindings` (`material_kind='mfg_product'`, main-first). Lead
    times from `mrp_category_lead_times` → order-by date = delivery − lead_days.
    PURE read — NO writes (matches 2990s "先做即时计算").
  - **FURNITURE MRP grouping DROPPED (Strategy-2):** the four CATEGORY TABS
    (Sofa/Bedframe/Mattress/Accessories), the entire sofa SETS engine (2990s route
    section 8 + page `sofaSetsToSkus`/`groupBySo`/`sofaComposition`/`SofaSoTable`,
    sofa colour-match / module-cells / `splitSofaCode`), the bedframe-flat variant
    flatten (`groupByVariant`), `buildVariantSummary` (→ `formatVariantKey`, the
    generic Houzs label), `isServiceLine` (no item-group taxonomy on Houzs lines),
    and the mfg_products category/name lookup (Houzs has NO product catalogue — the
    category + name come from the SO line's own item_group via `catFromGroup` +
    description, the SAME fallback 2990s uses for un-catalogued codes). The page is
    ONE generic flat list grouped by `groupByModel` ((warehouse, item_code) →
    variant sub-rows → SO orders). `sofaSets` is returned `[]` for wire compat.
    Reason: Houzs is not the 2990s furniture business; the sofa/bedframe tuning is
    dead weight. The demand-vs-supply-vs-shortage CORE + greedy allocation are
    verbatim. Also dropped the admin "Re-bind WH" backfill (no
    state_warehouse_mappings flow on Houzs).
  - **SO route un-stubbed:** N/A — the SO-detail per-line MRP coverage
    (`coverage_po`/`coverage_eta`, the deferral the SO slice flagged for #64) is
    left as a faithful empty for now; the shared `computeMrp` + `mrpLineCoverage`
    helpers ARE exported from `routes/mrp.ts` so a follow-up can wire SalesOrderDetail
    to stamp each line from the SAME allocation (one source of truth). No SO-detail
    UI change was in scope for this slice.
  - **SEAMS/deviations (documented in files):** Supabase PostgREST → Drizzle
    (rule #3); supabaseAuth → requirePermission("*") (rule #4); `inventory_balances`
    via raw `sql` (view); `db.execute<T>` returns the row array directly (project
    convention, same as inventory.ts). `mrp_category_lead_times.updated_at` kept
    timestamptz (config table, written via Drizzle ISO not raw datetime('now') →
    not the mig-0008 text-col gotcha). In-app useDialog/useToast (rule #10): the
    Proceed-PO result/error/created surfaces via toast + a dialog.confirm "Open
    Purchase Orders" navigate offer; the optional Expected-Delivery confirm step
    kept as the in-page `.dialog*` form (verbatim 2990s, the CSS supports a date
    input — `useDialog.prompt` has no date type), never window.confirm/alert.
  - **TODO / needs review:** the page's **Proceed PO** posts to
    `/api/purchase-orders/from-sos` (the SAME target 2990s uses), but that endpoint
    is STILL a guarded 409 stub on the Houzs PO route ("Convert-from-Sales-Order is
    available after the Sales Orders slice lands" — never un-stubbed even though SO
    landed). So Proceed PO currently surfaces that guarded message in a toast rather
    than creating POs. Wiring the real `/from-sos` write path (the ~230-line 2990s
    handler: resolve picks → per-line warehouse/delivery-date → group by
    (warehouse, supplier) / per-SO → insert PO + items + recount, with `fromMrp`
    bypassing the qty cap) is a separate PO-route follow-up, intentionally NOT
    pulled into this read-only MRP slice. The MRP read engine + lead-times are
    fully functional independent of it.
  - Migration `0032` NOT applied to any DB (batched for staging at #70).
- **2026-06-18 — PRODUCTS & MAINTENANCE slice DONE (#58):** the BIGGEST slice and
  the ONE exception to Strategy-2 — the owner wants the FULL furniture catalogue
  + pricing engine cloned ("全部搬,办完了我再修改"), so it is NOT stripped here.
  Migration `0033_products_maintenance.sql` (27 tables, 7 enums, all BARE names —
  no Houzs collision). Schema appended to `schema.pg.ts` (camelCase keys + explicit
  snake_case cols, rule #2). 11 routes mounted owner-only (`"*"`): `/api/products`
  `/api/categories` `/api/product-models` `/api/mfg-products` `/api/maintenance-config`
  `/api/fabric-tracking` `/api/fabric-library` `/api/fabric-tier-addon` `/api/pwp-codes`
  `/api/pwp-rules` `/api/sofa-combos`. Pages in `pages/scm/`: Products (SKU Master),
  ProductModels + ProductModelDetail, FabricTracking (Fabric Converter), Maintenance
  (config hub) + `products-queries.ts`; the 4 `.module.css` brought VERBATIM (rule #6).
  App.tsx routes (`/products`, `/product-models[/:id]`, `/fabric-converter`,
  `/maintenance`, all `<Guard perm="*">`); Sidebar "SKU Master / Product Models /
  Fabric Converter / Maintenance" under Supply Chain. **Both gates EXIT 0; window.*
  grep on the 5 new pages = 0.**
  - **Migration 0033 tables (27):** library — `categories`, `series`,
    `compartment_library`, `bundle_library`, `size_library`; retail catalogue —
    `products` + `product_size_variants`/`_compartments`/`_bundles`,
    `fabric_library`, `fabric_colours`, `product_fabrics`, `fabric_tier_addon_config`
    (seeded id=1), `bedframe_colours`, `product_bedframe_colours`, `bedframe_options`,
    `addons`, `special_addons`; mfg/pricing — `product_models`, `mfg_products`,
    `product_dept_configs`, `master_price_history`, `sofa_combo_pricing`, `pwp_rules`,
    `pwp_codes`, `fabrics`, `fabric_trackings`, `maintenance_config_history`,
    `model_special_delivery_fees`, `model_fabric_tier_overrides`,
    `model_default_free_gifts`, `sofa_quick_picks`. **Enums (7):** `pricing_kind`,
    `comp_group`, `mfg_product_category`, `mfg_product_status`, `fabric_category`,
    `fabric_price_tier`, `addon_kind`.
  - **Shared furniture-pricing packages PORTED (9, into Houzs `shared/`):**
    `sofa-combo-pricing`, `maintenance-pools`, `mfg-pricing`, `sofa-tier`, `sofa-build`
    (1666 lines), `fabric-tier-addon`, `variant-summary`, `free-gift`, `schemas/product`
    (the zod product schema — the `@shared` zod-alias resolves it, rule #8). Copied
    VERBATIM ("直接 copy paste"); added to the `shared/index.ts` barrel. ONE seam fix:
    `sofa-build.ts:cellEdges` widened a tuple-typed local to `EdgeType[] | undefined`
    for Houzs's stricter `noUncheckedIndexedAccess` (2990s's tsconfig didn't flag it).
    Reused the already-ported `variant-key`.
  - **schema.ts-vs-route STALENESS found:** (a) `mfgProducts.fabricUsage` etc are
    present but PR #104 dropped them from the live route SELECT — kept the columns
    for fidelity (the owner reconciles later). (b) `product-models.ts:409` queries a
    table named `maintenance_config` which DOES NOT EXIST (the canonical table is
    `maintenance_config_history`, 12 route call-sites + the 2990s migration 0039
    CREATE); it's a 2990s route bug wrapped in a try/catch that falls back to static
    SIZE_INFO — the Houzs clone reads the canonical `maintenance_config_history`.
  - **SEAMS/deviations (NOT furniture-stripping — this slice keeps it all):**
    PostgREST→Drizzle (rule #3); supabaseAuth + per-route staff-role gates
    (EDIT_ROLES/CREATE_ROLES/WRITE_ROLES) → the module's owner-only `requirePermission("*")`
    mount (rule #4); ALL staff.id (uuid) refs (created_by / updated_by / changed_by /
    owner_staff_id) → users.id INTEGER soft-refs (rule #4); customer_id → FK
    customers(id), supplier_id → FK suppliers(id) (cloned in 0024/0029); product_models
    ↔ mfg_products intra-refs are real FKs; money kept verbatim (retail = whole-MYR
    integer, mfg = *_centi/*_sen). `products` POST = the `create_product_with_pricing`
    RPC translated to a Drizzle transaction (insert product + per-pricing-kind rows);
    `mfg-products` activate-one-shot uses the same db handle (no service-role client);
    sku-usage guard ported to Drizzle (PO line check uses `material_code` — Houzs's
    cloned mfg_purchase_order_items has no `item_code` col, the supplier-binding
    vocabulary). `lib/mfg-pricing-recompute.ts` ports ONLY `loadModelSofaModuleCosts`
    (combo COST auto-detect); the full 2990s re-cost chain is out of scope.
  - **DROPPED (R2 / SECURITY DEFINER not wired this slice — return 501 not_configured,
    documented in-file):** category hero-image upload (PUBLIC_ASSETS bucket),
    product-model photo proxy/upload/delete (SO_ITEM_PHOTOS bucket), maintenance-config
    `/sofa-compartments/rename` cascade (rename_sofa_compartment SECURITY DEFINER fn).
    The DELETE-photo endpoints still null the column.
  - **DEFERRED (follow-up — pages are functional Houzs-native rebuilds, not 8000-line
    verbatim ports):** the 2990s pages (Products 4777 / ProductModels 2176 /
    ProductModelDetail 1331) are deeply POS-coupled (supabase client, @2990s/design-
    system, useAuth, jspdf, the sofa configurator). The Houzs pages cover the core:
    SKU Master (list + inline price/status edit + create + price history + delete),
    Models (list + create + detail with allowed-options sizes/compartments editor +
    Generate SKUs + SKU list), Fabric Converter (list + create + tier-cycle + inline
    edits + active + delete), Maintenance (fabric-tier deltas editor + categories +
    PWP rules + sofa-combo summary). The advanced editors — full sofa-combo BUILDER UI,
    the effective-dated maintenance_config blob editor, per-SKU variant drawer, CSV
    export/import (the `/bulk-upsert` + `/batch-import` ROUTES are cloned), R2 photo
    uploader, the SalesOrderMaintenance + Addons pages — are the documented next step.
    Backend is COMPLETE (all 11 routes + the pricing engine compile + are mounted).
  - Migration `0033` NOT applied to any DB (batched for staging at #70).
