# Module: Cross-document traceability display (SCM)

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

## 1. The linkage map (read this before changing anything)

There are THREE distinct linkages in play. They are NOT interchangeable; the
whole point of this doc is to record which one answers which question.

| # | Linkage | Where it lives | Semantics | Survives delivery? |
|---|---------|----------------|-----------|--------------------|
| A | **Floating MRP coverage** | `mrp.ts` `computeMrp()` → `mrpLineCoverage()` | Which outstanding PO currently covers which SO line, greedy by delivery date over a POOLED supply. `MrpLine.poNumber` is the forward map (SO line → PO). | **No** — computes over OUTSTANDING demand only; a delivered line is subtracted out (`effQtyOf` / `soDeliverableRemaining`) and `SO_DONE` statuses are excluded. The coverage evaporates the moment the line ships. |
| B | **Stored raise-link + document relationship** | `document-flow.ts` (`/document-flow/:type/:id`) | The SAP-B1 relationship graph. Real stored FKs: `purchase_order_items.so_item_id` (the SO line a PO line was RAISED from, 2026-07-09 onward), the PO "From SOs:" note (pre-MRP shared buys), `grns.purchase_order_id`, `purchase_invoices.grn_id`, `delivery_orders.so_doc_no`, `sales_invoices.*`. | **Yes** — these are immutable stored links; the graph resolves the whole family for any anchor. |
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
| b | **STORED ORIGIN** | **B** (`so_item_id` ∪ "From SOs:" note) | **STATIC** (`locked:true`) |
| c | **MRP FLOATING coverage** | **A** (`computeMrp` → `mrpReverseCoverage`, matched by SKU) | **FLOATING** (`locked:false`) |
| d | none | — | dash |

Shown as TWO INLINE per-line columns inside the existing `DocumentLinesExpansion`
table (`Assigned SO` + `SO Delivery Date`, styled like the SO detail's Stock /
Incoming-PO columns) in each of `PurchaseOrdersListV2` / `GoodsReceivedListV2` /
`PurchaseInvoicesListV2`. The chip is clickable on desktop (→ `/scm/sales-orders/:docNo`,
via `onOpenSo`); the mobile twin rides each `LineItem` in
`MobileModuleDetail.tsx` (display-only). **Floating** assignments render a dashed
chip + trailing "~" (title "Floating — live MRP coverage"); **static** (delivered
/ raised-from-SO) render a solid chip (title "Locked …"). A line with no
assignment at any layer renders **"—"**.

Backend: `GET /po-so-coverage/:type/:id` returns `{ poNumber, poId, origins }`
where `origins: [{ itemCode, assignments: [{ soDocNo, deliveryDate, locked }] }]`,
matched by SKU (`material_code`). The full relationship graph (SO/DO/SI + returns)
stays on the Relationship Map modal (`/document-flow/:type/:id`) — unchanged.

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
3. **(b) stored origin (B):** origin SO doc_nos = the PO lines' `so_item_id` →
   `mfg_sales_order_items.doc_no` **∪** the PO's "From SOs: …" note (shared
   `parseFromSosNote`), validated against company-owned `mfg_sales_orders` (the
   company gate + whole-token check). Pure `buildStoredOrigins(...)` matches by
   `item_code`, effective date `amended_delivery_date ?? customer_delivery_date`,
   `locked:true`.
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
`poSoOrigin.test.ts`). No second coverage engine was introduced.

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
(`DocumentTraceability.tsx`, the vendor `DocumentFlowModal`) ignore it.

The Sales Order relationship map (`so-relationship-map.ts` →
`DocumentRelationshipMapModal`, used by both `SalesOrderDetailV2` and the
`?edit=1` editor `SalesOrderDetail`) reads that array and renders an
"Amendments off the Sales Order" branch of clickable chips beneath the graph,
each opening its job card at `/scm/amendments/:id` (gated `scm.sales.orders` +
allowSales, same as the SO — no extra access check). PO amendments are NOT a
separate document: a PO revision is the PO leg of an SO amendment (approve-po →
`reviseBoundPo` → `po_revisions`), so there is nothing extra to branch off the
PO. The SI / DO / DR maps do not pass amendments and are unchanged.

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
- **SOFA:** derivable IF `mfg_sales_order_items.allocated_batch_no` (= locked
  source PO, sofa-only, mig 0121, forward-compat-guarded) is read — it is NOT in
  the SO `ITEM` select today.
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
- `frontend/src/components/DocumentTraceability.tsx` — DELETED.

Original strip (`feat/doc-traceability-display`, 2026-07-24 — now superseded):
- `frontend/src/components/DocumentTraceability.tsx` (new, since deleted).
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
all three, mirroring `so-relationship-map.ts`. Each hook
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

The Relationship Map + these columns are DESKTOP-ONLY surfaces, matching the
existing precedent (the mobile detail explicitly omits the relationship graph,
`MobileModuleDetail.tsx`; mobile lists don't render `converted_po_nos` either).

## 6. Out of scope (do not touch)
The DO/delivery STATUS derivation and delivery-planning state logic remain
owned separately and are sensitive — the R8 relationship work above is
read-only and never touches status. Confirm the DO status strip live before
merging any change near these files.
