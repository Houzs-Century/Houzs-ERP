> ## Corrections — 2026-08-12 code-read sweep
>
> 1. PO amendments ARE their own document now (document-flow.ts:993-1017, mig 0194): the graph returns a poAmendments array; §2.3's categorical sentence is retired.
> 2. HOUZS mints HC- since owner 2026-08-07 (companyScope.ts:400-441); a headless context degrades to the BASE prefix, never “” — §2.6/§2.7's bare-on-base frame is stale (the DocumentLinesExpansion.tsx:174-177 tooltip drifted the same way).
> 3. ACCESSORY lines on purchase-doc drill-downs render AccessoryAssignmentSummary, not chips, since 2026-08-04 (DocumentLinesExpansion.tsx:342-379,:636-651).
> 4. “Immutable stored links” is wording-stale: all three so_item_id FKs are ON DELETE SET NULL (so-line-relink.ts:1-33; re-adopted in 0235:87,99); survives-delivery = Yes stands.

# Module: Cross-document traceability display (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Read-time, DISPLAY-ONLY surfacing of "which Sales-side documents did this
purchase document's items end up assigned to", on the expandable rows of the
Purchase Order / GRN / Purchase Invoice lists. No DB writes, no snapshot, no
schema change — every linkage below is resolved at read time from data that
already exists. A persisted-snapshot approach was considered and rejected as
unsafe.

> Owner ask (2026-07-24 live testing): across the procurement chain each
> document should show the Sales Order it is assigned to (+ that SO line's
> delivery date) and, once delivered, the DO and SI the item ended up in.

Line references are against `feat/doc-traceability-display` off `origin/main`
@ `985ee12c`.

---

## Decision (owner, 2026-08-06): soft until DO, hard from DO

Before a Delivery Order exists, ALL supply-demand matching belongs to the
floating MRP allocator — pooled by (warehouse, item_code, variant_key),
constrained by one-batch-per-SOFA-set (bedframes exempt), ordered by delivery
date then doc_no. Nothing persisted before the DO governs **MRP matching**:
`purchase_order_items.so_item_id` and the mig-0235 allocation sub-lines carry NO
cap and NO coverage precedence inside `computeMrp` (`mrp.ts:174` — "informational
only now").

They are **not** inert at DO time, and the model below is what SHIPPED, not what
this section used to describe. At DO creation `resolveShipCommitments` decides
binding from four facts — sofa detection, the SO line's `allocated_batch_no`, the
STORED `so_item_id` raise-link resolved in `block` mode
(`resolveExpectedBatchBySoItem`, `dropship-batch.ts:62-80`), and the live
shortage list — and records the answer on the DO line (`committed_po_batch_no`,
mig 0230, written at `delivery-orders-mfg.ts:3789`). **The MRP allocator is not
consulted: `computeMrp` is never called anywhere in `delivery-orders-mfg.ts`.**
So the stored pre-DO link IS hardened into the DO, and that stamp then drives
receipt-time netting and MRP's own `applyCommittedSupply` deduction
(`mrp.ts:283-294`).

From that moment everything is anchored history: committed batches, OUT
movements, lot consumptions, COGS, delivered attribution. Post-DO records are
never recomputed.

> Whether "provenance binds nothing before the DO" was meant as a design RULE
> that `resolveShipCommitments` violates, or was simply superseded by it, is an
> OWNER DECISION (UNVERIFIED as of 2026-08-13). The code above is what runs.

A stored-link-vs-delivered divergence is therefore NOT a defect; a double-SERVE
in the delivered ledger IS. Do not reintroduce the stored link into any
execution path — that is the pre-2026-08 model this decision retires, and the
parked branch `wip/harden-so-po-link-parked` (which hardens the MRP pick INTO
the link) is formally ABANDONED by this decision; do not resurrect it.

Rollout is staged (lenses/docs → DO-time live allocator → pooled caps →
display demotion); until every stage lands, the transitional guard remains:
rejecting an SO-revision follow-up auto-releases the PO to STOCK.



## 1. The linkage map (read this before changing anything)

There are THREE distinct linkages in play. They are NOT interchangeable; the
whole point of this doc is to record which one answers which question.

| # | Linkage | Where it lives | Semantics | Survives delivery? |
|---|---------|----------------|-----------|--------------------|
| A | **Floating MRP coverage** | `mrp.ts` `computeMrp()` → `mrpLineCoverage()` | Which outstanding PO currently covers which SO line, greedy by delivery date over a POOLED supply. `MrpLine.poNumber` is the forward map (SO line → PO). | **No** — computes over OUTSTANDING demand only; a delivered line is subtracted out (`effQtyOf` / `soDeliverableRemaining`) and `SO_DONE` statuses are excluded. The coverage evaporates the moment the line ships. |
| B | **Stored raise-link + document relationship** | `document-flow.ts` (`/document-flow/:type/:id`) | The SAP-B1 relationship graph. Real stored FKs: `purchase_order_items.so_item_id` (the SO line a PO line was RAISED from, 2026-07-09 onward), the PO provenance note (pre-MRP shared buys), `grns.purchase_order_id`, `purchase_invoices.grn_id`, `delivery_orders.so_doc_no`, `sales_invoices.*`. | **Yes** — they survive delivery, which floating coverage does not. But they are RECORDED, not ENFORCED: every one is nullable (an ad-hoc DO line is written with `so_item_id ?? null` straight from the client payload, `delivery-orders-mfg.ts:3752`), and several have been rewritten by repair scripts (`backfill-po-so-item-links.mjs`, `repair-2990-doc-refs.mjs`) — so they are not immutable either. |
| C | **Physical batch/lot trail** | `soLineShippedSourcePos()` (`delivery-orders-mfg.ts`) | `batch_no = source PO number` (stamped by the GRN, mig 0120, copied onto the FIFO lot by the trigger). Recovers, for a SHIPPED SO line, the PO(s) its goods physically came from, via DO OUT movements ∪ `inventory_lot_consumptions` → `inventory_lots.batch_no`. | **Yes, but only for BATCHED stock** — plain-FIFO un-batched stock carries no batch, so the trail is best-effort and incomplete. |

Key trap: **A ≠ B.** For a PO raised via convert-from-SO, `so_item_id` (B) is the
SO line it was raised for, but the pooled coverage (A) may attribute that PO's
stock to a DIFFERENT, higher-priority SO line. Showing both would present two
conflicting "assigned to" SOs.

---

## 2. What shipped (cleanly derivable)

### 2.1 PO / GRN / PI "Assigned SO" — PRECEDENCE (delivered DO-lock > stored origin > MRP floating), two inline line columns
`feat/po-mrp-assigned-so` (2026-07-25) — supersedes the stored-origin-only build.
The arc: #1237 showed FLOATING only (wrong for a raised PO); #1246
(`feat/po-real-origin-so`) showed STORED origin only and so rendered "—" for
every PO NOT converted-from-SO, even when MRP was actively covering it (see
`BUG-HISTORY.md` 2026-07-25). The owner's model resolves the two: an SO knows its
covering PO (via MRP), so the REVERSE must hold and be CONSISTENT — the PO shows
its assigned SO(s) — FLOATING until the goods ship, then STATIC once a DO locks
them, and PO↔SO must invert ONE engine so they can never disagree.

Now the Assigned SO is resolved by **precedence per SKU**, combining all three
linkages:

| # | Precedence | Linkage | State |
|---|-----------|---------|-------|
| a | **DELIVERED → DO-locked** | **C** (reverse of `soLineShippedSourcePos`: `batch_no` = this PO number consumed by a DO → that DO's `so_item_id` / `so_doc_no`) | **STATIC** (`locked:true`) |
| b | **STORED ORIGIN** | **B** (`so_item_id` ∪ provenance note) | **STATIC** (`locked:true`) |
| c | **MRP FLOATING coverage** | **A** (`computeMrp` → `mrpReverseCoverage`, matched by SKU) | **FLOATING** (`locked:false`) |
| d | none | — | dash |

Shown as TWO INLINE per-line columns inside the existing `DocumentLinesExpansion`
table (`Assigned SO` + `SO Delivery Date`, styled like the SO detail's Stock /
Incoming-PO columns) in each of `PurchaseOrdersListV2` / `GoodsReceivedListV2` /
`PurchaseInvoicesListV2`. The chip is clickable on desktop (→ `/scm/sales-orders/:docNo`,
via `onOpenSo`); the mobile twin rides each `LineItem` in
`MobileModuleDetail.tsx` (display-only). Rendering follows the THREE chip
identities of §2.10 (since 2026-08-07; this supersedes the original two-way
dashed-vs-"Locked" rendering): **anchored** (source `delivered`) solid,
**provenance** (source `linked`) muted with "bought for" wording, **floating**
(source `mrp` / `locked:false`) dashed + trailing "~". A line with no
assignment at any layer renders a subtle **`STOCK`** tag, not a dash —
`emptyMeans="stock"` on the drill-down line cell and on the PO / GRN / PI list
header cells (`DocumentLinesExpansion.tsx:683-684`, `:837`). See §2.9.

Backend: `GET /po-so-coverage/:type/:id` returns `{ poNumber, poId, origins, delivered }`
where `origins: [{ itemCode, assignments: [{ soDocNo, deliveryDate, locked,
source }], storedLink, provenance: [{ soDocNo, deliveryDate, locked: true,
source: 'linked' }] }]` and `delivered: [{ itemCode, dos: [{ doNo, qty }] }]`,
matched by SKU (`item_code`). The full relationship graph (SO/DO/SI +
returns) stays on the Relationship Map modal (`/document-flow/:type/:id`) —
unchanged.

**The parallel `provenance` slot (2026-08-07, PR-3 of the Decision rollout —
ADDITIVE, precedence NOT changed).** `assignments` still carries ONLY the
precedence winner exactly as above; `provenance` ALWAYS carries the layer-(b)
stored-origin SOs for that SKU, whichever layer won (empty when none). It is
the "which SOs" companion to the coarser `storedLink` boolean. List rollups
carry the same pair: `PoAssignedSummary` gained `provenanceSos` (deduped
across SKUs) beside the untouched `assignedSos`/`sourceLinked`, and the PO /
GRN / PI list rows stamp it as `assigned_so_provenance` (for GRN / PI it is
rolled up over the same code-filtered origins, so header ≡ ∪(lines) holds for
the provenance slot too). Optional on the frontend types, so an older backend
degrades to exactly the pre-PR-3 rendering.

**Side-by-side rendering rule.** After the precedence chips, every Assigned-SO
surface (drill-down cells, `AssignedSoCell`, and the mobile twins — one
product) ALSO renders a muted "bought for" chip (§2.10 provenance identity —
never the word "Locked", no execution status pill) for each provenance SO NOT
already shown, deduped by `soDocNo` — when the stored origin won the
precedence the two slots are identical and nothing extra renders. The case
this exists for: the floating allocator re-assigned (dashed chips) while the
stored links remain — after an SO amendment both truths sit side by side.
Under TODAY'S precedence (b) still outranks (c), so a per-SKU floating winner
implies an empty stored layer; the side-by-side state reaches the UI now via
delivered-vs-stored divergence and mixed-SKU list rollups, and becomes the
common case when PR-4 (the owner-gated live DO-time allocator binding) flips
the execution answer to the allocator.

### 2.5 Doc-side split (2026-07-31) — sales docs show Source PO, purchase docs add Delivered; no "+N" collapse anywhere
`feat/assigned-so-inline-date`. Owner feedback split the unified "Assigned SO"
column by document side, and banned any "first + N" summarization:

- **Sales docs (DO, SI) — Assigned SO REMOVED, Source PO ADDED.** A DO/SI is born
  FROM a Sales Order, so "Assigned SO" is redundant there. Both now show **Source
  PO** = the PO(s) the shipped/invoiced goods actually came from, the durable
  `batch_no` = source-PO hard link (OUT movements ∪ consumed FIFO lots), NOT an
  MRP guess. `MfgDeliveryOrdersListV2` restored the document-flow **From SO** label
  and its drill-down uses `showSourcePo` (not `showAssignment`); `SalesInvoicesListV2`
  gained the same Source PO column + drill-down. Backend: the DO list stamps
  `source_pos` per row via `resolveDoSourcePosForDos` (batched, `delivery-orders-mfg.ts`);
  the DO detail already returned per-line `source_pos`. The SI list stamps
  `source_pos` via `stampSourcePos` (SI → `delivery_order_id` → DO ledger); the SI
  detail resolves per-line `source_pos` via `resolveDoLineSourcePos` matched by
  `(item_code, variant_key)`. An SI with no `delivery_order_id` (manual invoice)
  shows "—".
- **Purchase docs (PO, GRN, PI) — Assigned SO KEPT + Delivered ADDED.** They keep
  the precedence-resolved Assigned SO and gain a **Delivered** column = the DO(s)
  that shipped the PO's goods (`batch_no` = this PO) + qty per DO. Backend:
  `resolveDeliveredDosForPos` (list rollup) + `resolveDeliveredBySkuForPo`
  (per-SKU, added to the single-doc `delivered` field) in `po-so-coverage.ts`;
  CANCELLED DOs are EXCLUDED. Each list row carries `delivered_dos`; the drill-down
  maps it per SKU via `deliveredByCode` and passes `showDelivered`.
- **No collapse.** `AssignedSoCell`, the Source-PO cells and the new `DeliveredCell`
  render EVERY chip (they wrap); the "+N" was removed. Each Assigned-SO chip now
  carries its OWN delivery date inline.
- `computeMrp` still runs **≤ once per request** on every list endpoint — the new
  delivered/source-PO resolvers are pure ledger reads and add no MRP call.

### 2.6 Chip polish (2026-08-01) — no "x1", no "MRP guess" caption, and why the PO prefixes stay mixed
`fix/assigned-so-polish`. Three owner defects off one screenshot of the DO list.
Display only — no resolver, no endpoint and no stored value changed.

- **No `x1` on a Delivered chip.** `DeliveredCell` and the drill-down's Delivered
  cell now render the `xN` suffix only when `N > 1` (was `> 0`, so every
  single-unit shipment printed `x1`). Owner: *"为什么会放成 1? 很难看"*.
- **The "MRP guess · not linked" caption is GONE** from both surfaces — the
  drill-down cell in `DocumentLinesExpansion.tsx` and its mobile twin in
  `MobileModuleDetail.tsx`. **The resolution is untouched**: `sourceLinked` still
  rides the payload, the dashed-chip + trailing `~` still distinguish a floating
  MRP allocation from a stored link, and the fact the caption used to state now
  rides the chip's `title` on BOTH surfaces (the desktop `AssignedSoCell` already
  did this). So the 2026-07-29 "read a guess as a binding" protection survives as
  a tooltip and a tone, not as a printed line. The `LINKED` / `LOCKED` wording is
  tooltip text only — there was never a visible "LOCKED" caption to remove.
- **Source PO prefixes are DATA, and the labels stay verbatim.** The column mixes
  `2990-PO-2607-009` and `PO-2607-002`. The chip is
  `inventory_movements.batch_no` verbatim (`resolveDoSourcePosForDos`), and
  `batch_no` is `purchase_orders.po_number` verbatim (`resolvePoBatchByItem`,
  mig 0120) — **nothing on that path adds, strips or normalises a prefix**, so
  there is no display bug to fix. Doc numbers are namespaced PER COMPANY
  (`companyDocPrefix`): base company HOUZS mints BARE, every other company
  prefixes with its code. **Normalising the display would be unsafe**: the two
  namespaces can both hold the same tail, so stamping `2990-` on a bare chip
  could name a DIFFERENT real document on the batch → lot → COGS trail. The
  chips gained a `title` explaining the prefix instead (`sourcePoTitle`, exported
  from `DocumentLinesExpansion.tsx` and used by the DO + SI list columns).
- **Which data case it is, is a production question** — answered by
  `backend/scripts/check-source-po-prefixes.mjs` + the manual
  **Source PO prefix check (read-only)** workflow. It classifies every live DO
  OUT batch as prefixed / bare-on-base (correct by design) / **bare-on-a-non-base
  company (a mint gap — `companyDocPrefix` returns `""` when a reconstructed or
  headless context carries no `companyCode`)** / orphaned, and lists any bare
  batch that already has a prefixed twin. **If it reports bare-on-non-base, do
  NOT rename those POs**: `po_number` is copied into `inventory_movements` and
  `inventory_lots` as `batch_no`, so renaming orphans the costing trail. Fix the
  mint path, and leave history alone.

### 2.8 The SO source-PO rule (2026-08-01) — READY traces too, ONE resolver for every surface, and the lot-batch backfill
`feat/so-source-po-trace`. Owner rule, verbatim and now the acceptance bar:
"我们的 SO 如果已经是 Delivered、Ready to Ship 或者 Shipped 状态，其中的任何一件
货物都必须能够追溯到是拿什么 PO 进的货。系统里只要显示 Ready，肯定就代表有货；
既然有货，Inventory 里就绝对会有记录，写明这批货对应的是哪一个 PO。" Plus:
SO / DO / SI / GRN must show IDENTICAL source data for the same order.

- **ONE resolver: `backend/src/scm/lib/source-po-trace.ts`.** The consumption →
  lot → batch chain used to live in four near-copies (`soLineShippedSourcePos`
  / `resolveDoLineSourcePos` / `resolveDoSourcePosForDos` in
  delivery-orders-mfg.ts, plus po-so-coverage.ts's delivered ledger + two
  DO-lock bucket builds). All of them now delegate to this lib: forward
  (`traceDoShipmentSources` + adapters), reverse (`tracePoDeliveredLedger`,
  which returns the delivered qty maps AND the DO-lock bucket keys from one
  pass, so Assigned-SO and Delivered can never disagree). The legacy names
  survive as wrappers with unchanged shapes.
- **NULL-batch lots CLASSIFY instead of vanishing.** The shared core resolves
  a NULL-batch lot's source at read time: GRN-sourced → `grns
  .purchase_order_id` → `po_number` (the same evidence the backfill stamps
  durably, so the UI heals before the backfill runs); ADJUSTMENT-sourced →
  counted as adjustment units, surfaced as a **"STOCK ADJ"** chip (free gifts /
  cancel add-backs are PO-less BY DESIGN — explained, never a blank). DO/SI
  payloads carry `source_adj`; the SO items carry `shipped_source_adj`.
- **READY trace (the §3.3 gap, closed).** `soLineReadySourcePos`: sofa lines
  surface their stored `allocated_batch_no` (mig 0121 — now in the SO `ITEM`
  select); non-sofa lines project the bucket's OPEN LOTS in the engine's OWN
  consumption order (`received_at ASC, id ASC` — fn_consume_fifo's ORDER BY),
  claims walked in the MRP allocation order (delivery date, then doc_no —
  `sku.lines` array order of the SAME `computeMrp` result the detail already
  ran, so no second MRP call). Read-time derivation, no writes; it answers
  "this READY line will draw from PO X" and agrees with what FIFO will consume
  at DO time by construction. Pure core `projectReadyFifo` pinned by
  `backend/tests/sourcePoTrace.test.ts`. SO items carry
  `ready_source_pos: [{ po, qty, kind: 'po'|'adjustment' }]`.
- **Surfaces (desktop + mobile pair).** The SO side renders through ONE
  component, `frontend/src/components/SoSourceChips.tsx` (+ `SoStockPill`;
  the SO list's page-local `drillStock` moved there as `soLineStockPill`):
  the SO list drill-down, **`SalesOrderDetailV2` — which previously rendered
  NO Stock / Incoming PO columns at all** (the payload carried the fields; the
  page dropped them), and the `?edit=1` editor's Transfer-To cell. Mobile
  twins: `frontend/src/mobile/source-chips.tsx` (`SourcePosRowMobile` /
  `DeliveredRowMobile` / `soStockPillMobile`) used by `MobileSODetail` (new
  per-line pill + chips) and `MobileModuleDetail` (DO/SI lines gain Source PO,
  PO/GRN/PI lines gain Delivered — both previously desktop-only).
- **Chip rules (owner 2026-08-01).** (1) Delivered chips: a MULTI-DO line
  always shows each chip's qty — `2990-GRN-2607-020`'s two bare chips read as
  one unit shipped twice when it is a 2-unit batch split 1+1 (audit 10c:
  zero double-attribution); single-DO chips keep the no-`x1` rule
  (`showDeliveredQty`). (2) LIST cells (Assigned SO / Source PO / Delivered)
  render the first ~4 chips + an in-place `+N` toggle (`ChipOverflow` in
  DocumentLinesExpansion.tsx) — supersedes the 2026-07-31 "no collapse" rule
  for LIST cells only ("枕头订500个…UI直接爆开"); drill-down / detail rows
  still render every chip.
- **The durable half: `backend/scripts/backfill-lot-batch-from-docs.mjs` +
  workflow "Backfill lot batch_no from documents (DRY-RUN gated)".** Stamps
  `inventory_lots.batch_no` from document evidence: class `grn` (lot's GRN →
  PO; the lot's IN movement stamped in the SAME transaction — the
  partial-rename fault rule above), class `basis-seed` (the W3 reference-cost
  lots: their INSERT wrote batch_no NULL — verified in
  backfill-fifo-divergence.mjs source — but printed the basis doc into
  `notes`; parsing `(basis GRN|PO <doc> @` recovers the PO. This is what
  makes **`2990-DO-2607-009`'s TRION-(K)** resolve). ADJUSTMENT lots are
  classified, never stamped. Refusals: ambiguity, cross-company evidence,
  conflicting movement batch. Idempotent; per-row prints include WHICH DOs'
  trace each stamp completes.
- **The measurement: `backend/scripts/check-so-source-trace.mjs` + workflow
  "SO source trace check (read-only)".** Every line on every READY_TO_SHIP /
  SHIPPED / DELIVERED SO (both companies) classified — ok-delivered /
  ok-ready / ok-adjustment / service, or a named gap (no-do-line-link,
  do-no-ledger, consumed-lot-unbatchable, sofa-ready-no-batch,
  ready-no-open-lots, ready-lot-unbatchable). Ends with the owner's
  double-attribution verdict via the audit-inventory-costing §10c lens
  (expected ZERO). The bar is zero-or-explained.

### 2.9 HEADER ≡ ∪(lines), delivered precedence, and the duplicate-document detector (2026-08-02)
`fix/header-chip-union`. Three owner screenshots proved the display could still
disagree with itself; the round closes every independent second derivation and
adds the read-only tooling that keeps it closed. See `BUG-HISTORY.md` 2026-08-02
for the three incident entries.

- **THE RULE — a header/list chip set is derived ONLY as the union of that
  document's OWN physical lines' per-line resolver output** (services excluded;
  the drill's bound-PO fallback included). Never a second, independent rollup.
  `2990-DO-2607-017`'s list cell showed a phantom fourth PO because the old
  `byDo` rollup unioned EVERY ledger row keyed to the DO — including buckets no
  current item line owns (re-pointed consumptions, drifted variant keys).
  Implementation: pure `unionLineTraces` + `resolveDoHeaderSources` (DO list) +
  `resolveSiHeaderSources` (SI list — the SI's OWN invoiced lines, not its DO's
  whole set) in `scm/lib/source-po-trace.ts`; unit test locks header-equals-
  union over a mixed sofa/non-sofa/service DO with a phantom orphan bucket.
  GRN + PI list header cells now roll up the per-SKU coverage/delivered data
  RESTRICTED to their own line codes (`resolvePoSoCoveragePerSkuForPos` +
  `resolveDeliveredByCodeForPos` + exported `summarizeOrigins`) — a partial-
  receipt GRN no longer inherits parent-PO assignments its drill cannot show.
  The SO drill "Transfer To" needed no change (per-line derived, no independent
  header). Orphan ledger buckets remain visible to the trace check (section 6),
  never to a UI cell.
- **SO list "PO No." = the drill's union.** `source_po_union` + `source_po_adj`
  per row: SHIPPED/DELIVERED consumed batches (`soLineShippedSources`, now
  chunked for page-scale id sets) ∪ READY projections (`soLineReadySourcePos`
  — ONE computeMrp per list load), united per SO by pure `unionSoLineChips`
  (READY suppressed on fully-shipped lines — the drill's precedence). The
  legacy convert-time raise-link (`converted_po_nos`) survives as the tooltip
  ("Raised PO (convert-time link, not a goods source)") when it differs.
  Desktop column + mobile Orders card (`SourcePosRowMobile`).
  **Superseded 2026-08-11 — the raise-link is a MUTED CHIP again, not a
  tooltip.** Both source arms need execution (a DO line / an open lot that
  resolves to a PO), so a CONFIRMED unshipped order showed "—" while its
  Relationship Map named a PO. On production only ~53 of 2,723 Houzs Century
  SOs can light the source arms, against 277 carrying a real non-cancelled
  `purchase_order_items.so_item_id` link. The cell is now solid-chip = goods
  source, muted-chip = raised PO (deduped against the source set), capped at 3
  with a `+N` whose title lists all; one derivation in `lib/soPoChips.ts` feeds
  desktop (`SoListPoCell`) and mobile (`SourcePosRowMobile` `raised` slot).
- **"STOCK" tag (owner: surplus must not read as missing data).** A purchase-doc
  line/header with NO assignment renders a subtle `STOCK` tag instead of a bare
  dash (`StockTag` / `StockTagMobile`; `AssignedSoCell emptyMeans="stock"` on
  the PO/GRN/PI lists). MRP layer (c) float-assigns automatically when matching
  demand appears — nothing is stored.
- **Paired per-SO sub-table (owner's PO-2606-021 pillow case).** The purchase-doc
  drill's three parallel stacks (Assigned SO / dates / Delivered) are ONE
  sub-table now: one row per assigned SO = SO chip | its delivery date | the
  delivered-DO chips xqty FOR THAT SO | `DELIVERED` / `PENDING` status (an
  unshipped SO with a future date reads PENDING, never blank). Wire change:
  `DeliveredDo` carries `soDocNo` (the DO's own `delivery_orders.so_doc_no`) so
  each chip pairs with its SO row; a delivered DO whose SO is not among the
  assignments still renders (extra row — pairing must never hide a shipment).
  Desktop `PairedSoCell` (+ pure `buildPairedSoRows`), mobile
  `PairedSoRowsMobile`. Header cells keep `ChipOverflow` `+N`.
- **Delivered precedence in the fifo-attribute backfill (the 023/024 incident).**
  `planFifoAttribution` treats an SO line as TAKEN when the delivered ledger
  (consumptions → lot batch → PO) shows it served — regardless of which PO —
  and a partially-served line demands only its remainder. Corrective part
  `fifo-attribute-repair` (A10, DRY-RUN gated, `pos` input) re-evaluates
  EXISTING allocation rows: confirmed unexecuted duplicates get their rows
  REMOVED + a cancel recommendation printed (owner decision, never executed);
  served-elsewhere rows flip to STOCK with the incident-format print.
- **Duplicate-document detector** — `backend/scripts/check-duplicate-documents.mjs`
  + workflow **Duplicate documents check (read-only)**: all six doc types, both
  companies, same-counterparty line-MULTISET fingerprint (code+variant+qty+price)
  within ±3 days, verdicts LIKELY-DUPLICATE / SIBLING-LEGIT (same qty+price,
  disjoint codes — the ANGGN Q-vs-K shape) / NEEDS-EYES, risk-sorted with
  per-side execution state. Plus (H) open-demand verification for named POs
  (defaults 2990-PO-2607-001/-005) and (I) the MRP supply-inflation delta per
  unexecuted LIKELY-DUPLICATE PO (cancelling self-corrects MRP — dead statuses
  are excluded from supply; a duplicate-suspect flag on MRP supply rows is a
  noted follow-up, not built).
- **Cross-claim invariants in the trace check** (`check-so-source-trace.mjs`
  sections 6–9 + closing verdict): section 6 DO header-vs-line-union orphans
  (named-DO detail via `DOS` env, defaults -016/-017); J1 SO line served by >1
  PO (sofa multi-batch = HARD DEFECT; non-sofa fifo-suspect vs
  boundary-split-legit); J2 PO line assigned to >1 SO (consolidated splits are
  LEGIT; conflicts = exceeds-qty / claims-served-demand / stored-vs-delivered);
  J3 SO line claimed by >1 PO — **expected 0**; closing ONE-TRUTH verdict
  asserts exactly that.
- **2026-08-02 addenda (K + L).** K: the grn-gap repair had stocked a SERVICE
  (phantom SVC-TRANS.CHARGES movement + lot on 2990-GRN-2606-001 — the gap
  math counted service lines into accepted qty, as did the costing audit's 3a
  lens). Both now exclude service lines (`isServiceLineMirror`,
  lockstep-tested), and part **`service-lot-reverse`** deletes the phantom
  pair under zero-consumption guards (`planServiceLotReversal`). L: the 023
  source verdict — cancelled in the SOURCE system, imported verbatim — means
  no owner cancel is needed and MRP was never inflated (`PO_DEAD`); cancelled
  POs are now refused as attribution targets (`refusedPoStatus`), their
  existing allocations remove-all without a cancel recommendation, and the
  detector reads the prime-suspect pair at ANY status, reporting import drift
  rather than ever writing a status. See BUG-HISTORY 2026-08-02.
- **Dispatch instructions.** Actions → **SO source trace check (read-only)** →
  Run workflow (optionally `DOS` via the script env when run locally) — read
  sections 6–9 + the ONE-TRUTH verdict. Actions → **Duplicate documents check
  (read-only)** → Run workflow (inputs `window_days`, `verify_pos`) — read the
  PO section's prime-suspect line, (H) and (I). Corrective:
  **Repair 2990 doc references** → part `fifo-attribute-repair`, dry-run first,
  `pos` naming the confirmed POs, then `apply=1` (a CANCELLED target reads the
  no-owner-action recommendation); part `service-lot-reverse` for the phantom
  service receipt; re-run the trace check and expect J3 = 0.

### 2.10 Three chip identities (2026-08-07) — provenance stops dressing as execution
`feat/provenance-chip-treatment` (PR-1 of the Decision's display-demotion
stage). Display only — no resolver, no endpoint, no `getValue` sort key
changed. Every cross-document chip now renders ONE of three identities, so the
soft-until-DO model is legible at a glance:

| identity | data | dress | tooltip says |
|---|---|---|---|
| **ANCHORED** | `source 'delivered'` (DO shipped the goods); shipped source-PO chips; Delivered DO chips | solid accent chip — unchanged | delivered / anchored history |
| **PROVENANCE** | `source 'linked'` (stored `so_item_id` / provenance note); mig-0235 allocation SO-slices | muted (`bg-surface-dim` / phone `mutedChip`) | "Bought for `<SO>` — procurement provenance, not the live assignment." **Never the word "Locked"** |
| **FLOATING** | `source 'mrp'` / `locked:false`; READY FIFO projections; incoming MRP coverage | dashed border + trailing "~" | live, "recomputed on every view", moves as demand moves |

Implemented as one helper trio in `DocumentLinesExpansion.tsx`
(`assignmentTreatment` / `assignmentTitle` / `assignmentTone`) used by all
three desktop call sites (PairedSoCell, drill-down cell, `AssignedSoCell`);
`SoSourceChips` demotes READY + incoming chips to floating;
`PurchaseOrderDetailV2`'s allocation SO-slices wear provenance ("bought for",
never "assigned"; STOCK slices keep the dashed look); MRP's read-only supplier
tooltip says the PO covers the line in the CURRENT allocation (no persisted
per-line binding implied). Mobile mirrors all of it (`mobile/source-chips.tsx`
`floatingChip` + three-way `PairedSoRowsMobile`, `MobileModuleDetail`
allocation chips) — one-product rule. A `locked:true` assignment WITHOUT
`source` (older/cached payload) degrades to provenance, never anchored.
Pinned by the "Three chip identities" block in
`DocumentLinesExpansion.test.tsx`; see BUG-HISTORY 2026-08-06.

Since 2026-08-07 (PR-3) the provenance identity is no longer only a re-dress
of the precedence winner: the coverage wire carries a parallel `provenance`
slot and the Assigned-SO surfaces render it BESIDE the execution chips — see
the side-by-side rule in §2.1.

### 2.7 The 2990 doc-reference repair (2026-08-01) — the DATA answer to 2.6, and the rule that makes it safe
`fix/doc-ref-repair`. The **Source PO prefix check** was run and 2.6's open
question is answered: the mixed prefixes are TWO problems, not one.

**What the diagnostic found (production).** Of the 16 live source-PO batches:
3 prefixed, 1 bare-on-base (correct by design), **0 bare-on-a-non-base company**
(so there is NO mint gap — that theory is refuted), and **12 matching no
purchase order at all**. Those 12 are the real defect, and they are an IMPORT
defect, not a minting one.

**Root cause.** `migrate-2990-into-houzs.mjs` prefixes exactly two things: each
document table's own doc-number column (`DOCNO_COL`) and a hand-written list of
doc-number REFERENCE columns (`PREFIX_REF_COLS`, which covers `source_doc_no`).
Two references are in NEITHER list because they are free text inside another
column, so they still name PRE-IMPORT document numbers:

| reference | mismatched | dangling |
|---|---|---|
| `purchase_orders.notes` -> `From SOs: SO-2606-005` | 44 of 49 tokens | 0 |
<!-- recorded verbatim: this is what production held on the measurement date.
     The label was unified to "Transfer from Sales Order:" on 2026-08-18 -
     see docs/modules/document-conversion.md §10. -->
| `inventory_lots.batch_no` + `inventory_movements.batch_no` -> `PO-2606-001` | 24 of 32 batches | 0 |

Every consumer resolves these by string EQUALITY, so the reference matches
nothing and the UI honestly shows a dash.

**The repair, and the rule that makes it provable.**
`backend/scripts/repair-2990-doc-refs.mjs` + workflow **Repair 2990 doc
references (DRY-RUN gated)**. A reference is rewritten ONLY when **(1)** it
resolves to nothing as stored in its own row's company, **(2)** prefixing it
with that row's OWN company code resolves it to exactly ONE document, and
**(3)** that document belongs to the same company. Already-resolving references
are untouched; anything resolving to 0 or >1 prefixed is untouched and reported
with the reason. A base-company row has an empty prefix, so the repair is a
structural no-op there by construction.

This is what 2.6 said was missing: the safety fact ("`PO-2607-002` and
`2990-PO-2607-002` are both real") does not forbid the repair — it forbids the
BLANKET one. The rule above resolves the prefixed form inside one company, so it
can never land on the other namespace's document.

- **`inventory_lots` and `inventory_movements` move in ONE transaction** —
  `fn_reconcile_dropship_batch` (0088/0155) and batch-scoped FIFO consumption
  join them on `batch_no`, so a partial rename is a costing fault.
- **`trg_inventory_movement_fifo` is AFTER INSERT only**, so updating `batch_no`
  re-runs no allocation, creates and consumes no lot, and moves no value.
- **Ledger timestamps are not touched** — `updated_at` records when the goods
  moved, not when a label was corrected.
- **DRY-RUN by default, `apply=1` to write, idempotent** (a repaired reference
  resolves, so a re-run plans zero rows). Parts `notes` / `batches` /
  `consumptions` are individually selectable.

**Part `consumptions` (2026-08-01) — the ledger's OWN parent references.** The
costing audit (run 30694120826) found the same class on `source_doc_no` +
`source_doc_id` of `inventory_lot_consumptions` and `inventory_movements`: 5
consumed units naming a delivery order that does not exist (10b), 5 orphan
movements (4), 1 GRN line-vs-movement mismatch (3a). `source_doc_no` WAS in the
importer's `PREFIX_REF_COLS`, but pre-repair-pass rows can still be bare, and
`source_doc_id` was copied **verbatim** while parents inserted with
`ON CONFLICT DO NOTHING` — a parent dropped/remapped on PK collision leaves a
dangling id. The part applies the same three-part number rule per
`(company_id, source_doc_type, source_doc_no)` group (types **DO**/**GRN**
only), and writes `source_doc_id` **only from the resolution the number rule
just proved** (stamp NULL / restamp dangling / keep matching); a stored id
naming a DIFFERENT real document refuses the whole group
(`doc-id-conflict`). Both tables in one transaction — `fn_consume_fifo` copies
the movement's reference onto its consumptions, so they must move together.
The dry run additionally reports, read-only: number-resolves-but-id-dangles
groups (the dropped-parent shape, deliberately NOT rewritten here), the
audit's 3a mismatch per GRN with a bare-number movement probe, and the
movements already attached to each resolved document by id (double-posting
visibility). Rule: `classifySourceRef` in `lib/doc-ref-repair-core.mjs`.

**Part `ids` (2026-08-01, ledger-perfection W1) — the id-heal part
`consumptions` deliberately reported and did not touch.** When a group's
NUMBER already resolves to exactly ONE same-company document but the stored
`source_doc_id` matches NOTHING (the verbatim-copied pre-import id of a
dropped/remapped parent — run 30695536709 showed e.g. `2990-DO-2607-016`
resolving to a real document while its ledger rows store two ids that resolve
to nothing), the id is restamped **from that unique number resolution** —
the prefix rule's mirror image, same burden of proof. `classifyIdRestamp`
(`lib/doc-ref-repair-core.mjs`): a stored id naming a DIFFERENT real document
refuses the group (`doc-id-conflict`); a number matching 0 same-company
documents is part-`consumptions` territory; a number matching >1 has no unique
resolution and refuses; **NULL ids are counted and never written** (the
audit's sections 4/10b read only non-NULL ids, and a NULL may legitimately
predate id stamping). Both tables in one transaction, per-row old -> new in
the dry run, UPDATE scoped to the exact dangling ids the plan proved. Closes
audit findings 4 and 10b.

**Collision-aware since the 2026-08-01 live APPLY** (which died on
`uq_inv_mov_do_source`): the executor takes a SAVEPOINT per row; a
unique-violation (23505) rolls back to the savepoint and files that row under
`duplicate-of-real` — the dangling movement is an import DUPLICATE of a
movement the real document already carries, and repointing it would double the
document's ledger. Duplicates are reported with the violated constraint's
name and NEVER deleted (removal is its own explicit decision; the row still
counts in audit section 4, now classified). A consumption row follows its
movement — refused together, never split. The dry run EXERCISES the identical
writes in a rolled-back transaction, so the collision verdicts are applied
truth, not prediction; catching 23505 (rather than pre-computing the key)
also survives prod's hand-applied indexes that this tree does not describe.

**Part `grn-gap` (2026-08-01, ledger-perfection W2) — the audit's 3a inbound
gap itself.** `2990-GRN-2606-001` accepted 501 units net of returns; its ONE
IN movement booked 500 — one unit never entered either ledger, so on-hand and
lot value understate reality. The part recomputes the per-product delta LIVE
(accepted-net-of-returns vs signed GRN movements), prints every line and every
sibling movement, and plans an INSERT of the missing IN movement **through the
normal path** — a plain `INSERT INTO inventory_movements`, so the AFTER-INSERT
FIFO trigger opens the lot exactly as a live GRN post would — into the bucket
and at the landed unit cost its own sibling movement proves
(`classifyGrnInboundGap` in `lib/ledger-repair-core.mjs`: exactly one distinct
(warehouse, variant, batch, company) bucket AND exactly one sibling unit cost,
or the product is refused). GRN movements carry no `uq_inv_mov_*` unique index
(check-duplicate-movements section 0 ground truth), so the insert cannot be
rejected; idempotency is the recomputed delta (a repaired GRN plans zero), a
compare-and-set re-check inside the APPLY transaction, and a
`repair:grn-inbound-gap` notes marker that refuses a re-insert if the delta
somehow still reads short. The movement is timestamped NOW — the unit enters
FIFO at the repair date; backdating would rewrite the consumption chronology.
The `grns` workflow input names the targets (default the one 3a implicated).

**Part `dedupe` (2026-08-01, owner authorization "继续 全部可以" including
removal).** The rows part `ids` classifies `duplicate-of-real` may now be
DELETED — under a rule STRICTER than the index collision that classified
them: the real document must carry a FULL-ROW twin, same (company, product,
variant, warehouse, movement_type, qty), because `uq_inv_mov_do_source` is
keyed without movement_type and proves nothing about qty
(`classifyDuplicateMovement`). The delete reverses the duplicate's whole
ledger effect in ONE transaction — consumptions go with the movement, each
consumed lot's `qty_remaining` is restored (so audit-2a conservation holds by
construction), any drift aborts everything. Old values of every deleted row
print in dry run AND apply, plus the per-bucket movement-sum before -> after
(duplicate OUTs double-decrement on-hand, so audit-2b negative buckets should
shrink — the output shows whether they do). Run order: `ids` APPLY first — a
self-collision's surviving sibling becomes the real twin that licenses
deleting the other. All of it is pinned by `tests-pg/idRestampExec.pg.test.ts`
against a real unique index in CI's postgres container.

**Line-basis fallback since the 2026-08-01 live run** (which planned zero:
the short product had written NO movement at all, so no sibling existed): when
the sibling rule refuses with `no-sibling`, the insert falls back to the GRN
line's OWN landed cost — `round(unit_price_sen x exchange_rate)`, the same
`toMyrSen` path grns.ts uses for movements written outside the allocation —
with the bucket from single-valued GRN facts (`deriveGrnLineBasis`: exactly
one line for the product, one warehouse across the GRN's movements else the
header warehouse, one batch else unbatched, variant from the line's own
variants via a lockstep mirror of `computeVariantKey` pinned by test to the
real function). Several lines for the product, no resolvable warehouse, or a
zero/NULL price still refuse.

**A regression the repair would otherwise have caused.** `document-flow.ts`'s
relationship-map note edge matched on the prefix-STRIPPED root SO only, and
`noteMentionsToken` forbids an adjacent doc-number character — so
`SO-2607-016` does not match inside `2990-SO-2607-016`. Repairing the notes
would have broken the SO->PO edge for exactly the POs it fixed. It now tries the
FULL doc number first, then the bare tail. **Both note shapes are permanent**:
the writer stamps the doc number verbatim, and the repair deliberately leaves
ambiguous history alone — so any new note reader must accept either.

**Then, and only then, the stored links.**
`backend/scripts/backfill-po-so-item-links.mjs` + workflow **Backfill PO -> SO
item links (DRY-RUN gated)**. Tier 1 (the delivered chain, linkage C) is
suppressed until the batches are repaired, because that join is exactly the one
that misses. Tier 2 is a provenance note naming exactly ONE valid,
company-owned SO. Both write only where the item code pairs 1:1 — the rule now
shared with `link-po-to-so.mjs` via `scripts/lib/po-so-line-pairing.mjs`.

**Never written, by design:** a PO whose note names 2+ SOs (which line served
which is recorded nowhere), a line with no evidence, and anything MRP-derived
(layer (c) is FLOATING — it shifts as demand moves and evaporates on delivery,
so freezing it into a stored link would make a live computation a permanent
wrong record). All three are counted and listed in the report instead.

### 2.4 PO "Assigned SO" resolution — precedence over linkages **C → B → A**
`backend/src/scm/routes/po-so-coverage.ts` (`GET /po-so-coverage/:type/:id`,
`type ∈ po|grn|pi`), mounted on the coarse SCM read gate beside `/document-flow`
(same sensitivity class — SO doc no + delivery date; **no cost, no margin**).
Resolution, all set-based and company-scoped:
1. Resolve the anchor to its PO (GRN→PO, PI→GRN→PO).
2. **(c) MRP floating (A):** call `computeMrp` ONCE with the active company id +
   `includeUndated`, then `mrpReverseCoverage(result).get(po.poNumber)` — the exact
   reverse of the `mrpLineCoverage` the SO detail reads (§ linkage A). Group by SKU,
   `locked:false`. This is called ONCE per request, NOT per-SKU in a loop.
3. **(b) stored origin (B):** origin SO doc_nos = the PO lines' EFFECTIVE
   stored links → `mfg_sales_order_items.doc_no` **∪** the PO's provenance
   note (shared `parseFromSosNote`), validated against company-owned
   `mfg_sales_orders` (the company gate + whole-token check). Pure
   `buildStoredOrigins(...)` matches by `item_code`, effective date
   `amended_delivery_date ?? customer_delivery_date`, `locked:true`.

   **"Effective" (mig 0235, allocation-aware).** A consolidated PO line can
   serve SEVERAL SOs plus stock; `scm.purchase_order_item_allocations` splits
   it into sub-numbered slices (`PO-2606-001-01`, `-02`, ...), each
   `(qty, so_item_id | NULL)` — NULL = stock. Pure `effectiveStoredLinks
   (poLines, allocationsByItem)` resolves per LINE: a line WITH allocations
   reads the allocations' non-null so_item_ids as THE authoritative links —
   its own single `so_item_id` is superseded, NOT unioned (where both exist,
   allocations win, so one line can never double-count; an all-stock split
   yields no link at all, overruling a stale single link). A line WITHOUT
   allocations keeps the single `so_item_id` — the 1:1 fast path, unchanged.
   The same function feeds `storedLink`/`sourceLinked`: an allocation IS a
   stored link, so an allocated SKU reads as linked (a provenance chip since
   §2.10), and each
   allocated SO now appears in the Assigned SO cell (multiple SOs per line are
   finally expressible). Both the single-doc route and the batched list
   resolver call the ONE pure function, so a list row and its drill-down
   cannot disagree. Allocations reads are best-effort (absent table → empty →
   exactly the pre-0235 behaviour). Layers (a)/(c) are untouched.
4. **(a) delivered DO-lock (C):** `resolveDeliveredSoLock(po.poNumber)` finds the
   `(do, code, variant)` buckets whose goods shipped from THIS PO (OUT movements
   with `batch_no` = PO number ∪ FIFO lot consumptions of this PO's lots), resolves
   each to its SO via `delivery_order_items.so_item_id` (preferred) or
   `delivery_orders.so_doc_no` (fallback), re-validated + dated against company SOs.
   Pure `buildDeliveredSoLock(...)`, `locked:true`. Best-effort — an absent
   table/column or un-shipped PO yields nothing and falls through to (b)/(c).
5. Pure `mergeAssignments(poSkus, doLock, storedOrigin, floating)` applies
   a > b > c > dash per SKU.

**SO↔PO symmetry** is guaranteed because the floating layer inverts the SAME
single `computeMrp` allocation the SO detail reads: `mrpLineCoverage` (SO→PO) and
`mrpReverseCoverage` (PO→SO) are two directions of one map (unit-proven in
`poSoOrigin.test.ts`). No second coverage engine was introduced. Since
2026-08-01 (`fix/mrp-consistency-tails`, audit D6) the symmetry holds across
EVERY caller regardless of `includeUndated`: the flag is display-only — the
engine always allocates the full demand set (undated lines last), so the MRP
page (false) and these coverage readers (true) read one identical allocation.
See `docs/modules/mrp.md`.

**Do NOT touch** DO status derivation / delivery-planning state — the DO-lock only
READS `delivery_order_items` / `delivery_orders` / inventory lots + movements,
never writes.

### 2.2 SO-side Q2 — SERVICE lines read READY
Read path, `mfg-sales-orders.ts` `GET /:docNo` and `/:docNo/items`: a service
line (`isServiceLine`) now stamps `stock_state='stock'` so it renders READY, not
a blank cell. Frontend `drillStock` (SO list) service branch returns READY.
Logged in `BUG-HISTORY.md` (bug-class fix).

### 2.3 SO amendments surfaced on the Relationship Map — uses linkage **B**
`GET /document-flow/:type/:id` now returns an extra read-only `amendments` array
alongside `nodes` / `edges` / `rootSos`: `{ id, soDocNo, amendmentNo, status,
createdAt }` for every `so_amendments` row whose `so_doc_no` is one of the
company-scoped `rootSos` (so the amendments inherit the exact company scope the
graph already enforces — no new gate). The field is ADDITIVE: existing consumers
(the vendor `frontend/src/vendor/scm/components/DocumentFlowModal.tsx` and
`frontend/src/mobile/MobileRelationshipMap.tsx`) ignore it. *Corrected
2026-08-14: this line also named `DocumentTraceability.tsx`, which `:832` of this
same file records as DELETED — and it is: `frontend/src/components/DocumentTraceability.tsx` [gone]
does not exist on `origin/main` `0c2a4e88`.*

The Sales Order relationship map (`so-relationship-map.ts` →
`DocumentRelationshipMapModal`, used by both `SalesOrderDetailV2` and the
`?edit=1` editor `SalesOrderDetail`) reads that array and renders an
"Amendments off the Sales Order" branch of clickable chips beneath the graph,
each opening its job card at `/scm/amendments/:id` (gated `scm.sales.orders` +
allowSales, same as the SO — no extra access check). PO amendments are NOT a
separate document: a PO revision is the PO leg of an SO amendment (approve-po →
`reviseBoundPo` → `po_revisions`), so there is nothing extra to branch off the
PO. The SI / DO / DR maps do not pass amendments and are unchanged.

### 2.11 The living Relationship Map (2026-08-07) — chain / provenance / floating, zero added backend load
`feat/living-relationship-map` (PR-2 of the soft-until-DO rollout). The map now
RENDERS the §Decision model instead of contradicting it: before this, a stored
SO→PO raise-link drew in the same visual register as the execution FKs, and the
floating pre-DO pairing — the thing that actually governs matching — was not on
the map at all.

**Three edge classes, one rule each:**

| class | what it is | where it comes from | rendering |
|---|---|---|---|
| **chain** | vertical execution FKs — SO→DO→SI→payment, DO→DR, PO→GRN→PI, GRN→PR, consignment | `/document-flow` stamps `linkage:'chain'` on every edge (ADDITIVE field; default) | solid, existing kind colours — anchored history |
| **provenance** | the SO→PO raise-link (stored `so_item_id` / provenance note) | `/document-flow` stamps `linkage:'provenance'` at the ONE SO→PO edge callsite | muted solid, tooltip "Bought for — procurement provenance" |
| **floating** | the live pre-DO PO↔SO MRP pairing ("会跳动" — recomputed per open, may change) | CLIENT-ASSEMBLED: `buildFloatingOverlay` / `floatingSoDocNos` (flow-queries.ts) over the `usePoSoCoverage` response, `source:'mrp'` assignments ONLY | dashed + pulse (`animate-pulse`, no bespoke animation system), tooltip "Live MRP pairing — recomputed on every view; may change" |

**The zero-load rule (owner: "它可能会 API 爆炸").** The floating overlay adds
NO backend call class: `document-flow.ts` gained no query and must never call
`computeMrp`; the overlay reads the SAME `usePoSoCoverage` query key the PO /
GRN / PI list drill-downs and detail readers already use, so the common path is
a react-query cache hit (staleTime 30s; the backend path-cache dedupes a cold
one) and the worst case is the ONE normal coverage fetch the page would do
anyway. No polling, no websockets.

**One-engine symmetry, test-pinned.** Floating edges equal EXACTLY the
coverage assignments with `source:'mrp'` (`flow-floating-overlay.test.ts`) —
the same single `computeMrp` allocation every other coverage reader inverts
(§2.4), so the map can never disagree with the Assigned-SO chips. A
`locked:false` assignment WITHOUT a source (older backend) is never floated.

**Surfaces.** The vendor `DocumentFlowModal` (PO / GRN / PI anchors via
`RelationshipMapButton`) merges the overlay into the graph — a floating SO
absent from the stored graph is synthesised as a dashed node; legend gains
"Bought for (provenance)" + "Live MRP pairing (floating)". The scm-v2
`DocumentRelationshipMapModal` gains an optional `pairing` prop
(`{ kind: 'provenance' | 'floating' }`): the PO map (`po-relationship-map.ts`,
now also calling `usePoSoCoverage('po', id)`) restyles its SO↔PO hop — floating
when any `source:'mrp'` pairing exists (SO slot floats dashed + "~" when
nothing stored backs it), provenance when only stored links do — and the
execution hops behind a declared pairing render solid. The SO map passes
`provenance` for its SO↓PO drop when the graph carries stored PO links; it
deliberately shows NO floating hop (coverage is purchase-doc-keyed — an
SO-keyed read would be new backend load; the SO side already shows the same
engine's answer in its per-line coverage column). DO / SI / DR maps pass
nothing and render exactly as before. The mobile surface shipped as §2.12
(same three identities, same zero-load rule).

### 2.12 Mobile relationship map (2026-08-07) — parity with the desktop three-identity map
`feat/mobile-relationship-map`. The phone now has the map the §2.11 living-map
round left "queued separately". One product, two presentations: instead of the
desktop SVG stage-column canvas, the phone renders the SAME graph as a STACKED
CHAIN LIST — `frontend/src/mobile/MobileRelationshipMap.tsx`, a full-screen
overlay opened by a "Map" header button on `MobileSODetail` (SO anchor) and on
the generic `MobileModuleDetail` document detail (PO / GRN / PI / DO anchors,
`flowAnchorForModule`; SI / returns / consignment stay map-less, matching the
shipped desktop anchor set).

- **Same three identities, same wording.** Sales chain and procurement chain
  render as stage-ordered card groups joined by solid connectors (every
  vertical hop is an execution FK — anchored history); the SO ▸ PO hop renders
  as explicit pairing rows: muted chips + "Bought for — procurement
  provenance" for the stored raise-link (incl. the kind-`value` fallback for
  an older cached response), dashed chips + trailing "~" + "Live MRP pairing —
  recomputed on every view; may change" for the floating pairing. Phones have
  no hover, so the identity wording the desktop carries as tooltips renders as
  a visible caption under each pairing row. A floating-only SO synthesises as
  a dashed card in the sales chain. Legend matches the desktop labels
  ("Bought for (provenance)" / "Live MRP pairing (floating)").
- **Zero added backend load (the §2.11 rule, unchanged).** The screen reads
  the SAME `useDocumentFlow` query key the desktop modal reads and, for
  purchase anchors only, the SAME `usePoSoCoverage` key the mobile document
  detail already fetched for its Assigned-SO chips — a react-query cache hit.
  The floating rows come from the SAME pinned `buildFloatingOverlay`
  (one-engine symmetry — the model never re-derives "floating" itself). The
  SO anchor fetches NO coverage, the desktop SO map's deliberate
  no-floating-hop rule. No polling, no new endpoint.
- **Navigation, fail-closed.** Tapping a node opens its mobile screen — SO →
  `MobileSODetail` (doc_no), the rest → the generic module detail (uuid) —
  but ONLY when MobileApp's `flowNav.can` (the same `allowed()` gate the menu
  rows use) admits the destination; a gated or screen-less node (AR payment)
  renders inert (off, not hide). Amendment chips are display-only on the
  phone.
- **Pure model, pinned.** `frontend/src/mobile/relationship-map-model.ts`
  (`buildMobileMapModel` / `flowDocNav` / `flowAnchorForModule` + the verbatim
  identity wording constants) is pure and unit-pinned by
  `relationship-map-model.test.ts`: floating rows equal EXACTLY the
  `source:'mrp'` assignment set, provenance never renders as execution, the
  wording matches the desktop strings character-for-character.

---

## 3. What was STOP-and-reported (not built — would require fabricating a linkage or new persistence)

### 3.1 PO "assigned to SO + that SO line's delivery date" as a FLOATING view
**SHIPPED 2026-07-25 — see §2.1 / §2.4.** Now the FLOATING layer (c) in the
precedence: `computeMrp` → `mrpReverseCoverage` matched by SKU, marked
`locked:false`, used when there is no delivered DO-lock (a) and no stored origin
(b). The multi-PO under-attribution below remains a stated limitation (a split
line records only its first covering PO). The original deferral reasoning is kept
below for the record.

The floating coverage (A) is derivable-by-inversion of `computeMrp`'s existing
output (group `MrpLine.poNumber` → SO lines; no re-implementation of allocation),
and `computeMrp` already requires `companyId`. BUT:
- It only exists for OUTSTANDING demand, so it cannot also serve the "once
  delivered" half (see 3.2) — the two halves would come from different linkages.
- The covering SO line's **delivery date** is not on any existing PO read path;
  surfacing it needs a small read enrichment, but attaching it to the floating
  assignment (A) while the delivered chain uses the raise-link (B) risks showing
  two different SOs for one PO.
- `PoSupply` in `computeMrp` carries only `po_number` (a string), not the PO id
  or PO-line id, and a split line records only its FIRST covering PO
  (`if (poNumber == null)`), so an inversion under-attributes multi-PO lines.

Decision: shipped the stable stored relationship (B, §2.1) instead. A floating
"assigned to SO (delivery date)" overlay for still-outstanding POs is deferred
pending the owner choosing which semantics to display, because A and B disagree
by design.

### 3.2 "DO# / SI# the item ended up in" as a PHYSICAL trail on the PO
**PARTIALLY SHIPPED 2026-07-25 — see §2.1 / §2.4 (a).** The linkage-C reverse of
`soLineShippedSourcePos` (`batch_no = po_number`) is now built as
`resolveDeliveredSoLock` and used as the STATIC DO-lock: a delivered PO line
resolves to its DO's SO. As predicted below it is best-effort — the FIFO-lot-
consumption path recovers plain-FIFO (bed frame / mattress / accessory) lines
too, but an un-batched lot with no `batch_no` carries no trail, so a PO whose
goods shipped from un-batched stock falls through to (b)/(c). We surface the
locked SO, not the DO/SI number itself (the DO/SI numbers remain on the
Relationship Map graph, linkage B).

### 3.3 SO-side Q1 — retain the covering PO after a line goes READY
When a covering PO is received (GRN), the line flips to READY-by-STOCK; the
floating coverage (A) drops the PO (demand satisfied) and, until the line ships,
the physical trail (C) has no DO yet — so `coverage_po` goes null in that window.
- **SOFA:** shipped 2026-08-01 (§2.8). `mfg_sales_order_items.allocated_batch_no`
  (= locked source PO, sofa-only, mig 0121) IS in the SO `ITEM` select on both
  the detail and list paths (`mfg-sales-orders.ts:1095`, `:1578`), and
  `soLineReadySourcePos` surfaces it.
- **Non-sofa:** NOT derivable — FIFO-pool stock has no per-line batch allocation
  before it ships, so there is no stored PO trail for a READY-by-stock line
  without new persistence.
Reported, not built. `shipped_source_pos` (C) already restores the source PO once
the line SHIPS; the gap is only the received-but-not-yet-shipped window.

---

## 4. Files changed
Precedence rework (`feat/po-mrp-assigned-so`, 2026-07-25 — DO-lock + floating restored):
- `backend/src/scm/routes/po-so-coverage.ts` — precedence resolver: pure
  `buildStoredOrigins` (B) / `buildDeliveredSoLock` (C) / `mergeAssignments`, async
  `resolveDeliveredSoLock` (DO-lock), floating via `computeMrp` + `mrpReverseCoverage` (A).
  Response `origins: [{ itemCode, assignments: [{ soDocNo, deliveryDate, locked }] }]`.
- `backend/src/scm/routes/mrp.ts` — export `MrpSku` / `MrpLine` types (for the symmetry test).
- `frontend/src/vendor/scm/lib/flow-queries.ts` — `OriginAssignment` gains `locked?`.
- `frontend/src/components/DocumentLinesExpansion.tsx` — floating (dashed + "~") vs static (solid) chip.
- `frontend/src/mobile/MobileModuleDetail.tsx` — same floating/static indicator on each `LineItem`.
- `backend/tests/poSoOrigin.test.ts` — extended to 18 cases (DO-lock, precedence, SO↔PO symmetry).

Stored-origin build (`feat/po-real-origin-so`, 2026-07-25 — superseded by the above):
- `backend/src/scm/routes/document-flow.ts` — new exported `parseFromSosNote` (note extractor, kept).
- `backend/src/scm/routes/po-so-coverage.ts` — stored origin per SKU (now the (b) layer).
- `frontend/src/vendor/scm/lib/flow-queries.ts` — `usePoSoCoverage` shape + `originsByCode`.
- `frontend/src/components/DocumentLinesExpansion.tsx` — `Assigned SO` + `SO Delivery Date` columns.
- `frontend/src/pages/scm-v2/{PurchaseOrdersListV2,GoodsReceivedListV2,PurchaseInvoicesListV2}.tsx`
  — feed the columns from `usePoSoCoverage`; the old `DocumentTraceability` strip removed.
- `frontend/src/mobile/MobileModuleDetail.tsx` — assignment rides each `LineItem`.
- `frontend/src/components/DocumentTraceability.tsx` [gone] — DELETED.

Original strip (`feat/doc-traceability-display`, 2026-07-24 — now superseded):
- `frontend/src/components/DocumentTraceability.tsx` [gone] (new, since deleted).
- `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx`, `GoodsReceivedListV2.tsx`,
  `PurchaseInvoicesListV2.tsx` — rendered the strip in the row-expansion wrappers.
- `frontend/src/pages/scm-v2/MfgSalesOrdersListV2.tsx` — `drillStock` service → READY.
- `backend/src/scm/routes/mfg-sales-orders.ts` — service line `stock_state='stock'`
  (both SO read callsites).

Amendments-on-map + clickability (`feat/relmap-clickable-amendment`, §2.3):
- `backend/src/scm/routes/document-flow.ts` — `amendments` array on the SO-chain response.
- `frontend/src/vendor/scm/lib/flow-queries.ts` — `FlowAmendment` type + response shape.
- `frontend/src/pages/scm-v2/so-relationship-map.ts` — expose amendments + `onAmendmentClick`;
  mark the candidate-PO node `actionable`.
- `frontend/src/components/scm-v2/DocumentRelationshipMapModal.tsx` — amendments branch,
  `AmendmentChip` type, `actionable` flag + clickable-logic fix.
- `frontend/src/pages/scm-v2/SalesOrderDetailV2.tsx`, `SalesOrderDetail.tsx` — pass amendments.

> **2026-09-01, same file, the PROVENANCE chips:** the "Incoming PO" column is
> where a sales line names the purchase order its goods came from or are coming
> from — traceability the operator actually reads. Since #2834 those chips arrive
> on a SECOND request, `GET /:docNo/coverage`, because the detail payload defers
> its MRP run and returns `coverage_po: null` / `ready_source_pos: []`. Any
> surface rendering them must make that call and merge through the one shared
> overlay, `frontend/src/vendor/scm/lib/so-coverage-overlay.ts`. The list
> drill-down did not, and its column was blank for a day —
> `docs/bugs/0598-*`, chips catalogued in `docs/modules/sales-order.md` §0.8.

> **2026-08-17, same two files, unrelated surface:** the detail page's Edit
> affordance is no longer disabled outright on a hard-locked (DO/SI) order —
> a caller holding `scm.so.attribute_other` can open it to change the
> Salesperson, and only that field. Every other input stays locked and
> Override remains the door for addresses and lines. See `so-handover.md`.

## 5. Sales-side Relationship Maps read the live graph (SO/DO/SI/DR) — audit R8

Distinct surface from the strip above: the bespoke 5/7-node **Relationship Map**
modal (`components/scm-v2/DocumentRelationshipMapModal.tsx`) that the sales
document DETAIL pages open. The Sales Order map was taught to read
`/document-flow` in #600 (`so-relationship-map.ts`); the Delivery Order, Sales
Invoice and Delivery Return maps kept a HAND-BUILT `chainNodes` literal and so
lied about exactly the nodes an operator needs:

- **DO** hard-coded its GRN node to "Not created" forever (the procurement leg
  the family carries was invisible).
- **SI** dropped its AR **payment** nodes for a dead "Sales side · no GRN" tile.
- **DR** hard-coded its Sales Order + Sales Invoice nodes to "Upstream …" text —
  neither showed a real number nor was clickable.

**Shipped (`feat/r8-docflow-do-si-dr`, display-only):**
`frontend/src/pages/scm-v2/sales-doc-relationship-map.ts` — the ONE builder for
all three, mirroring `so-relationship-map.ts`.

> **Customer reference — ONE rule since 2026-08-18 (`fix/unify-customer-ref-builders`).**
> The four builders here and in `so-relationship-map.ts` each inlined their own
> fallback for the "Customer PO" cell (three different orders), so one order
> could show a different reference on the DO map than the SI map. They now all
> call `customerRefOf(header)` from `frontend/src/lib/customer-ref.ts`, which
> resolves `ref || customer_so_no || po_doc_no`. Owner ruling: `ref` is the
> customer-reference field; `customer_so_no` is a retired near-duplicate and
> `po_doc_no`/`customer_po*` are dead columns dropped in a later migration. Each hook
(`useDoRelationshipMap` / `useSiRelationshipMap` / `useDrRelationshipMap`) reads
`useDocumentFlow(type, id)` — linkage **B**, the same company-scoped graph the
SO map, the vendor `DocumentFlowModal` and the purchase-side maps use — and a
pure `build*ChainNodes(...)` fn maps the resolved family nodes to the 5-node
canvas (unit-tested in `sales-doc-relationship-map.test.ts`). GRN opens are
procurement-gated (same OR-shape as the SO map, so a sales-hatch reader is never
handed a `<Forbidden>` node); the SI **Payments** node lists payments in an
in-app notice (they live on that page) rather than navigating.

**CRITICAL — status untouched.** Only the DO/SI/DR *traceability* node source
changed. The DO status strip, `computeDoLifecycle`, and delivery-planning state
are NOT read by these hooks. Consignment documents already read the live graph
via `RelationshipMapButton` (`cso/cdo/cdr/pco/pcr/pcrn`) and were not changed.

**List columns (transfer-to / convert-from), mirroring the SO list's
`converted_po_nos`:**
- DO list — **"Invoiced to"**: the SI number(s) each DO was invoiced into (+ DR
  numbers returned), from the SAME batched `sales_invoices` / `delivery_returns`
  read that already stamps `has_children` (`delivery-orders-mfg.ts` list handler,
  new `invoiced_si_nos` / `return_nos` — additive, no status touch).
- SI list — **"From DO"**: `stampDoNumber` resolves `delivery_order_id → do_number`
  (the SI header has no `do_doc_no` column; only the UUID), on both list paths.
- DR list — **"From SO"**: the Sales Order behind the return's DO, resolved
  `delivery_order_id → delivery_orders.so_doc_no` (best-effort, never 500s).

The Relationship Map is no longer desktop-only: §2.12 ships the mobile surface
(SO / PO / GRN / PI / DO anchors, stacked-list idiom, same three identities,
zero added backend load). The LIST columns above (`Invoiced to` / `From DO` /
`From SO`, and `converted_po_nos`) remain desktop-only.

## 6. Out of scope (do not touch)
The DO/delivery STATUS derivation and delivery-planning state logic remain
owned separately and are sensitive — the R8 relationship work above is
read-only and never touches status. Confirm the DO status strip live before
merging any change near these files.
