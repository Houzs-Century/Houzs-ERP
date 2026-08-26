> ## Corrections — 2026-08-12 code-read sweep
>
> 1. applyPoAmendment applies MANUAL amendments only; a follow-up (source_so_amendment_id set) is applied by reviseBoundPo scoped {onlyPoId} — its stored lines are a never-applied preview (po-amendments.ts:343-356; amendment-po-followup.ts:8-13).
> 2. The workflow migration is 0194_scm_po_amendment_workflow.sql (internal header still says 0192).
> 3. shared/po-amendment.ts is NOT client-shared: zero frontend references; pure/DB-free holds.
> 4. Approve also queues an AutoCount edit via enqueueEdit (po-amendments.ts:409-421) and writes an extra follow-up audit row (:392-407).

# Module: Purchase Order Amendment (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Standalone amendment / revision workflow for a **Purchase Order**, the PO-side
sibling of the SO amendment module (`so-amendments.ts` / `so-amendment.ts` /
`so-revision.ts`). It lets a purchaser change a live PO through a **single
approver gate**: raise a request, an authorized approver applies it in place.

Built to the owner's **simplified** model (2026-07-24): statuses are just
`REQUESTED -> APPROVED`, with `REJECTED` as the terminal close for both a
rejection and a withdrawal. There is deliberately **no** supplier-confirm /
two-gate / sent chain here — that surfaced complexity was cut. (The SO amendment
still carries the older enum values in its backend for the 2990 mirror, but its
UX is being reduced to the same Requested / Approved / All set.)

> Read this before touching the PO amendment code. If your change alters the
> surface (a new endpoint, permission, status, or a field that starts/stops being
> required), update this guide in the same PR.

---

## 1. What an amendment can change

Per line: **SPEC** (material code / name / variants), **QTY**, **PRICE**
(`unit_price_sen` — the supplier cost the purchaser negotiated; it is written
through as given, there is **no** honest-pricing recompute like the SO side),
**DELIVERY** (per-line `delivery_date`), **ADD** a line, **REMOVE** a line.

Header: `supplier_id`, `expected_at` (PO delivery date), `notes` — the trust
boundary is `AMENDABLE_HEADER` in `routes/po-amendments.ts`; an unlisted key is
rejected `400 header_field_not_amendable`.

---

## 2. API surface — `/api/scm/po-amendments`

Mounted in `scm/index.ts` under `scmAreaGuard("scm.procurement.po")` (same L2
area guard as Purchase Orders: GET = view, PATCH = edit). The finer
`scm.po_amendment.*` gates layer on inside each handler.

| Method | Path | Gate | Effect |
|---|---|---|---|
| GET  | `/po-amendments` | area view | List (company-scoped, newest first, `.limit(500)`). |
| GET  | `/po-amendments/:id` | area view | Detail: amendment + `po_amendment_lines` + light PO header summary. |
| POST | `/po-amendments` | `scm.po_amendment.create` | Raise a request against a PO. Body: `{ poId, reason?, headerChanges?, lines[] }`. |
| PATCH| `/po-amendments/:id/approve` | `scm.po_amendment.approve` | **Applies** the amendment (see §4). `REQUESTED -> APPROVED`. |
| PATCH| `/po-amendments/:id/reject`  | `scm.po_amendment.approve` | Refuse — no PO change. `reason` **required**. `-> REJECTED` (resolution `REJECTED`). |
| PATCH| `/po-amendments/:id/withdraw`| requester, or `scm.po_amendment.approve` | Requester pulls it back. `-> REJECTED` (resolution `WITHDRAWN`). |

Create guards, in order: body has a `poId` + at least one change (else 400) → PO
exists, company-scoped (else 404) → PO not cancelled (else 409) → no OPEN
(`REQUESTED`) amendment (else 409; the partial unique index is the DB backstop).

`amendment_no` = `${po_number}/A${n}`, `n` = (prior amendments for this PO) + 1.

Permissions (`services/permissions.ts`): `scm.po_amendment.create`,
`scm.po_amendment.approve`. Owner + IT Admin cover both via `*`; grant purchasing
positions via Team > Positions. `approve` also gates reject.

---

## 3. State machine — `shared/po-amendment.ts`

Pure, DB-free, shared client+server. `REQUESTED` is the only open state.

```
approve  : REQUESTED -> APPROVED
reject   : REQUESTED -> REJECTED
withdraw : REQUESTED -> REJECTED   (resolution = 'WITHDRAWN' distinguishes it)
```

**Rejecting a FOLLOW-UP auto-releases the PO to STOCK (2026-08-06).** A
follow-up (`source_so_amendment_id` set) exists because the SO was revised;
rejecting it means the supplier will NOT follow the revision, so the goods will
arrive as originally ordered — no longer the revised SO line's goods. The reject
handler therefore inserts a STOCK allocation slice for each affected line's
un-allocated remainder (`planStockRelease`, `lib/po-allocations.ts` — existing
slices are never touched), audits it, and returns `releasedToStock` on the
response; both UIs surface it in the success toast. MRP then re-shows the
corrected spec as a shortage. Owner's rule: the spec mismatch is a fact, not a
decision ("SO amendment 了之后,我那张 PO 就直接废了…他就变了"). A release
failure never un-rejects the amendment — it lands in `releaseWarnings` and is
retryable via the allocation editor.

`poReceivedFloorViolation(line, po)` — a revised qty may never drop below what has
already been received. Tests: `shared/po-amendment.test.ts`.

**Barrel note:** this module is NOT re-exported through `shared/index.ts` — its
`canTransition` / `nextStatus` names collide with `so-amendment`'s. Import it
directly: `from '../shared/po-amendment'`.

---

## 4. Apply engine — `lib/po-revision.ts` (`applyPoAmendment`)

On approve, for the one PO the amendment targets:

1. **Received floor** — every surviving in-place line is checked BEFORE any
   write; a revised qty below `received_qty` throws `ReceivedFloorError` (route →
   `409 received_floor`), nothing mutated.
2. **Snapshot** the current PO into `scm.po_revisions` via `snapshotPo`
   (**reused from `so-revision.ts`** — the immutable prior version). Returns the
   next revision number.
3. **Header diffs** applied (`supplier_id` / `expected_at` / `notes`).
4. **Line diffs** applied to `purchase_order_items`: SPEC/QTY/PRICE/DELIVERY
   mutate in place (`line_total_sen = max(0, qty*unit - discount)`); ADD inserts;
   REMOVE deletes — **except** an already-received line, which is **preserved and
   warned**, never silently dropped.
5. **Roll up** `subtotal_sen` / `total_sen` (= subtotal + `tax_sen`) and
   `expected_at` (earliest line delivery date, unless the header set it) from the
   live line set, then bump `purchase_orders.revision` to the snapshot's next
   number.
6. **Audit** — one `AMENDMENT_PO_APPROVED` row on `scm.entity_audit_log`
   (`entity_type = 'PURCHASE_ORDER'`, mig 0139) via `recordEntityAudit`.

The approve route (`routes/po-amendments.ts`) runs this inside `runScmPgCommand`
(one DB transaction), behind an **audit pre-flight** (`assertAuditWritable` — the
owner's ruling that a change must never look saved when its history row did not
write) and an optimistic **claim + apply-lease** (version predicate + lease token)
so a concurrent approve cannot double-apply. `snapshotPo` upserts idempotently on
`(po_id, revision)`, so a mid-apply failure is retry-safe.

Tests: `lib/po-revision.applyPoAmendment.test.ts` (fake-sb harness — snapshot,
revision bump, line diffs, total roll-up, received-floor abort, preserved
received REMOVE, header change, audit row).

---

## 5. Database — mig `0194_scm_po_amendment_workflow.sql`

> **Corrected 2026-08-14.** This heading said `0192`. That number belongs to
> `0192_scm_stock_transfer_atomic.sql`; the amendment migration is
> `backend/src/db/migrations-pg/0194_scm_po_amendment_workflow.sql`. The branch
> was renumbered to dodge a collision before merge and the doc kept the
> pre-rename number — the same renumber drift that produced the 0284 collision
> on 2026-08-13, showing up in the layer no test looks at.

New: enum `scm.po_amendment_status ('REQUESTED','APPROVED','REJECTED')`, tables
`scm.po_amendments` + `scm.po_amendment_lines`. Reused (both from mig 0080):
`scm.po_revisions` (snapshot table) and `scm.purchase_orders.revision` (counter).

- `po_amendments`: `po_id` (FK `purchase_orders`, CASCADE), `po_number`,
  `amendment_no`, `status`, `reason`, `requested_by` / `approved_by` /
  `rejected_by` (FK `scm.staff`), `approved_at` / `rejected_at`,
  `rejection_reason`, `resolution` ('REJECTED' | 'WITHDRAWN'), `header_changes` /
  `old_header_snapshot` (jsonb), `edited_at` / `edit_count`, `version` +
  `apply_lease_token` + `apply_lease_expires_at` (concurrency), `company_id`.
- `po_amendment_lines`: `amendment_id` (FK, CASCADE), `purchase_order_item_id`,
  `change_type`, `new_material_code` / `new_material_name` / `new_variants` /
  `new_qty` / `new_unit_price_sen` / `new_delivery_date`, `old_snapshot`.
- `uq_po_amendment_open` — partial unique on `(po_id) WHERE status = 'REQUESTED'`:
  one open amendment per PO.

`company_id` is nullable, no FK (companies master is Phase 0f) — matches every
amendment table in 0080.

> **Migration number caveat:** taken as `0192` at branch time and renumbered to
> `0194` at merge — the number in this section is the one on disk. Parallel PRs
> collide on numbers; re-check and renumber at MERGE by re-listing the tree.

---

## 6. Frontend

### Printable amendment document — SHIPPED (both SO and PO)

`frontend/src/vendor/scm/lib/amendment-pdf.ts` — ONE client-side jsPDF template
shared by the SO and PO amendment (`generateAmendmentPdf(input)`), same mechanism
as `purchase-order-pdf.ts`. Layout: HOUZS letterhead + title ("Sales order
amendment" / "Purchase order amendment") + amendment no + issue date + status;
reference block (original doc no, customer / supplier, revision old → new); the
CHANGE TABLE (per changed field: item, field, **BEFORE in red tint, AFTER in
green tint**; ADD = muted dash before, REMOVE = "Removed" after); reason;
approval block (requested by + approved by + timestamps + revision); "Supersedes
revision N" footer. **No emoji anywhere** (owner rule).

`amendment-pdf-map.ts` — pure mappers (`soAmendmentToPdfInput` /
`poAmendmentToPdfInput`) that fold each detail-API shape into the template input,
one change-table row per changed field. Unit-tested in `amendment-pdf-map.test.ts`.

**The STATUS word is the mapper's, not the caller's — since 2026-08-26.**
`frontend/src/vendor/scm/lib/amendment-pdf-map.ts` exports
`amendmentPrintedStatus`, which is `simplifiedAmendmentPill(status).label` from
`frontend/src/vendor/scm/lib/status-pill.ts` — the canonical Requested /
Approved / Rejected collapse the amendment LISTS use. `AmendmentPdfInput` no
longer takes a `statusLabel`, so a caller cannot hand the document its own word.
It used to, and all four surfaces hand-wrote the same
`applied ? "Approved" : "Requested"`, which has no arm for REJECTED: **a rejected
amendment printed "Requested"** — the word that says nobody has decided yet — on
the sheet filed as the decision record. The `PrintPreviewModal` Status row on all
four surfaces reads the same helper, so the preview and the document cannot
disagree; `amendment-pdf-map.test.ts` source-scans the four for the old
expression. Entry
`docs/bugs/0548-every-printed-document-title-cased-the-raw-stored-status-ins.md`.

**Still open, and deliberately not settled here:** the amendment DETAIL page
shows the GRANULAR pill (`resolveStatusPill('soAmendment', …)` — Supplier
Pending, SO Approved, Sent) while the document carries the simplified collapse,
so paper and that screen still differ on the in-flight states. Which vocabulary
the printed document should carry is a naming decision, and the owner reserved
those to himself on 2026-08-21 (`docs/modules/document-status-vocabulary.md` §1).

Wired into the SO amendment detail page (`AmendmentDetailV2.tsx`, "Print
amendment" button) with the simplified status label described directly above,
into the
mobile SO amendment surface (`MobileSODetail.tsx`'s `AmendmentDiffSheet` footer,
same generator + `soAmendmentToPdfInput` — added to close the desktop/mobile
parity gap; reachable REQUESTED..PO_APPROVED, i.e. `open_amendment`), and into the
PO amendment detail on both desktop (`PoAmendmentDetailV2.tsx`) and mobile
(`MobilePoAmendmentDetail.tsx`) via `poAmendmentToPdfInput`. All four surfaces
reuse the ONE shared generator.

### PO amendment UI — SHIPPED (feat/amendment-ui)

Desktop + mobile, mirroring the SO amendment surfaces, built to the SIMPLIFIED
single-approver model.

**Queries** — `frontend/src/vendor/scm/lib/po-amendment-queries.ts`. TanStack
hooks against the single `/po-amendments` mount: `usePoAmendments` (list),
`usePoAmendmentDetail`, `useCreatePoAmendment` (POST `/po-amendments`),
`useApprovePoAmendment` / `useRejectPoAmendment` / `useWithdrawPoAmendment`. Every
gate invalidates the amendment list/detail + the PO list/detail keys
(`mfg-purchase-orders*` / `mfg-purchase-order-detail`) + `po-revisions`.

**Desktop**
- `pages/scm-v2/PoAmendments.tsx` — the queue (DataGrid), route `/scm/po-amendments`.
- `pages/scm-v2/PoAmendmentDetailV2.tsx` — the job card, route
  `/scm/po-amendments/:id`: revision hero (Requested -> Approved), the before ->
  after diff per line (qty / cost / delivery / spec / add / remove) + the header
  diffs, the **Print amendment** button (shared `generateAmendmentPdf` +
  `poAmendmentToPdfInput`), and the single-approver gate (approve / reject /
  withdraw, gated on `scm.po_amendment.approve` + requester-for-withdraw).
- `components/scm-v2/PoAmendmentCreateModal.tsx` — the create-request flow: a
  focused diff editor over the PO's current lines (qty / unit cost / per-line
  delivery date / remove) + header delivery date + notes + reason. Opened from a
  localized **Raise amendment** button on `PurchaseOrderDetailV2` (shown on a
  live, non-cancelled PO to `scm.po_amendment.create` holders). Adding a brand-new
  line and changing the supplier are backend-supported but deferred in this editor
  (they need the product / supplier pickers the big PO editor owns).

**Mobile**
- `mobile/MobilePoAmendments.tsx` — the queue, screen `po-amendments`, menu row
  under Procurement & MRP.
- `mobile/MobilePoAmendmentDetail.tsx` — the job card: diff + gate actions +
  Print. Screen `po-amendment-detail`, reached by tapping a queue row.
- Mobile CREATE is deferred: the PO has no mobile detail/editor surface to host
  it, so raising a PO amendment is desktop-only for now (the review/approve inbox
  is the high-value mobile flow). Deep-linking `/scm/po-amendments/:id` directly on
  a phone is not wired (in-app tap only).

### Status simplification — SHIPPED

The amendment LIST surfaces (SO + PO, desktop + mobile) collapse to
**Requested / Approved / All**. Shared helpers in `vendor/scm/lib/status-pill.ts`:
`amendmentBucketOf` (REQUESTED = open incl. SO's SUPPLIER_PENDING; APPROVED =
applied incl. SO's SO_APPROVED / PO_APPROVED / SENT; REJECTED = closed),
`simplifiedAmendmentPill`, `AMENDMENT_LIST_CHIPS`, `amendmentBucketLabel`, plus an
`AmendmentStatusPill` component. The granular SO enum + the SO detail stepper +
the backend values are UNCHANGED — only the list display/filter is collapsed, and
the closed (REJECTED / withdrawn) rows are reached via **All**. A new
`poAmendment` docType was added to the canonical map (REQUESTED / APPROVED /
REJECTED).

### Relationship map — SHIPPED (localized; concurrent-edit overlap flagged)

PO amendments now branch off the Purchase Order in the relationship map, the way
#1229 branched SO amendments off the SO. `document-flow.ts` surfaces a separate
`poAmendments` array (keyed to the PO nodes in the graph), and `DocumentFlowModal`
(the PO map) renders them as a clickable chip row -> `/scm/po-amendments/:id`.
NOTE: `document-flow.ts` / `DocumentFlowModal.tsx` / `PurchaseOrderDetailV2.tsx`
overlap with the concurrent `feat/relmap-clickable-amendment` work — the edits
here are additive (an appended query block, a chip row, one button) to keep the
merge trivial.

---

## 7. Amendment TYPE classification + department ROUTING — SHIPPED (feat/amendment-type-routing)

Layered on top of the existing amendment (backend + UI + PDF). It classifies every
changed field into a TYPE and tags it with a responsible DEPARTMENT, for display
and accountability. **It does NOT change the apply gate** — approval stays
single-signature (any `scm.po_amendment.approve` holder applies the WHOLE
amendment, mixed or not). No new endpoint, permission, status, or migration:
classification is a PURE FUNCTION of which field moved, so it is derived on read
and cannot drift from the row.

**The classifier — `amendment-routing.ts` (mirrored: `frontend/src/vendor/scm/lib/`
+ `backend/src/scm/shared/`).** One `FIELD_ROUTING` table maps each field atom to
`{type, department}`; keep the two copies in sync (each has its own unit test).

| Field atom | Source field | Type | Responsible dept |
|---|---|---|---|
| `SPEC` | material code / name | Processing | Production / Design |
| `VARIANT` | colour / fabric / variants | Processing | Production / Design |
| `QTY` | quantity | Processing | Production / Design |
| `LINE` | add / remove a line | Processing | Production / Design |
| `PRICE` | unit cost (`unit_price_sen`) | Delivery / Commercial | Finance |
| `DELIVERY` | delivery date (line or header `expected_at`) | Delivery / Commercial | Logistics |
| `SUPPLIER` | header `supplier_id` | Delivery / Commercial | Purchasing |

A single amendment carrying atoms of BOTH types is **mixed** and shows both type
badges. (Owner's `production/design` and `purchasing/logistics/finance` groupings
are honoured: processing is one combined-owner group; delivery/commercial splits
per field. Whether `qty`/`price` should instead route to Purchasing is the one
open call left for the owner at review — one table row to flip.)

**Line/header extractors.** `poLineFieldKinds(line)` + `poHeaderFieldKind(key)`
(in `po-amendment-queries.ts`) turn a PO amendment line / header change into the
atoms above — shared by the PO desktop detail and the mobile detail so both label
a row identically.

**Display — desktop + mobile (change together).**
- `PoAmendmentDetailV2.tsx` (desktop) — a **type badge row** in the header
  (`AmendmentTypeBadges`), **per-row department chips** on each diff card
  (`RowRoutingChips`), and a **Department routing** aside card
  (`AmendmentRoutingBlock`) grouping dept -> fields with the single-signature note.
  Shared chips live in `vendor/scm/components/AmendmentRouting.tsx`.
- `MobilePoAmendmentDetail.tsx` (mobile) — the same three, in the mobile inline
  idiom (local `TypeBadges` / `RoutingChips` + a Department-routing card).

**PDF — `amendment-pdf.ts` + `amendment-pdf-map.ts`.** The previously-deferred
additions now ship: an **AMENDMENT TYPE** badge line (Processing / Delivery
Commercial / Mixed), a **Dept** column on the change table (each changed field
against its department), a **DEPARTMENT ROUTING** block (dept -> fields), and a
single-signature accountability line in the approval block. The mapper
(`attachRouting`) tags each row's `department` from its field label and folds the
`AmendmentPdfRouting` summary.

**Audit — `lib/po-revision.ts`.** The `AMENDMENT_PO_APPROVED` row now carries a
`routing` field-change + a `Routing — ...` note (`routingNote`, from the shared
classifier) recording which type/departments the single approval covered.
Accountability is the record, not a per-department block.

**Tests.** `amendment-routing.test.ts` (both copies) proves colour -> processing
(Production / Design), delivery date -> delivery/commercial (Logistics), and a
mixed amendment tags both. `amendment-pdf-map.test.ts` proves the per-row
`department` + the `routing` summary (incl. a delivery-date -> Logistics case).
