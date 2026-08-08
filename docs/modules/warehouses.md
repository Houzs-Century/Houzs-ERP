# Module: Warehouses (SCM master)

Per-module technical doc for `scm.warehouses` — the master list of physical
stock locations. Small table, but load-bearing: every stock movement / DO / GRN
/ SO reserve / inventory balance / venue resolve reads from it.

> Convention: money in **sen**, dates UTC. Reads/writes via `/api/scm/*`.
>
> Line references are against `feat/warehouse-type-unify`.

---

## 1. Frontend

| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/Warehouses.tsx` | DataGrid, per-column filter + sort. Type column + label at `:22-33`. |
| Shared edit drawer | `frontend/src/vendor/scm/components/WarehouseFormDrawer.tsx` | Type dropdown replaces the old "Mark as Showroom" checkbox (mig 0171). |
| Master admin (inline) | `frontend/src/pages/scm-v2/SalesOrderMaintenance.tsx` | Legacy inline table — also uses `useCreateWarehouse` / `useUpdateWarehouse`. |
| Query hook | `frontend/src/vendor/scm/lib/inventory-queries.ts` | `useWarehouses({ includeInactive })`, staleTime 5 min. `Warehouse` + `WarehouseType`. |

`useWarehouses()` is the single read hook every consumer (PO, DO, GRN, SO,
Inventory board, Racks) reaches through. Do not open a per-page fetch — the
5-min staleness is intentional and shared.

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

### Type enum (mig 0171)

`scm.warehouse_type` has FIVE values:

| Type | Meaning | Cross-company sharing |
|------|---------|-----------------------|
| `warehouse` | Pure stock (KL, PG, SBH, SRW, CHINA) | **Both companies** — this is a fleet-shared type. |
| `showroom` | Sales point that also feeds the venue list. `is_showroom = true` invariant. | Company-specific — HOUZS: Kelana.J, Sunway. 2990: PJ. |
| `display` | Display stock at a partner site; must NOT net into sellable inventory. | HOUZS-only (C&C, EM, KL, PG, SBH). |
| `service` | Repair / customer-service centre. | **Both companies** — KL SERVICE, PG SERVICE. |
| `others` | HQ, C&C K.J, any site that doesn't fit. | HOUZS-only. |

`is_showroom` is kept for backward compatibility (venue-binding resolver +
Members-page staff parking + `inventory.ts:257`'s OR-include). The write path
enforces `is_showroom = (type = 'showroom')` — updating either side flips the
other so the two stay coherent.

---

## 3. Backend routes (`/inventory/warehouses`)

Owned by `backend/src/scm/routes/inventory.ts`:

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
  Sales Maintenance venue list. `type='showroom'` guarantees the flag is true.
- **Members page** — staff `showroom_warehouse_id` FK; the picker filters on
  `is_showroom = true`.
- **Inventory list** (`inventory.ts:257`) OR-includes `is_consignment=true`
  rows into the balances read so consignment/showroom stock stays visible.

Rule of thumb when adding a new consumer: if you want "sales point", filter
`type='showroom'`; if you want "stock location", filter `type='warehouse'`; if
you want "everything selectable", filter `is_active=true` and skip type.

---

## 5. Rules that will bite you

- **`is_showroom` and `type` are ONE fact.** Do not update them independently.
  The API enforces the invariant server-side; the schema does not, so a raw SQL
  UPDATE on either column MUST update the other in the same statement.
- **Company scope is on every read/write.** Any new query on `scm.warehouses`
  must go through `scopeToCompany` / `scopeToCompanyId`, or `activeCompanyId(c)`
  in a hand-written filter. The audit at `inventory.ts:110-122` shows what
  happens without it: a company can promote / demote / delete another company's
  default warehouse.
- **CONSIGN-OUT is 2990-only and inactive.** It's a historical consignment-out
  placeholder; do not copy it to HOUZS on any future unification pass.
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
