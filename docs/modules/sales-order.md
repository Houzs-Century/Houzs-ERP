# Module: Sales Order (SCM)

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. First of the per-module set; the same
structure applies to PO / DO / SI / GRN (they are near-identical clones).

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx` | Renders via the shared `DataTable`. **Windowed** past 30 rows (page-scroll-preserving, PR #430). |
| Desktop detail | `frontend/src/pages/scm-v2/SalesOrderDetail*.tsx` | Bounded to one doc's lines. |
| Mobile list | `frontend/src/mobile/MobileSalesOrders.tsx` | Card list (bottom "Orders" tab). |
| Mobile new/edit | `frontend/src/mobile/MobileNewSO.tsx` | 2600-line screen, **lazy-loaded** (PR #426). |

### Data hooks
`frontend/src/vendor/scm/lib/sales-order-queries.ts`

- `useMfgSalesOrders(status?)` — the list.
  - `queryKey: ['mfg-sales-orders', status ?? 'all']`
  - `queryFn` → `authedFetch('/mfg-sales-orders?status=…')`
  - `staleTime: 30_000`, `placeholderData: prev` (keep old rows while a tab switch loads).
- `useMfgSalesOrderDetail(docNo)` — `['mfg-sales-order-detail', docNo]`, `enabled: !!docNo`.
- Mutations (`create/patch/proceed/cancel/…`) each call
  `qc.invalidateQueries({ queryKey: ['mfg-sales-orders'] })` on success, so the list
  reflects a write immediately (same tab) and cross-tab via the MutationCache broadcast.

### Caching / loading behaviour (why the list opens instantly)
Three layers, tuned so the list never shows a full-load spinner on a revisit:
1. **react-query in-memory** (`lib/queryClient.ts`) — `staleTime 30s`, `gcTime 30min`.
   A warm re-visit serves cached rows instantly and revalidates in the background
   (measured: refetch=false, skeleton=false).
2. **localStorage snapshot** (`lib/query-persist.ts`, PR #437) — persists the list
   query; on a COLD open (reload / PWA reopen) it hydrates the cache at boot so the
   last-known list renders instantly, then revalidates. Verified: list rendered at
   ~81ms, revalidation fetch didn't start until ~767ms. Namespaced by `__BUILD_ID__`
   so a payload-shape change on deploy can't hydrate a stale shape.
3. **`api/cache.ts`** — 15s path-cache + in-flight dedup under `authedFetch`.

Invalidation always wins over all three (mutation → invalidate → forced refetch).

---

## 2. API surface

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/api/scm/mfg-sales-orders` | list handler | Grid rows (+ `?summary=1` lightweight bucket mode, `?status=`, `?debtor=`; `?page=` opts into the paginated contract) |
| GET | `/api/scm/mfg-sales-orders/:docNo` | detail | One SO header + lines |
| GET | `/api/scm/mfg-sales-orders/my-mtd` | MTD scoreboard | Mobile Profile tiles |
| GET | `/api/scm/mfg-sales-orders/mine` | POS board | Salesperson's own orders |
| PATCH/POST | `…/:docNo/*` | mutations | proceed / cancel / amend / payments / etc. |

All under `backend/src/scm/routes/mfg-sales-orders.ts`. Auth: inside `/api/scm/*`,
`user.id` is the caller's **scm.staff UUID** (bridge-pinned); use `houzsUser.id` for
the public bigint or you get a 500 (uuid-in-int column).

Paginated contract (`?page=`) returns `{ salesOrders, total, page, pageSize,
statusCounts, aggregates }`. `statusCounts` carries `all` plus ONE lowercase
bucket per `SO_STATUSES` vocabulary entry (draft / confirmed / in_production /
ready_to_ship / shipped / delivered / invoiced / closed / on_hold / cancelled)
plus `other` (rows whose status is outside the vocabulary — legacy spellings,
blanks), so the buckets always sum to `all`. It is computed by ONE grouped
PostgREST aggregate over the base table (JS-reduce fallback if aggregates are
disabled). `?status=OTHER` filters to exactly that catch-all bucket; every real
status stays an exact match.

### Deleting an SO — DRAFT only, and the test-order escape hatch

`DELETE /:docNo` (`mfg-sales-orders.ts:5555`) hard-deletes a **DRAFT and nothing
else** — `409 so_not_draft` on anything CONFIRMED or later. That is deliberate: a
confirmed order is CANCELLED, a reversible audited status change that also books
any deposit as customer credit, and cancel is FINAL (`:5396` — no un-cancel,
because the credit has no claw-back).

Which leaves the POS smoke-test problem: a real handover on 2990 POS mints a real
`doc_no`, a real payment and real PWP vouchers. To purge one, use
**Actions -> "Delete test SO"** (`backend/scripts/delete-test-so.mjs`). Dry-run by
default; `apply=1` also requires `confirm_doc` to repeat the doc_no. It REFUSES on
any downstream DO/SI (both FKs are `ON DELETE SET NULL`, so a delete would
silently orphan a real document), on a status past CONFIRMED, on more than one
payment, and on vouchers already in circulation.

Vouchers are the part that does not cascade: `pwp_codes.source_doc_no` /
`.redeemed_doc_no` carry **no FK** to the SO, so deleting — or cancelling — an
order leaves its issued vouchers AVAILABLE and redeemable. The script cleans up
after itself (deletes what the order issued, hands back with `restore_redeemed=1`
what was spent on it); **the app's cancel path still does not** — see
`BUG-HISTORY.md` 2026-07-28.

### Processing-Date save gates (aggregated `validation_failed`)

Setting or changing the Processing Date (`internal_expected_dd` — the UI's
"Processing Date"; the `processing_date` column is a dead legacy snapshot) runs
EVERY gate and reports all failures at once (`so-save-problems.ts` →
`{ error: 'validation_failed', problems: [...] }`, HTTP 422; rendered by the
shared `SaveProblemsList`/`humanApiError` on desktop + mobile):

| Gate | Code | Rule |
|------|------|------|
| Variants complete | `variants_incomplete` | every non-cancelled line's category-mandatory axes filled (`so-variant-rule`) |
| Colour KIV | `fabric_colour_kiv` | **no line may still be colour-KIV** (series committed via `fabricId`/`fabricLabel`, no `fabricCode` — `isColourKiv` in `variant-summary.ts`). Owner rule 2026-07-24 after SO-2607-016: a Processing Date means every line is a fully-confirmed maintained selection. Fires only when the date is genuinely SET or CHANGED — unrelated edits to an old KIV order, and clearing the date, never block. Also enforced on line-ADD / line-EDIT against an already-dated SO (409). |
| 30% deposit | `processing_date_unpaid` | ≥30% of order total collected (`order-rules`) |
| Date sanity | `processing_date_past` / `delivery_date_past` / `processing_after_delivery` | no fresh past dates (unchanged past dates grandfathered); processing ≤ delivery |

Related short-circuit gates: Processing + Delivery all-or-nothing
(`processing_delivery_must_pair`), remove-date is super-admin only
(`processing_date_remove_forbidden`), and the processing-date LOCK once the day
elapses (`so-field-policy`). POS "Proceed" stamps `proceeded_at` only — it never
writes `internal_expected_dd`.

### Selling-price authoring — who may set the line price

The unit selling price is **operator-authored** and the trust gate is by SESSION,
not role (Owner ruling, `mfg-sales-orders.ts` `isPosTabletCaller`):
- **POS-tablet session** (`origin='pos'`, minted at `/api/pos/pin-login`): the
  server recomputes the authoritative catalog price and **drift-rejects (400)** a
  deviating client price — the anti-tamper non-negotiable. (Empty until the 2990
  POS repoints here.)
- **Every other session** (desktop web ERP, mobile, invite, TOTP): **not POS →
  never drift-rejected.** Owner ruling 2026-07: a salesperson may hand-type the
  price. `recomputeFromSnapshot(..., trustOperatorSelling=true)` — passed on the
  create / add-line / patch paths as `!isPosTabletCaller` — persists the operator's
  entered price instead of normalising a catalog line to `sell_price_sen` (client
  0 = "not provided" still fills the catalog price). COST stays a server snapshot.
- **Frontend gate**: `SoLineCard` / `MobileNewSO` `canEditPrice = isAdminLevel ||
  isHatchSales`; the Houzs bridge (`vendor/scm/lib/auth.ts`) now returns
  `isHatchSales` true for `sales` (+ `super_admin`), so the price input is editable
  for salespersons on both surfaces.

---

## 3. Backend (list handler)

`backend/src/scm/routes/mfg-sales-orders.ts` — `mfgSalesOrders.get('/')`.

Flow:
1. **Scope** — `resolveSalesScopeIds()` → allowed salesperson ids (SELF + manager
   downline, or all for directors / `scm.so.view_all`). Feeds the main query's `.in()`.
2. **Main query** — reads the VIEW `mfg_sales_orders_with_payment_totals` (so the
   Balance column is live = total − Σpayments), `order by so_date desc limit 500`.
   ⚠️ **VIEW-TRAP** (`docs/scm-view-trap-coe.md`): the view's column set is frozen at
   CREATE VIEW; a base-table column added to `HEADER` that the view lacks 500s the
   whole page. Post-view columns (delivery_state, amended_delivery_date) are read
   separately off the base table.
3. **Enrichment wave (PERF, PR #416)** — 6 independent per-doc_no reads run
   **concurrently** (was serial ~390ms desktop / 650ms mobile → ~40ms warm):
   payment-method summary, downstream DO/SI lock, deliverable-remaining, lifecycle +
   current-doc, warehouse labels, base-table planning cols. Only the item→catalog
   chain is sequential (catalog needs the item codes). Pattern: launch each as an
   immediately-invoked async thunk, await at its use-site.
4. **Assemble** — per-row flags (stock readiness, planning state, branding pill,
   payment-methods, has_children lock) merged onto the rows, returned as
   `{ salesOrders: [...] }`.

`?summary=1` skips the view join + item read entirely (dashboard only needs status
buckets) — do not fully-hydrate 500 rows for a count.

---

## 4. Database

Schema: `scm` (vendored 2990 clone, 108 tables). Key tables:

| Table | Role |
|-------|------|
| `scm.mfg_sales_orders` | SO header (doc_no PK-ish, status, salesperson_id, totals in sen, so_date, delivery_state, amended_delivery_date, company_id) |
| `scm.mfg_sales_order_items` | SO lines (item_group, stock_status, variants, warehouse_id) |
| `scm.mfg_sales_order_payments` | payments ledger (so_doc_no FK, method, online_type) |
| VIEW `scm.mfg_sales_orders_with_payment_totals` | header + `paid_total_centi` + `balance_centi_live` (Σ over payments) — the list reads this |

Indexes that matter here:
- `idx_msop_doc` on `mfg_sales_order_payments(so_doc_no)` — the payment-totals view's
  aggregation (already present; not the bottleneck).
- mig **0104** — trigram GIN on `mfg_products(description,barcode)` + partial
  `(category) WHERE status='ACTIVE'` (feeds the SO line item picker's search).
- FIFO / stock movement handled by scm PL/pgSQL functions (12 fns + 2 triggers,
  `search_path=scm` pinned) — a doc "proceed" moves stock via these.

Stock/inventory rules: DO=out, DR/GR=in, PR=out; one ledger + FIFO lots; balances
are a VIEW; allocation is computed; SO readiness is binary.

---

## 5. Performance summary (what's optimized, what to watch)

Optimized:
- List endpoint: 6 serial enrichment reads → one concurrent wave (**388ms → ~40ms warm**, PR #416).
- Desktop list: row windowing past 30 rows (PR #430).
- Cold/warm open: gcTime 30min (#436) + localStorage snapshot (#437) → no spinner.
- Search: trgm GIN indexes (0104).

Watch as data grows:
- The 500-row `limit` on the list — beyond that, page it server-side + push filter/
  counts to the server (don't filter a page client-side).
- If AR aging (`/outstanding/summary`) gets slow, snapshot it server-side (follow the
  freshness guardrails in `docs/perf-optimization-plan.md` §G9).

---

## Applying this to the sibling modules
PO / DO / SI / GRN follow the same shape (list hook → `/api/scm/<doc>` handler →
`scm.<doc>` tables). Differences to fill in per-module: the enrichment reads each
list does (audited — DO already parallel; GRN has a genuine item→downstream chain;
PO/SI make ≤1), and each doc's stock direction. See `docs/perf-optimization-plan.md`
for the cross-module audit.

---

## SO amendment — type classification + department routing

The SO amendment (revise a processing-locked SO + its bound PO) now classifies
each changed field into a TYPE (Processing vs Delivery / Commercial) and tags it
with a responsible DEPARTMENT, for display + accountability. **The apply gate is
unchanged** — approval stays single-signature; this is advisory routing only, no
new endpoint / permission / status / migration. The classifier and the shared PDF
are documented in full in **`docs/modules/purchase-order-amendment.md` §7**
(one `amendment-routing.ts` table drives both SO and PO).

SO-specific wiring:
- **Line atoms** come from `amendmentLineFieldKinds(line)` in
  `so-amendment-line-diff.ts` (SPEC / VARIANT / QTY / PRICE, or LINE for
  add/remove) — the SAME shared diff logic the desktop job card, the desktop diff
  modal and the mobile diff sheet already use, so all three label a row
  identically. **Header** atoms come from `soHeaderFieldKind(key)` in
  `so-amendment-header.ts`; every amendable SO header key (delivery / processing
  date, state, postcode, city) is a scheduling / delivery-address change ->
  `DELIVERY` (Logistics).
- **Surfaces (change together):** `AmendmentDetailV2.tsx` (type badges + per-row
  chips + Department-routing aside), the `AmendmentDiffModal` in
  `SalesOrderDetail.tsx` (a **Dept** column), and `MobileSODetail.tsx`'s
  `AmendmentDiffSheet` (type badges + per-row chips). Colour / fabric now also
  renders as its own change row on the SO PDF.
- **Audit:** `lib/so-revision.ts` stamps a `routing` field-change + a `routing …`
  note on the `AMENDMENT_SO_APPROVED` row recording which departments the single
  approval covered.
