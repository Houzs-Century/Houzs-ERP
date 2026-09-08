# Module: Document Cancellation Approval (SCM)

> Line numbers are deliberately absent from this guide. Resolve a route to its
> current line with the generated locator, which is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Cancelling a **Sales Order** or a **Purchase Order** is a request with a
mandatory reason, followed by **two approvals** — level 1, then level 2, two
different people, neither of them the requester — before the document's own
cancel route is allowed to run.

Owner, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」.

> Read this before touching the cancellation code. If your change alters the
> surface (an endpoint, a permission, a status, who may press what), update this
> guide in the same PR.

---

## 1. Why this exists

Until 2026-09-08 a cancel was one click, with no reason recorded anywhere:

- On the Sales Order it is also **final**: `so_cancelled_final` refuses the way
  back, the deposit turns into customer credit (`creditFromCancelledSo`) and an
  AutoCount cancel is queued that no screen can undo (`cancel_is_final`).
- On the Purchase Order it releases the SO quota (`recomputeSoPicked`) and
  deletes the allocation sub-lines.

Neither asked why, neither asked a second person. The owner's rule closes both
gaps: the reason is written by the requester and read by the two approvers;
the cancel itself does not run until both have signed.

## 2. The shape — a request ROW, not a status

`scm.document_cancel_requests` (migration
`backend/src/db/migrations-pg/20260908T1400_scm_document_cancel_requests.sql`).
One row per request; the document tables gain **no column** and the document's
status is **never touched** until the cancel runs. This is the same reading as
the hold marker (mig 0324) and for the same reasons: a `PENDING_CANCEL` enum
value could never be dropped, would turn the status column into a laundry, and
could not remember a refused request beside the next one.

| column | meaning |
|---|---|
| `doc_type` / `doc_key` | `SO` + `mfg_sales_orders.doc_no`, or `PO` + `purchase_orders.id` — each document's own route key |
| `doc_number` | what a person calls it (inbox, notices) |
| `status` | `REQUESTED` → `L1_APPROVED` → `APPROVED` → `EXECUTED`; or `REJECTED` (an approver refused) / `WITHDRAWN` (the requester pulled it back) |
| `reason` | the requester's words — `NOT NULL`, 5–1000 chars after whitespace collapse |
| `requested_by`, `l1_by`, `l2_by`, `rejected_by`, `executed_by` | `public.users.id` of the REAL Houzs caller, each with a `*_name` snapshot beside it |
| `reject_reason` | the approver's words on a rejection (mandatory) |

**One open request per document** — the partial unique index
`uq_document_cancel_request_open` over `(doc_type, doc_key) WHERE status IN
('REQUESTED','L1_APPROVED','APPROVED')`. A second request is refused at the door
(`cancel_request_open`, 409) and the index is the floor under that refusal.

The pure rules — transitions, who may sign, reason validation, what the guard
refuses — live in `backend/src/scm/shared/document-cancel.ts` and nowhere else.

## 3. Routes

All in `backend/src/scm/routes/document-cancel-routes.ts`, mounted from
`backend/src/scm/index.ts`. The per-document routers ride the SAME prefix and
therefore the same L2 area guard as the document (`scm.sales.orders` /
`scm.procurement.po`); the Sales Order set also sits behind the migrated-SO
lock (`migratedSoReadonly`), so a migrated order cannot be asked about.

| Method | Path | What |
|---|---|---|
| GET | `/mfg-sales-orders/:docNo/cancel-request` | `{ open, history, needsApproval }` — the open request (or null) and the last 20 |
| POST | `/mfg-sales-orders/:docNo/cancel-request` | `{ reason }` → 201 `{ request }`. Refuses: reason too short (400 `reason_required`), a DRAFT (409 `draft_is_discarded`), CANCELLED / CLOSED (409), a document with a live child (409, the downstream-lock refusal), an open request already there (409 `cancel_request_open`) |
| POST | `.../cancel-request/approve` | signs whatever level is pending → `{ request, execute }`; `execute` is true after level 2 |
| POST | `.../cancel-request/reject` | `{ reason }` (mandatory) → `REJECTED`; either approver desk, while a signature is pending |
| POST | `.../cancel-request/withdraw` | → `WITHDRAWN`; the requester (at any open point, level 2 included) or an approver. Silent — nobody is notified |
| same five | `/mfg-purchase-orders/:id/cancel-request…` | the Purchase Order set |
| GET | `/cancel-requests?scope=open\|all` | the inbox — both documents, this company, newest first. Coarse `scm.access` only: an inbox spanning two areas cannot pick one — so the prefix is listed in `SCM_UNGUARDED_PREFIXES` (`backend/src/scm/lib/scm-areas.ts`), which the write-freeze drift test pins against the mounts |

Every step writes an audit row on the document's own history — the SO's
`mfg_so_audit_log` (`CANCEL_SUBMIT_FOR_APPROVAL` / `CANCEL_APPROVE` /
`CANCEL_REJECT` / `CANCEL_WITHDRAW_FROM_APPROVAL`) and the PO's entity audit
(`SUBMIT_FOR_APPROVAL` / `APPROVE` / `REJECT` / `WITHDRAW_FROM_APPROVAL`) — with
the real caller as actor.

### The guard in front of the cancel itself

`cancelApprovalGuard('SO')` is mounted on `PATCH /mfg-sales-orders/:docNo/status`
and wakes only when the body says `CANCELLED`; `cancelApprovalGuard('PO')` on
`PATCH /mfg-purchase-orders/:id/cancel`. Each:

1. passes a **DRAFT** straight through — a draft is discarded, never approved
   (the SO deletes it; a draft PO committed nothing to anyone);
2. refuses with **403 `cancel_approval_required`** unless the document carries
   an `APPROVED` request (the message says how many of the two signatures are on
   it);
3. lets the existing handler run, untouched, with every guard it always had
   (downstream lock, version CAS, PWP vouchers, customer credit, AutoCount
   outbox);
4. on a 2xx, stamps the request `EXECUTED` with `executed_by` / `executed_at`.

The two cancel handlers are **not edited** — `mfg-sales-orders.ts` and
`mfg-purchase-orders.ts` sit on their size ceilings, and a middleware at the
mount is the position the write freeze and the migrated-SO lock already occupy.
This means a script or a stray client that sends `CANCELLED` directly is refused
the same way a screen is.

## 4. Who may do what

Four permission keys in `backend/src/services/permissions.ts`, verb `approve`:

| key | signs |
|---|---|
| `scm.so_cancel.approve_l1` | level 1 on a Sales Order (also reject) |
| `scm.so_cancel.approve_l2` | level 2 on a Sales Order (also reject) |
| `scm.po_cancel.approve_l1` | level 1 on a Purchase Order (also reject) |
| `scm.po_cancel.approve_l2` | level 2 on a Purchase Order (also reject) |

Owner, IT Admin and the Managing Director pass every key via `*`. The rules a
wildcard does **not** lift (`approvalRefusal` in `shared/document-cancel.ts`):

- the requester may not sign their own request (`self_approval`, 403);
- the level-2 signer must be a different person from the level-1 signer
  (`same_signer`, 403);
- a level needs its own key (`approve_forbidden`, 403).

**Raising** a request needs no new key — whoever could reach the document and
write to it before (the area guard's `edit`, plus the salesperson row-scope on
a Sales Order) can ask for it to be cancelled.

## 5. Notices

`backend/src/services/cancelRequestNotify.ts` — the same private-announcement
delivery `amendmentNotify` uses (`postPersonalNotice`, bell system slice, red
unread count). Audience per event:

| event | told |
|---|---|
| raised | holders of the level-1 key for that document type |
| level 1 signed | holders of the level-2 key |
| approved (level 2 signed) | the requester |
| rejected | the requester, with the approver's reason |
| withdrawn | nobody |

The keys are literals in the service (a Houzs-side service must not import the
SCM bundle); `cancelRequestNotify.test.ts` asserts they equal the gate's table.

## 6. The screens

- **Request**: every former Cancel control now raises a request through
  `frontend/src/pages/scm-v2/use-cancel-request-action.ts` — one prompt, one
  copy of the words ("nothing is cancelled yet; two approvers have to sign, and
  they will read this reason"). Sites: `SalesOrderDetail.tsx`,
  `SalesOrderDetailV2.tsx`, the SO list right-click (`row-menus.ts` →
  `MfgSalesOrdersListV2.tsx`), `PurchaseOrderDetail.tsx`, the PO list right-click
  (`PurchaseOrdersListV2.tsx`), and `frontend/src/mobile/MobileSODetail.tsx`.
  A **DRAFT Purchase Order** keeps its direct Cancel behind the confirm — the
  server exempts it too.
- **The card on the document**:
  `frontend/src/vendor/scm/components/CancelRequestPanel.tsx`, above the header
  on both detail pages and the mobile SO detail. Shows the reason, who raised
  it, which signatures are on it, and the buttons the viewer may press
  (`viewerCanApprove` / `viewerCanReject` / `viewerCanWithdraw` in
  `frontend/src/vendor/scm/lib/document-cancel-queries.ts` mirror the server
  rules; the server's 403 is the gate). **The second approve runs the page's own
  cancel mutation** — the same one the Cancel button always ran. If that is
  refused, the request stays `APPROVED` and **Cancel now** retries it.
- **The inbox**: `frontend/src/pages/scm-v2/CancelRequests.tsx` at
  `/scm/cancel-requests` (route in `frontend/src/App.tsx` and in the executable
  URL contract `frontend/src/routing/routeManifest.ts`, whose drift test pins
  the route count; sidebar entry Procurement → Cancellation Requests in
  `frontend/src/components/Sidebar.tsx`, shown to holders of any of the four
  keys; tab label in `frontend/src/lib/routeLabels.ts`). Both documents, Open / All, the same
  actions on the row; double-click opens the document.

## 7. What did NOT change

- The cancel handlers, their guards and their side effects.
- `PATCH /mfg-purchase-orders/:id/reopen` — a cancelled PO can still be
  reopened; a later cancel needs a fresh request.
- Draft discard on the SO (`DELETE /mfg-sales-orders/:docNo`).
- The status vocabulary: no new status label anywhere; `status-pill.ts` is
  untouched.

## 8. Tests

- `backend/src/scm/shared/document-cancel.test.ts` — the rules.
- `backend/src/scm/routes/document-cancel-routes.test.ts` — the routes and the
  guard over the PostgREST fake: request, two signatures by two people, the
  requester and the double-signer refused, reject/withdraw, the guard refusing
  0-of-2 and 1-of-2 and stamping `EXECUTED` once.
- `backend/src/services/cancelRequestNotify.test.ts` — audiences, and the
  key-table referee.
- Frontend: `document-cancel-queries.test.tsx`, `use-cancel-request-action.test.tsx`,
  `CancelRequestPanel.test.tsx`, `CancelRequests.test.tsx`.
