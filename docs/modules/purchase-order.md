> ## Corrections — 2026-08-12 code-read sweep
>
> 1. List pageSize is a persisted per-user preference defaulting to 50 (PurchaseOrdersListV2.tsx:726), not fixed.
> 2. The mobile shared-invalidation gap is FIXED: sharedInvalidate.ts:80 includes mfg-purchase-orders-paged (comment :75-79 records the bug).
> 3. POST /bulk-supplier-date exists (mfg-purchase-orders.ts:2680, owner 2026-08-03) and is absent from the API table.
> 4. Reopen is refused 409 cancel_is_final when the cancelled PO carries linked_ac_docno (:4392-4400). The guide contains zero mention of linked_ac_docno/linked_ac_dtlkey or the AutoCount outbox wired through every PO write (enqueuePoCreate :1382/:2416/:4055, queueAcPoEdit on PATCH/line CRUD/bulk-date/convert, retiredLineOf :3282, enqueueCancel :4353).
> 5. outstanding-so-items is a pooled stock-aware MRP shortage view (:665-694); qty−po_qty_picked>0 is only the degraded fallback.
> 6. /from-sos buckets by (warehouseId, supplierId) + per-category rules in po-grouping.ts (sofa/bedframe per-SO; mattress merges only within a Monday-anchored 7-day window) — same supplier routinely emits several POs.
> 7. A second revision engine exists: applyPoAmendment (po-revision.ts:98-341) driven by the standalone PO-amendments router; po_amendments tables appear nowhere in this guide.
> 8. On the create paths the matrix/combo cost is written into unit_price_sen, not unit_cost_sen (:1229-1260, :2352-2385; autoCostCenti → unitPriceCenti :2164-2173).
> 9. §9's “no second read” is false: after GRN enrichment the list runs a second Promise.all wave — resolvePoSoCoverageForPos (computeMrp inside) + resolveDeliveredDosForPos (:572-576); §3.4 already describes them.

# Module: Purchase Order (SCM)

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. Sibling of `sales-order.md`; the PO is the
BUY side of the same doc-machinery (list hook → `/api/scm/<doc>` handler →
`scm.<doc>` tables).

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.
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

Doc-flow position: **SO → PO → GRN → PI**. The PO is the only document in that
chain that moves **no stock at all** (see §5).

---

## Decision (owner, 2026-08-06): soft until DO, hard from DO

Before a Delivery Order exists, ALL supply-demand matching belongs to the
floating MRP allocator — pooled by (warehouse, item_code, variant_key),
constrained by one-batch-per-SOFA-set (bedframes exempt), ordered by delivery
date then doc_no. Nothing persisted before the DO may bind execution:
`purchase_order_items.so_item_id` and the mig-0235 allocation sub-lines are
**procurement provenance** — they record why we bought, and they are displayed
and audited. That is the TARGET state; the demotion is staged and **none of the
three has landed**. Today `so_item_id` still drives all three execution paths:
the per-line over-convert cap (`soLineOverConvertRefusal` →
`409 qty_exceeds_remaining`, `mfg-purchase-orders.ts:2956-2975`), the drop-ship
expected batch (`dropship-batch.ts:77-126`), and `/po-so-coverage` layer (b)
precedence (`po-so-coverage.ts:245-256`). The router concedes it inline at
`mfg-purchase-orders.ts:2884-2887`.

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

> **The DO-time live allocator stage LANDS WITH PR-4 (this branch, owner-gated
> — NOT on main until the flip merges).** From that merge,
> `resolveShipCommitments` binds `committed_po_batch_no` from
> `allocateExpectedBatches` (`backend/src/scm/lib/do-live-allocator.ts`) —
> pooled open-PO supply minus outstanding commitments, owner tiebreaks
> encoded (supply: earliest effective ETA nulls-last then smaller PO number;
> demand: delivery date then smaller doc number; sofa sets picked whole; ties
> auto-pick + operator confirms in the existing short-stock dialog). What
> remains of the stored `so_item_id` link on the SHIP path after the flip:
> **provenance display and evidence only** — the BIND_SHADOW divergence rows,
> the DO detail's bound-PO Source-PO fallback (`resolveExpectedBatchBySoItem`
> at the detail read), the legacy pre-0230 drop-ship batch re-resolution in
> `resolveDoSofaBatchMap` (anchored history, not a new binding), and — flagged
> as an open review item on the flip PR — the Type-A sofa no-batch guard's
> drop-ship waiver. It decides no cap, no batch expectation, no coverage
> precedence. See `docs/modules/delivery-order.md` §5 for the mechanism.

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
| Desktop list | `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx` | Server-paginated. Page size is operator-chosen and persisted per user (`useLocalStorage("scm:perpage:purchase-orders", 50)`) — 50 is the default, not a constant; the server clamps to 1..100. Page index in `?page=`. Renders the server page verbatim — no client re-filter. |
| Desktop detail (read) | `frontend/src/pages/scm-v2/PurchaseOrderDetailV2.tsx` | **READ-ONLY by design** (`:334`). A thin router: `?edit=1` forwards to the legacy editor (`:351`). |
| Desktop detail (edit) | `frontend/src/pages/scm-v2/PurchaseOrderDetail.tsx` | The inline editor + the SO-amendment "Revision ready" banner + Revisions tab. Lazy-loaded (`PurchaseOrderDetailV2.tsx:341`). |
| Desktop new | `frontend/src/pages/scm-v2/PurchaseOrderNew.tsx` | |
| Desktop from-SO | `frontend/src/pages/scm-v2/PurchaseOrderFromSo.tsx` | Multi-select picker over `/outstanding-so-items`. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | Generic screen; the PO config is `MODULE_CONFIGS["mfg-purchase-orders"]` (`:1198-1237`). |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Generic; PO config `:354`, PO status actions `:515-532`. |
| Mobile convert (SO→PO) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "po"`. Offered only to a caller who passes `canOperatePurchaseOrders` — see below. |

**The mobile `+` is an OPERATE gate (2026-08-14).** `MobileModuleList` renders the
`+` on the presence of an `onNew` callback alone, and `MobileConvertWizard` imports
no auth of its own — so withholding `onNew` is the only thing that keeps the wizard
away from a caller who may not write. `MobileApp.tsx` gated the DO and SI convert
targets and then fell through to a literal `: true`, which covered this one: a
`view`-level holder of `scm.procurement.po` was offered the `+`, filled in the whole wizard, and
met the area guard's 403 at the end of it. The gate is now
`canOperatePurchaseOrders(can, pageAccess)` (`frontend/src/auth/salesAccess.ts`), which mirrors
`scm/middleware/area-guard` — `edit` on the area for POST/PATCH/PUT/DELETE, with
`*` always passing. The target chain has no default arm, so a new ConvertTarget
that forgets its gate will not typecheck.


Desktop routes are declared in `frontend/src/App.tsx:516-519`, all behind
`<ScmGuard area="scm.procurement.po">`.

**The "Purchase Location" column shows the warehouse CODE (2026-08-21).** It
printed `purchase_location?.name || purchase_location?.code`, so the grid
truncated the full name to `BALAKONG WAREHO…` while this same page's PDF export
already printed the code. The one display rule is `warehouseLabel` — code first,
then name — and it now has a FRONTEND home to import:
`frontend/src/vendor/scm/lib/warehouse-label.ts`, a byte-identical mirror of
`backend/src/scm/lib/warehouse-label.ts`. Never hand-write the order again; see
`docs/modules/warehouses.md` for the mirror and its referee. The GRN-from-PO
picker's Warehouse column reads through the same rule.

### `item_group` is the SKU's, and it decides where the stock lands (2026-08-22)

A PO line's `item_group` is not a label. It is an **input to the stock bucket**:
`computeVariantKey(item_group, variants)` composes a sofa's fabric / seat / leg
into the key **only** for a sofa or bedframe group — for null or `others` it
returns `''` by design (`shared/variant-key.ts`, "Accessory / Others / Service —
product code only").

So a PO line that lost its group produces a GRN that lost it (`grns.ts:1897`
copies the PO line), and `postGrnAndRollup` writes the receipt's inventory
movement under the EMPTY key. The goods are then in the warehouse, at the right
value, with their `variants` jsonb fully intact — and invisible to every sofa
order, which looks up `fabriccode=…|seatheight=…|legheight=…`.

**The variants are never the thing that goes missing.** `description2` is built
from the jsonb alone and prints correctly the whole time, which is exactly why
this reads as impossible from the screen: the specs are right there on the PO.
Only the one word that says *how to read them* was blank. Owner 2026-08-22:
「我们的 PO 没有规格 generate 不出的啊？所以应该不可能没有规格？」 — the specs
were there; the category was not.

**The server resolves it from the product, not from the request.**
`POST /mfg-purchase-orders` reads `mfg_products.category` for every
`mfg_product` line's code — company-scoped, because `code` is shared between the
two organisations (the reason `grns.ts:287` gives) — and uses it in preference
to `it.itemGroup`. The caller's value survives only as the fallback for a
raw-material line, which has no product row. `description2` is built from the
SAME resolved group, so the printed text and the stock key cannot describe
different things.

That server rule is the load-bearing half. The desktop From-SO mapper also stops
re-deriving the group (it now uses the pick's own `itemGroup`, which the picker
already renders as the row's Category chip) — but fixing only the browser would
leave the next client free to lose it again. Trace:
`docs/bugs/0514-the-so-to-po-hop-lost-the-category-so-received-sofa-stock-wa.md`.

**The variant summary on the transfer pickers is labelled "Description 2"
(2026-08-21).** `VariantDescription` (the shared component GRN ← PO and the nine
other Convert-From pickers render that column through) exports
`DESCRIPTION_2_LABEL` and prints it above the summary. The word is the system's
existing one — the SO line editor's column header and
`pages/scm-v2/so-audit-labels.ts` — not a new name for the string.

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
2. **Mobile's shared-invalidation entry carries all three PO roots** —
   `frontend/src/mobile/sharedInvalidate.ts:73-80` maps `"mfg-purchase-orders"`
   to `["mfg-purchase-orders", "mfg-purchase-orders-paged",
   "mfg-purchase-order-detail"]`, so a mobile PO status write DOES invalidate the
   desktop paged list. PO was the one document module missing `-paged`; the
   entry's own comment names the bug this paragraph used to describe.

---

> **Right-click on a list row** opens the same actions — see
> `docs/modules/document-conversion.md` §8a for the shape, the table of what
> every list offers, and the two absences that are deliberate.

## 2. API surface

All under `backend/src/scm/routes/mfg-purchase-orders.ts`, mounted at
`/api/scm/mfg-purchase-orders` (`backend/src/scm/index.ts:237`) behind
`scmAreaGuard('scm.procurement.po')` (`:236`) — GET needs `view`, writes need
`edit` on that area, **but only for a caller whose position is
`scm_l2_configured`**. Anyone else hits the no-lockout fallthrough
(`area-guard.ts:168-172`) and passes on the coarse `scm.access` umbrella alone,
with no per-area level consulted.

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/` | `:374` | List. `?page=` opts into pagination + `statusCounts`; without it the legacy `{ purchaseOrders }` array. |
| GET | `/outstanding-so-items` | `:537` | SO lines carrying an uncovered POOLED shortage — `computeMrp` runs and a line shows only when `shortageQty > 0`, so a line covered by stock or an open PO drops off and returns when that cover is consumed. `qty - po_qty_picked` is the FALLBACK, used only when the MRP compute throws. Excludes CANCELLED / DRAFT / ON_HOLD. The From-SO picker. |
| GET | `/:id` | `:693` | Header + items + `has_children`. |
| GET | `/:id/linked` | `:859` | Downstream GRNs / PIs / PRs (three parallel reads). |
| GET | `/:id/revisions` | `:896` | `po_revisions` snapshots for the Revisions tab. |
| GET | `/so-line-candidates?code=&poId=&itemId=` | (static, pre-`/:id`) | SO lines carrying this item code AND — when `poId`+`itemId` are given — the same SPEC as that PO line (fabric + colour + SEAT/LEG/SPECIAL via `specSignature`/`buildVariantSummary`; dye-lot excluded, owner 2026-08-08). INCLUDING picked/delivered ones (historical consolidated POs are the point). Excludes cancelled lines + cancelled/draft SOs. Omitting `poId`/`itemId` -> code-only (back-compat). |
| GET | `/:id/items/:itemId/allocations` | | The line's allocations + `lineQty` + `poNumber` (mig 0235). |
| POST | `/:id/items/:itemId/allocations` | | Add one slice `{ qty, soItemId\|null }` (null = STOCK; STOCK skips the SO gate, qty-capped insert). A non-null `soItemId` must be the same code AND same SPEC as the PO line — `soLinkTargetRefusal` returns 409 `so_link_material_mismatch` / `so_link_spec_mismatch` (owner 2026-08-08). seq auto-assigned dense. |
| PATCH | `/:id/items/:itemId/allocations/:allocationId` | | Edit a slice (`qty?`, `soItemId?` — explicit null → STOCK; absent keeps). |
| DELETE | `/:id/items/:itemId/allocations/:allocationId` | | Remove a slice + resequence the survivors dense 1..n. |
| GET | `/:id/items/:itemId/photos/:photoKey/signed` | | Trade one key from the line's `photo_urls` for a short-lived signed R2 GET URL (`{ mode:'signed', signedUrl, thumbUrl, expiresAt }`). Falls back to `{ mode:'proxy', proxyPath, … }` — never 500 — when signing is impossible. READ-ONLY — see §4 *Line photos*. |
| GET | `/:id/items/:itemId/photos/:photoKey` | | PROXY: streams the object from the R2 binding, no S3 credential needed. Same authz as `/signed`, company scoping included. Behind the auth gate, so NOT usable as a bare `<img src>` — see §4 *Line photos*. |
| POST | `/:id/items/:itemId/photos` | | Upload a PO-authored add-on photo (owner 2026-08-28; multipart `file` + optional client `thumb`). Key minted under `po-items/<poId>/<itemId>/`. Refused on a CANCELLED PO. Lives in `purchase-order-item-photos.ts` (the main router is at its size ceiling), mounted in `backend/src/scm/index.ts` on the SAME `/mfg-purchase-orders` prefix as the main router — the separate-router-same-prefix construction the DO scan token uses. |
| DELETE | `/:id/items/:itemId/photos/:photoKey` | | Delete a PO-OWNED (`po-items/...`) key + its R2 object/thumb. A carried `so-items/...` key is refused 403 `carried_photo_readonly` — same R2 object as the SO's photo; manage it on the Sales Order. |
| POST | `/` | `:911` | Create (`asDraft: true` → DRAFT, else SUBMITTED). SO-sourced lines (carrying `soItemId`, e.g. the desktop New-PO-from-SO flow) are capped at the SO line's remaining (`qty - po_qty_picked`): over-convert → 409 `qty_exceeds_remaining` unless `confirmOverConvert: true` (pre-write guard, marks idempotency no-write). Manual lines (no `soItemId`) unaffected. |
| POST | `/from-sos` | `:2139` | Batch convert whole SOs, emitting N POs. The bucket key is per-CATEGORY (owner 2026-07-17, `po-grouping.ts:69-90`): sofa/bedframe per (warehouse, supplier, SO), mattress per (warehouse, supplier, 7-day delivery window), everything else per the caller's `combined \| per-so` toggle. Warehouse is always in the key, which is what keeps the header's `purchase_location_id` unambiguous. |
| POST | `/:id/convert-from-so` | `:2694` | Append SO lines onto an existing PO. |
| PATCH | `/:id` | `:2219` | Header edit. |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | `:2400` / `:2504` / `:2619` | Line CRUD. A line carrying `soItemId` is capped at the SO line's remaining exactly like `POST /` — over-convert → 409 `qty_exceeds_remaining` unless `confirmOverConvert: true` (2026-08-11; see *Binding a PO line to its source SO line*). |
| PATCH | `/:id/submit` | `:2904` | Legacy no-op/echo — returns 409 unless already SUBMITTED. |
| PATCH | `/:id/confirm` | `:2998` | **The commit**: DRAFT → SUBMITTED. |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | `:2400` / `:2504` / `:2619` | Line CRUD. |
| PATCH | `/:id/submit` | `:2904` | Legacy no-op/echo — returns 409 unless already SUBMITTED. Also 409 `purchase_location_id_required` if the PO has no ship-to warehouse (2026-08-02). |
| PATCH | `/:id/confirm` | `:2998` | **The commit**: DRAFT → SUBMITTED. Blocked 409 `purchase_location_id_required` (via `poWarehouseGap`) if the header `purchase_location_id` is blank AND any line has no `warehouse_id` — a warehouse-less PO can't go live because its GR would receive into the wrong warehouse (owner 2026-08-02). |
| POST | `/:id/send-to-supplier` | `:3019` | Email the PO PDF. Fail-closed on the `purchase_order` email channel (`:3032`). |
| PATCH | `/:id/cancel` | `:3182` | → CANCELLED; releases SO quota AND clears the line's mig-0235 allocation sub-lines (a cancelled PO attributes nothing — 2026-08-02). |
| PATCH | `/:id/reopen` | `:3276` | CANCELLED → SUBMITTED; re-claims SO quota. Allocation sub-lines are NOT restored (they were cleared on cancel); the coarse `so_item_id` link remains, re-split via the allocation editor if needed. **Since 2026-08-13 it also runs `poWarehouseGap` and stamps `submitted_at`** — reopen was the third door to SUBMITTED and the only one with no warehouse gate, so cancel-then-reopen turned a warehouse-less DRAFT into a live, GR-receivable PO. |
| POST | `/bulk-supplier-date` | — | **Was missing from this table until 2026-08-13.** Sets ONE supplier-REVISED delivery-date slot (`slot` 2/3/4 → `supplier_delivery_date_2..4`) across up to 100 POs. It never touches `supplier_id` and never touches `expected_at`. `applyToLines` **defaults to TRUE**, so unless the caller opts out it cascades onto every line's date as well. A downstream-locked or foreign-company PO is reported in `skipped`, never written; each updated PO still gets its own audit row. |

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

### CAN a Sales Order be converted to a PO right now? The eligibility chain, in order

> Added 2026-08-16 after the owner reported *"my new SO cannot be converted"*.
> Read this before concluding a line is "not convertible": four independent
> filters run, three of them SILENT, and the empty state asserts the opposite of
> what is happening.

`GET /outstanding-so-items` is the only source the desktop picker
(`pages/scm-v2/PurchaseOrderFromSo.tsx`) and the mobile wizard
(`mobile/MobileConvertWizard.tsx`) read. A line must survive all four:

| # | Filter | Silent? | What survives |
|---|---|---|---|
| 1 | `.eq('cancelled', false)` + company scope + **`.limit(500)`**, ordered `doc_no` DESC | **yes** | at most 500 SO ITEM rows, newest doc numbers first. Newer orders are on the safe side of this cap; older ones fall off it with no message |
| 2 | SO header status not in `CANCELLED`, `DRAFT`, `ON_HOLD` | **yes** | a **DRAFT SO is never convertible.** This is the honest, common answer to "my new SO cannot be converted": confirm it first |
| 3 | pooled MRP shortage `> 0` — `shortageBySoItem.get(id) ?? 0` | **yes, and it is the dangerous one** | see below |
| 4 | client-side: category filter, date-range filter, draft-already-consumed subtraction, one-supplier-per-PO lock (greys rows out, with a visible banner) | no | the visible grid |

**Filter 3 is where lines vanish for a reason nobody can see.** The picker asks
`computeMrp` for each line's shortage and keeps only `> 0`. That is correct by
design — a line already covered by stock or an open PO should not be re-ordered.
But the lookup is `?? 0`, so **a line MRP never planned at all is
indistinguishable from a line MRP planned and found fully covered.** Both read
as shortage 0. Both disappear.

And MRP does not plan most lines. `computeMrp`'s demand read is capped at the
PostgREST server ceiling with a truncation guard that cannot fire, so on
production company 1 it planned **1,000 of 13,918 demand lines (7.2%)** — an
arbitrary slice, because the read orders by a uuid. Full trace and the measuring
run in `docs/modules/mrp.md` §5. So:

- roughly 93% of otherwise-eligible SO lines are absent from the picker;
- the loss is invisible — no error, no warning, no partial-results banner;
- `pooledOk` does NOT rescue it. That flag only flips when `computeMrp`
  **throws**; a truncated-but-successful compute keeps `pooledOk = true`, so the
  documented fallback (`qty - po_qty_picked > 0`) never engages.

**What the operator sees when nothing is offered** — the grid's `emptyMessage`:

> *"No outstanding SO lines — every line has been converted (or there are no
> SOs)."*

That sentence is a positive assertion that the work is done, and under filter 3
it is false. (The picker gets the READ-FAILED case right: `itemsQ.isError`
renders a different, correct sentence saying the list is incomplete. Truncation
is not an error, so it takes the wrong branch.)

**Verdict, as of 2026-08-16:** an SO *can* be converted to a PO — the mechanism
works and is multi-select at line level — but only for a line that is
(a) confirmed or later, (b) inside the newest 500 item rows, and (c) one of the
~7% MRP happened to plan. Fixing (c) is PR #2304 (#2300, #2294 alongside);
**none merged**.

---

## 3. Backend

### The list handler — `mfgPurchaseOrders.get('/')` (`:374-520`)

1. **Select** (`:387`) — one PostgREST query with three embeds:
   `supplier:suppliers(...)`, `items:purchase_order_items(item_code, material_name, qty)`
   (the per-row item summary), and `purchase_location:warehouses!purchase_location_id(...)`.
2. **Two paths, chosen by the presence of `page`** (`:394-395`).
   - Legacy (`:404-419`): `order po_date desc, created_at desc`, `.limit(500)`,
     `status` matched against `VALID_STATUSES` (`:285`), optional `supplierId`,
     `scopeToCompany`.
   - Paginated (`:420-483`): `pageSize` clamped to 1..100 (default 50), sort
     whitelist `po_date | po_number | status | total_sen` (`:426`) with
     `po_number` as the unique tiebreaker (`:433`), bucket resolution via
     `PO_STATUS_BUCKETS` (`:292-298`), `q` ilike over `po_number` + `notes` only
     (`:448` — supplier name is an embedded resource and cannot be `ilike`d),
     `from`/`to` on `po_date`, `.range(...)`.
   - `statusCounts` = seven `head:true count:'exact'` queries in one `Promise.all`
     (`:467-474`), over the same company + supplier filter but **without** status,
     search or paging. (Seven, not six: the `outstanding` roll-up is counted
     separately rather than derived, so the pill and the filter share one source.)
     A count that cannot be READ is now `500 { error: 'status_counts_failed' }`
     naming the bucket (`lib/status-counts.ts`, 2026-08-17) — it used to fall
     through `count ?? 0` and show a broken bucket as an empty one. A
     legitimately empty bucket still answers 0. Same guard on the PI, SI, GRN and
     DO lists.
3. **Enrichment — TWO waves.** First one GRN query (`:496-512`): all
   non-cancelled GRNs for the listed PO ids, carrying `id` + `grn_number`. It
   powers both `has_children` (the downstream lock) and the "GRN No" column, so
   those two are one round trip. `transfer_to_grns` is `{ id, grnNumber }[]` —
   the id is what lets the column link to `/scm/grns/:id`. Then a parallel pair
   (`:573-576`): `resolvePoSoCoverageForPos` and `resolveDeliveredDosForPos`,
   which together add roughly a dozen reads **and one full `computeMrp` run per
   list request** (`po-so-coverage.ts:787`). That MRP run, not the row fetch, is
   the list's dominant cost.
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
- `SO_UNORDERABLE_STATUSES = {DRAFT, CANCELLED, ON_HOLD, CLOSED}` (`:312`) — a PO
  line sourced from an SO in any of those is refused (`firstUnorderableSo`, `:313`).
  A purely manual line with no SO link skips the check entirely.
  **This is a threshold on the SALES order, not on this document's own status.**
  It must stay EQUAL to the delivery side's `SO_UNDELIVERABLE_STATUSES`
  (`backend/src/scm/shared/so-deliverable-states.ts`), and
  `backend/tests/duplicatedDecisionPins.test.ts` PIN 2 fails if the two drift:
  a threshold one write path enforces and the other does not means a document
  type can be built from an order the other refuses. `CLOSED` joined both on
  2026-08-22 — on a Sales Order it means **stop chasing the remainder**, so
  nothing more ships against the order and nothing more is bought for it. The
  PURCHASE ORDER'S OWN `CLOSED` is a separate question and is not built; see
  `docs/modules/document-status-vocabulary.md` §1b.

### Binding a PO line to its source SO line (`so_item_id`)

`so_item_id` is what lets a shipment resolve its incoming PO: `dropship-batch.ts`
finds the expected batch through it, `/po-so-coverage` treats it as the STATIC
link, and `recomputeSoPicked` counts from it. (**Post-PR-4** the first of those
three is provenance/evidence only — the ship-time batch expectation comes from
the live allocator; see the §Decision callout above.) Measured on prod 2026-07-31, **67
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
  line's `item_code`. Otherwise `404 so_line_not_found`,
  `409 so_line_cancelled` or `409 so_link_material_mismatch`.
- **`POST /` (bare create) is company-scoped too (2026-08-19).** The desktop
  "New PO from SO" / MRP-convert path feeds SO-sourced lines through this generic
  create. It now reads each line's `soItemId` **scoped to the active company** and
  refuses any that resolves to nothing — `404 so_line_not_found` — before the line
  is linked (`so_item_id`), its `photo_urls` copied, or `recomputeSoPicked` rolls
  `po_qty_picked` forward. Previously the read carried no company predicate (the
  service-role client bypasses RLS), so a foreign `soItemId` re-parented another
  company's SO line onto this company's PO. `BUG-HISTORY.md` 2026-08-19.
- **And through `soLineOverConvertRefusal` (2026-08-11)** — `soLinkTargetRefusal`
  proves a bind POINTS somewhere legitimate; it says nothing about HOW MUCH. Both
  line paths take an operator-supplied qty, and until this landed neither capped
  it, so a line could be appended (or edited upward) against an SO line that was
  already fully converted and re-order the goods. Now capped at
  `qty - po_qty_picked` → `409 qty_exceeds_remaining`, overridable with
  `confirmOverConvert: true` (the same escape hatch `POST /` documents).
  On **edit**, the line's own stored qty is credited back while it stays on the
  SAME SO line — otherwise re-saving an already-bound line would 409 against
  itself; a **rebind** onto a different SO line gets no such credit.
  Repeat conversion stays legal: the ceiling is capped, never the second convert.
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
  `item_code`).
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
| 2 | **Note names exactly ONE SO.** The provenance note written at raise time (`Transfer from Sales Order: …`, and the legacy `From SOs:` / `From SO:` — all three are accepted forever) resolves to one valid, company-owned Sales Order. | With one order there is no question which it served. |
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

### Write-back: a line ADDED here reaches the account book (since 2026-08-31)

Every PO write queues an AutoCount edit through `queueAcPoEdit`. A line this
request INSERTED carries no AutoCount key yet, and a keyless line means two
opposite things — just added, or never backfilled — so the two routes that insert
lines (`POST /:id/items`, `POST /:id/convert-from-so`) pass the row ids they just
wrote as `newLineIds`. They go out marked `IsNewLine` and AutoCount appends them
with `AddDetail`. A keyless line the route did NOT name still refuses the whole
document: guessing a key would rewrite somebody else's line, and on a purchase
order a duplicate line cannot be removed at all.

Until this was wired, adding a line to a PO already in the account book refused
that document and left a `skipped` outbox row nobody was watching. Removing a
line has always worked — it goes as a RETIREMENT (`Qty = 0`), never a delete.

A newly added line also needs a stock location or AutoCount refuses the detail
and the whole save with it; when the line has no warehouse of its own, the
purchase order's own is used (`composePoState`). An EXISTING line with no
location still sends no location, so the book keeps the value it owns. Full rule:
`docs/modules/autocount-writeback.md`, "Adding a line".

### The MIGRATED purchase orders — a fourth source of evidence, above all three

The tiers above recover a link from what the ERP itself recorded. A purchase
order imported from AutoCount has something stronger: AutoCount's own
`PODTL.FromSODtlKey`, which names the sales-order line the PO was raised from as
a matter of record. `backend/scripts/repair-migrated-po-lines.mjs` (workflow
**Repair migrated PO lines (dedication, dates, line key)**) walks it, and in the
same pass fills the two other things those rows lost. All three are one repair
because they are one row and one cause.

| What it writes | Where it comes from |
|---|---|
| `so_item_id` | `PODTL.FromSODtlKey` -> the AutoCount sales order -> the ERP line with the matching code, through the SHARED taker `scripts/lib/so-line-dedication.mjs` — so a sales-order line is claimed exactly once across every importer and this repair. |
| `delivery_date` | `PODTL.DeliveryDate`, via `scripts/lib/ac-po-line.mjs`. |
| `linked_ac_dtlkey` | `PODTL.DtlKey` — AutoCount's PRIMARY KEY for the line. |
| `purchase_orders.expected_at` | Earliest of the header's own line dates, the same rule `backfill-po-expected-at.mjs` and the SO->PO convert use. |

Matching an already-imported ERP row back to its AutoCount line is done from
`supplier_sku`, which carries AutoCount's `ItemCode` verbatim (a sofa line
carries `<ItemCode> <compartment>`); the rule lives in
`scripts/lib/ac-po-line-match.mjs`. **One AutoCount sofa line owns SEVERAL ERP
rows** — one per compartment — and all of them carry its `DtlKey`, which is why
`linked_ac_dtlkey` is indexed and never unique. Where one document has several
AutoCount lines sharing an ItemCode they are split further on `(qty, Desc2)`.
A group whose two sides do not split the same way is refused whole.

**Where even `(qty, Desc2)` does not separate them, the ERP rows are identical
but the AUTOCOUNT LINES USUALLY ARE NOT — and the AutoCount side is where every
written value comes from.** All 5 such buckets in the committed snapshots carry
different `FromSODtlKey`s, and on `PO-000290` the two keys name two different
PRODUCTS on one sales order. So a bucket is zipped only when its AutoCount lines
agree on `FromSODtlKey` and `DeliveryDate`; otherwise it is REFUSED with both
candidates printed. On today's data that refuses all 5 and repairs none of their
rows, which is the correct outcome — **a wrong `linked_ac_dtlkey` is strictly
worse than NULL**, because NULL tells the write-back to CREATE while a wrong one
makes `AcSyncService` APPEND a line instead of editing the operator's.

For the same reason the dedication never crosses products: the sales-order
line's own ERP code is only tried when it names the same product as the PO line
(or that line's sofa placeholder). A cross-product candidate is left blank and
listed for the owner. Which codes a row may claim is one function —
`dedicationCandidates()` in `scripts/lib/so-line-dedication.mjs`, beside the
taker — so the rule and the script cannot drift apart.

A cancelled sales-order line is never offered, and every query that builds the
taker pool reads the column as **nullable** — `COALESCE(cancelled, false) =
false`, the same way `check-po-so-links.mjs` (the checker for this exact link)
reads it. A bare `cancelled = false` is NULL for a NULL row, which silently
drops it out of a **claim-once** pool: that both under-repairs and hands a
DIFFERENT line to the PO row that follows.

Every UPDATE re-asserts that the column is still NULL, so the repair is
idempotent and never overwrites a value a human has set by hand. It does NOT
recompute `po_qty_picked` — `recomputeSoPicked` only ever runs from a route
handler — so the SO lines it dedicates keep reading as still-needing-ordering in
the From-SO picker (`qty - po_qty_picked > 0`, `/outstanding-so-items`) until
something touches them. **That is a duplicate-PO risk**: the line is now bound to
a purchase order, but the picker still offers it, so a second PO can be raised
for stock already on order. `backfill-po-so-item-links.mjs` has the identical
gap, so this is precedent rather than a regression. The DRY-RUN lists every
affected SO line by id, so the exposure is enumerable rather than estimated.

Because it may only write into a NULL, the repair is **silent about rows another
writer already filled** — and on 2026-08-10 `backfill-ac-line-keys.mjs` filled
275 of them by a weaker rule. Silence there would be a choice not to look, so the
script also AUDITS what it may not touch: it compares every stored
`linked_ac_dtlkey` against the one it derives and prints each disagreement with
the ERP row's own `Desc2` beside the AutoCount line's. It never writes or reverts
them. A wrong `DtlKey` makes `AcSyncService` APPEND a line to the live account
book instead of editing the operator's, so each disagreement is an owner ruling,
not a thing for a script to decide.

### The SO-quota counter — `recomputeSoPicked` (`:2352-2398`)

Live-count, not arithmetic: it re-sums `purchase_order_items.qty` per
`so_item_id` and writes `mfg_sales_order_items.po_qty_picked`. Two exclusions
matter: lines with `from_mrp === true` never lock the SO line (`:2372`), and
POs whose status is `CANCELLED` **or `DRAFT`** are excluded (`:2384`). Best-effort
throughout — it logs and skips, because the primary write already committed.

---

### The Main Supplier column, and the convert's `missing_bindings`

Both read `supplier_material_bindings` for every code in the picker, and both
now go through `readMfgProductBindings`
(`backend/src/scm/lib/supplier-bindings.ts`) rather than their own query —
`backend/src/scm/routes/mfg-purchase-orders.ts` at the SO->PO picker, the
convert body and the append-to-PO pricing path, plus `reviseBoundPo` in
`backend/src/scm/lib/so-revision.ts`.

The two failures are not the same size. On the picker a binding that does not
arrive is a blank **"— none —"** cell. In the convert body it is a **400**: the
SKU comes back as `missing_bindings`, i.e. the operator is told a bound SKU
"isn't bound to a supplier yet" and cannot raise the order at all. The shared
reader chunks the IN-list by URL bytes, pages past PostgREST's 1,000-row
response cap, and orders totally (`is_main_supplier DESC, item_code, id`) — the
last of which is what decides which alternate wins when a code is bound to
several suppliers.

A supplier's own detail page (`suppliers.get('/:id')`,
`backend/src/scm/routes/suppliers.ts`) had no `.range()` at all and is now paged
by `paginateAll` for the same reason: production carries 2,660 bindings across
43 suppliers, so a large supplier could show a subset of its own SKUs and report
nothing.

## 4. Database

Schema `scm`. Baseline DDL: `backend/scripts/scm-schema/2990s-full-schema.sql:1150`
(`purchase_orders`) and `:1103` (`purchase_order_items`); later columns arrive via
`backend/src/db/migrations-pg/`. The authoritative in-code column lists are
`HEADER_COLS` (`mfg-purchase-orders.ts:342-355`) and `ITEM_COLS` (`:357-371`) —
those are what the route actually selects.

| Table | Role |
|-------|------|
| `scm.purchase_orders` | PO header. `po_number` (UNIQUE), `supplier_id`, `status`, `po_date`, `expected_at`, `purchase_location_id` (FK → `warehouses.id`), `currency`, `subtotal_sen` / `tax_sen` / `total_sen`, `submitted_at` / `received_at` / `cancelled_at`, `revision`, `supplier_delivery_date_2..4`, `company_id`. |
| `scm.purchase_order_items` | PO lines. `binding_id`, `material_kind` / `item_code` / `material_name`, `supplier_sku`, `qty`, `received_qty`, `unit_price_sen`, `discount_sen`, `line_total_sen`, `unit_cost_sen`, variant columns (`item_group`, `variants`, `gap_inches`, `divan_*`, `leg_*`, `custom_specials`, `line_suffix`, `special_order_price_sen`), `delivery_date`, `warehouse_id`, `supplier_delivery_date_2..4`, `so_item_id`, `from_mrp`, `photo_urls` (mig 0274 — see *Line photos* below), `linked_ac_dtlkey` (mig 0273 — AutoCount `PODTL.DtlKey`; indexed, NOT unique — one AutoCount sofa line becomes one ERP line per compartment and every one carries the same key). |
| `scm.purchase_order_items`.`variants` ownership | The jsonb has several writers and no schema. The AutoCount re-parse sweep (`refresh-po-variants.mjs`) owns only `OWNED_VARIANT_KEYS` (`backend/scripts/lib/variant-merge.mjs`) — fabric/colour + gap/divan/leg/total + size — and MERGES them (`variants = variants \|\| patch`); it must never rebuild the object, which deletes every key it has not heard of. `specials` (and the HOOKKA singular `special`) belong to `backfill-specials-into-variants.mjs`, the only writer with the money guard. `custom_specials` on a PO line is neither derived nor script-free: `POST /:id/items` and `PATCH /:id/items` store `it.customSpecials` VERBATIM from the request body with no recompute (`:3044`, `:3176` — unlike the SO / consignment routes), and three repair scripts write the column directly on `scm.purchase_order_items` (`backfill-sofa-special-orders.mjs`, `census-custom-specials-arrays.mjs`, `repair-custom-specials-double-encoded.mjs`). It has no single owner. |
| `variants` — the reviewed hand-patch escape hatch | `apply-variant-patch.mjs` is the only writer allowed keys outside `OWNED_VARIANT_KEYS`, because its patch is a human-reviewed artifact submitted per batch through a workflow input (it exists to set things like `seatHeight` that no parser derives). It writes through `mergeReviewedVariantPatch` (`lib/variant-merge.mjs`): merged in the DATABASE, guarded on `jsonb_typeof(...) = 'object'`, counted from `RETURNING`, and re-read on a fresh connection. Geometry uses `COALESCE`, so a patch silent about `gap` leaves `gap_inches` alone — unlike the sweep, which is entitled to restamp all three from the text it just parsed. |
| `scm.purchase_order_item_allocations` | mig 0235 — sub-line slices of ONE PO line across customers + stock: `company_id` (NOT NULL), `purchase_order_item_id` FK CASCADE, `seq` (1-based dense, UNIQUE per line), `qty` (>0, SUM <= line qty via triggers), `so_item_id` FK SET NULL (NULL = stock), `created_by`, `created_at`. Attribution only — no stock/money/quota. |
| `scm.po_revisions` | Full header+items snapshot per revision, keyed `(po_id, revision)`. Written by `snapshotPo` / `reviseBoundPo` (`backend/src/scm/lib/so-revision.ts:861`, `:991`). |
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

**Three producers, one column — reads are shape-blind, DELETION is not.**

| Producer | Key shape |
|---|---|
| SO->PO convert (copies the source line's array) | `so-items/<soDocNo>/<soItemId>/<uuid>.<ext>` |
| AutoCount photo importer (appends its own) | `po-items/<po_number>/<po item id>/ac-<DtlKey>-<n>.jpg` |
| PO add-on upload (owner 2026-08-28, `purchase-order-item-photos.ts`) | `po-items/<poId>/<itemId>/<uuid>.<ext>` |

All live in the SAME R2 bucket (binding `SO_ITEM_PHOTOS`). The READ path stays
shape-blind — no CHECK constraint, and the signed/proxy routes authorise by
MEMBERSHIP of the row's `photo_urls`, never by key shape. The importer's append
(`ARRAY(SELECT DISTINCT unnest(COALESCE(photo_urls,'{}') || <keys>))`) is why
the column must stay NOT NULL with a `'{}'` default.

**TWO SCREENS OFFER THE CONTROL, AND THEY MUST NOT DRIFT (2026-08-28).** The
strip is on the PO's TABLE view (`PurchaseOrderDetailV2`, a `Photos` column) AND
in the rich LINE EDITOR (`PurchaseOrderDetail`, inside each `PoLineCard`). The
editor was added second, hours after the owner said 「还是不能添加照片啊」 with
the table version already shipped — he was on the screen a purchaser is actually
on when specifying a line.

The cause is worth remembering: `PoLineCard` was extracted as "the same SHAPE as
SoLineCard" — a copy of the layout, not a use of the component — so the photo
rail `SoLineCard` grew later had no mechanism by which to arrive here. The card
now takes a `photos` RENDER SLOT (a node, not photo data) so it stays a layout
and knows nothing about documents or permissions;
`vendor/scm/components/po-line-card-photos.test.ts` asserts it never grows an
upload of its own, and that BOTH surfaces use `canOperatePurchaseOrders` and
`isPoOwnedPhotoKey` — two screens writing one column must not disagree about who
may write or which keys they own.

**An UNSAVED line has no address.** The key is `po-items/<poId>/<itemId>/…`, so
the item id is not a detail — it is where the photo lives. A brand-new card says
"Save this line first, then attach photos to it." rather than showing nothing:
an absent rail is what sent the owner looking for it. **The SO stages instead**
(`SoLineCard`'s `pendingPhotoFiles`, drained after save); the PO does not, so a
photo on a not-yet-saved PO line costs one extra save. `docs/bugs/0555-…`.

**The prefix IS the ownership rule on DELETE (since 2026-08-28).** `po-items/...`
keys are PO-owned: the PO detail offers a delete control for them (add-on uploads
and the importer's historical keys alike), and DELETE removes the key, the R2
object and its `.thumb`. A carried `so-items/...` key is the SAME R2 object the
SO line lists, so deleting it from the PO is refused (403
`carried_photo_readonly`) — delete it on the Sales Order instead.

**The convert copies KEYS, not objects.** SO line and PO line point at the same
R2 objects — one photo, two documents, no duplicated bytes and no R2 round-trip
inside the convert. Consequence, deliberate: deleting a photo from the SO line
removes the object, so it also leaves any PO raised from that line. The reverse
is false by design: a PO add-on lives only on the PO (its keys are never copied
back), shows only on the PO detail, and prints only on the PO PDF.

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

> **`reviseBoundPo`'s own signature is unchanged (2026-08-16).** Its file-mate
> `applySoAmendment` gained a required `approval: SoAmendmentApproval | null`
> and turned `c` / `concurrency` into required-with-an-explicit-empty-value, so
> that an approved SO amendment can persist the unit price it approved instead
> of re-pricing to the catalogue — see
> `docs/modules/sales-order.md`, *What an approved amendment does to the LINE
> PRICE*. Nothing on the PO side reads that flag: the bound PO's line cost is
> still derived by `deriveMfgPoUnitCost`, never copied from the SO's selling
> price.

**Read-only on the PO side.** Photos are authored on the Sales Order (or by the
importer); there is no PO upload or delete route to drift from the SO's
lease/audit rules. Since 2026-08-28 the desktop V2 detail renders them (Photos
column, read-only strip — see §8) and the printed PO carries them too:

**Line photos on the printed PO (owner mockup, 2026-08).**
`frontend/src/vendor/scm/lib/purchase-order-pdf.ts` prints ONE
"ITEM PHOTOS" block in the page-bottom zone — beside the
"Sofa layout — front faces TV" section when the last diagram row leaves usable
width, wrapping below it otherwise; a PO with no sofa renders the block alone,
full width. (Owner print QA 2026-08-28: generated strings are English-only —
CJK in generated text re-fonted every photo-carrying PDF — and the labels and
sizes here are the v2 ruling.) Table rows carry NO image; a line with
`photo_urls` appends " (photo)" to its description instead. Groups are keyed by
row position in the items table (`Item 3`, or `Item 2-4` when consecutive rows
carry a deep-equal photo list — a sofa set's shared build photo prints once),
with the SUPPLIER code beside the chip and ~52mm square thumbnails, max 3 per
row; a group never splits across pages.
The logic is the shared `frontend/src/vendor/scm/lib/pdf-item-photos.ts`
module the SO PDF also prints through (unit-tested beside it). Only `.thumb`
siblings are fetched (never originals — PDF size) via the authed PO proxy,
keyed by the header's `id`; per-photo best-effort — a failed fetch or an
undecodable format skips that photo, never the document.

> **THE TILE IS SQUARE; THE PHOTO IS NOT CROPPED TO IT (2026-08-28).** Owner:
> 「确保一下，当我就算 zoom 大这个照片，它也不会变模糊」. Two things changed
> together and `docs/bugs/0554-…` carries the arithmetic:
>
> · `PDF_THUMB_PX` 512 → **1536**. 512 across a 52mm tile is ~250dpi, chosen for
> PAPER and fine there — but a reader zooming to 400% on a screen is asking for
> ~786 device pixels, so the photo softened exactly when somebody leaned in to
> check a detail. That is the moment these photos exist for: a purchaser
> photographs a tape measure against a panel. The cost is real and was accepted:
> ~9× the pixels, a tile around 200-500 kB instead of 30-70 kB.
>
> · The transcode used to force a square by cropping to the shorter side, so
> every PORTRAIT photo lost its top and bottom — and a tape-measure photo is
> portrait BECAUSE it is a tape measure. It now keeps its aspect ratio,
> letterboxed inside the still-52mm tile, so the grid and every height
> calculation are untouched. `PdfPhotoImage` carries `w`/`h` for that: without
> the encoded dimensions a portrait photo in a square tile comes out squashed,
> which is a worse lie than the crop was.
>
> The encoder never UPSCALES — a 300px source re-encoded at 1536 is the same
> 300px of detail in nine times the bytes.

> **THE PLAN FOLLOWS THE LINES, SO THE LINES ARE ORDERED WHEN THEY ARE MADE
> (2026-08-28).** `buildDefaultSofaCells` tiles modules left→right IN THE GIVEN
> ORDER, and the given order is whatever the document lists — so a PO carrying
> `L(RHF)` before `2A(LHF)` drew the right-hand chaise on the left. The fix is at
> line creation, not in the drawing: `orderSofaCellsForNewLines` (shared) sorts
> by the handedness the CODES carry — the owner: 「我们是看后面的 LHF RHF 啊 这才
> 是方向」 — with real geometry breaking ties within one hand.
>
> It is separate from `orderSofaCellsLeftToRight` because that one runs at
> DISPLAY time too, and reordering there would re-sequence every existing order
> the next time it was opened (「只针对新的order生效 旧的就不理了」).
> `docs/bugs/0564-…`.
>
> The plan's heading is now `Sofa layout — viewed from above, front faces the
> TV`. It used to end `(orientation / LHF·RHF)` — a note to ourselves on a
> document a supplier reads. LHF/RHF still print per line, where they identify a
> part.

> **THE COMPARTMENT DEFAULT IS DERIVED FROM THE CODE, NOT READ FROM CONFIG
> (2026-08-28).** `loadSofaCompartmentArtForPrint(codes)` takes the module codes
> THIS sheet needs and falls back to `sofa-modules/<code>`; the stored
> `sofaCompartmentMeta` is consulted only for an OVERRIDE (an uploaded photo, or
> a typed URL).
>
> It has to work that way because the stored config carries NO imageKey for the
> defaults: `seedCompartmentMeta` in `Products.tsx` supplies them CLIENT-SIDE at
> render time, so the Maintenance list shows a picture for every compartment
> while the database holds nothing. The print path read the stored value, found
> nothing, and drew schematics — pictures on screen, drawings on paper, no error
> anywhere, and both observations true. `docs/bugs/0561-…`.
>
> **`seedCompartmentMeta` is still a second declaration of the same default** and
> should move to the shared library both surfaces import. Today they agree only
> because both happen to land on `sofa-modules/<code>`.

> **FIVE BUTTONS PRINT THIS DOCUMENT; THERE IS ONE OF THE DOCUMENT (2026-08-28).**
> The owner printed three POs and asked why they did not match, then asked the
> question that names the confusion: 「我的 PO 的 documentation 不是应该只有一个
> documentation 吗？」 There is. `purchase-order-pdf.ts` is the only generator and
> the layout has never been duplicated. What there are five of is CALLERS —
> `PurchaseOrderDetailV2`, `PurchaseOrderDetail` (the edit page),
> `PurchaseOrdersListV2` (two exports) and `printDocumentPdf` (the right-click
> chain print) — and the sofa artwork was an OPTIONAL ARGUMENT each had to
> remember. Only the V2 detail did, so the other four printed the fallback
> schematic.
>
> **The generator now fetches the artwork itself**
> (`loadSofaCompartmentArtForPrint`, beside the supplier/fabric lookup it already
> does at print time). A supplied `opts.sofaPhotos` still wins, so the V2 detail
> spends no second request. Passing it at five call sites is the arrangement that
> produced the defect; a sixth caller would have reproduced it.
> `po-print-paths-draw-the-sofa.test.ts` COUNTS the callers that pass the map, so
> it fails when a fifth appears. `docs/bugs/0556-…`.
>
> Note for diagnosis: the plan is drawn at PRINT time and nothing about it is
> stored on the document, so an old PO and a new one print identically — which is
> what ruled out the data when the owner asked whether only new orders were
> affected.

> **THE SOFA PLAN DRAWS THE OWNER'S OWN ARTWORK, POS'S WAY (2026-08-28).**
> `sofa-compartment-art.ts` resolves the THREE shapes an `imageKey` takes — an
> uploaded object, the seeded `sofa-modules/<code>` bundled art, or an http URL.
> It previously sent all three to the uploaded-photo API, so every DEFAULT
> compartment 404'd and the sheet drew its own schematic instead. The art is also
> cropped to its alpha bbox before jsPDF sees it, because the files are 1024²
> with the drawing padded inside and filling a cell with the raw file tiles the
> modules small and gappy — POS's "2WC card bug".
>
> A corner sofa draws as ONE connected L (`sofa-corner-pdf.ts`, ported from POS):
> tiling the three per-module PNGs "leaves a STEP + an INTERNAL ARM", and on a
> supplier's sheet that step reads as a real gap.
>
> **NOT ported:** POS's `renderSeamlessSofa`, which joins a straight run
> containing a power seat or a wide-arm 1B/2B. The 13 SVG-only codes fall back to
> the drawn schematic — a drawing is visibly a drawing; a blank cell looks like a
> missing module. `docs/bugs/0553-…`.

### Status vocabulary

> **THE HOLD IS A MARKER NOW, NOT A STATUS — 2026-08-22, mig 0324.** Owner:
> 「我们的hold是给我们知道一个 order hold这的」. `scm.purchase_orders` carries
> `on_hold` / `hold_reason` / `held_at` / `held_by`, and `PATCH /:id/hold` is the
> control — **the PO's first working hold of any kind**, because the status added
> on 2026-08-21 had no writer anywhere in `frontend/src`. A held
> `PARTIALLY_RECEIVED` order is still partially received; the list shows the real
> pill plus a Hold chip, and the **On Hold** tab reads the flag.
>
> **THE FREE BLOCK STOPPED BEING FREE, and this is the paragraph to read before
> touching the receive path.** The note below said a held PO was excluded from
> `RECEIVABLE_PO_STATUSES` "without a line of new code". That was true only while
> the hold OVERWROTE the status. A held PO now reads `SUBMITTED` and sails
> through an allow-list of `SUBMITTED / PARTIALLY_RECEIVED` — so the predicate is
> now `isReceivablePo(po)` in `grns.ts`, which reads the marker off the ROW.
> Getting this wrong writes stock IN against a purchase order somebody
> deliberately stopped.
>
> **`recomputePoReceived` deliberately did NOT gain a flag term.** It excluded
> `ON_HOLD` only because re-deriving the status would have erased a hold living
> in that column. It cannot any more, and freezing a held PO's received counts
> would be the same lossiness the marker removes. It keeps the `ON_HOLD` literal
> for a LEGACY row, whose hold is in the status column and nowhere else.

> **`ON_HOLD` added 2026-08-21 (mig 0318, owner: 「PO 加 hold」).** The purchase
> side never had a reversible stop — only `CANCELLED`, which is final and which
> the ERP pushes to AutoCount where it cannot be un-cancelled. The LABEL stays in
> `scm.po_status` for ever (Postgres has no `DROP VALUE`) and every pill map
> keeps rendering it; nothing writes it.
>
> **Three display maps move with it**, two of them on the detail page:
> `status-pill.ts`'s PO map, `PurchaseOrderDetailV2`'s `STAGE_LABEL`, and that
> page's `effectiveOf` — whose fall-through answered **`cancelled`**, so a held
> order would have told the buyer it was cancelled.



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
`mfg_sales_order_items.po_qty_picked` (`recomputeSoPicked`, `:2988`), the base
for the over-convert cap. It no longer decides From-SO picker visibility — the
pooled MRP shortage does (`/outstanding-so-items`, §2). Cancel and reopen move
the counter back and forth; so do line delete and line edit. There is no
document delete on a PO.

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
is `reviseBoundPo` (`backend/src/scm/lib/so-revision.ts:991`), driven by the
SO-amendment approve-PO gate; `GET /:id/revisions` (`:896`) feeds the Revisions
tab. There is no "Revised" badge: the revision rides the DOC NUMBER itself —
`poDisplayNumber()` (`vendor/scm/lib/po-status.ts:37-44`) renders
`<po_number>_R<revision-1>` when `revision > 1`, on screen and on every print.

---

## 7. The cost / money columns

Everything is integer sen. The PO is a **cost** document — it has no margin
columns at all.

| Column | Where | Frozen or live |
|--------|-------|----------------|
| `unit_price_sen` | line | Live — operator-editable until the PO locks. This is the agreed supplier price. |
| `discount_sen` | line | Live. Clamped so `line_total_sen = max(0, qty*unit - discount)` (`:2432`). |
| `line_total_sen` | line | Derived on every line write; rolls into the header. |
| `unit_cost_sen` | line | Written by the **SO→PO convert paths only** — `computeMfgPoUnitCost` (`shared/mfg-pricing`) plus the supplier sofa-combo spread (`loadSupplierSofaCombos`, `:78`). Plain `POST /` writes no `unit_cost_sen` at all, and add-line / line-edit store whatever `unitCostCenti` the client sends, unvalidated. |
| `subtotal_sen`, `tax_sen`, `total_sen` | header | Derived from lines. |
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
| **Line remarks (`notes`)** | text under the item on `PurchaseOrderDetailV2.tsx` + a `defaultHidden` **Remark** column (search / filter / export); an editable **Remarks** box on `PurchaseOrderDetail.tsx` (Edit, via `PoLineCard`'s `showRemarks`) and on `PurchaseOrderNew.tsx` (Create) | text under the item on `mobile/MobileModuleDetail.tsx` — rendered through the shared `mobile/MobileLineRemark.tsx`, DISPLAY-ONLY (the phone PO surface still has no per-line editor) |
| Line photos (mig 0274) | Photos column on `PurchaseOrderDetailV2.tsx` (read-only strip, since 2026-08-28) | NOT BUILT — the mobile PO detail surface DOES exist (`MobileModuleDetail` config, Submit/Cancel/Reopen actions, a line list already rendering the mig-0235 allocation chips); it renders no photos, and there is no per-line editor to hang an uploader on |

### Line remarks — `purchase_order_items.notes`, surfaced 2026-09-04

Owner, 2026-09-04: 「那个 description 2 也要记录进我们的 remarks 里面」,
「SO line 和 PO line 的 remarks」. The PO line's free text is `notes` — the twin
of the SO line's `remark`. It has always been selected by `ITEM_COLS`, persisted
by the item POST, and patchable through the item PATCH's `['notes','notes']`
field map; **no screen rendered it until 2026-09-04**, and `PoLineCard` had no
`notes` or `remark` field of any kind.

That mattered because it is where the AutoCount migration parked the book's own
`Desc2`. Measured on production 2026-09-04 over the 1,117 migrated company-1 PO
lines: **923 carry the book's wording in `notes`** (891 byte-identical to
`description2`, 32 the same text plus a suffix), e.g.
`col:PC-151-03/m.gap:12inch/divan:8inch+2inchleg`.

**Why `notes` and not `description2`.** `description2` is server-owned on a PO
line — the item PATCH recomputes it from `buildVariantSummary` on every write —
and it IS on the AutoCount write-back path. `notes` is neither: `PO_ITEM_COLS`
(`backend/src/scm/lib/autocount-outbox.ts`) does not select it, and the only
`notes` the write-back sends is the HEADER's (`purchase_orders.notes` →
`Description`). So a line remark survives every save and never reaches the book.

**`PoLineCard`'s box is OPT-IN** (`showRemarks`, default off). The same card is
reused by `PurchaseInvoiceDetail`, `PurchaseInvoiceDetailV2` and
`PurchaseConsignmentOrderDetail`, and each of those parents enumerates the fields
it sends on add/update — a box they do not send would accept typing and discard
it on save. Turn it on in a parent only when that parent also carries `notes` in
BOTH payloads. Ledger: `docs/bugs/0638-*`; sales-side twin `docs/bugs/0639-*`.

**Line photos render on the desktop V2 detail since 2026-08-28** — a read-only
Photos column between Supplier SKU and Ordered, tiles opening the shared
`MediaLightbox` against the full object. Read-only is BY DESIGN: photos are
authored on the SO and carried across, so the PO strip has no upload/delete UI.

The fetcher seam this section used to ask for exists now, the way it asked: the
resolver in `frontend/src/vendor/scm/lib/so-line-photo.ts` is
source-parameterised (`useScmLinePhoto('so' | 'po', …)`; `useSoLinePhoto` stays
as the SO-shaped wrapper so the SO call sites did not change), the PO-shaped
fetcher siblings live beside the SO ones in
`frontend/src/vendor/scm/lib/sales-order-queries.ts`
(`fetchPoItemPhotoSignedUrl` / `fetchPoItemPhotoBlob` — that file owns the
photo wire contract), and `photo_urls` is threaded through `PoItemRow`. The
hook was NOT copied. Read `so-line-photo.ts`'s header before touching it —
three production regressions have lived in that state machine. The caches are
keyed by the R2 key and shared across sources on purpose: an SO→PO convert
copies the key list, so both surfaces show the same bytes.

Still missing: the phone surface (no photos on `MobileModuleDetail`'s PO line
list), and `PoLineCard.tsx` (the edit card) shows none either — both stay open,
each its own PR.

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

`backfill-po-so-item-links.mjs` resolves this link from the PO's PROVENANCE
note, written at raise time by the SO -> PO convert (`Transfer from Sales
Order: …` since 2026-08-18; the legacy `From SOs:` / `From SO:` spellings are
accepted permanently — see document-conversion.md §10). A migrated PO has no such
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

---

## When the accounts will not take the order, the buyer is told at save

Owner 2026-08-19. The rule and the block-or-warn reasoning live in
`docs/modules/autocount-writeback.md` §6b; the sentences in
`backend/src/scm/lib/ac-preflight.ts`.

`ac-preflight.ts` carries a SECOND verdict from 2026-08-20, and it is not this
one. `AC_NOT_SENT` means *the accounts do not have this document*;
`AC_SENT_INCOMPLETE` (`acNotCarriedProblems`) means *they DO have it, and a
field on it did not come with it* — the case that only arises on the four
TRANSFERRED documents, whose route applies a strictly narrower header than an
edit does. Two codes and not one, because filing the second under the first
would tell an operator their goods receipt is ERP-only when the book already
holds it, which sends them to raise it twice. Nothing on a sales order or a
purchase order raises `AC_SENT_INCOMPLETE`; it is named here only so the two
are not confused when reading that module.
See `docs/modules/autocount-writeback.md` §7c5.


All three PO create anchors — `POST /` (`createMfgPurchaseOrderHandler`),
`POST /from-sos` (per created PO), and `PATCH /:id/confirm` — now return
`acNotSent: SaveProblem[]` when the AutoCount composer refused the order. The key
is ABSENT when the order composed cleanly. `POST /from-sos` carries it per PO
inside `created[]`, because that route raises several and which one was refused
is the whole point.

**It never refuses the save**, and that is a decision, not an omission. Every live
cause on this side needs master data a buyer does not own:

| Cause | What the buyer is told to do |
|---|---|
| The ERP code maps to several AutoCount items and this order's supplier owns none of them | raise the order against the supplier the product is actually bought from, or ask for the duplicate AutoCount item to be retired |
| `scm.suppliers.code` is empty — no AutoCount creditor | ask accounts to give the supplier its creditor code, then re-raise |
| **Added 2026-08-20** — the order was raised FROM a sales order and one of its sofa builds does not line up with how the accounts already hold that build (`AcSoToPoAlignmentError`) | ask for that build's line keys to be checked, then re-raise |

That third cause has the same shape as the first two — master data a buyer does
not own — and it is the only one whose refusal is about the SO-to-PO transfer
rather than the order's own contents. `docs/modules/autocount-writeback.md`
§7c3b-i has what "does not line up" means and which sofa build reaches it.

**A refusal is surfaced TWICE and the two lists must agree**: `noteReadFailure`
(the durable outbox row, for an engineer) and `acNotSentProblems` (the sentence,
for the buyer) are two `instanceof` chains someone has to remember to extend, and
both were short of the same class on the day it was added. They are now pinned
against each other in `backend/src/scm/lib/ac-preflight.test.ts`, which reads the
two sources and names whichever side is missing a class.

Blocking any of them would stop procurement over an accounting-map defect and blame
the person who cannot fix it. Measured against the compiled cutover map: 117
ambiguous ERP codes, all 117 refused under a creditor that owns none of their
candidates — this is the purchase side's problem alone, because a sales order
names no supplier and resolves to the ERP's own code.

Surfaced on `frontend/src/pages/scm-v2/PurchaseOrderNew.tsx`, before the
navigation so the page change cannot swallow it. `PurchaseOrderFromSo.tsx` is
NOT wired yet and still saves in silence.

## Right-click Print, for the whole chain (owner ruling, 2026-08-22)

**The list's right-click Print prints the chain (2026-08-23).** A PO row offers
`Print`, `Print Sales Order <no>` for each order its supply is BOUND to, and
`Print Goods Received <no>` for each GRN it was received into — in place, no
navigation. The row already carries `assigned_sos` and `transfer_to_grns`, so no
payload change was required.

Two exclusions are deliberate: an `assigned_sos` entry whose `source` is `'mrp'`
builds NO entry (a live allocation binds nothing — the 2026-07-29 incident), and
neither does a PRE-2026-07-31 bare-string GRN chip, which carries a number and
no address. `document-conversion.md` §8b has both.

### The PO PDF's sofa diagram draws REAL compartment photos (2026-08-28)

The sofa-layout schematic on the PO PDF (`drawSofaLayout` in
`vendor/scm/lib/sofa-layout-pdf.ts`) draws each module's real uploaded hero photo
— the same per-code photos POS Custom Builder shows — in place of the hand-drawn
cream rectangle, when one exists. It is an OPTIONAL overlay: a compartment with no
uploaded photo, or one whose fetch fails, still renders the drawn schematic, so
this is never a hard dependency and pre-existing behaviour is unchanged.

Photos are keyed by compartment CODE, so a photo uploaded later in Backend → Sofa
Compartments appears on the PO the next time it is printed, with no code change.
The live `/scm/purchase-orders/:id` page (`PurchaseOrderDetailV2`) reads the master
maintenance config's `sofaCompartmentMeta` and `loadSofaCompartmentPhotos`
(`vendor/scm/lib/sales-order-queries.ts`) fetches each via the public
`/maintenance-config/sofa-compartments/:code/photo/:key` proxy into a
`{ code: dataURL }` map passed to `generatePurchaseOrderPdf`. Other PO print paths
(list bulk-print, consignment, v1 detail) pass no photos and keep the schematic.
Engine merged in #2754; wiring in #2758.

## Drill-down columns and "still loading"

A cell fed by a SECOND query renders **WORKING…** while that query is in flight
and **NOT LOADED** if it fails — never `STOCK` or a bare dash, which are
answers. `coverage` is a required prop on the shared drill-down; the rule, the
five surfaces that fetch separately, and how to add a sixth are in
`docs/modules/coverage-state.md` (trace: `docs/bugs/0603-a-drill-down-printed-stock-while-the-answer-was-still-loadin.md`).

## Special orders on a PO line: the price is recomputed in the BROWSER

`PATCH /mfg-purchase-orders/:id/items/:itemId` (`mfg-purchase-orders.ts:3131`)
runs NO server-side pricing recompute. `unit_price_sen`, `unit_cost_sen` and
`special_order_price_sen` are persisted exactly as the client sends them
(`:3164-3172`, `:3204-3208`). The re-pricing lives in the ERP UI:
`PurchaseOrderDetail.tsx:415` re-prices every line whose `priceTouched` is false,
and `:621-629` clears that flag whenever the operator changes a variant — so
editing a spec re-derives the supplier cost through `computeMfgPoUnitCost`.

**Which pool that reads matters, and it is not the picker's.** It sums
`maintenance_config_history`'s `specials` pool (`backend/src/scm/shared/mfg-pricing.ts:538`), NOT
`scm.special_addons`. Measured on prod 2026-09-02 (read-only run **33659562235**)
that pool DOES carry `priceSen` for the priced picker codes at master scope and
at both supplier scopes, so adding one of those codes to a migrated PO line's
`variants.specials` moves that PO's price on the operator's next spec edit.

That is why the migrated-line backfill writes `variants.specialsRecorded`
instead — a key no pricing path reads. Full rule and the surfaces that render it:
`docs/modules/sales-order.md` §`variants.specialsRecorded`.
