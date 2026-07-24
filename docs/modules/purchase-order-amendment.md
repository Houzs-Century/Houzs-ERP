# Module: Purchase Order Amendment (SCM)

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
(`unit_price_centi` — the supplier cost the purchaser negotiated; it is written
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
   mutate in place (`line_total_centi = max(0, qty*unit - discount)`); ADD inserts;
   REMOVE deletes — **except** an already-received line, which is **preserved and
   warned**, never silently dropped.
5. **Roll up** `subtotal_centi` / `total_centi` (= subtotal + `tax_centi`) and
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

## 5. Database — mig `0192_scm_po_amendment_workflow.sql`

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
  `new_qty` / `new_unit_price_centi` / `new_delivery_date`, `old_snapshot`.
- `uq_po_amendment_open` — partial unique on `(po_id) WHERE status = 'REQUESTED'`:
  one open amendment per PO.

`company_id` is nullable, no FK (companies master is Phase 0f) — matches every
amendment table in 0080.

> **Migration number caveat:** taken as `0192` at branch time. Parallel PRs
> collide on numbers — re-check and renumber at MERGE by re-listing the tree.

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

Wired into the SO amendment detail page (`AmendmentDetailV2.tsx`, "Print
amendment" button) with the simplified Requested / Approved status label. The PO
side reuses the same generator + `poAmendmentToPdfInput` once the PO amendment
pages land.

### DEFERRED to a follow-up PR

- PO amendment desktop pages (list / detail / create) under
  `frontend/src/pages/scm-v2/` and mobile under `frontend/src/mobile/`, mirroring
  the SO amendment surfaces (`Amendments.tsx` / `AmendmentDetailV2.tsx` /
  `MobileAmendments.tsx`), each with the simplified **Requested / Approved / All**
  filter, and the "Print amendment" button wired to `poAmendmentToPdfInput`.
- The SO-surface status simplification (hiding the old supplier-pending /
  PO-approved / sent states from the list + detail while keeping the backend enum
  values the 2990 mirror depends on).
- Adding PO amendments to the PO relationship map, analogously to #1229's SO
  amendment branch. NOTE: `PurchaseOrderDetail` / the relationship-map files are
  concurrently edited by another agent (branch `feat/relmap-clickable-amendment`,
  assigned-SO feature) — keep the amendment edits localized and merge carefully.
