# Purchase Consignment Order

An order to a supplier for goods held on consignment — the supplier's stock parked in this warehouse until a settlement turns it into owned stock. A line-for-line clone of the owned-stock Purchase Order with the owned-stock pipeline stripped out. Owned-stock original: `docs/modules/purchase-order.md`.

## Statuses and flow

`SUBMITTED -> PARTIALLY_RECEIVED -> RECEIVED`, plus `CANCELLED`. There is no DRAFT — a PC Order is created directly as `SUBMITTED`; `PATCH /:id/submit` survives only for legacy callers and is a no-op. `CANCELLED` is terminal and is the ONLY way to retire a PC Order — there is no document delete and no Reopen (unlike the owned PO, which has `PATCH /:id/reopen`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/:id`, `/:id/linked` | List, detail, downstream receives/returns |
| POST | `/` | Create — lands `SUBMITTED` |
| PATCH | `/:id` | Update header — field-level lock once a live PC Receive exists (below) |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | Line add/update/remove |
| PATCH | `/:id/submit` | Legacy no-op |
| PATCH | `/:id/cancel` | -> `CANCELLED`, terminal |

**ORDER-ONLY — a PC Order writes NO inventory movements.** It is a paper commitment; only its children touch the ledger: PC Receive books stock IN, PC Return books stock OUT.

The lock in front of edits is a downstream lock, not a status lock: once ANY non-CANCELLED PC Receive exists against a PC Order, the whole order becomes read-only (no header edit, no line edit, no cancel — 409 `pco_has_downstream`). Before that, `PATCH /:id` still freezes `supplier_id`/`currency`/`purchase_location_id` once a live PC Receive exists (409 `pco_identity_locked`); dates and notes stay editable.

## Permissions

- One guard, `scm.consignment.po_orders`, over the whole router — covers read and write.

## Rules that must not break

- Never re-add the owned-PO features this clone deliberately dropped — the MRP shortage picker, the From-SO bulk converter, per-line `so_item_id` linkage, or GRN-receipt rollups. None of them apply off the owned-stock pipeline.
- A PC Order must never reach AutoCount — the outbox's `doc_type` vocabulary does not include consignment purchasing.
- The field-level edit lock's column set must be read from the one shared rulebook (`document-policy.ts`'s `PCO_LOCK_COLS`) — don't hand-maintain a second list that can drift from sibling documents.
- To retire a PC Order that already has receipts against it, cancel the PC Receive(s) first (itself cancel-only, no delete), then the PC Order — there is no other way in, since neither document can be deleted.
- The create-time rollback delete (cleaning up a headerless orphan when a line insert fails mid-create, since there's no cross-statement transaction) is NOT the removed document-delete feature — it must stay; it only ever removes a document that never successfully existed.

## Gotchas

- The owned-stock `PurchaseOrder*.tsx` pages are a different module on different tables — a fix here does not apply there and vice versa; don't assume the two stay in sync automatically.
- There is no mobile status-action surface for this module — cancel is desktop-only.
- A PC Order cancelled by mistake cannot be brought back through the API — there is no Reopen; warn a user before they confirm a cancel.
- `GET /:id/linked`-shaped endpoints across the SCM routers used to be missing company scoping (a bare id lookup could resolve another company's document) — this instance is fixed, but confirm scoping explicitly on any new endpoint of this shape rather than assuming the pattern is safe by default.

## Where the code is

- `backend/src/scm/routes/purchase-consignment-orders.ts` — main API surface.
- `backend/src/scm/shared/document-policy.ts` — `PCO_LOCK_COLS`, the shared lock rulebook.
- `frontend/src/pages/scm-v2/PurchaseConsignmentOrders.tsx`, `PurchaseConsignmentOrderDetail.tsx`, `PurchaseConsignmentOrderNew.tsx` — desktop surfaces.
- `frontend/src/vendor/scm/lib/purchase-consignment-order-queries.ts` — query hooks.
- `frontend/src/vendor/scm/lib/variant-editor-groups.ts` — shared fabric/seat/leg editor group rules (with owned-stock PO forms).
