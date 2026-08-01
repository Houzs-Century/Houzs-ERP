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

Backend: `GET /po-so-coverage/:type/:id` returns `{ poNumber, poId, origins, delivered }`
where `origins: [{ itemCode, assignments: [{ soDocNo, deliveryDate, locked }] }]`
and `delivered: [{ itemCode, dos: [{ doNo, qty }] }]`, matched by SKU
(`material_code`). The full relationship graph (SO/DO/SI + returns) stays on the
Relationship Map modal (`/document-flow/:type/:id`) — unchanged.

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
that misses. Tier 2 is a `"From SOs:"` note naming exactly ONE valid,
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
