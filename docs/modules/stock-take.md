# Module: Stock Take (SCM warehouse)

Per-module technical doc for the cycle-count document — `scm.stock_takes` +
`scm.stock_take_lines`. OPEN (counting) → POSTED (variance booked as signed
ADJUSTMENT movements) → CANCELLED (cancel, or reverse-of-posted).

> Convention: money in **sen**, dates UTC. Reads/writes via `/api/scm/*`.
>
> Line references are against `feat/stock-take-accountable` (phase 1,
> owner-approved 2026-08-08).

---

## 1. Surfaces

| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/StockTakesListV2.tsx` | Assignee column; variance shows "Hidden" on a blind OPEN take for non-supervisors. |
| Desktop create | `frontend/src/pages/scm-v2/StockTakeNew.tsx` | Warehouse + **Assignee (required)** + Scope + Date + Notes + **Blind** toggle. |
| Desktop detail / count sheet | `frontend/src/pages/scm-v2/StockTakeDetail.tsx` | Model view (default) / flat toggle; per-cell Counted By; blind-aware. |
| Model-grouping fold | `frontend/src/pages/scm-v2/stock-take-grouping.ts` | Pure; tested beside itself. |
| Query hooks | `frontend/src/vendor/scm/lib/stock-queries.ts` | Vendored slice — types extended narrowly for phase 1. |
| Mobile | generic `MobileModuleList` config `"stock-takes"` | **Read-only list.** There is NO mobile counting surface — phase 1 is desktop-only for entry; the phone list simply reflects the same list endpoint. |
| Backend routes | `backend/src/scm/routes/stock-takes.ts` | Mounted at `/api/scm/stock-takes` behind `scmAreaGuard("scm.warehouse.stock_take")`. |
| Threshold rule (pure) | `backend/src/scm/shared/stock-take-threshold.ts` | Tested beside itself. |

## 2. Schema

Baseline tables from the 2990 dump; grown by:

| Migration | What it added |
|-----------|--------------|
| `0035_scm_stock_take_variant_key.sql` | Variant-grained sheet: `variant_key`/`variant_label` on lines; unique `(stock_take_id, product_code, variant_key)`. |
| `0083_multicompany_company_id.sql` | `company_id` on header + lines. |
| `0270_scm_stock_take_accountable.sql` | **Phase 1**: `assignee_staff_id` (FK `scm.staff`, required by the route for new takes), `blind` flag on the header; `counted_by`/`counted_at` on lines; scope CHECK gains `'NONZERO'`. |

## 3. Phase-1 rules (owner-approved 2026-08-08)

- **Assignee accountability.** Every NEW take names the person responsible at
  creation (`assigneeStaffId`, a `scm.staff` uuid — pick from
  `/staff/pickable`). POST is allowed only for the assignee or a holder of the
  flat permission **`scm.stock_take.supervise`** (`services/permissions.ts`;
  normal wildcard semantics, so Owner + IT Admin pass via `*`). Legacy takes
  with `assignee_staff_id NULL` keep the pre-phase behaviour — any
  area-access caller may post — so history stays operable. Splitting one
  warehouse count across people = several takes with CATEGORY / CODE_PREFIX
  scopes, each with its own assignee; the scope mechanism IS the sub-sheet
  mechanism (deliberately no extra sheet table).
- **Variance threshold.** At post time, per-line |counted − live| is judged by
  the pure fold in `shared/stock-take-threshold.ts`: breach when
  |qty delta| > limit (default **5**) OR |delta| × best-known unit cost >
  value limit (default **RM500**; unknown cost ⇒ qty rule only). A breach
  without `scm.stock_take.supervise` answers **403
  `variance_supervisor_required`**, names the SKUs, and REVERTS the POSTED
  flip (same posture as the R3 `cost_required` 422 — nothing written, take
  stays OPEN). Limits are env-tunable: `STOCK_TAKE_VARIANCE_QTY_LIMIT` /
  `STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN` (absent = defaults, same idiom as
  `COSTING_DISPLAY_ENABLED`).
- **Who counted what.** `PATCH /:id/lines` stamps `counted_by`/`counted_at`
  on every cell whose counted qty changes, from the caller's REAL `scm.staff`
  uuid (`resolveCallerStaffId`, mig-0066 bridge). Clearing a count clears the
  attribution. The History drawer keeps the per-save from→to record keyed by
  product code (entity-audit, actor = `houzsUser`).
- **Movements name the real person.** The post/reverse ADJUSTMENT rows (and
  the manual `/inventory/adjustments` write) stamp `performed_by` with the
  caller's real staff uuid — see BUG-HISTORY 2026-08-08 ("Performed by:
  Unknown user") for the trap this closed. Never stamp `c.get('user').id`
  inside `/api/scm/*`: that is the pinned system row.
- **Blind counts.** `blind = true` on the header ⇒ while the take is OPEN,
  GET `/:id` strips `system_qty` and `variance` to null and GET `/` nulls
  `variance_total`, for every caller WITHOUT `scm.stock_take.supervise` —
  stripped SERVER-side (devtools shows nothing; the standing one-logic-layer
  rule). The response's `viewer` object (`isAssignee` / `canSupervise` /
  `blindActive`) is what the UI trusts; the frontend never re-derives
  permissions. POSTED/CANCELLED reads reveal everything.
- **NONZERO scope.** `scopeType: 'NONZERO'` snapshots only buckets whose
  system qty ≠ 0 — no synthetic zero lines, no zero buckets.

## 4. Post mechanics (unchanged by phase 1, restated)

- Post re-reads LIVE on-hand per (code, variant) — `adjustment = counted −
  live`, stamped with `variant_key` (mig 0035/#15).
- Positive variances must carry a real unit cost (`resolveForcedUnitCostSen`;
  422 `cost_required` reverts the flip — audit R3, see
  `docs/modules/warehouses.md` §5).
- Status flips are atomic CAS (`.eq('status', …)`) — the single-flight lock.
- Company scope: `requireActiveCompanyId` + `scopeToCompanyId` on every write
  (audit #826 item 5); cross-company ids answer 404 `not_found_in_company`.
- Exactly TWO inline `recomputeSoStockAllocation` calls (post + reverse) —
  counted by `tests/stockAllocationDurabilityScope.test.ts`; do not add or
  remove one without updating that ledger.

## 5. Tests

- `backend/tests/stockTakeAccountable.test.ts` — assignee/supervisor gate,
  threshold gate (qty + value + revert), blind stripping, create validation,
  NONZERO scope, counted_by stamping, performed_by attribution.
- `backend/src/scm/shared/stock-take-threshold.test.ts` — the pure threshold
  fold + env parsing + refusal-message contract (<200 chars, no braces, no
  bare five-digit number — the humanApiError filter).
- `frontend/src/pages/scm-v2/stock-take-grouping.test.ts` — the model fold
  (order, blind-null totals, counted math).
- `backend/tests/companyScopeHardening.test.ts` — the cross-company post
  refusals (pre-date this phase; still green).

## 6. See also

- `docs/modules/warehouses.md` — the warehouse master + the R3 cost rule.
- `BUG-HISTORY.md` — 2026-08-08 "Performed by: Unknown user"; 2026-07-25 R3
  cost-less lot; audit #826 item 5 tenancy fixes.
