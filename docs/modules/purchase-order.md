# Module: Purchase Order (SCM)

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. Sibling of `sales-order.md`; the PO is the
BUY side of the same doc-machinery (list hook → `/api/scm/<doc>` handler →
`scm.<doc>` tables).

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.
>
> Line references are against `main` @ `8f8427ed`.

Doc-flow position: **SO → PO → GRN → PI**. The PO is the only document in that
chain that moves **no stock at all** (see §5).

---

## Decision (owner, 2026-08-06): soft until DO, hard from DO

Before a Delivery Order exists, ALL supply-demand matching belongs to the
floating MRP allocator — pooled by (warehouse, item_code, variant_key),
constrained by one-batch-per-SOFA-set (bedframes exempt), ordered by delivery
date then doc_no. Nothing persisted before the DO may bind execution:
`purchase_order_items.so_item_id` and the mig-0235 allocation sub-lines are
**procurement provenance** — they record why we bought, they are displayed and
audited, and they influence NO cap, NO batch expectation, NO coverage
precedence.

At DO creation the allocator decides binding **live** — including which incoming
PO batch a ship-before-arrival commits to — and records it on the DO line
(`committed_po_batch_no`, mig 0230). From that moment everything is anchored
history: committed batches, OUT movements, lot consumptions, COGS, delivered
attribution. Post-DO records are never recomputed from provenance, and
provenance is never "hardened" into them.

A stored-link-vs-delivered divergence is therefore NOT a defect; a double-SERVE
in the delivered ledger IS. Do not reintroduce the stored link into any
execution path — that is the pre-2026-08 model this decision retires, and the
parked branch `wip/harden-so-po-link-parked` (which hardens the MRP pick INTO
the link) is formally ABANDONED by this decision; do not resurrect it.

Rollout is staged (lenses/docs → DO-time live allocator → pooled caps →
display demotion); until every stage lands, the transitional guard remains:
rejecting an SO-revision follow-up auto-releases the PO to STOCK.



### Why — the owner's business case (2026-08-06, verbatim intent)

Customise moves from Make-to-Order to **Make-to-Stock**, possible because every
SKU now carries its variant identity — a PO can order spot stock against a
specific (SKU, variant), and an incoming SO simply gets allocated.

1. **Cheaper procurement** — order ahead in bulk, negotiate the supplier down.
2. **No dead-stock risk from mistakes** — a mis-ordered spec is not dead goods:
   clear the order and the PO's units re-assign to the next identical demand
   automatically.
3. **Automated matching** — no more CS hand-matching after a mistake; sell the
   identical thing and the SO auto-assigns on open, straight to READY.
4. **Delivery flexibility** — spot stock ships early when the customer wants
   it; a rush order takes from the pool and the next PO backfills.

Every surface must present this model: the execution chains (SO→DO→SI,
PO→GRN→PI) are anchored facts; every pre-DO PO↔SO pairing is floating and
visibly live — including the Relationship Map, which "会跳动" by design.

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx` | Server-paginated, `pageSize = 50` fixed (`:584`), page index in `?page=`. Renders the server page verbatim — no client re-filter. |
| Desktop detail (read) | `frontend/src/pages/scm-v2/PurchaseOrderDetailV2.tsx` | **READ-ONLY by design** (`:334`). A thin router: `?edit=1` forwards to the legacy editor (`:351`). |
| Desktop detail (edit) | `frontend/src/pages/scm-v2/PurchaseOrderDetail.tsx` | The inline editor + the SO-amendment "Revision ready" banner + Revisions tab. Lazy-loaded (`PurchaseOrderDetailV2.tsx:341`). |
| Desktop new | `frontend/src/pages/scm-v2/PurchaseOrderNew.tsx` | |
| Desktop from-SO | `frontend/src/pages/scm-v2/PurchaseOrderFromSo.tsx` | Multi-select picker over `/outstanding-so-items`. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | Generic screen; the PO config is `MODULE_CONFIGS["mfg-purchase-orders"]` (`:1198-1237`). |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Generic; PO config `:354`, PO status actions `:515-532`. |
| Mobile convert (SO→PO) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "po"` (`:75`). |

Desktop routes are declared in `frontend/src/App.tsx:516-519`, all behind
`<ScmGuard area="scm.procurement.po">`.

### Data hooks
`frontend/src/vendor/scm/lib/suppliers-queries.ts` — the PO hook block was
vendored into the Suppliers slice, **not** a `purchase-order-queries.ts` (see the
banner at `:487-494`). This is the single most common wrong guess about this module.

- `usePurchaseOrdersPaged({page,pageSize,status,supplierId,q,sort})` (`:523`) — what
  the desktop list actually uses.
  - `queryKey: ['mfg-purchase-orders-paged', page, pageSize, status, supplierId, q, sort]`
  - `placeholderData: (prev) => prev`, `staleTime: 30_000`.
  - Returns the whole envelope so the page can read `.purchaseOrders` **and**
    `.statusCounts`.
- `usePurchaseOrders({status?, supplierId?})` (`:496`) — the legacy unpaginated
  hook, `queryKey: ['mfg-purchase-orders', status ?? 'all', supplierId ?? 'all']`.
  Still used by `GrnNew.tsx:156`.
- `usePurchaseOrderDetail(id)` (`:542`) — `['mfg-purchase-order-detail', id]`,
  `enabled: Boolean(id)`.
- `fetchPurchaseOrderDetail(id)` (`:555`) — plain non-hook fetch for batch print.
- `useOutstandingSoItems()` (`:627`) — `['mfg-purchase-orders', 'outstanding-so-items']`.
- Mutations invalidate `['mfg-purchase-orders']` (e.g. `:693`, `:842`) and force a
  refetch of the picker key (`:845`).

### Caching / loading behaviour
Same three layers as the SO module (`docs/modules/sales-order.md` §1), with two
PO-specific facts:

1. **The paged list is NOT persisted to localStorage.**
   `frontend/src/lib/query-persist.ts:92-98` whitelists the entity
   `"mfg-purchase-orders"`; the desktop list's key is
   `"mfg-purchase-orders-paged"`, which is a *different* first segment and so
   fails `isListKey` (`:113`). A cold open of the PO list therefore shows a real
   load, unlike the SO list.
2. **Mobile's shared-invalidation entry omits the paged root.**
   `frontend/src/mobile/sharedInvalidate.ts:71` maps `"mfg-purchase-orders"` to
   `["mfg-purchase-orders", "mfg-purchase-order-detail"]` — no
   `"mfg-purchase-orders-paged"`, unlike the DO / SI / GRN entries either side of
   it (`:69-72`). A mobile PO status change does not invalidate the desktop
   paged list. Stated as observed, not as a recommendation.

---

## 2. API surface

All under `backend/src/scm/routes/mfg-purchase-orders.ts`, mounted at
`/api/scm/mfg-purchase-orders` (`backend/src/scm/index.ts:237`) behind
`scmAreaGuard('scm.procurement.po')` (`:236`) — GET needs `view`, writes need
`edit` on that area.

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/` | `:374` | List. `?page=` opts into pagination + `statusCounts`; without it the legacy `{ purchaseOrders }` array. |
| GET | `/outstanding-so-items` | `:537` | SO lines still convertible (`qty - po_qty_picked > 0`) — the From-SO picker. |
| GET | `/:id` | `:693` | Header + items + `has_children`. |
| GET | `/:id/linked` | `:859` | Downstream GRNs / PIs / PRs (three parallel reads). |
| GET | `/:id/revisions` | `:896` | `po_revisions` snapshots for the Revisions tab. |
| GET | `/so-line-candidates?code=` | (static, pre-`/:id`) | SO lines carrying this item code, INCLUDING picked/delivered ones — the allocation editor's picker (historical consolidated POs are the point; the shortage view hides exactly those). Excludes cancelled lines + cancelled/draft SOs. |
| GET | `/:id/items/:itemId/allocations` | | The line's allocations + `lineQty` + `poNumber` (mig 0235). |
| POST | `/:id/items/:itemId/allocations` | | Add one slice `{ qty, soItemId\|null }` (null = STOCK). seq auto-assigned dense. |
| PATCH | `/:id/items/:itemId/allocations/:allocationId` | | Edit a slice (`qty?`, `soItemId?` — explicit null → STOCK; absent keeps). |
| DELETE | `/:id/items/:itemId/allocations/:allocationId` | | Remove a slice + resequence the survivors dense 1..n. |
| GET | `/:id/items/:itemId/photos/:photoKey/signed` | | Trade one key from the line's `photo_urls` for a short-lived signed R2 GET URL (`{ mode:'signed', signedUrl, thumbUrl, expiresAt }`). Falls back to `{ mode:'proxy', proxyPath, … }` — never 500 — when signing is impossible. READ-ONLY — see §4 *Line photos*. |
| GET | `/:id/items/:itemId/photos/:photoKey` | | PROXY: streams the object from the R2 binding, no S3 credential needed. Same authz as `/signed`, company scoping included. Behind the auth gate, so NOT usable as a bare `<img src>` — see §4 *Line photos*. |
| POST | `/` | `:911` | Create (`asDraft: true` → DRAFT, else SUBMITTED). SO-sourced lines (carrying `soItemId`, e.g. the desktop New-PO-from-SO flow) are capped at the SO line's remaining (`qty - po_qty_picked`): over-convert → 409 `qty_exceeds_remaining` unless `confirmOverConvert: true` (pre-write guard, marks idempotency no-write). Manual lines (no `soItemId`) unaffected. |
| POST | `/from-sos` | `:2139` | Batch convert whole SOs; groups by supplier, can emit N POs. |
| POST | `/:id/convert-from-so` | `:2694` | Append SO lines onto an existing PO. |
| PATCH | `/:id` | `:2219` | Header edit. |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | `:2400` / `:2504` / `:2619` | Line CRUD. |
| PATCH | `/:id/submit` | `:2904` | Legacy no-op/echo — returns 409 unless already SUBMITTED. Also 409 `purchase_location_id_required` if the PO has no ship-to warehouse (2026-08-02). |
| PATCH | `/:id/confirm` | `:2998` | **The commit**: DRAFT → SUBMITTED. Blocked 409 `purchase_location_id_required` (via `poWarehouseGap`) if the header `purchase_location_id` is blank AND any line has no `warehouse_id` — a warehouse-less PO can't go live because its GR would receive into the wrong warehouse (owner 2026-08-02). |
| POST | `/:id/send-to-supplier` | `:3019` | Email the PO PDF. Fail-closed on the `purchase_order` email channel (`:3032`). |
| PATCH | `/:id/cancel` | `:3182` | → CANCELLED; releases SO quota AND clears the line's mig-0235 allocation sub-lines (a cancelled PO attributes nothing — 2026-08-02). |
| PATCH | `/:id/reopen` | `:3276` | CANCELLED → SUBMITTED; re-claims SO quota. Allocation sub-lines are NOT restored (they were cleared on cancel); the coarse `so_item_id` link remains, re-split via the allocation editor if needed. |

**There is no document-level DELETE.** `DELETE /:id` existed until 2026-08-11 and
hard-purged a CANCELLED PO. It was removed under the owner's rule
不可以删只可以 cancel: a PO is cancelled, never deleted. `PATCH /:id/cancel` is
the terminal action and the row stays, which is also what makes an AutoCount
reconcile possible — a purged PO has nothing to reconcile against. Line-level
`DELETE /:id/items/:itemId` and the allocation DELETE are unaffected; so are the
create-time rollback deletes inside `POST /` and `POST /from-sos`, which remove a
document that never successfully existed (supabase-js has no transaction, and
they are the only thing preventing a headerless orphan).

Auth note (same as SO): inside `/api/scm/*`, `user.id` is the caller's **scm.staff
UUID**; use `houzsUser.id` for the public bigint.

---

## 3. Backend

### The list handler — `mfgPurchaseOrders.get('/')` (`:374-520`)

1. **Select** (`:387`) — one PostgREST query with three embeds:
   `supplier:suppliers(...)`, `items:purchase_order_items(material_code, material_name, qty)`
   (the per-row item summary), and `purchase_location:warehouses!purchase_location_id(...)`.
2. **Two paths, chosen by the presence of `page`** (`:394-395`).
   - Legacy (`:404-419`): `order po_date desc, created_at desc`, `.limit(500)`,
     `status` matched against `VALID_STATUSES` (`:285`), optional `supplierId`,
     `scopeToCompany`.
   - Paginated (`:420-483`): `pageSize` clamped to 1..100 (default 50), sort
     whitelist `po_date | po_number | status | total_centi` (`:426`) with
     `po_number` as the unique tiebreaker (`:433`), bucket resolution via
     `PO_STATUS_BUCKETS` (`:292-298`), `q` ilike over `po_number` + `notes` only
     (`:448` — supplier name is an embedded resource and cannot be `ilike`d),
     `from`/`to` on `po_date`, `.range(...)`.
   - `statusCounts` = seven `head:true count:'exact'` queries in one `Promise.all`
     (`:467-474`), over the same company + supplier filter but **without** status,
     search or paging. (Seven, not six: the `outstanding` roll-up is counted
     separately rather than derived, so the pill and the filter share one source.)
3. **Enrichment — exactly ONE extra query** (`:496-512`): all non-cancelled GRNs
   for the listed PO ids, carrying `id` + `grn_number`. It powers both
   `has_children` (the downstream lock) and the "GRN No" column, so the two are
   one round trip. `transfer_to_grns` is `{ id, grnNumber }[]` — the id is what
   lets the column link to `/scm/grns/:id`.
4. **Assemble** (`:513-517`) — `has_children` + `transfer_to_grns` +
   `assigned_sos` / `assigned_so_linked` (`resolvePoSoCoverageForPos`) +
   **`delivered_dos`** (`resolveDeliveredDosForPos`) stamped per row; response is
   `{ purchaseOrders }` or `{ purchaseOrders, total, page, pageSize, statusCounts }`.
   The **Delivered** column = the DO(s) that shipped this PO's goods
   (`batch_no` = PO number, CANCELLED DOs excluded) + qty per DO; drill-down
   per-SKU via the single-doc `delivered` field, whose chips carry `soDocNo`
   since 2026-08-02 — the drill renders a PAIRED per-SO sub-table (one row per
   assigned SO: SO chip | delivery date | that SO's delivered DOs xqty |
   DELIVERED/PENDING) instead of three parallel stacks; a line/header with no
   assignment reads a subtle **"STOCK"** tag, never a bare dash (surplus stock
   — MRP layer (c) float-assigns automatically when matching demand appears).
   Duplicate ORDERS (same supplier + identical line multiset within days —
   the 2990-PO-2606-023/-024 incident) are the province of the read-only
   **Duplicate documents check** workflow; an unexecuted duplicate inflates MRP
   incoming supply until cancelled. See
   `docs/modules/document-traceability.md` §2.5 + §2.9 (owner 2026-07-31 /
   2026-08-02).

### Main mutation paths

- **Create** (`:911`). `asDraft === true` lands `status: 'DRAFT'` with
  `submitted_at: null` (`:1065-1071`); otherwise SUBMITTED. `recomputeSoPicked`
  runs only on the non-draft path (`:1142`). Both create paths delete the header
  again if the line insert fails, which is why `recordPoCreate` (`:174`) re-reads
  the persisted row instead of echoing the payload.
- **Confirm** (`confirmMfgPurchaseOrderHandler`, `:2928`). DRAFT → SUBMITTED:
  stamps `submitted_at`, writes a `POST` audit row, then runs `recomputeSoPicked`
  best-effort (`:2983-2989`). Idempotent on SUBMITTED / PARTIALLY_RECEIVED
  (`:2943`); rejects anything else with 409.
- **Cancel** (`:3182`). Refuses RECEIVED (`:3200`); idempotent on CANCELLED;
  then two locks — `poHasDownstream` (`:3208`) and `poHasOutstandingDropshipOut`
  (`:3214`). Releases every converted SO line's quota via `recomputeSoPicked`
  (`:3251-3259`).
- **Reopen** (`:3276`). CANCELLED → SUBMITTED only (`:3294`); re-claims the quota.
- **Delete** — GONE (2026-08-11). CANCELLED is terminal. The removed endpoint's
  own comment called the audit row it left behind "the ONLY remaining evidence
  that the PO existed", which is the argument against it, not for it.

### The two guards worth knowing

- `poHasDownstream(sb, poId)` (`:226-235`) — any non-cancelled GRN on this PO ⇒
  header edit, line add/edit/delete and cancel all 409. Convert-to-GRN is
  deliberately **not** gated, so partial receiving keeps working.
- `poHasOutstandingDropshipOut(sb, poNumber)` (`:252-283`) — reads
  `inventory_movements` for `OUT / source_doc_type 'DO' / batch_no = this PO's number`.
  A drop-ship DO ships against the PO's *expected* batch before receipt; cancelling
  the PO would strand that OUT with no incoming batch. Best-effort: a read error
  or a missing `batch_no` column returns `null` (no block).
- `SO_UNORDERABLE_STATUSES = {DRAFT, CANCELLED, ON_HOLD}` (`:312`) — a PO line
  sourced from an SO in any of those is refused (`firstUnorderableSo`, `:313`).
  A purely manual line with no SO link skips the check entirely.

### Binding a PO line to its source SO line (`so_item_id`)

`so_item_id` is what lets a shipment resolve its incoming PO: `dropship-batch.ts`
finds the expected batch through it, `/po-so-coverage` treats it as the STATIC
link, and `recomputeSoPicked` counts from it. Measured on prod 2026-07-31, **67
of 101 live PO lines carried none** — the From-SO and convert-from-SO paths stamp
it, but a hand-typed line never could.

- **`POST /:id/items`** has accepted `soItemId` / `so_item_id` since an earlier
  audit fix, and now also runs `recomputeSoPicked` for the line it binds.
- **`PATCH /:id/items/:itemId`** accepts it too (2026-07-31), so an already-saved
  line can be bound or unbound. Partial-PATCH semantics: an **absent** key keeps
  the stored link; an explicit `null` / `''` **unbinds** (a genuine stock
  replenishment PO must stay valid). Both the previous and the new SO line are
  re-counted so quota moves with the link.
- Both writes go through `soLinkTargetRefusal` — the SO line must exist **in the
  active company**, must not be cancelled, and its `item_code` must equal the PO
  line's `material_code`. Otherwise `404 so_line_not_found`,
  `409 so_line_cancelled` or `409 so_link_material_mismatch`.
- **UI:** the PO detail edit grid's `PoLineCard` renders an optional *Source
  Sales Order line* picker plus a `SO LINKED` / `NOT LINKED` badge. Candidates
  come from the existing `GET /mfg-purchase-orders/outstanding-so-items` shortage
  view (the same source the From-SO picker and `MobileConvertWizard` read),
  filtered to the line's own SKU; the parent (`PurchaseOrderDetail`) selects them
  and passes `soLinkOptions`, so the card never fetches and Create / the PI reuse
  are unchanged. **No mobile counterpart** — mobile's PO surface
  (`MobileModuleList` / `MobileModuleDetail`) is list + header only and has no
  per-line editor at all.

### Splitting one line across several SOs — allocations (mig 0235)

`so_item_id` is single-valued, and a CONSOLIDATED purchase breaks it: one
supplier line covering several customers plus stock (live case
`2990-PO-2606-023` — ONE qty-5 MAKOTO line = SO-036 x1 + SO-029 x1 + 3 stock)
has NO correct single value, which is exactly why the backfill below refused
those lines. The owner's chosen fix (2026-08-01) is the sub-table
`scm.purchase_order_item_allocations`: 1-based sub-numbered slices per line
(`PO-2606-001-01`, `-02`, ...), each `(qty, so_item_id | NULL)` — NULL = stock.

The rules, all enforced in the write path AND by DB triggers (the app check is
check-then-insert over PostgREST with no transaction, so the triggers are the
concurrency backstop — `fn_po_item_alloc_guard` locks the parent line FOR
UPDATE; `fn_po_item_qty_guard` catches every OTHER qty writer, amendment
revisions included):

- `qty` is a positive integer and **SUM(slices) <= line qty** — 409
  `allocation_exceeds_line_qty` carrying `lineQty/allocatedQty/remainingQty`.
  The line PATCH refuses a qty SHRINK below the allocated sum
  (`line_qty_below_allocated`).
- an SO target passes the SAME `soLinkTargetRefusal` gate as the line-level
  bind (company-owned, not cancelled, `item_code` = the line's
  `material_code`).
- `seq` is auto-assigned dense 1..n; DELETE resequences survivors (ascending,
  so the UNIQUE `(item, seq)` can never collide mid-move).

**Semantics vs the single link.** A line WITHOUT allocations keeps the
`so_item_id` 1:1 fast path — nothing existing changes. A line WITH allocations:
they are the AUTHORITATIVE finer-grained answer; `/po-so-coverage` layer (b)
reads the allocations' so_item_ids INSTEAD of that line's `so_item_id` (never
both — no double count; an all-stock split therefore overrules a stale single
link entirely). See `docs/modules/document-traceability.md` §2.4.

**What allocations are NOT.** Attribution metadata only: no stock, no money,
no quota — `recomputeSoPicked` still counts ONLY `purchase_order_items
.so_item_id`, MRP layer (c) and delivered layer (a) are untouched. That is why
allocation writes are deliberately NOT behind `poHasDownstream` and stay
allowed on RECEIVED POs (the 8 contended historical lines are all received;
originally left for a hand split, now covered by the gated FIFO attribution
below — owner ruling 2026-08-01, "你根据FIFO 就没问题了啊"); only CANCELLED
refuses. Known gap, accepted:
`so-line-relink.ts` (TBC swap) does not carry this table, so a swap on an
allocated line degrades its slices to STOCK via the FK's ON DELETE SET NULL —
the UI shows the degradation honestly.

**UI.** Desktop: the read-only `PurchaseOrderDetailV2` line table gains an
**Allocations** column — chips `PO-xxxx-yy-01 -> 2990-SO-xxxx (qty 2)` /
`... -> STOCK (qty 3)` (solid = customer, dashed = stock) + a Split button per
line opening `PoLineAllocationsModal` (immediate-mode editor: qty + SO picker
per slice, picker fed by `/so-line-candidates`; refusals shown verbatim). It
lives on the V2 READ page, not the `?edit=1` editor, because the editor locks
on received POs. Mobile: `MobileModuleDetail`'s `LineItem` renders the same
chips display-only (documented precedent — the phone PO surface has no
per-line editor). Writes ride the router's `scm.procurement.po` edit gate.

### Backfilling `so_item_id` on historical lines — the evidence tiers

`backend/scripts/backfill-po-so-item-links.mjs` (workflow **Backfill PO -> SO
item links**) stamps the links history never recorded. It is DRY-RUN unless
`apply=1`, runs in one transaction, and is idempotent — a stamped line is no
longer unlinked, so a re-run plans zero rows. Run it **after** *Repair 2990 doc
references*: Tier 1 joins batches to `po_number`, and while the 2990 batches
still name pre-import numbers that join silently finds nothing.

Three tiers, in precedence order — a weaker inference can never overwrite a
stronger one, because each tier treats the previous tier's plan as already
linked and its SO lines as taken:

| Tier | Evidence | What it proves |
|---|---|---|
| 1 | **Delivered chain.** A DO consumed a lot stamped `batch_no` = this PO number (or its OUT movement carries it); the SO comes from the DO's real `so_item_id`. | A record of what happened, not an inference. |
| 2 | **Note names exactly ONE SO.** The `From SOs:` note written at raise time resolves to one valid, company-owned Sales Order. | With one order there is no question which it served. |
| 3 | **Consolidated PO — code unique across the NAMED SET.** The note names several SOs (one supplier order covering several customers, routine for mattresses). Every free line of every named SO is pooled, then the same 1:1 test runs against the pool. | If exactly one unlinked PO line and one free SO line in the whole set carry the code, no other named order could have absorbed it. |

All three apply the *same* rule from `backend/scripts/lib/po-so-line-pairing.mjs`
— a link is written only when the item code pairs **1:1** (one still-unlinked PO
line, one still-free SO line). Tier 3 widens the candidate pool; it does not
weaken the rule.

Deliberately never written, and why:

- **A code two of the named orders both still want.** Which line served which is
  recorded nowhere. The dry-run prints the full candidate table so a human can
  adjudicate; the script refuses.
- **Anything discriminated only by quantity.** Matching qty-to-qty among
  same-code candidates is an inference about intent, not a record of one.
  Quantities are printed for the reader, never acted on.
- **Anything MRP-derived** (`po-so-coverage` layer (c)). That allocation is
  floating by design — it shifts as demand moves and evaporates on delivery.
  Freezing it into a stored link would turn a live computation into a permanent,
  wrong record. The script never calls the MRP engine.

**The contended remainder — FIFO attribution as ALLOCATIONS (2026-08-01).**
The "code two named orders both still want" refusals are closed by the owner's
stated rule ("为什么要手动分配的 你根据FIFO 就没问题了啊？"): part
`fifo-attribute` on `repair-2990-doc-refs.mjs` (workflow **Repair 2990 doc
references**, `pos` input naming the target POs — default the two contended
ones, `2990-PO-2606-019` + `-023`). The named SOs' free lines sort in
computeMrp's own deterministic order (delivery date ASC, NULL last, doc_no
ASC), PO lines in document order, and a quantity-aware FIFO walk pairs them —
a qty-5 line splits and its remainder books as STOCK. Critically it writes
`purchase_order_item_allocations` rows, NEVER `so_item_id`: a FIFO inference
must stay visibly an allocation, because stamped into `so_item_id` it would be
indistinguishable from a recorded fact — which is the exact reason the tiers
above refused. Idempotent (linked or already-allocated lines skip); one SO
line is never double-served (links and allocations both count as taken). Rule:
`planFifoAttribution`, `backend/scripts/lib/doc-evidence-core.mjs`.

### The SO-quota counter — `recomputeSoPicked` (`:2352-2398`)

Live-count, not arithmetic: it re-sums `purchase_order_items.qty` per
`so_item_id` and writes `mfg_sales_order_items.po_qty_picked`. Two exclusions
matter: lines with `from_mrp === true` never lock the SO line (`:2372`), and
POs whose status is `CANCELLED` **or `DRAFT`** are excluded (`:2384`). Best-effort
throughout — it logs and skips, because the primary write already committed.

---

## 4. Database

Schema `scm`. Baseline DDL: `backend/scripts/scm-schema/2990s-full-schema.sql:1150`
(`purchase_orders`) and `:1103` (`purchase_order_items`); later columns arrive via
`backend/src/db/migrations-pg/`. The authoritative in-code column lists are
`HEADER_COLS` (`mfg-purchase-orders.ts:342-355`) and `ITEM_COLS` (`:357-371`) —
those are what the route actually selects.

| Table | Role |
|-------|------|
| `scm.purchase_orders` | PO header. `po_number` (UNIQUE), `supplier_id`, `status`, `po_date`, `expected_at`, `purchase_location_id` (FK → `warehouses.id`), `currency`, `subtotal_centi` / `tax_centi` / `total_centi`, `submitted_at` / `received_at` / `cancelled_at`, `revision`, `supplier_delivery_date_2..4`, `company_id`. |
| `scm.purchase_order_items` | PO lines. `binding_id`, `material_kind` / `material_code` / `material_name`, `supplier_sku`, `qty`, `received_qty`, `unit_price_centi`, `discount_centi`, `line_total_centi`, `unit_cost_centi`, variant columns (`item_group`, `variants`, `gap_inches`, `divan_*`, `leg_*`, `custom_specials`, `line_suffix`, `special_order_price_sen`), `delivery_date`, `warehouse_id`, `supplier_delivery_date_2..4`, `so_item_id`, `from_mrp`, `photo_urls` (mig 0274 — see *Line photos* below). |
| `scm.purchase_order_items`.`variants` ownership | The jsonb has several writers and no schema. The AutoCount re-parse sweep (`refresh-po-variants.mjs`) owns only `OWNED_VARIANT_KEYS` (`backend/scripts/lib/variant-merge.mjs`) — fabric/colour + gap/divan/leg/total + size — and MERGES them (`variants = variants \|\| patch`); it must never rebuild the object, which deletes every key it has not heard of. `specials` (and the HOOKKA singular `special`) belong to `backfill-specials-into-variants.mjs`, the only writer with the money guard. `custom_specials` is DERIVED by the pricing recompute and is written by no script. |
| `scm.purchase_order_item_allocations` | mig 0235 — sub-line slices of ONE PO line across customers + stock: `company_id` (NOT NULL), `purchase_order_item_id` FK CASCADE, `seq` (1-based dense, UNIQUE per line), `qty` (>0, SUM <= line qty via triggers), `so_item_id` FK SET NULL (NULL = stock), `created_by`, `created_at`. Attribution only — no stock/money/quota. |
| `scm.po_revisions` | Full header+items snapshot per revision, keyed `(po_id, revision)`. Written by `snapshotPo` / `reviseBoundPo` (`backend/src/scm/lib/so-revision.ts:595`, `:725`). |
| `scm.mfg_sales_order_items` | Upstream. `po_qty_picked` is written by this module. |
| `scm.grns` | Downstream. `purchase_order_id` is the lock's join column. |

Note on migration numbers: several in-code comments cite the **2990 source repo's**
numbering, which does not line up with `backend/src/db/migrations-pg/`. Verified
matches: `0082_scm_fx_landed_cost.sql`, `0143_scm_do_ship_cost_snapshot.sql`,
`0154_scm_oversell_retrocost.sql`. Do not trust a bare "migration NNNN" in a
comment without checking the filename.

### Line photos (mig 0274)

Owner 2026-08-10: an SO line can hold photos, a PO line must too, and converting
an SO into a PO carries them across automatically. `photo_urls text[] NOT NULL
DEFAULT '{}'` — the same column shape as `mfg_sales_order_items.photo_urls`.

**Two producers, one column, and no key-shape rule anywhere.**

| Producer | Key shape |
|---|---|
| SO->PO convert (copies the source line's array) | `so-items/<soDocNo>/<soItemId>/<uuid>.<ext>` |
| AutoCount photo importer (appends its own) | `po-items/<po_number>/<po item id>/ac-<DtlKey>-<n>.jpg` |

Both live in the SAME R2 bucket (binding `SO_ITEM_PHOTOS`). Nothing in the schema
or the read path may depend on the prefix — no CHECK constraint, and the signed
URL route authorises by MEMBERSHIP of the row's `photo_urls`, never by key shape.
The importer's append (`ARRAY(SELECT DISTINCT unnest(COALESCE(photo_urls,'{}') ||
<keys>))`) is why the column must stay NOT NULL with a `'{}'` default.

**The convert copies KEYS, not objects.** SO line and PO line point at the same
R2 objects — one photo, two documents, no duplicated bytes and no R2 round-trip
inside the convert. Consequence, deliberate: deleting a photo from the SO line
removes the object, so it also leaves any PO raised from that line.

**Reading a photo: signed first, proxy fallback (2026-08-10).** There are two
read routes and the difference is not cosmetic.

| Route | Mints | Needs | Usable as `<img src>`? |
|---|---|---|---|
| `/photos/:photoKey/signed` | presigned S3 URL | `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` (wrangler SECRETS) | YES — signature travels in the query string |
| `/photos/:photoKey` (proxy) | the bytes | the `SO_ITEM_PHOTOS` binding only | **NO** — see below |

Those three secrets have never been provisioned in production, so
`soItemPhotoBindings()` throws and `/signed` used to answer
`500 {"error":"signing_failed"}` for every photo. It now falls back to the proxy
and returns `200 { mode: 'proxy', proxyPath, thumbProxyPath, expiresAt: null,
reason }`. Signing is still attempted first and still used when it works —
signed URLs exist so a grid of thumbnails does not pay a Worker invocation per
tile, and the fallback must not become the default read path.

**The proxy path is NOT an `<img src>`.** It sits behind the global auth gate,
which reads the bearer token from the `Authorization` HEADER only; there is no
cookie session in this app. A browser attaches no header to an `<img>`, so
pointing one at the proxy 401s. The client must fetch it with the authed client,
read the response as a Blob, and hand `URL.createObjectURL(blob)` to the `<img>`
(revoking it on unmount). This is why the fallback returns `proxyPath` and
deliberately leaves `signedUrl` undefined — populating it would swap a visible
500 for an invisible 401. See `backend/src/scm/lib/photoProxyFallback.ts`.

**Per line, never deduplicated across a PO.** One sofa build is several
compartment lines that legitimately share one build photo; folding them would
blank every compartment but the first. Lines stay 1:1 with their SO line, so each
carries its own array.

Every path that turns an SO line into a PO line carries them: `POST /` (derived
server-side from `so_item_id` — the client never holds these keys, and trusting a
caller-supplied array would let any PO line reference any R2 object),
`POST /from-sos` (both the create-new-POs and append-to-existing-PO branches),
`POST /:id/convert-from-so`, and the SO-amendment path `reviseBoundPo`
(`backend/src/scm/lib/so-revision.ts`).

**Read-only on the PO side.** Photos are authored on the Sales Order (or by the
importer); there is no PO upload or delete route to drift from the SO's
lease/audit rules. The frontend does not render them yet — see §8.

### Status vocabulary

`VALID_STATUSES` (`:285`): `DRAFT | SUBMITTED | PARTIALLY_RECEIVED | RECEIVED | CANCELLED`.
Filter-pill buckets (`:292-298`): five are 1:1 but the KEYS differ from the raw
status — `draft→DRAFT`, `open→SUBMITTED`, `partial→PARTIALLY_RECEIVED`,
`received→RECEIVED`, `cancelled→CANCELLED`. `outstanding→SUBMITTED +
PARTIALLY_RECEIVED` is the one ROLL-UP (owner 2026-07-31): raised but not
received in full, the pill twin of the Outstanding stat card. It **overlaps**
open + partial by design, so the pill counts no longer sum to `all`.

`PARTIALLY_RECEIVED` / `RECEIVED` are **not** set by this module — they are
derived by `recomputePoReceived` in `grns.ts:672-733` from live GRN lines
(`:719-728`), and it never resurrects a CANCELLED PO (`:731`).

---

## 5. Stock direction

**A Purchase Order moves NO inventory, in either direction, at any status.**

Verified: `mfg-purchase-orders.ts` contains exactly one reference to
`inventory_movements` — a `.select()` inside the drop-ship cancel guard (`:258`).
There is no `writeMovements` import and no write to any movement table. The
file's own audit header says it plainly: *"No REVERSE: a PO posts nothing to the
ledger, so there is nothing to contra"* (`:114`).

What the PO *does* move at confirm is a **counter, not stock**:
`mfg_sales_order_items.po_qty_picked` (`recomputeSoPicked`, `:2988`), which is
what drops a line out of the From-SO picker. Cancel/reopen/delete move the same
counter back and forth.

The inventory IN for purchased goods happens one document later, at **GRN post**
(`docs/modules/grn.md` §5).

---

## 6. What locks and when

| Trigger | What stops being editable | Enforced at |
|---------|---------------------------|-------------|
| Any non-cancelled **GRN** exists on the PO | Header PATCH, line add, line edit, line delete, **and cancel** | `poHasDownstream`, now imported from `scm/lib/downstream-lock.ts` (see below) |
| Status `RECEIVED` | Cancel refused outright | `:3200` |
| Status `RECEIVED` or `CANCELLED` | Whole page read-only (frontend) | `PurchaseOrderDetail.tsx:254-255` — `isEditableStatus` is DRAFT / SUBMITTED / PARTIALLY_RECEIVED; `isLocked = !isEditableStatus || hasChildren` |
| Any status | Document-level DELETE — the endpoint no longer exists (2026-08-11) | n/a |
| Drop-ship DO shipped against this PO's expected batch | Cancel refused | `:3214` |
| Status `DRAFT` or `CANCELLED` | Send-to-supplier refused | `poSendRefusalForStatus`, `:3052` |

The frontend drops out of edit mode automatically if the PO locks while the user
is editing (`PurchaseOrderDetail.tsx:261-267`).

**The GRN lock is also the AutoCount rule.** Owner, 2026-08-10:
*"已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"* —
AutoCount refuses to cancel or edit a document it has already transferred
downstream, so the ERP must refuse the same or the two systems diverge the
first time someone edits a received PO. `poHasDownstream` used to be a private
copy inside this router; it now lives in `backend/src/scm/lib/downstream-lock.ts`
alongside its SO / DO / GRN siblings, with the same signature, the same JSON and
the same 409 — and, for the first time, a unit test. See
`docs/modules/autocount-writeback.md` §5.

**Amendment path — yes.** The PO is revised **in place** with a bumped `revision`
column, and the prior version is snapshotted into `scm.po_revisions`. The engine
is `reviseBoundPo` (`backend/src/scm/lib/so-revision.ts:725`), driven by the
SO-amendment approve-PO gate; `GET /:id/revisions` (`:896`) feeds the Revisions
tab and the detail header shows a "Revised · rev N" badge when `revision > 1`
(`:346-349`).

---

## 7. The cost / money columns

Everything is integer sen. The PO is a **cost** document — it has no margin
columns at all.

| Column | Where | Frozen or live |
|--------|-------|----------------|
| `unit_price_centi` | line | Live — operator-editable until the PO locks. This is the agreed supplier price. |
| `discount_centi` | line | Live. Clamped so `line_total_centi = max(0, qty*unit - discount)` (`:2432`). |
| `line_total_centi` | line | Derived on every line write; rolls into the header. |
| `unit_cost_centi` | line | Written at create from the supplier cost matrix (`computeMfgPoUnitCost`, `shared/mfg-pricing`) / supplier sofa-combo spread (`loadSupplierSofaCombos`, `:78`). |
| `subtotal_centi`, `tax_centi`, `total_centi` | header | Derived from lines. |
| `currency` | header | MYR / RMB / USD / SGD (`VALID_CURRENCIES`, `:299`). **The PO carries no `exchange_rate`** — FX→MYR conversion happens at the GRN, using the GRN's own rate (`grns.ts:400`). |
| `received_qty` | line | Not money, but the column the money chain hangs off: written only by `recomputePoReceived` (`grns.ts:672`). |

Supplier cost never leaks sideways: `loadSupplierSofaCombos` (`:78-105`)
deliberately excludes sales-side combo rows (`supplier_id IS NULL`), and the
`/sofa-combos` route is NOT `openRead` for exactly this reason
(`backend/src/scm/index.ts:195-205`).

---

## 8. Desktop and mobile files that must change together

A rule change to the PO touches both surfaces. The pairs:

| Concern | Desktop | Mobile |
|---------|---------|--------|
| List columns / filters | `pages/scm-v2/PurchaseOrdersListV2.tsx` | `mobile/MobileModuleList.tsx` `MODULE_CONFIGS["mfg-purchase-orders"]` (`:1198`) |
| Server pagination opt-in | the `usePurchaseOrdersPaged` hook | `mobile/MobileModuleList.tsx` `SERVER_PAGINATED` set (`:328`) |
| Detail fields | `pages/scm-v2/PurchaseOrderDetailV2.tsx` (read) + `PurchaseOrderDetail.tsx` (edit) | `mobile/MobileModuleDetail.tsx` config `:354` |
| Status actions (Confirm / Cancel / Reopen) | `PurchaseOrderDetailV2.tsx` action bar | `mobile/MobileModuleDetail.tsx` `mfg-purchase-orders` case — Delete was removed from BOTH surfaces on 2026-08-11 |
| SO→PO conversion | `pages/scm-v2/PurchaseOrderFromSo.tsx` | `mobile/MobileConvertWizard.tsx` (`target: "po"`) |
| Line allocations (mig 0235) | `PurchaseOrderDetailV2.tsx` Allocations column + `components/scm-v2/PoLineAllocationsModal.tsx` (editor) | `mobile/MobileModuleDetail.tsx` `LineItem` chips — DISPLAY-ONLY (the phone PO surface has no per-line editor, same precedent as the SO-link picker) |
| Cache invalidation after a write | the mutation hooks in `vendor/scm/lib/suppliers-queries.ts` | `mobile/sharedInvalidate.ts:71` |
| Line photos (mig 0274) | NOT BUILT — see below | NOT BUILT — there is no mobile PO detail surface at all (only PO amendments) |

**Line photos are backend-only today, deliberately.** The keys are on the detail
row and the signed-URL route serves them, but no surface renders them yet. The
SO's `PhotoThumb` is ~110 lines defined INSIDE
`vendor/scm/components/SoLineCard.tsx`, hard-wired to
`fetchSoItemPhotoSignedUrl(docNo, itemId, key)` plus two module-level caches
(`signedUrlCache`, `thumbMissingKeys`) and its own CSS-module classes. Reusing it
for the PO means extracting it with an injectable fetcher, adding a PO signed-URL
query, threading `photoUrls` through the PO detail type into `PoLineCard.tsx`, and
building the phone surface that does not exist. That is a UI project, not a field
add — do it as its own PR, extracting the thumb rather than copying it.

Shared, so a change lands on both at once: the backend route, and the
`suppliers-queries.ts` hooks (mobile's convert wizard and POD screens call
`authedFetch` directly, which is why `sharedInvalidate.ts` exists at all — see
its header comment, `:1-19`).

---

## 9. Performance summary

Optimized:
- List: **one** enrichment query total (`:496-512`), serving both `has_children`
  and `transfer_to_grns`. Nothing to parallelise — there is no second read.
- Detail: header + items + downstream-count folded into one `Promise.all`
  (`:700-718`) instead of three sequential round trips.
- `/:id/linked`: three reads in one `Promise.all` (`:863`).
- Desktop list is server-paginated (50/page) with server-side search, sort and
  status counts — the page renders the server's rows verbatim.

Watch as data grows:
- The **legacy unpaginated path** still `.limit(500)` (`:413`) and is still used
  by `GrnNew.tsx:156`. Beyond 500 POs that picker silently truncates.
- `statusCounts` costs seven `count:'exact'` queries per paginated request
  (`:467-474`). They are `head:true` so no rows travel, but they are seven index
  scans on every page turn.
- Free-text search cannot reach supplier name/code (`:444-449`) because those are
  embedded resources. A user searching by supplier gets nothing.

Cross-module context: `docs/perf-optimization-plan.md`. Route/permission
inventory: `docs/generated/`.

## `so_item_id` on a MIGRATED purchase-order line (2026-08-11)

`backfill-po-so-item-links.mjs` resolves this link from the PO's `From SOs:`
note, written at raise time by the SO -> PO convert. A migrated PO has no such
note — measured, not assumed: of the 181 company-1 sofa/bedframe PO lines with
a NULL `so_item_id`, the notes of **zero** name a sales order. That script's
three tiers are structurally blind to the cutover corpus.

`repair-po-so-links-autocount-text.mjs` covers it with the evidence a migrated
line does carry, under the same 1:1 discipline: the line sits on a purchase
order where OTHER lines are linked (so it is not a stock buy), and exactly one
unclaimed, non-cancelled SO line carries the same item code AND the same
AutoCount `description2`.

Three things it will not do, and the reasons are the rule rather than caution:

- **168 lines on POs where nothing is linked are left alone.** A stock purchase
  is not raised for any order. Per `docs/modules/document-traceability.md` this
  column is procurement *provenance* and binds no execution; filling it would
  invent a dedication that never existed.
- **Anything that does not pair 1:1 is reported, never written.** A guess
  stamped into `so_item_id` is indistinguishable from a fact afterwards.
- **A wrong link is corrected to NULL when the right target is not certain.**
  `scm.purchase_order_items` has no `cancelled` column (unlike
  `scm.mfg_sales_order_items`), so there is no third state to park it in.
How this document's lines relate to the SO / PO / GRN / DO it was copied from,
which columns the migrated writer did and did not copy, and what a correction
applied upstream does NOT reach: `docs/sofa-document-chain-map.md`.
