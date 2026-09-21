# Document traceability (cross-document display)

Read-time, display-only surfacing of "which Sales-side documents did this
purchase document's items end up assigned to" (and the reverse) on PO / GRN /
PI / DO / SI list drill-downs and the Relationship Map. No DB writes, no
snapshot — every linkage is resolved fresh from data that already exists.
Used by SCM/procurement/sales staff reading any of those document lists.

## Statuses and flow

No document status of its own — this module reads other documents' data. Its
one lifecycle rule is **soft until DO, hard from DO**. Three distinct
linkages answer different questions and are not interchangeable:

| # | Linkage | What it is | Survives delivery? |
|---|---|---|---|
| A | **Floating MRP coverage** (`computeMrp`) | which outstanding PO currently covers which SO line, pooled/greedy by delivery date | No — computed only over outstanding demand, evaporates once a line ships |
| B | **Stored raise-link** (`purchase_order_items.so_item_id`, provenance notes, mig-0235 allocation slices) | the SO line a PO line was raised FOR | Yes, but nullable/unenforced — not immutable, has been rewritten by repair scripts |
| C | **Physical batch/lot trail** (`batch_no` = source PO, via GRN/FIFO) | which PO a SHIPPED line's goods physically came from | Yes, but best-effort — only for batched stock |

**Before a Delivery Order exists**, all matching is the floating MRP allocator
(A) — nothing is persisted or binding. **At DO creation**,
`resolveShipCommitments` decides binding (sofa detection, stored SO-line
batch, the stored raise-link, live shortage) and stamps
`committed_po_batch_no` on the DO line — the MRP allocator is NOT consulted at
this step. From that moment the DO line, OUT movements, lot consumptions and
COGS are **anchored history and never recomputed**.

PO "Assigned SO" resolves by precedence per SKU: **(a) delivered DO-lock (C)**
> **(b) stored origin (B)** > **(c) MRP floating (A)** > dash. A
`storedLink`/provenance slot is shown ALONGSIDE the precedence winner (not
replacing it) whenever it differs. Sales docs (DO, SI) show **Source PO**
(linkage C, physical); purchase docs (PO, GRN, PI) show **Assigned SO**
(precedence above) plus **Delivered** (the DOs that shipped from this PO).

## Permissions

No dedicated permission — `GET /po-so-coverage/:type/:id` and
`/document-flow/:type/:id` ride the same coarse SCM read gate (same
sensitivity class: SO doc-no + delivery date only, **no cost, no margin**).
Opening a linked document from a chip is gated by that document's own normal
permission (e.g. `scm.procurement.po`).

## Rules that must not break

- **A ≠ B.** A PO's stored raise-link (B) and its current pooled MRP cover
  (A) can name different SO lines — never present them as one "assigned SO".
- Never reintroduce the stored link (B) into an execution/binding path before
  a DO exists — that is the pre-2026-08 model the "soft until DO" decision
  retired; the abandoned branch is `wip/harden-so-po-link-parked`.
- A header/list chip set must be derived **only** as the union of that
  document's own lines' per-line resolver output — never a second,
  independent rollup (a second rollup produced phantom chips from
  re-pointed/orphaned ledger buckets).
- Never label a provenance or floating chip "Locked". Three identities only:
  **anchored** (solid, delivered/execution fact), **provenance** (muted,
  "Bought for `<SO>` — procurement provenance, not the live assignment"),
  **floating** (dashed + trailing "~", "recomputed on every view"). A
  `locked:true` payload with no `source` field (older/cached) must degrade to
  provenance, never anchored.
- All resolvers are company-scoped; do not read across companies.
- Do **not** touch DO status derivation or delivery-planning state from this
  module — it only reads `delivery_orders`/`delivery_order_items`/inventory
  ledgers, never writes, and status logic is owned elsewhere.
- Doc-number prefixes (`2990-` vs bare) are DATA, copied verbatim
  (`batch_no` = `po_number`) — never strip/normalize on display; the two
  namespaces can hold the same tail, so a normalized display could name the
  wrong document.
- A migration may never rewrite a downstream row's `item_code` (or any
  attribute) without predicating on the OLD value it claims to migrate from —
  blind restamping can make a wrong link agree with a wrong code and erase
  the finding (`migration-copy-never-compute`).
- FOC (free line) is decided by exactly one function, `isFocLine` — do not
  re-derive per surface; before it existed, the same line read FOC on the
  delivery order and Sale on the invoice.
- `computeMrp` runs **at most once per request** on any list endpoint —
  reverse-coverage and delivered/source-PO resolvers must not call it again
  or call it per-SKU in a loop.
- A drill-down cell fed by a second/async query renders **WORKING…** while
  loading and **NOT LOADED** on failure — never `STOCK` or a bare dash, which
  are answers, not loading states.

## Gotchas

- A stored-link-vs-delivered divergence is expected, not a bug; a **double
  SERVE** in the delivered ledger (two DOs claiming the same shipped unit) is
  the actual defect to chase.
- Mixed doc-number prefixes across companies are almost always an **import
  reference defect** (a note/`batch_no` naming a pre-import doc number), not a
  minting gap — fix via the proven three-part repair rule (resolves inside
  one company only), never a blanket rename; renaming a live `batch_no`
  corrupts the costing trail.
- LIST cells cap at ~4 chips + a `+N` toggle; drill-down/detail rows always
  render every chip — do not apply the list collapse rule to detail rows.
- On the SO list "PO No." cell, solid chip = goods source (execution), muted
  chip = raised PO shown only when it differs from the source — do not
  collapse these into one bucket.
- Only the DO relationship map renders the 7-node (two-chain) shape; SI and
  DR intentionally keep 5 nodes (Payments / the Return itself have no 7-node
  slot). A 6-node array silently drops the 6th node — define a new canvas
  position before adding one.
- A PO's GRN nodes — and the PO-list "GRN No" column and its `has_children`
  lock — are the union of the PO's own lines' `grn_items` links and the header
  FK, never the header FK alone: a supplier multi-receive (grns
  `/from-po-items`) heads ONE GRN at the first source PO while its lines span
  many, so a header-only rollup hid that receipt on every OTHER source PO (it
  read "received with no GRN"). The PO export keeps the header FK only, on
  purpose — the per-line reads would blow the Worker subrequest budget over
  every PO a tab matches.
- Customer reference display has one resolver, `customerRefOf` (`ref ||
  customer_so_no || po_doc_no`) via `CustomerRefHeader` — a locally-typed
  header missing `ref` silently degrades to the wrong fallback and
  TypeScript's excess-property check will not catch it inside a `useMemo`.

## Where the code is

- `backend/src/scm/routes/po-so-coverage.ts` — precedence resolver (a/b/c).
- `backend/src/scm/routes/document-flow.ts` — the stored relationship graph.
- `backend/src/scm/lib/source-po-trace.ts` — the shared consumption→lot→batch
  trace (linkage C), forward and reverse.
- `backend/src/scm/routes/mrp.ts` — `computeMrp` / `mrpReverseCoverage`
  (linkage A).
- `frontend/src/components/DocumentLinesExpansion.tsx` — desktop drill-down
  chips, chip-identity helpers.
- `frontend/src/mobile/MobileModuleDetail.tsx`,
  `frontend/src/mobile/source-chips.tsx` — mobile chip parity.
- `frontend/src/mobile/MobileRelationshipMap.tsx`,
  `frontend/src/mobile/relationship-map-model.ts` — mobile Relationship Map.
- `frontend/src/components/scm-v2/DocumentRelationshipMapModal.tsx`,
  `frontend/src/pages/scm-v2/so-relationship-map.ts`,
  `frontend/src/pages/scm-v2/sales-doc-relationship-map.ts` — desktop maps.
- `frontend/src/components/SoSourceChips.tsx` — SO-side source/ready chips.
- `frontend/src/lib/customer-ref.ts` — the one customer-reference resolver.
- `frontend/src/vendor/scm/lib/foc-line.ts` — the one FOC-line rule.
