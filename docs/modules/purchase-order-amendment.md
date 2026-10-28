# Purchase Order Amendment

Standalone amendment/revision workflow for a Purchase Order — the PO-side sibling of SO amendment. A single approver gate: a purchaser raises a request, an authorized approver applies it in place. No supplier-confirm / two-gate chain.

## Statuses and flow

`REQUESTED -> APPROVED`, or `REQUESTED -> REJECTED` (the same terminal status covers both a rejection and a withdrawal; `resolution` = `REJECTED` or `WITHDRAWN` distinguishes them).

A line change is SPEC / QTY / PRICE (`unit_price_sen`, written through as given — no recompute) / DELIVERY (per-line date) / ADD / REMOVE. Header changes are limited to `supplier_id`, `expected_at`, `notes` (`AMENDABLE_HEADER` allowlist; anything else is `400 header_field_not_amendable`).

| Method | Path | Gate | Effect |
|---|---|---|---|
| GET | `/po-amendments` | area view | List, company-scoped |
| GET | `/po-amendments/:id` | area view | Detail |
| POST | `/po-amendments` | `scm.po_amendment.create` | Raise a request against a PO |
| PATCH | `/po-amendments/:id/approve` | `scm.po_amendment.approve` | Apply the amendment |
| PATCH | `/po-amendments/:id/reject` | `scm.po_amendment.approve` | Refuse, reason required |
| PATCH | `/po-amendments/:id/withdraw` | requester, or `scm.po_amendment.approve` | Requester pulls it back |

Create guards, in order: body has `poId` + at least one change, else 400 → PO exists (company-scoped), else 404 → PO not cancelled, else 409 → no open (`REQUESTED`) amendment on this PO, else 409 (DB partial unique index is the backstop). `amendment_no` = `{po_number}/A{n}`.

Apply (`lib/po-revision.ts`, on approve): check received floor on every surviving line first (a revised qty below `received_qty` aborts nothing-mutated) → snapshot the PO into `po_revisions` → apply header/line diffs (an already-received REMOVE is preserved and warned, never dropped) → roll up `subtotal_sen`/`total_sen`/`expected_at` → bump `purchase_orders.revision` → one `AMENDMENT_PO_APPROVED` audit row. Runs in one DB transaction behind an audit pre-flight and an optimistic claim + apply-lease so a concurrent approve cannot double-apply.

A follow-up PO amendment (`source_so_amendment_id` set) is auto-raised when an SO amendment's LINES lane is approved, filtered by: `poRelevant` (qty/add/remove always reshape the PO; spec only if code/variants moved), not `serviceOnlyChange` (service lines never escalate to a PO), and only against the PO that HOSTS the changed line — or, for a brand-new ADD, the bound PO whose SUPPLIER can make it, the same main-supplier match `reviseBoundPo` applies at confirm (`lib/supplier-bindings.ts`). An ADD whose supplier serves no bound PO, and a changed existing line with no PO home, are WARNED to raise a separate PO — never forced onto a PO the supplier does not serve (owner 2026-09-20: a mattress added to an order whose only PO was a bedframe PO must not bump that PO's printed `_R` for a line its supplier cannot make).

## Permissions

- `scm.po_amendment.create` — raise a request.
- `scm.po_amendment.approve` — approve, reject, and withdraw on behalf of the requester. Owner + IT Admin cover both via `*`.
- Mounted under `scmAreaGuard("scm.procurement.po")` (GET = view, PATCH = edit); the finer keys above layer on inside each handler.
- The sidebar pending-count endpoint checks `scm.po_amendment.approve` literally, so the `*` wildcard does not populate the Owner account's badge.

## Rules that must not break

- A revised line quantity may never drop below `received_qty` (`poReceivedFloorViolation`) — checked before any write.
- Rejecting a follow-up amendment auto-releases its lines' un-allocated remainder to STOCK (`planStockRelease`) — existing allocation slices are never touched, and a release failure never un-rejects the amendment (it surfaces in `releaseWarnings`, retryable via the allocation editor).
- A line whose item code moves, and any ADDed line, takes `supplier_sku` from the PO supplier's current binding; no binding clears the code (falls back to the live binding, else `—`) rather than keeping a stale code.
- This module is not re-exported through `shared/index.ts` (its `canTransition`/`nextStatus` names collide with `so-amendment`'s) — import directly from `../shared/po-amendment`.
- Only one open (`REQUESTED`) amendment per PO at a time.

## Gotchas

- Line numbers in generated docs drift with every merge — resolve a route with `npm --prefix backend run gen:route-locator` and `docs/generated/route-locator.md`, don't trust a hardcoded `:NNN`.
- There is no honest-pricing recompute on a PO amendment's PRICE change (unlike the SO side) — the supplier cost is stored exactly as entered.
- Mobile has no PO amendment CREATE surface — raising one is desktop-only; deep-linking `/scm/po-amendments/:id` is not wired on mobile (in-app tap only).
- The mobile PO amendment queue shows only the newest open amendment per PO — if two lanes are open, the banner may not match the row that was tapped.
- An SO-driven row in the PO amendments queue opens the source Sales Order, not a PO amendment detail — expect navigation to `so-detail` / the SO amendment surfaces from that card.
- The amendment detail page's granular status pill and the printed PDF's simplified status label are allowed to differ — that is accepted, not a bug to silently "fix".

## Where the code is

- `backend/src/scm/routes/po-amendments.ts` — API surface, create/approve/reject/withdraw, pending-count.
- `backend/src/scm/shared/po-amendment.ts` — pure state machine.
- `backend/src/scm/lib/po-revision.ts` — apply engine (`applyPoAmendment`).
- `backend/src/scm/lib/amendment-po-followup.ts` — follow-up raising rules.
- `backend/src/scm/lib/po-line-supplier-sku.ts` — supplier SKU binding on SPEC/ADD.
- `backend/src/db/migrations-pg/0194_scm_po_amendment_workflow.sql` — schema.
- `frontend/src/pages/scm-v2/PoAmendments.tsx`, `PoAmendmentDetailV2.tsx` — desktop queue + job card.
- `frontend/src/components/scm-v2/PoAmendmentCreateModal.tsx` — create-request editor.
- `frontend/src/mobile/MobilePoAmendments.tsx`, `MobilePoAmendmentDetail.tsx` — mobile queue + job card.
- `frontend/src/vendor/scm/lib/po-amendment-queries.ts` — TanStack hooks, cache invalidation.
- `frontend/src/vendor/scm/lib/amendment-pdf.ts`, `amendment-pdf-map.ts` — shared printable document.
