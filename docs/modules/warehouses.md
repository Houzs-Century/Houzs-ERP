> ## Corrections — 2026-08-12 code-read sweep
>
> 1. The schema DOES enforce type↔is_showroom one-way: trigger trg_warehouse_sync_is_showroom (mig 0186, absent from this guide) overwrites is_showroom from type — a raw UPDATE of is_showroom alone is silently reverted.
> 2. SalesOrderMaintenance.tsx:38-41 dropped useCreateWarehouse/useUpdateWarehouse — that view only READS.
> 3. The type enum shipped in 0177_scm_warehouse_type_and_unify.sql, not “mig 0171” (0171 is idempotency; the file's internal header was never renumbered).
> 4. The OR-include at inventory.ts:357-359 reads is_consignment, not is_showroom.
> 5. POST/PATCH also accept country/state/postcode/city (mig 0180); 0180 + 0186 missing from the migration table. Racks, state-warehouse-mappings, warehouse-label and WH_NONE are undocumented here (coverage gap). — *warehouse-label CLOSED 2026-08-21: see §1, "The display rule has a FRONTEND home now". The other three remain open.*

# Module: Warehouses (SCM master)

Per-module technical doc for `scm.warehouses` — the master list of physical
stock locations. Small table, but load-bearing: every stock movement / DO / GRN
/ SO reserve / inventory balance / venue resolve reads from it.

> **Naming (vocabulary registry).** The building an order ships from is
> `warehouse_id` (uuid -> `scm.warehouses`), per line; its one display rule is
> `warehouse-label.ts` (code first, then name). It is declared in
> `backend/scripts/lib/vocabulary.mjs`. The SO header still keeps a free-text
> snapshot `sales_location`; unifying that onto `warehouse_id` is a STAGED backfill
> migration (it lands on `scm.mfg_sales_orders` and its grant-bearing
> `mfg_sales_orders_with_payment_totals` view — the 0189 hazard), not yet shipped.
> `purchase_location_id` (PO header) and `showroom_warehouse_id` are separate
> columns, not drift.

> Convention: money in **sen**, dates UTC. Reads/writes via `/api/scm/*`.
>
> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

---

## 1. Frontend

| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/Warehouses.tsx` | DataGrid, per-column filter + sort. Type column + label at `:22-33`. |
| Shared edit drawer | `frontend/src/vendor/scm/components/WarehouseFormDrawer.tsx` | Type dropdown replaces the old "Mark as Showroom" checkbox (mig 0177). |
| Master admin (inline) | `frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx` | Legacy inline table — also uses `useCreateWarehouse` / `useUpdateWarehouse`. |
| Query hook | `frontend/src/vendor/scm/lib/inventory-queries.ts` | `useWarehouses({ includeInactive })`, staleTime 5 min. `Warehouse` + `WarehouseType`. |

`useWarehouses()` is the single read hook every consumer (PO, DO, GRN, SO,
Inventory board, Racks) reaches through. Do not open a per-page fetch — the
5-min staleness is intentional and shared.

### The display rule has a FRONTEND home now (2026-08-21)

`warehouseLabel` — **code first, then name**, trimmed, `null` when neither is
set — used to exist only at `backend/src/scm/lib/warehouse-label.ts`, and the
frontend cannot import from `backend/src`. So every frontend surface that showed
a warehouse hand-wrote its own order and they drifted in both directions: the
Purchase Orders list printed the NAME and the grid truncated it to
`BALAKONG WAREHO…`, while the same page's PDF export printed the code.

| | |
|---|---|
| the rule | `backend/src/scm/lib/warehouse-label.ts` |
| the frontend MIRROR | `frontend/src/vendor/scm/lib/warehouse-label.ts` — **byte-identical**, and it must stay at the top level of `vendor/scm/lib` |
| the referee | `frontend/src/vendor/scm/lib/warehouse-label.canonical.test.ts` (byte-identity + the order + a corpus pin) and `node backend/scripts/check-shared-mirrors.mjs --strict`, which already enumerates that exact directory pair |

**Import it; do not spell it.** The corpus pin in that test fails by NAMING any
file under `frontend/src` that re-grows a private `?.name || ?.code` warehouse
fallback, so a new screen cannot quietly add the fifteenth copy. Where a row
carries the warehouse as FLAT snapshot columns instead of a nested object
(`warehouse_code` / `warehouse_name`, `warehouseLocationCode` /
`warehouseLocationName`), wrap the two into the rule with a one-line local
adapter — `GrnFromPo.tsx` is the worked example — rather than writing a second
rule.

Two sites are deliberately still private copies. Both are already code-first, so
both render correctly:

- `pages/scm-v2/SalesOrderDetail.tsx` resolves a venue's warehouse by hand. It is
  the corpus test's shrink-only `PENDING` entry — converting it makes the test
  fail until the entry is deleted.
- `pages/scm-v2/Inventory.tsx`, three cells over the flat columns. Converting it
  needs an adapter, and that file is AT its file-size ceiling, which
  `npm run check:file-size` will not let a change grow. Do it when that file is
  next split.

---

## 2. Schema (`scm.warehouses`)

Row per (company, code). Baseline table in `0000_baseline.sql`; grown through
these migrations:

| Migration | What it added |
|-----------|--------------|
| `0086_warehouses_company_id.sql` | `company_id bigint` + backfilled to HOUZS; per-company index. |
| `0087_master_codes_per_company.sql` | UNIQUE `(company_id, code)` (replaced `code`-unique). |
| `0148_venue_binding.sql` | `is_showroom bool NOT NULL DEFAULT false` + `venue_name text`. |
| `0177_scm_warehouse_type_and_unify.sql` | `scm.warehouse_type` enum + `type` column (NOT NULL); 2990 renames; cross-company copies for warehouse + service types. |
| `0186_warehouse_is_showroom_sync.sql` | one-time reconcile + `trg_warehouse_sync_is_showroom` — a BEFORE INSERT OR UPDATE OF `type`, `is_showroom` trigger that sets `is_showroom := COALESCE(type = 'showroom', false)` on every write. 0177 backfilled once in one direction and added no trigger, so a warehouse typed 'showroom' through the new drawer kept `is_showroom=false` — that is why 2990's "PJ SHOWROOM" was missing from the venue picker. |

### Type enum (mig 0177)

`scm.warehouse_type` has FIVE values:

| Type | Meaning | Cross-company sharing |
|------|---------|-----------------------|
| `warehouse` | Pure stock (KL, PG, SBH, SRW, CHINA) | **Both companies** — this is a fleet-shared type. |
| `showroom` | Sales point that also feeds the venue list. `is_showroom = true` invariant. | Company-specific — HOUZS: Kelana.J, Sunway. 2990: PJ. |
| `display` | Display stock at a partner site; must NOT net into sellable inventory. | HOUZS-only (C&C, EM, KL, PG, SBH). |
| `service` | Repair / customer-service centre. | **Both companies** — KL SERVICE, PG SERVICE. |
| `others` | HQ, C&C K.J, any site that doesn't fit. | HOUZS-only. |

`is_showroom` is kept for backward compatibility (venue-binding resolver +
Members-page staff parking + `inventory.ts`'s OR-include). Since mig 0186
**`type` is canonical and `is_showroom` is DERIVED from it by a database
trigger** — `trg_warehouse_sync_is_showroom` overwrites `is_showroom` with
`(type = 'showroom')` on every insert and on every update touching either
column. The routes still compute the pair themselves (POST `inventory.ts:150-151`,
PATCH `:267-271`), but the trigger has the last word: a create sent as
`{ type: 'display', isShowroom: true }` lands `is_showroom=false`, not the
`true` the route computed.

---

## 3. Backend routes (`/inventory/warehouses`)

Owned by `backend/src/scm/routes/inventory.ts`:

- `GET /inventory/valuation?asOf=YYYY-MM-DD` — the as-of photograph (GL
  redesign item 5, 2026-09-05; handler in `inventory-valuation.ts`): per-item
  qty + value replayed on the BUSINESS date (`stockBreakdownAsOf` in
  acc/stock-close.ts, the same engine the month-end close reads), joined to
  the product master. Feeds the Inventory page's 选日期 view with category
  subtotals; deliberately carries none of the live list's planning columns.
- `GET  /inventory/warehouses?includeInactive=true` — list. Company-scoped via
  `scopeToCompany(...)` (`:42-52`).
- `POST /inventory/warehouses` — create. Company required (`requireActiveCompanyId`
  refuses if unresolved — see the LEAK FIX header at `:64-69`). Accepts
  `{ code, name, location?, isActive?, isDefault?, isShowroom?, venueName?, type? }`.
  `type` defaults to `'warehouse'`, or `'showroom'` when `isShowroom=true` and
  `type` omitted (`:71-97`).
- `PATCH /inventory/warehouses/:id` — update. Same company-scope guard as POST
  (`:124-168`); demoting the previous default is scoped to this company (this
  used to be a cross-company leak — see the header at `:110-122`). `type` and
  `isShowroom` move together — send either, get both.
- `DELETE /inventory/warehouses/:id` — hard delete. Also company-scoped
  (`:184-201`). Returns `in_use` (409) on FK violation from
  `inventory_movements` / `lots` / `cogs`; UI should suggest deactivate instead.

---

## 4. Downstream reads

The Type column is not just cosmetic — several downstream code paths already
key off the older `is_showroom` flag and will migrate to `type` incrementally:

- **Venue-binding resolver** (mig 0148) reads `is_showroom = true` to feed the
  Sales Maintenance venue list. Since 0186 the trigger guarantees the flag
  tracks `type='showroom'` on every write, so these readers need no migration.
- **Members page** — staff `showroom_warehouse_id` FK; the picker filters on
  `is_showroom = true`.
- **Inventory list** (`inventory.ts:257`) OR-includes `is_consignment=true`
  rows into the balances read so consignment/showroom stock stays visible.
- **Free-to-sell** (`inventory.ts`, `deliveredReturnedBySoItem`) subtracts a
  Sales Order line's delivered qty, and only counts a DO whose status is NOT in
  `DO_NOT_DELIVERED_STATES`. **That set gained LOADED on 2026-08-20** — a
  delivery still on the lorry was taking its units OUT of Reserved before any
  stock had moved, which inflates free-to-sell towards over-sell. One predicate
  now (`doCountsAsDelivered`); the trace is in `docs/modules/delivery-order.md`
  under *"Has this delivery counted?" is ONE predicate now*.
- **FIFO lot feeds carry the consignment verdict on the ROW** (2026-08-20).
  `GET /inventory/lots/:itemCode` now stamps `is_consignment` on every lot, the
  way `GET /inventory/reservations` already did, from the one classifier
  `isConsignmentLotSource` (`scm/lib/inventory-movements.ts`) over the lot's
  `source_doc_type` / `source_doc_no`. It was the only lot feed that did not say,
  and its consumer — the desktop Stock Card — therefore valued the supplier's
  goods as ours while the per-warehouse table beneath it, fed by
  `/breakdown/:itemCode`, excluded them. Both clients now split the same feed
  through the shared `buildStockBreakdown`, so a new lot surface adds no third
  filter.

Rule of thumb when adding a new consumer: if you want "sales point", filter
`type='showroom'`; if you want "stock location", filter `type='warehouse'`; if
you want "everything selectable", filter `is_active=true` and skip type.

---

## 5. Rules that will bite you

- **`is_showroom` and `type` are ONE fact, and the SCHEMA enforces it** since
  mig 0186. Set `type`; `is_showroom` follows. A raw SQL UPDATE of `is_showroom`
  alone does NOT stick — the BEFORE trigger rewrites it from `type` — so a
  "fix" applied to the flag is silently discarded. To change whether a warehouse
  is a showroom, change `type`.
- **Company scope is on every read/write.** Any new query on `scm.warehouses`
  must go through `scopeToCompany` / `scopeToCompanyId`, or `activeCompanyId(c)`
  in a hand-written filter. The audit at `inventory.ts:110-122` shows what
  happens without it: a company can promote / demote / delete another company's
  default warehouse.
- **CONSIGN-OUT is 2990-only and inactive.** It's a historical consignment-out
  placeholder; do not copy it to HOUZS on any future unification pass.
- **Consignment is QUANTITY, never VALUE — and the verdict is by SOURCE.** Stock
  fed by a Purchase Consignment Receive belongs to the supplier until it sells,
  so it counts on hand and must stay out of every value total. Classify with
  `isConsignmentLotSource(source_doc_type, source_doc_no)`, never with the
  warehouse's own `is_consignment` flag: a PCR mis-posted into a normal
  warehouse defeats the flag and leaks into owned value (BUG-HISTORY
  2026-07-25). On the client, never write a fourth filter — `buildStockBreakdown`
  (`frontend/src/vendor/scm/lib/inventory-queries.ts`) is the one split, and it
  returns `ownedValueSen` beside `consignmentQty` so a surface can show both.
- **Do not delete a warehouse with movement history.** FK from
  `inventory_movements` will refuse (409 `in_use`). Deactivate (`is_active=false`)
  instead — the master row stays, historical rows keep pointing at it.
- **A positive stock ADJUSTMENT / STOCK_TAKE variance must carry a real unit cost
  (audit R3, 2026-07-25).** A found-stock increase opens a FIFO lot; the trigger
  floors an un-costed lot to RM0 and never re-costs it (permanent RM0 COGS). So
  `POST /inventory/adjustments` (increase) and stock-take `PATCH /:id/post` now
  resolve the SKU's best-known cost (operator's if typed, else the weighted avg of
  its other priced open lots — consignment excluded — else its last-known priced
  cost). If NO basis exists anywhere they reject with **422 `cost_required`**
  (adjustment: the operator enters a cost; stock-take: the POSTED flip is reverted
  to OPEN and the SKU(s) named). Pure decision in
  `backend/src/scm/shared/adjustment-cost.ts`; never writes 0.

---

## 6. See also

- `docs/modules/stock-take.md` — the cycle-count document (assignees, blind
  counts, variance threshold, NONZERO scope — phase 1, 2026-08-08).
- `docs/modules/delivery-order.md` — DO consumes warehouse for the OUT leg.
- `docs/modules/grn.md` — GRN consumes warehouse for the IN leg.
- `BUG-HISTORY.md` — entry 2026-07-23 for the type + unification rationale;
  entry 2026-06-20 for the `is_default` cross-company leak fix.
