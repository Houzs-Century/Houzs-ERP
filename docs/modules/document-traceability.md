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

### 2.1 PO / GRN / PI "Assigned SO" — REAL stored origin, two inline line columns — linkage **B**
`feat/po-real-origin-so` (2026-07-25) — supersedes the earlier advisory strip.
The owner's complaint: a PO RAISED from an SO showed "Floating stock — not yet
assigned to a Sales Order" (see `BUG-HISTORY.md` 2026-07-25). It did, because the
section rendered the FLOATING recompute (linkage A, §2.4), which reports "not
assigned" whenever its greedy pool does not currently land on that PO — never the
PO's actual origin.

Now the assignment is the STORED origin (linkage **B**), shown as TWO INLINE
per-line columns inside the existing `DocumentLinesExpansion` table (added
`Assigned SO` + `SO Delivery Date`, styled like the SO detail's Stock /
Incoming-PO columns), in each of `PurchaseOrdersListV2` / `GoodsReceivedListV2` /
`PurchaseInvoicesListV2`. The `Assigned SO` chip is clickable on desktop (→
`/scm/sales-orders/:docNo`, via `onOpenSo`); the mobile twin rides each
`LineItem` in `frontend/src/mobile/MobileModuleDetail.tsx` (display-only). A line
with no origin renders **"—"** — there is NO floating banner and NO advisory
section anymore. The old `frontend/src/components/DocumentTraceability.tsx` strip
and the `PoSoCoverageMobile` card are deleted.

Backend: `GET /po-so-coverage/:type/:id` now returns `{ poNumber, poId, origins }`
where `origins: [{ itemCode, assignments: [{ soDocNo, deliveryDate }] }]`, matched
by SKU (`material_code`). The full document relationship graph (SO/DO/SI + returns)
is still available via the Relationship Map modal (`useDocumentFlow` /
`/document-flow/:type/:id`) on each detail — unchanged.

### 2.4 PO "assigned SO" origin resolution — linkage **B** (stored), not **A** (floating)
`backend/src/scm/routes/po-so-coverage.ts` (`GET /po-so-coverage/:type/:id`,
`type ∈ po|grn|pi`), mounted on the coarse SCM read gate beside `/document-flow`
(same sensitivity class — SO doc no + delivery date; **no cost, no margin**).
Resolution, all set-based and company-scoped:
1. Resolve the anchor to its PO (GRN→PO, PI→GRN→PO).
2. Origin SO doc numbers = the PO lines' `so_item_id` → `mfg_sales_order_items.doc_no`
   (the 2026-07-09+ raise-link) **∪** the PO's "From SOs: …" note, extracted by the
   shared `parseFromSosNote` in `document-flow.ts` (co-located with
   `noteMentionsToken` — one home for the note FORMAT).
3. Validate candidates against real, company-owned `mfg_sales_orders` (this is both
   the company gate AND the whole-token check: a token equals a `doc_no` or it is
   dropped — a split token "SO-1" can only equal "SO-1", never "SO-10").
4. Pure `buildSkuOrigins(poSkus, soHeaders, soLines)` matches the PO's SKUs to those
   SOs' lines by `item_code` and attaches each SO's effective delivery date
   (`amended_delivery_date ?? customer_delivery_date`).

`computeMrp` / `mrpReverseCoverage` are NO LONGER called on this read (the floating
recompute was the bug). They remain in `mrp.ts` for the MRP page and the SO
drill-down; a PO's origin is now an immutable stored fact, presented as the real
assignment — not advisory. A genuine stock PO (no `so_item_id`, no note origin)
simply yields no assignments and every line shows "—".

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
**SHIPPED 2026-07-24 — see §2.4.** The owner confirmed the floating semantics are
what he wants, LABELLED advisory. The original deferral reasoning is kept below
for the record; it was resolved by (a) showing A and B side by side, each
labelled, rather than collapsing them into one "assigned to", and (b) accepting
the multi-PO under-attribution as a stated advisory limitation.

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
- Via linkage B (shipped): the DO/SI in the relationship graph — honest as a
  document relationship, not a physical-unit trace.
- Via linkage C (physical): a PO → DO reverse of `soLineShippedSourcePos`
  (`batch_no = po_number`) IS technically derivable for BATCHED lots, but is
  best-effort and **incomplete for plain-FIFO un-batched stock** — there is no
  stored trail from a plain-FIFO PO's received units to the specific DO/SI that
  shipped them without new persistence. Not built; reported.

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
Real-origin rework (`feat/po-real-origin-so`, 2026-07-25 — supersedes the strip):
- `backend/src/scm/routes/document-flow.ts` — new exported `parseFromSosNote` (note extractor).
- `backend/src/scm/routes/po-so-coverage.ts` — returns stored origin per SKU
  (`{ poNumber, poId, origins }`); new pure `buildSkuOrigins`; no longer calls `computeMrp`.
- `frontend/src/vendor/scm/lib/flow-queries.ts` — `usePoSoCoverage` new shape + `originsByCode`.
- `frontend/src/components/DocumentLinesExpansion.tsx` — `Assigned SO` + `SO Delivery Date`
  columns (`showAssignment` / `onOpenSo`, per-line `assignedSos`).
- `frontend/src/pages/scm-v2/{PurchaseOrdersListV2,GoodsReceivedListV2,PurchaseInvoicesListV2}.tsx`
  — feed the columns from `usePoSoCoverage`; the old `DocumentTraceability` strip removed.
- `frontend/src/mobile/MobileModuleDetail.tsx` — assignment rides each `LineItem`;
  `PoSoCoverageMobile` card removed.
- `frontend/src/components/DocumentTraceability.tsx` — DELETED.
- `backend/tests/poSoOrigin.test.ts` — new.

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
