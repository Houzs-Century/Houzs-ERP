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

### Per-line source-PO trace on the detail payload (owner rule 2026-08-01)

`GET /:docNo` and `GET /:docNo/items` stamp, per line, on top of the existing
`stock_state` / `coverage_po` / `coverage_eta` / `shipped_source_pos`:

| field | meaning |
|---|---|
| `shipped_source_adj` | the delivered goods drew (at least partly) from a PO-less stock ADJUSTMENT lot — UI shows "STOCK ADJ", never a blank |
| `ready_source_pos` | `[{ po, qty, kind: 'po'\|'adjustment' }]` — the PO(s) a READY (allocated, un-shipped) line WILL draw from: sofa = stored `allocated_batch_no` (mig 0121, now in the `ITEM` select), non-sofa = FIFO projection over the bucket's open lots in the engine's consumption order (received_at ASC, id ASC), earlier claims first, off the SAME `computeMrp` result the handler already ran |

Resolution lives in the ONE shared resolver `scm/lib/source-po-trace.ts`
(`soLineShippedSources` / `soLineReadySourcePos`) — the same lib the DO / SI /
GRN surfaces read, so all four show identical source data (owner: "在我的 SO、
DO、SI 里，应该看到的数据都是一致的"). Render side is also ONE component:
`frontend/src/components/SoSourceChips.tsx` (+ `SoStockPill`) on the list
drill-down, `SalesOrderDetailV2` (Stock + Incoming PO columns — added
2026-08-01; the page previously dropped these payload fields entirely) and the
`?edit=1` editor; mobile twins in `frontend/src/mobile/source-chips.tsx`
(`MobileSODetail` line pill + chips). Full write-up:
`docs/modules/document-traceability.md` §2.8, including the lot-batch backfill
(`backfill-lot-batch-from-docs.mjs`) and the read-only measurement
(`check-so-source-trace.mjs`).

**LIST "PO No." column (owner 2026-08-02, SURFACE CHANGE).** The list stamps
`source_po_union` + `source_po_adj` per row — the UNION of the per-line source
chips the drill shows (shipped consumed batches ∪ READY projections, pure
`unionSoLineChips` over the same two resolvers; READY suppressed on
fully-shipped lines; ONE `computeMrp` per list load). The visible chips read
THAT, because the previous content (`converted_po_nos`, the convert-time
raise-link) lied by omission: an accessories/CS SO fulfilled from stock bought
under other POs raises no PO of its own and showed "—" while its drill named
the source PO. `converted_po_nos` still rides the payload as the tooltip
("Raised PO (convert-time link, not a goods source)") when it differs. Mobile
Orders card renders the same union via `SourcePosRowMobile` (row omitted when
empty — card idiom).

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
`.redeemed_doc_no` carry **no FK** to the SO, so nothing the database does will
clean them up. Both paths now settle them explicitly — the script deletes what
the order issued and hands back with `restore_redeemed=1` what was spent on it
(`BUG-HISTORY.md` 2026-07-28); the cancel path VOIDS instead of deleting, below.

### Cancelling an SO settles its PWP vouchers

`PATCH /:docNo/status` → `CANCELLED` (`backend/src/scm/lib/so-cancel-vouchers.ts`):

| voucher | on cancel |
|---|---|
| issued BY this SO (`source_doc_no`) | `status -> VOID` — never deleted, the cancelled order still needs its record |
| earned elsewhere, spent HERE (`redeemed_doc_no`) | `status -> AVAILABLE`, redemption columns cleared — the customer's property |
| issued by this SO, already redeemed on ANOTHER order | **cancel REFUSED**, `409 pwp_voucher_redeemed_elsewhere`, naming the code + that order |
| minted AND redeemed on this same SO | `status -> VOID` (dies with the order — NOT a refusal) |

`VOID` is a new value on `pwp_codes.status` (plain `text`, no check constraint).
Every redemption gate is an allow-list (`AVAILABLE`, or `RESERVED` owned by the
caller), so `VOID` is refused by construction rather than by a new rule.

The cancel transition — and only that transition — runs inside
`runScmPgCommand`'s real transaction, because a half-applied cancel would burn a
customer's vouchers on an order that is still live. So a cancel needs
`DATABASE_URL`: without it the endpoint fails closed with
`503 scm_pg_command_required`. See `BUG-HISTORY.md` 2026-07-29.

### The SO line's downstream links — `so_item_id`, and what deletes it

`scm.mfg_sales_order_items.id` is referenced by **three** tables, and all three
FKs are declared `ON DELETE SET NULL`
(`backend/scripts/scm-schema/2990s-full-schema.sql`):

| Referencing column | Line | What it decides |
|---|---|---|
| `purchase_order_items.so_item_id` | `:1747` | whether a shipment can bind its incoming PO — `resolveExpectedBatchBySoItem` (`dropship-batch.ts`) resolves the expected batch through it, and since 2026-07-31 that resolution decides the binding for EVERY short ship, not only a confirmed drop-ship (see below). `recomputeSoPicked` counts `po_qty_picked` from it |
| `delivery_order_items.so_item_id` | `:1651` | which SO line a shipped unit served |
| `sales_invoice_items.so_item_id` | `:1767` | which SO line a billed unit served |

So **deleting an SO line silently unlinks every downstream document** — the rows
survive, only the link is wiped, which is exactly what makes it invisible.

- **A genuine line DELETE** (`DELETE /:docNo/items/:itemId`, and the automatic
  free-gift cleanup in `free-gift-reconcile.ts`) SHOULD null: the line is gone,
  so a link to it would be a lie. Nothing to fix there.
- **A delete-and-REINSERT must not.** `POST /:docNo/items/:itemId/tbc-swap-sofa`
  replaces a whole sofa build with a new set of module lines when a TBC fabric is
  confirmed. Since 2026-07-31 it freezes the links first
  (`snapshotSoLineLinks`), then re-points them onto the replacement lines
  (`planSoLineRelink` / `applySoLineRelink`, `backend/src/scm/lib/so-line-relink.ts`)
  inside the SAME transaction. Matching is by SKU, paired ordinally within a SKU
  by `line_no`; an old module SKU the new build does not carry is **not**
  re-pointed — that link is genuinely gone, and it is reported
  (`soLinks: { restored, dropped }` on the response, plus `sourceLinksCarried` /
  `sourceLinksDropped` on the `UPDATE_LINE` audit row) rather than lost quietly.
- The single-item `tbc-swap` (`:8669`) UPDATEs the row in place — the id
  survives, so no link is touched. Safe by construction, not by a guard.
- The SO **amendment** REMOVE (`applySoAmendment`) is a genuine removal and keeps
  nulling; its `snapshotSo` `poLinks` blob is the compensating record the
  Approve-PO gate (`reviseBoundPo`) reads to reconcile the orphaned PO line. It
  captures the PO side only — the DO / SI sides are not snapshotted there.

The 2026-07-31 measurement of the live database: **101 PO lines, only 34 carry
`so_item_id` — 67 are NULL.**

#### What the link now decides at ship time

Until 2026-07-31 `so_item_id` only mattered if the operator reached the drop-ship
dialog: a plain "Ship anyway" ignored it, so the shipment bound nothing and the
GRN could never net it. That is no longer true. A DO line that ships before its
goods arrive and resolves **exactly one live bound PO** through this column is
bound to that PO's batch automatically, and the binding is recorded per LINE in
`delivery_order_items.committed_po_batch_no` (migration 0230). The full decision
table, and what "resolves" excludes (ambiguous multi-PO, partial short, already
allocated), lives in **`docs/modules/delivery-order.md` §5**.

Two knock-on effects for anyone working on the SO:

- **The link is now load-bearing for COSTING, not just for a dialog.** A bound
  line's OUT is stamped with the incoming PO number, so its COGS lands from THAT
  batch's lot when the GRN posts. Break the link (see the `ON DELETE SET NULL`
  trap above) and the shipment silently reverts to an unbound oversell.
- **MRP ATTRIBUTES the committed units to the PO that owes them.** `mrp.ts`
  subtracts them from that PO's incoming supply and adds the same units back to
  on-hand stock (the OUT had already taken them off `inventory_balances`). Read
  that precisely: **net availability does not change and no shortage figure
  moves** — the balance arithmetic already propagated the negative correctly and
  already tagged those units `source: 'shortage'` rather than `coverage_po`. What
  changes is that the commitment stops being a nameless negative in whichever
  bucket the OUT landed in, so Stock and PO-Outstanding stop being wrong in
  opposite directions on the SKU row.
- **A sofa SET must bind ONE purchase order.** One PO IS one batch number, so if
  two modules of a set resolve two different POs the ship is refused
  (`sofa_set_po_split`) rather than stamped with two batch numbers. Point every
  module's PO line at its Source Sales Order line before shipping.

Allocation order is unchanged by any of this and is worth restating, because it
is easy to assume otherwise: MRP allocates greedily by
`line_delivery_date ?? customer_delivery_date`, then `doc_no`. An urgent order
inserted with an earlier delivery date DOES re-shuffle the allocation and DOES
take stock and PO supply ahead of a later one — the delivery date is the
mechanism. (The `priority_rank` / `priority_reason` columns exist but have zero
readers; they are not what drives this.)

### The warehouse follows the SO — where the order's warehouse actually lives

Owner, 2026-07-31: **"我们的 item 都不会有仓库, 还是跟着 SO 的"** — an item never
carries a warehouse of its own; the warehouse comes from the Sales Order.

**There is NO warehouse FK on `scm.mfg_sales_orders`.** This is the surprising
part and the reason people look in the wrong place. The header records its
warehouse as the free-text **`sales_location`**, written by `warehouseLabel()`
(`lib/warehouse-label.ts` — the warehouse CODE when there is one, else the
name), which is itself derived from `customer_state` through
`state_warehouse_mappings`. So the SO's warehouse resolves as:

```
sales_location  ->  warehouses.code / warehouses.name    (what the SO says)
customer_state  ->  state_warehouse_mappings             (how it was derived)
```

recorded value first, derivation only as a fallback. That rule lives in ONE
place — **`backend/src/scm/lib/so-warehouse.ts`** — and every reader and writer
goes through it.

`scm.mfg_sales_order_items.warehouse_id` (mig 0118) is the per-line binding MRP,
inventory balances and auto-allocation all key on. It is **nullable**, and
several paths leave it null: imported history, the amendment ADD line
(`lib/so-revision.ts`) and the auto free-gift line
(`lib/free-gift-reconcile.ts`). Both of those write paths now inherit the SO's
warehouse (fail-soft — an unresolvable header still yields null, so a missing
state mapping can never block an amendment or a gift).

**`computeMrp` resolves a null line's warehouse from the SO header** before any
bucket key, warehouse filter or label is built (`routes/mrp.ts`), so the MRP
page, the SO detail's coverage and `po-so-coverage`'s reverse map all read one
answer. Before this, `2990-SO-2607-028`'s two-module LOTTI set rendered as TWO
rows — `Mrp.tsx`'s `groupBySo` keys on `` `${warehouseId ?? WH_NONE}|${soDocNo}` ``
— and the split was in the backend's own allocation, not only on screen.

> **Never fall back to a SIBLING LINE's warehouse.** MRP, balances and
> allocation are strictly per-warehouse, and the `WH_NONE` bucket exists to stop
> unbound demand pooling stock across that boundary. Borrowing another line's
> warehouse would silently pool them. Falling back to the SO's OWN header
> cannot: every line of one order shares one header, which is exactly what makes
> the warehouse a property of the order.

Also relevant: `apply_so_header_cas` (mig 0173) rebinds `warehouse_id` on the
order's **NULL lines only** when the header's warehouse changes, while the
approved-amendment path (`so-revision.ts`) rebinds every non-cancelled line.

**Historical backfill for the header-unresolvable lines (2026-08-01, gated).**
Part `so-warehouse` on `backend/scripts/repair-2990-doc-refs.mjs` (workflow
**Repair 2990 doc references**) stamps `warehouse_id` on the lines the read
path can NEVER resolve — NULL warehouse AND a header where both
`sales_location` and `customer_state` resolve nothing (the
check-backfillable-gaps section-1 hard core; 24 lines on the 2026-08-01 run).
Document-evidence order, single-valued or refused: the line's own DO OUT
movement (where the goods physically left), else **unanimous** sibling
agreement, else the company's single active warehouse. The sibling arm does
NOT breach the callout above: the callout guards against pooling across a
warehouse boundary, and an SO whose every warehoused line names ONE warehouse
has no boundary to pool across — disagreeing siblings refuse, and the
single-warehouse fallback must not rescue them. Company-2990 rows are
mirror-maintained (`so-mirror.ts` drains DELETE-then-INSERT per SO, wiping
local stamps), so they verdict `mirror-source` — reported with the exact stamp
for the 2990 SOURCE database, never written here. Rule:
`classifySoLineWarehouse`, `backend/scripts/lib/doc-evidence-core.mjs`.

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
| Deposit, PER COMPANY | `processing_date_unpaid` | **Houzs 30%, 2990 50%** of the order total collected (`processingDateThresholdFor` in `order-rules`). Until 2026-07-31 the split existed only in a comment and both constants applied to everyone, so a 2990 order was refused at the Houzs 30%. An unknown/absent company code falls back to the LOOSER 30% on purpose — over-gating stops the shop floor with no signal. |
| Customer + delivery complete | `processing_date_incomplete` | customer name, delivery address line 1, postcode, delivery date. **No email** (owner 2026-07-31: "不需要email"). Added 2026-07-31 when the Processing Date and Proceed gates were unified — this half used to apply only to Proceed. Measured free: of 63 live dated SOs, zero lacked any of these four; 12 lacked only the email that was dropped. |
| Date sanity | `processing_date_past` / `delivery_date_past` / `processing_after_delivery` | no fresh past dates (unchanged past dates grandfathered); processing ≤ delivery |

Related short-circuit gates: Processing + Delivery all-or-nothing
(`processing_delivery_must_pair`), remove-date is super-admin only
(`processing_date_remove_forbidden`), and the processing-date LOCK once the day
elapses (`so-field-policy`). POS "Proceed" stamps `proceeded_at` only — it never
writes `internal_expected_dd`.

**ONE gate, one name (owner 2026-07-31).** *"不要又 Processing Date,又 Proceed,
全系统直接统一一个叫 Processing Date... Processing Date 就是当天 Proceed 的意思。"*
`meetsProceedGate` in `order-rules` is now the single rule behind ALL of it:
setting `internal_expected_dd`, the create-time auto-stamp of `proceeded_at`, and
both manual proceed paths (`PATCH /:docNo/status` → IN_PRODUCTION and `PATCH
/:docNo` `proceededAt`). `proceeded_at` stays a separate COLUMN because it is a
timestamp the system writes, not a date a user picks — what was unified is the
RULE, not the storage. Net effect: the proceed paths LOOSENED by one condition
(email), the processing-date path TIGHTENED by four (name / address / postcode /
delivery date), and the threshold became per-company.

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

### Looking a product up by CODE — always pass the company

`mfg_products.code` is **not unique**. Both companies keep their own SKU master,
so one code can name two different products: on 2026-08-01 seventeen did —
`CODY` / `FENRIR` / `JAGER` × `(K)(Q)(S)(SK)(SS)` plus two mattress codes — HOUZS's
manufacturing row (cost columns, NULL `sell_price_sen`) and 2990's selling row
(`sell_price_sen` + `pwp_price_sen`). Both are legitimate; neither can be renamed.

Every by-code read on the order path therefore takes a `companyId`:

| helper | file |
|---|---|
| `loadProductByCode` / `loadProductsByCodes` | `scm/lib/mfg-pricing-recompute.ts` |
| `loadModelSofaModulePrices` / `…Costs` / `…CostRows` | `scm/lib/mfg-pricing-recompute.ts` |
| `loadProductAndModel` / `loadProductsAndModels` | `scm/lib/allowed-options-check.ts` |
| `validateItemCodes` | `scm/lib/validate-item-codes.ts` |
| `findServiceLineCodes` | `scm/lib/service-line-guard.ts` |
| `findSofaLinesWithoutCompleteBatch` / `detectSofaSoItemIds` / `findIncompleteSofaSets` | `scm/lib/sofa-batch-guard.ts` |
| `snapshotUnitCostSen`, GRN + PI landed-charge CBM, delivery-planning / delivery-zones category maps, `scan-so`'s OCR catalogue | in their route files |

**`base_model` is a partial key too.** It is plain text on the same per-company
table, so the three sofa module loaders merge both companies' SKUs when
unscoped — and because their result is a module→price map keyed by module
suffix, the other company's module *replaces* this one's rather than competing
with it. Every non-`id` predicate on `mfg_products` (`code`, `base_model`,
`sku_code`, `barcode`) is a partial key; only `id` and a UUID `model_id` stand
alone.

**Two reads stay unscoped on purpose**, and say so inline:
`so-stock-allocation.ts` (recomputes every SO across both companies, 34 callers,
no request context) and `resolveDoSofaBatchMap` (reached only from
context-free inventory-cost helpers). Both use the catalogue solely to classify
a code as SOFA / SERVICE, i.e. a union across companies — correct while the two
rows agree on category, so `so-stock-allocation` logs a disagreement rather than
silently choosing.

Callers pass `activeCompanyId(c)` — or, inside `createSalesOrderCore` (which has a
`SoCreateContext`, not a Hono `Context`), its local `companyId`. `null`/`undefined`
degrades to no predicate, matching `validateSoDropdownFields` and
`loadFabricTierAddonConfig`, so a single-company install, a headless job and the
unit tests read exactly as before. Migration **0233** adds
`UNIQUE (company_id, code)` so the scoped `.maybeSingle()` is single by
construction.

**These move together or not at all.** Scope the pricing read but not
`validateItemCodes` and a foreign code passes validation, then prices at 0 and
dies as `pricing_drift`; scope neither and the SO path can price a line off the
other company's row — which is how an order came to be refused with
*"this SKU has no PWP price set (SKU Master)"* while the SKU Master, which **is**
company-scoped, showed RM 490 for that SKU. Tests:
`scm/lib/product-lookup-company-scope.test.ts`.

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
