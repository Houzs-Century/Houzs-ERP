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
the source PO.

**LIST "PO No." column — the raised PO is a CHIP again (2026-08-11, SURFACE
CHANGE).** Demoting `converted_po_nos` to a tooltip reintroduced the same lie
from the other side. BOTH source arms need EXECUTION: the shipped arm needs a
Delivery Order line, the READY arm needs an open lot that still resolves to a
PO. A CONFIRMED order that has not shipped and whose stock is not allocated
satisfies neither, so the cell rendered "—" for documents whose own
Relationship Map names a purchase order (`HC-SO-011733` → `HC-PO-008783` →
`HC-GR-004863`). Measured on production: of the 2,723 Houzs Century SOs at
most **53** can light the source arms at all, while **277** carry a real
non-cancelled PO on `purchase_order_items.so_item_id` — so the column was
blank for ~91% of the orders that have one. A tooltip on an em-dash is not an
answer: **if a link exists, a chip must show.**

The cell now renders two chip identities, never conflated — SOLID for a goods
source (`source_po_union`), MUTED for a raised PO (`converted_po_nos`, filtered
against the source set so a PO is never chipped twice), each with its own
tooltip. It is a LIST surface, so it caps at `PO_CELL_MAX` (3) and appends a
`+N` chip whose title lists every PO — many-POs-to-one-SO is real (12 Houzs SOs
carry 2, one carries 3) and must never render only the first in silence. `—`
now means "no purchase order of any kind", which is what a reader assumes it
means. `getValue` (search / export) returns the same combined list the cell
renders.

One derivation for both surfaces: `frontend/src/lib/soPoChips.ts`
(`poCellChips` + `PO_CELL_MAX`, pure). Desktop renders it via `SoListPoCell` in
`components/SoSourceChips.tsx`; the mobile Orders card via
`SourcePosRowMobile`'s `raised` slot (`mobile/source-chips.tsx`, row omitted
when empty — card idiom, and the `+N` cap is a list-cell rule so the phone
wraps the full list instead). Render tests for both surfaces:
`frontend/src/components/SoListPoCell.test.tsx`. No backend change was needed —
`converted_po_nos` was already on the list payload.

**LINE "SPECIAL:" segment — one request prints once (2026-08-11).** The
migrated-corpus backfill (`backfill-specials-into-variants.mjs`, PRs
#1926/#1940) is deliberately MERGE-ONLY and machine-asserts that it never
removes a pre-existing entry, so `variants.specials` legitimately holds BOTH
the parser's glued phrase and the picker code derived from it — and
`buildVariantSummary` printed both (`SPECIAL: BACKCUSHIONCHANGE8030 + Change
8030 Backcushion + Wooden Arm`). The stored data is correct; the doubled
RENDERING was the defect, and it is resolved at the display layer only:
`foldRedundantSpecials` in `scm/shared/variant-summary.ts` hides an entry when
another entry in the same list is a strictly richer twin of it. Deliberately
narrow — only a SINGLE-TOKEN (machine-glued / fragmentary) entry is ever
hideable, so an operator's multi-word request can never be suppressed. Measured
on production: **216 of 1,051** lines carrying specials rendered a redundant
twin (0 emptied, 0 live picker codes lost); **26 more** carry a SEMANTIC pair
(`NOSTICHINGINSITTINGAREA` beside `No notch on Seat Cushion`) that needs the
owner's phrase ruling and is deliberately left alone — see BUG-HISTORY for why
the phrase map was NOT vendored into the runtime bundles.

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

### The downstream lock — and why AutoCount cares

An SO with any non-cancelled Delivery Order or Sales Invoice against it cannot
be cancelled and its lines cannot be edited (`soHasDownstream`, 409
`so_has_downstream`). Emitting the NEXT DO is still allowed — only mutation and
cancel are blocked.

Owner, 2026-08-10, on the AutoCount cutover:
*"已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"*.
AutoCount refuses to cancel or edit a transferred document, so the ERP must
refuse the same or the two systems disagree the first time someone edits a
shipped order — with the ERP wrong, because the stock has already moved.

`soHasDownstream` used to be a private copy inside this router; it now lives in
`backend/src/scm/lib/downstream-lock.ts` with its PO / DO / GRN siblings, same
signature and same JSON, and is unit-tested for the first time. Every SO
mutation that gets past it also queues an ERP -> AutoCount edit — see
`docs/modules/autocount-writeback.md`.

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

### Every line is a catalog SKU — free text never saves (owner rule 2026-08-08)

> Owner, verbatim, on HC-SO-2607-013's line "Square pillow Col: BO315-22":
> *"为什么会有这样的 sku square pillow 你可以允许 freetext 的吗!?"*

**The rule.** Every SO line names a REAL catalog SKU (`scm.mfg_products`,
company-scoped — see "Looking a product up by CODE" below). Typed text that
matches nothing can never become a row. Enforced at TWO layers:

**Insert layer** (every path that writes `mfg_sales_order_items` rows —
create / add-line / PATCH code change / tbc-swaps / amendment submit+apply;
the free-gift and delivery-fee writers already draw their codes FROM the
catalog; the 2990 mirror is a verbatim historical copy and is exempt):

| shape | verdict |
|---|---|
| non-blank code not in the company catalog | `409 unknown_item_code` (`validateItemCodes`) |
| non-blank code, INACTIVE, on a NEW pick (create / add-line / a PATCH that CHANGES the code / amendment ADD) | `409 unknown_item_code` with `inactive` — the picker only offers ACTIVE, so an INACTIVE arrival did not come from the UI. An UNCHANGED code on a line edit stays existence-only, so discontinued-SKU history remains editable |
| blank code + typed description (the square-pillow shape) | `409 so_free_text_line` — refused on EVERY create, draft or not |
| blank code + blank description | the scan pipeline's "Pick a product…" placeholder — allowed on DRAFT creates ONLY; the confirm gate below stops it there |

**Confirm gate** (`lib/so-confirm-gate.ts`) — runs on DRAFT→CONFIRMED
(`PATCH /:docNo/status`) and on every create that lands directly CONFIRMED
(`asDraft !== true`, i.e. desktop New SO / mobile wizard / POS handover /
from-products). Aggregated `validation_failed` + `problems[]` (HTTP 422, the
same contract as the Processing-Date gates), all reasons at once:

| problem | rule |
|---|---|
| `so_line_no_product` / `so_line_not_catalog` | every non-cancelled line resolves in the SO's own company catalog |
| `salesperson_required` | `salesperson_id` OR the legacy `agent` text set (HC-SO-2607-008 confirmed as "Unassigned") |
| `venue_required` | `venue` text OR `venue_id` set (owner: *"venue is compulsory的"*). No venue-less order class exists in code — venue-binding's "empty is honest" rule governs AUTO-resolution only; when it resolves nothing, confirm demands a human pick |
| `variants_incomplete` | every goods line's required axes via `missingConfirmVariantAxes` (shared, both frontends + backend): sofa Seat Height + Fabrics, bedframe Divan/Leg/Gap/Fabrics. **Colour-KIV satisfies the fabric axis** — KIV blocks the Processing Date (2026-07-24 rule), never confirm. Mattress / accessory / service / others carry no axes |

**Who may write which key of the `variants` jsonb.** The column has several
writers and no schema, so ownership is by convention and the convention is
enforced in code:

| keys | owner |
|---|---|
| `fabricId` / `colourId` / `fabricCode` / `colourLabel` / `fabricLabel` / `gap` / `divanHeight` / `legHeight` / `totalHeight` / `size` | the AutoCount re-parse sweeps — `OWNED_VARIANT_KEYS` in `backend/scripts/lib/variant-merge.mjs` |
| `specials` (and the HOOKKA singular `special`) | `backend/scripts/backfill-specials-into-variants.mjs`, the only writer with the money guard — a picked add-on's surcharge folds into the authoritative unit price, so stamping a PRICED code reprices a historical document |
| everything else (POS configurator, line editors) | its own writer |

A sweep MERGES its patch (`variants = variants || patch`) and never rebuilds the
object; rebuilding deletes every key it has not heard of. `custom_specials` is a
DERIVED output of the pricing recompute and is written by no script at all.

Drafts stay freely saveable — the scan pipeline still lands imperfect drafts;
what changed is that they can no longer BECOME orders until resolved.
ON_HOLD-resume and reopen re-enter CONFIRMED without re-gating (legacy orders
must not strand).

**Frontend twins (change together).** Desktop `SoLineCard` marks unmatched
typed text with a red ring + "Not in the catalog" note (the text stays for
correction; the parent save guards refuse the line). `SalesOrderNew` +
`MobileNewSO` pre-check variants (confirm rule, KIV-exempt) / venue /
salesperson on Create — Save-as-draft skips all three. The mobile headless
scan-draft path (`createDraftFromPrefill` → `buildItemBody`) sends an
UNPICKED line's description as '' (the desktop clean-placeholder rule,
2026-07-13) — it used to send the raw slip text, which is exactly how the
square pillow saved. `MobileSODetail`'s Create Sales Order and the desktop
DRAFT banner / list Confirm surface the refusal list via the existing
`humanApiError` problems rendering.

**A DRAFT never carries a Processing Date** (owner 2026-08-08 addendum,
2990-SO-2608-007 — `internal_expected_dd` equal to its SO date). The only
silent stamper was the backend scan job (`buildDraftSoBodyFromSlip`'s
2026-07-04 "slip delivery date ⇒ pin processing to today" rule, now
superseded): scan drafts land with BOTH dates null, and the operator keys the
pair at review (the create core's both-or-none pairing rule forbids carrying
the slip's delivery date alone; the mobile headless scan draft was already
dateless). The desktop Save-as-Draft's visible Processing Date FIELD is an
explicit operator entry and still saves. Confirm deliberately stamps NO
processing date: setting one is its own gated act (deposit threshold,
variants, KIV, customer completeness, delivery-date pairing) and an
auto-stamp at confirm would bypass every one of those gates. The
processing-date LOCK was verified to ignore DRAFTs on both ends
(`soProcessingLocked` / `procLockActive` both short-circuit on status DRAFT,
and every backend caller passes `status`), so a stamped draft misleads — it
does not lock.

**Existing damage** (pre-guard rows): Actions → **SO non-catalog lines check
(read-only)** (`backend/scripts/check-so-noncatalog-lines.mjs`) lists every
non-catalog line, confirmed order without salesperson / venue, confirmed
line with incomplete variants, and DRAFT carrying a Processing Date — with a
TEST? hint for the "Jalan Test" batch. Deliberately NO auto-repair: each row
needs a human to pick the right SKU / salesperson / venue / dates.

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

### Delivery fee — every ringgit is a line (owner ruling 2026-08-07)

> Owner, verbatim intent: *"正常来说,全部都会有 SKU 的,不可能没有 SKU,一定要有
> SKU 才可以 … 怎么可以走后门呢?"*, reinforced the same day: *"无论是 POS
> 系统也好,什么情况也好,它一定要有这一个 SKU 出来"* — **every ringgit on a
> Sales Order is a LINE (SKU) row, on EVERY path, no exceptions.** The delivery
> fee's one correct shape is an `SVC-DELIVERY*` service line (e.g.
> 2990-SO-2608-005: `SVC-DELIVERY qty 1 MYR 250.00`, inside the subtotal). The
> header `delivery_fee_centi` column is a dual-write MIRROR of those lines — it
> may only ever equal Σ(SVC-DELIVERY* lines), **never carry money the lines
> don't**. A fee that reaches the TOTAL without a line is a back door and must
> not exist.

**One derivation, one write path.** The fee amount is owned by the pure
`computeSoDeliveryFee` (`scm/shared/pricing.ts` — the base is
`delivery_fee_config.base_fee` for the SO's company, whole-MYR ×100 → sen: the
familiar RM250), decomposed into line specs by `buildDeliveryFeeServiceLines`
(`scm/shared/service-lines.ts` — Σ lines === fee.total by construction), and
written by exactly one primitive: the atomic RPC
`scm.rebuild_mfg_so_delivery_lines` (migration **0214**: per-doc advisory xact
lock, delete → insert → header stamp in one call — the duplicate-fee race fix).

**Path inventory — how each SO-producing path satisfies the ruling:**

| path | fee? | how the line is guaranteed |
|---|---|---|
| **POS handover create** (`applyDeliveryFee` — the ONLY sender of a fee at create) | yes | `createSalesOrderCore`: `computeSoDeliveryFee` → `buildDeliveryFeeServiceLines` specs pushed into the SAME item insert as the goods; header fee dual-written equal to Σ(specs); a failed item insert deletes the whole header — the fee and its lines land together or not at all |
| **Desktop New SO / mobile New-SO wizard** | no | neither sends `applyDeliveryFee`; fee = 0, no line needed, header 0 |
| **Scan/OCR draft → create** (`buildDraftSoBodyFromSlip` / shell) | no | never sets `applyDeliveryFee`; the draft lands fee-less — an operator later triggering a fee does so through edits, which derive below |
| **Every line add / patch / delete** | re-derive | `rederiveDeliveryFee` → `recomputeDeliveryFeeCore` → 0214 RPC (stored cross-category source passed through) |
| **Customer change** | re-derive | `redetectCrossCategoryDelivery` → same core (re-runs the auto-match) |
| **Amendment apply** | re-derive | `applySoAmendment` → `rederiveDeliveryFee` |
| **2990 mirror import** (pre-cutover history) | verbatim copy | whatever shape 2990 held — the one path that could legitimately leave a header-only fee; those rows are exactly what the detector lists and the repair itemises |

**The bail rule (the 2990-SO-2608-006 fix).** `recomputeDeliveryFeeCore` bails
(derives nothing) only when the SO has **no `SVC-DELIVERY*` lines AND no header
`delivery_fee_centi`** — the dormant-fee rule: backend-authored SOs never grow
a fee. It used to bail on "no fee lines" alone, which was half of a back door
AND a heal-blocker: deleting/cancelling the fee line orphaned the header
snapshot, the derivation turned itself off forever (a fee-line-less SO could
NEVER be healed by any recompute, no matter how many edits followed), and
`recomputeTotals`' legacy line-less fallback kept folding the snapshot into
the total — 006 read subtotal RM0 / total RM250 with no line saying why. Now
an orphaned header fee is **re-materialised as lines through the same
derivation** on the next edit — the recompute no longer depends on a fee line
already existing; deleting a derived fee line is therefore a no-op — the way
to change the fee is to change what drives it (the items, the rate config, or
the `SVC-DELIVERY-ADD` operator line).

**The legacy fallback.** `recomputeTotals` still reads the header fee back for
a line-less SO — that exists ONLY for legacy (pre-P2 / mirror-imported) rows
and may not be deleted until Loo retires the column (SO-SKU spec §5 P6).
Integrity tooling: `backend/scripts/check-so-fee-line-integrity.mjs` (read-only
detector: every non-cancelled SO where total ≠ Σ(lines), with audit-log
evidence) + `repair-so-fee-line-integrity.mjs` (DRY-RUN gated; materialises the
missing line via the same 0214 RPC — total never changes, only itemises), both
behind the **SO fee-line integrity check (read-only)** workflow. Tests:
`backend/tests/soDeliveryFeeLineIntegrity.test.ts`.

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

   Branding truth lives in `scm.mfg_products.branding` (stamped onto lines by
   `derive-line-branding.ts`; `product_models` feeds `generate-skus`). Owner
   2026-08-08: HC sofa = **Zanotti**, 2990 sofa = 2990's own brand; drifted
   'Houzs'/blank rows are repaired by **HC sofa branding fix (Zanotti)**
   (`fix-hc-sofa-branding.mjs`, DRY-RUN gated, #1723).

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

### What an approved amendment does to the LINE PRICE

Approving an amendment re-runs the honest-pricing recompute on every changed
line (`so-revision.ts` -> `recomputeOneLine`), and that recompute is
**authoritative by default**: it rewrites `unit_price_centi` to
`mfg_products.sell_price_sen` (+ fabric-tier delta + extras). That is deliberate
for a NATIVE order — the catalogue is the truth for an order this ERP priced —
and it applies even to a QTY-ONLY amendment, because the recompute is per-line,
not per-changed-field.

**A MIGRATED order is exempt.** When the SO header carries `linked_ac_docno`
(migration 0271 — the marker that actually exists; `migrated_no_stock` lives only
on `scm.grns` / `scm.delivery_orders`, never on the SO or PO header), the apply
passes `trustOperatorSelling: 'including-zero'` and the stored price is kept. Two
reasons, both money:

- that unit price is what AutoCount recorded as negotiated with the customer, and
  `sell_price_sen` is in no sense a better answer for an order this ERP never
  priced;
- `'including-zero'` rather than plain `true` because a migrated sofa is
  routinely carried as the **whole-set price on ONE lead module line with 0 on its
  siblings**. Plain trust reads a stored 0 as "not provided" and hands the sibling
  a catalogue price anyway, which bills the set several times over.

If a migrated line's price genuinely must change, the amendment carries
`new_unit_price_sen` and THAT is what persists — a SPEC change alone does not
re-price a migrated line.

Note the reachability gate: a migrated SO is only `amendment_eligible` once it is
processing-locked, and the importer does not set `internal_expected_dd`, so today
most migrated orders cannot reach this path at all. The exemption exists so that
giving one a Processing Date does not silently destroy its price later.
