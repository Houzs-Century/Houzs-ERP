# Document Cancellation Approval

Cancelling a Sales Order, Purchase Order, or Delivery Order always costs a written reason. What that reason then waits for differs per document.

## Statuses and flow

| Document | Cancel needs | Approver(s) |
|---|---|---|
| Sales Order | a request + two signatures, two different people, neither the requester | level 1 = Sales Director, level 2 = Purchaser |
| Purchase Order | the reason only — cancelled on the spot, no approval | the buyer doing it |
| Delivery Order | the reason only — same shape as PO | whoever may operate delivery orders |

Shape: one row per request in `scm.document_cancel_requests` — the document's own table gains no column and its status is untouched until the cancel actually runs.

- `doc_type`/`doc_key`: `SO`+doc_no, `PO`+id, or `DO`+id (a DB CHECK constraint allows exactly these three).
- `status`: on an SO, `REQUESTED -> L1_APPROVED -> APPROVED -> EXECUTED`, or `REJECTED` / `WITHDRAWN`. On a PO or DO the row is written `EXECUTED` directly, after the cancel already succeeded — it is a record, never a queue item.
- `reason` is `NOT NULL`, 5–1000 characters after whitespace collapse.
- One open request per document, enforced by a partial unique index (409 `cancel_request_open` on a second one).

Routes (`backend/src/scm/routes/document-cancel-routes.ts`): full request/approve/reject/withdraw set for the SO. The same five exist for the PO but since its approval step was removed, only GET does anything — POST raise is refused `409 no_approval_needed` and approve/reject/withdraw find nothing signable; GET is what a screen reads to show why a PO was cancelled. The Delivery Order has **no** request routes at all — nothing to raise or sign; its guard writes the reason straight onto the document's history at cancel time. `GET /cancel-requests?scope=open|all` is the shared inbox for all three documents.

A guard sits in front of the cancel itself and wakes only when the PATCH body asks for `CANCELLED` (trim + uppercase compared, matching the handler's own normalisation exactly):
- **SO / PO** (`cancelApprovalGuard`, mounted BEFORE the area guard so a signing approver without area access can get through): passes a DRAFT straight through; refuses `403 cancel_approval_required` unless the request is fully `APPROVED`; when approved and the caller holds an approve key, admits them to run the cancel PATCH even without edit-level access (and only that one write); on 2xx stamps the request `EXECUTED`.
- **PO / DO** (`reasonOnlyCancel`): reads `{ reason }` off the cancel PATCH body itself, refuses `400 reason_required` before the handler runs; refuses `403 caller_unknown` if the caller can't be identified; on 2xx writes a `CANCEL` history row (reason as its note) plus the `EXECUTED` ledger row, best-effort; writes nothing if the document was already `CANCELLED` (avoids a duplicate record on a double click or a second tab).

The cancel handlers themselves (`mfg-sales-orders.ts`, `mfg-purchase-orders.ts`, `delivery-orders-mfg.ts`) are never edited for this — the whole rule lives at the mount, so a script or stray client sending `CANCELLED` directly is refused the same way a screen is.

**Where an open request SHOWS.** Three places, all reading the same rows: the document’s own `CancelRequestPanel`, the `Cancellation Requests` inbox (all three document types), and — since owner 2026-09-24 (「当有 SO request cancel bill - 需要在 SO amendment 出现」) — the **SO Amendment queue**, desktop and phone, for `doc_type = SO` only. That queue carries the same approve / reject / withdraw / "Cancel now" buttons and counts unsigned requests in its sidebar badge, so a Sales Director or Purchaser signs without opening a second screen. Nothing about the flow changed for it: the queue calls the same routes, and the final approve still runs the document’s own cancel.

## Permissions

- `scm.so_cancel.approve_l1` / `scm.so_cancel.approve_l2` (verb `approve`) are the only cancel-approval keys that exist. There is no PO or DO key — those approve/reject paths fail closed structurally (a `*` wildcard grants nothing there because there is nothing to grant).
- Raising a cancel request needs no special key — ordinary edit access to the document (plus the SO's own salesperson row-scope) is enough.
- Signing needs the specific approve key, not the document's area permission — a dedicated write-bypass admits an approve-key holder to only the approve/reject/withdraw endpoints (and read access to the cancel card), even if their position's area access to the document is view-only.
- A wildcard (`*`) does not lift: self-approval by the requester, the SO's level-1 and level-2 signer being the same person, or signing a level without that level's own key.

## Rules that must not break

- The guard's "asks for CANCELLED" check and the status handler's own check must use the identical normalisation (trim + uppercase, and unwrap a single-element array) — a mismatch lets a value like `"CANCELLED "` skip the guard while the handler still executes it.
- Caller identity for actor/signer resolution reads `houzsUser` first, falling back to `user` only while `user` is still the pre-bridge numeric Houzs id (not the pinned staff uuid) — needed because the SO/PO cancel guards are mounted ahead of the sub-router's own auth, before `houzsUser` exists yet.
- The PO/DO guard must write its history + ledger rows only on a 2xx from the handler, and only when the document was not already CANCELLED — otherwise a refused cancel or a duplicate call fabricates a record of something that didn't happen (or happened twice).
- One open cancel request per document — never bypass the partial unique index with a raw insert.

## Gotchas

- A cancellation row shown inside the SO Amendment queue is still a `document_cancel_requests` row — never give it an `so_amendments` id, a lane, or an amendment number. The queue keys it `cancel:<id>` against the amendments’ `amendment:<id>` precisely so the two can never be confused by a click handler.

- A Purchase Order or Delivery Order cancel notifies nobody at any step — there is no approval desk to tell. Only the Sales Order's request/approve/reject events post bell notices.
- The PO's cancel card was removed from its editor along with the approval step — a PO can no longer have an open request to show; only a legacy pre-cutover `APPROVED` PO request can still be finished, via "Cancel now" on the inbox row.
- A cancelled Purchase Order can still be reopened (`PATCH .../reopen`) — a subsequent cancel then needs a fresh request.
- Don't add new fields to the cancel handlers to carry the reason — the reason is recorded by the guard, in its own row, specifically so the size-capped handler files never need to change.
- `GET /cancel-requests` enriches `doc_type = 'SO'` rows with the order's `ref` / `customer_so_no` (as `doc_ref` / `doc_customer_so_no`) so the SO Amendment queue can print its Reference column. Sent RAW — the display rule (`customerRefOf`) lives on the client, in one place. A failed enrich read FAILS the list rather than blanking the column: blank would claim the order has no reference.
- The inbox's `/cancel-requests` route is guarded only by coarse `scm.access` (it spans multiple document areas and cannot pick one) — do not tighten it to a single document's area permission.

## Where the code is

- `backend/src/scm/shared/document-cancel.ts` — the pure rules: approval depth per document, transitions, reason validation, who may sign.
- `backend/src/scm/routes/document-cancel-routes.ts` — request/approve/reject/withdraw/inbox routes.
- `backend/src/scm/lib/write-freeze.ts` — `cancelApprovalGuard`, `cancelApproverWriteBypass`, `cancelExecutionBypass`.
- `backend/src/services/cancelRequestNotify.ts` — notice audiences per event.
- `frontend/src/vendor/scm/components/CancelRequestPanel.tsx` — the card on the document.
- `frontend/src/pages/scm-v2/CancelRequests.tsx` — the inbox.
- `frontend/src/pages/scm-v2/use-cancel-request-action.ts`, `use-po-cancel-action.ts`, `use-do-cancel-action.ts` — the per-document prompt flows.
