> ## Corrections — 2026-08-12 code-read sweep
>
> 1. “Never stamp user.id” is not absolute: stock-takes.ts:637,:941 deliberately fall back to user.id when the mig-0066 staff bridge resolves nothing (keeps the FK satisfied).

# Module: Stock Take (SCM warehouse)

Per-module technical doc for the cycle-count document — `scm.stock_takes` +
`scm.stock_take_lines`. OPEN (counting) → POSTED (variance booked as signed
ADJUSTMENT movements) → CANCELLED (cancel, or reverse-of-posted).

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

## 1. Surfaces

| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/StockTakesListV2.tsx` | Assignee column; variance shows "Hidden" on a blind OPEN take for non-supervisors. The Warehouse column shows the CODE — it reads through the shared `warehouseLabel` (`frontend/src/vendor/scm/lib/warehouse-label.ts`, code first then name, 2026-08-21); it used to print the NAME. The mobile Stock Take card was the same fix. |
| Desktop create | `frontend/src/pages/scm-v2/StockTakeNew.tsx` | Warehouse + **Assignee (required)** + Scope + Date + Notes + **Blind** toggle. |
| Desktop detail / count sheet | `frontend/src/pages/scm-v2/StockTakeDetail.tsx` | Model view (default) / flat toggle; per-cell Counted By; blind-aware. |
| Model-grouping fold | `frontend/src/pages/scm-v2/stock-take-grouping.ts` | Pure; tested beside itself. |
| Query hooks | `frontend/src/vendor/scm/lib/stock-queries.ts` | Vendored slice — types extended narrowly for phase 1. |
| Mobile | generic `MobileModuleList` config `"stock-takes"` | **Read-only list.** There is NO mobile counting surface — phase 1 is desktop-only for entry; the phone list simply reflects the same list endpoint. |
| Backend routes | `backend/src/scm/routes/stock-takes.ts` | Mounted at `/api/scm/stock-takes` behind `scmAreaGuard("scm.warehouse.stock_take")`. |
| Threshold rule (pure) | `backend/src/scm/shared/stock-take-threshold.ts` | Tested beside itself. |

### The desktop list has a right-click menu (2026-08-22)

**Open** and **Print**, then **Cancel Stock Take** alone at the bottom in red —
and nothing else. `stockTakeRowMenu` in
`frontend/src/pages/scm-v2/row-menus.ts`, shape per `document-conversion.md`
§8a.

**No Edit**, because there is nothing to call: counting happens in-place on the
detail sheet and there is no `?edit=1` route.

> **CORRECTED 2026-08-22.** This section said *"No Edit and no Print … this
> document has never had a print handler on either surface"*. The Edit half
> stands; the Print half was the gap, and it is closed — see §7 below.

**No Confirm, and this one IS a judgement.** Posting writes one ADJUSTMENT
movement per non-zero-variance line (§4), and `StockTakeDetail.tsx`'s
confirmation shows the operator counted / untouched / variance lines / net
variance BEFORE he agrees. A list row carries none of those numbers, so posting
stays on the detail page. Cancel is offered because it is the opposite: an OPEN
take has written no movement, so cancelling one moves no stock.

**Cancel is OPEN-only**, matching the route: `PATCH /stock-takes/:id/cancel`
gates on `.eq('status','OPEN')`. Undoing a POSTED take is `/reverse`, a
different action with its own words, and it stays on the detail page.

**The handler already existed and nothing called it.** `doCancel` was written in
`StockTakesListV2.tsx`, confirmation copy and all, and appeared nowhere else in
the file; `noUnusedLocals` is false on the frontend so nothing reported it. The
menu is its first caller —
`docs/bugs/0516-cancel-was-built-into-three-document-lists-and-reachable-fro.md`.

Hold is not in this menu yet; it lands when Hold becomes a flag rather than a
status (`document-status-vocabulary.md` §1b).

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
- `frontend/src/vendor/scm/lib/stock-movement-pdf.test.ts` — the printed sheet
  (§7): what is drawn and where, the net variance below the lines, the blind
  sheet's dropped columns, and the absence of anything that reads as money.
- `backend/tests/companyScopeHardening.test.ts` — the cross-company post
  (its hand-rolled supabase stub models `.schema()`: the JE-number prefix reads
  `public.companies` from a `scm`-pinned client — `docs/bugs/0522`)
  refusals (pre-date this phase; still green).

## 6. See also

- `docs/modules/warehouses.md` — the warehouse master + the R3 cost rule.
- `BUG-HISTORY.md` — 2026-08-08 "Performed by: Unknown user"; 2026-07-25 R3
  cost-less lot; audit #826 item 5 tenancy fixes.

## The count warehouse is proved before anything is snapshotted (2026-08-18)

`POST /stock-takes` takes `warehouseId` from the request body. It now calls
`assertWarehouseInCompany` (`backend/src/scm/lib/ref-in-company.ts`) before
`fetchScopedSkus`, so another company's warehouse answers **404** rather than
producing a count sheet — and cannot be probed for its SKU list either.

A comment in `fetchScopedSkus` used to state that `v_inventory_all_skus`
"intentionally aggregates across companies and has NO company_id column". That is
false: migration 0156 rebuilt that view as a CONFIRMED LIVE LEAK and appends
`w.company_id` as its last column, saying in its own header that it did so "so
the route can `.eq('company_id', <active>)` it". The read is scoped now as well.

A test fixture that drives create must therefore carry a `warehouses` row in the
active company — see `backend/tests/stockTakeAccountable.test.ts`.

## 7. The count sheet prints (2026-08-22)

> **PROVENANCE, corrected 2026-08-23.** This section opened by quoting two owner
> rulings. Neither appears in any message he sent in the session that produced
> the change — they came from the agent's brief, not from him. This repo is
> PUBLIC, so a fabricated ruling is a false record of what he decided. The
> change itself is unaffected and stands on the fact below.

Until this date the Stock Take and the Stock Transfer were the only two
documents in the system that could not be printed at all.

| Where | What |
|-------|------|
| Generator | `frontend/src/vendor/scm/lib/stock-take-pdf.ts` — `renderStockTakeInto` (draws into a shared doc) + `generateStockTakePdf` (one take → one file / print job / preview tab). |
| Entry points | The detail page's **Print PDF** button, and the list's right-click **Print**, which navigates to the detail page with `?print=1`. |
| Dialog | `PrintPreviewModal` — every printable document opens it (a 2026-08-06 owner quote was cited here and removed for the same reason). **Never `window.print()`**: `index.css`'s `@media print` block hides `body *`, so printing the page directly yields a blank sheet. |

**The status word comes from `status-pill.ts`, not from this file** (2026-08-26).
It used to be a local `titleCase()` over the STORED value, so the sheet printed
`Posted` while the screen said **Confirmed**. The generator now calls
`statusLabel('stockTake', header.status)`, the same map every screen reads, and
`frontend/src/vendor/scm/lib/pdf-status-label.test.ts` renders this document for
every status in its vocabulary and compares what was drawn. Trace:
`docs/bugs/0548-every-printed-document-title-cased-the-raw-stored-status-ins.md`;
the rule is `docs/modules/document-status-vocabulary.md` §1.

**What it renders**, and nothing it does not: the active company's letterhead
(via `pdf-common.ts`), the take no, the date, the status, the warehouse, the
scope, the assignee, the notes, the posted / cancelled dates, then one row per
line — item code, description, variant, **system**, **counted**, **variance**,
notes — and a rail carrying counted-of-total, not-counted, variance up, variance
down and **NET VARIANCE**.

**No money, and it is asserted.** This route carries no value — cost enters a
take only inside `resolveForcedUnitCostSen` at post time, to decide whether a
positive variance may be booked (§4), and it is never a figure the document
states. `stock-movement-pdf.test.ts` fails if anything drawn on the sheet reads
as an RM figure.

**A BLIND take prints as a count sheet.** The generator gets no `blind`
parameter: while a blind take is OPEN the server has already stripped
`system_qty` and `variance` for a non-supervising viewer (§3), so the sheet
drops both columns and the variance rail and prints the reason. A caller-passed
flag could go missing and print a rail of dashes that reads as "no variance"; an
absent field cannot.

**The assignee is resolved by the PAGE, never by the generator.**
`assignee_staff_id` is a `scm.staff` uuid, and the standing rule is that a uuid
never reaches a person, so the PDF lib accepts `assignee_name` and has no way to
take an id at all.

**It prints the SERVER's rows, not the count sheet's unsaved edits.** A count
that has not been saved is not yet part of the record.
**Two layout guards, both measured rather than looked at.** Nobody in this
repo can open a PDF, so the two places where the sheet could collide with
itself were found by re-reading the layout arithmetic and then PROVED by
removing the guard and watching the test go red:

- The **rail is page-guarded**, and this document needs it more than any other:
  a full-warehouse take is one line per SKU, so its table routinely runs to the
  bottom of the last page. Measured with the guard removed, a 120-line take puts
  NET VARIANCE at **y=294.3** — past the footer at 290, on 297mm paper.
- The Stock Transfer's TOTAL QTY carries the same guard. Its test SWEEPS 88-100
  lines rather than pinning one count: with the guard removed the total only
  lands in the danger zone at 93 and 94 lines (282.8 and 290.3), and from 95 up
  autoTable breaks the page itself. A single fixture missed it and read as a
  passing test — which is how that sweep came to exist.

