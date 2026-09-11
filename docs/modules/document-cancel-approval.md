# Module: Document Cancellation Approval (SCM)

> Line numbers are deliberately absent from this guide. Resolve a route to its
> current line with the generated locator, which is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Cancelling a **Sales Order** or a **Purchase Order** always costs a written
reason. What that reason then waits for differs per document:

| document | what the cancel needs | who (prod appointment) |
|---|---|---|
| Sales Order | a request + **two signatures** — level 1, then level 2, two different people, neither the requester | level 1 = Sales Director, level 2 = Purchaser |
| Purchase Order | **the reason, and nothing else** — no request, no approver, cancelled on the spot | the buyer doing it |

Owner, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」, then the
same day 「只有 SO 需要 sales director approval, PO 不需要 … PO 只要 Purchaser
一个审批」 and 「需要先给 sales director 审批才到 purchaser 审批」. Then on
**2026-09-09**: 「PO cancelled 不需要审批，只需要 remark 原因取消」 — the Purchase
Order's one signature is gone; its reason is not.

**The PO is a REASON-ONLY document** (`isReasonOnly` in
`shared/document-cancel.ts`, `APPROVAL_LEVELS.PO = 0`). The reason rides the
cancel's own body, the guard refuses the cancel without it, and the cancellation
is written to the same ledger the Sales Order's approvals use — as an `EXECUTED`
row with no signatures. Nothing about a PO cancel is optional except who else
has to agree.

> Read this before touching the cancellation code. If your change alters the
> surface (an endpoint, a permission, a status, the depth for a document, who
> may press what), update this guide in the same PR.

---

## 1. Why this exists

Until 2026-09-08 a cancel was one click, with no reason recorded anywhere:

- On the Sales Order it is also **final**: `so_cancelled_final` refuses the way
  back, the deposit turns into customer credit (`creditFromCancelledSo`) and an
  AutoCount cancel is queued that no screen can undo (`cancel_is_final`).
- On the Purchase Order it releases the SO quota (`recomputeSoPicked`) and
  deletes the allocation sub-lines.

Neither asked why, neither asked anyone else. The owner's rule closes both
gaps: the reason is written by the requester and read by the approver(s); the
cancel itself does not run until they have signed.

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
| `status` | Sales Order: `REQUESTED` → `L1_APPROVED` → `APPROVED` → `EXECUTED`; or `REJECTED` (an approver refused) / `WITHDRAWN` (the requester pulled it back). Purchase Order: `EXECUTED` on arrival — the row is written by the guard AFTER the cancel succeeded, so a PO row is a record, never a queue item |
| `reason` | the requester's words — `NOT NULL`, 5–1000 chars after whitespace collapse |
| `requested_by`, `l1_by`, `l2_by`, `rejected_by`, `executed_by` | `public.users.id` of the REAL Houzs caller, each with a `*_name` snapshot beside it. On a Purchase Order the buyer is both `requested_by` and `executed_by`, and `l1_by` / `l2_by` stay null — nobody signed, and the row must not pretend otherwise |
| `reject_reason` | the approver's words on a rejection (mandatory) |

**One open request per document** — the partial unique index
`uq_document_cancel_request_open` over `(doc_type, doc_key) WHERE status IN
('REQUESTED','L1_APPROVED','APPROVED')`. A second request is refused at the door
(`cancel_request_open`, 409) and the index is the floor under that refusal.

The pure rules — the depth per document (`APPROVAL_LEVELS`), transitions, who
may sign, reason validation, what the guard refuses — live in
`backend/src/scm/shared/document-cancel.ts` and nowhere else. Nothing in a
route counts to two; every handler asks that table.

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
| POST | `.../cancel-request/approve` | signs whatever level is pending → `{ request, execute }`; `execute` is true after the document's FINAL signature (level 2 on an SO, the only one on a PO) |
| POST | `.../cancel-request/reject` | `{ reason }` (mandatory) → `REJECTED`; any approver desk of that document, while a signature is pending |
| POST | `.../cancel-request/withdraw` | → `WITHDRAWN`; the requester (at any open point) or an approver. Silent — nobody is notified |
| same five | `/mfg-purchase-orders/:id/cancel-request…` | the Purchase Order set. Since 2026-09-09 only the **GET** does anything: raising is refused `409 no_approval_needed` (there is no approval to ask for) and approve / reject / withdraw find nothing signable. The GET is what a screen reads to show WHY a PO was cancelled |
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

1. passes a **DRAFT** straight through on a document that takes signatures — a
   draft is discarded, never approved (the SO deletes it);
2. refuses with **403 `cancel_approval_required`** unless the document carries
   an `APPROVED` request (the message says how many of the document's
   signatures are on it — "0 of 2", "1 of 2");
3. when the request IS approved and the caller holds one of the document's
   approve keys, sets `cancelExecutionAdmitted` on the context — the area
   guard's `writeBypass` (`cancelExecutionBypass`) honours it, so the approver
   who just signed can run the cancel even when their position lacks the
   document's `edit` level (prod: the Purchaser with Sales Orders at `view`).
   For this the guard is mounted BEFORE the area guard on both prefixes and
   mints its own service client when the auth bridge has not run yet
   (docs/bugs/0717). Only this one write: the same approver is never admitted
   to any other status transition;
4. lets the existing handler run, untouched, with every guard it always had
   (downstream lock, version CAS, PWP vouchers, customer credit, AutoCount
   outbox);
5. on a 2xx, stamps the request `EXECUTED` with `executed_by` / `executed_at`.

**On the Purchase Order the guard is a different shape** (`reasonOnlyCancel`),
because there is no request to wait for and the reason is the whole rule:

1. reads `{ reason }` off the cancel's own PATCH body and validates it with the
   SAME `readReason` an SO request uses — 5-1000 characters, whitespace
   collapsed — refusing **400 `reason_required`** before the handler is reached.
   A DRAFT is asked too: one rule, whatever the status;
2. refuses **403 `caller_unknown`** if the Houzs caller cannot be identified —
   `requested_by` is `NOT NULL`, and naming the wrong person is worse than
   refusing;
3. lets the handler run, then — **only on a 2xx** — writes TWO things: a
   `CANCEL` row on the document's own history carrying the reason as its note,
   so the History drawer answers "why" beside the status change the handler
   wrote; and the `EXECUTED` ledger row. A cancel the handler refused (a GRN on
   the PO, a drop-ship DO already shipped, an already-received order) leaves
   neither. Both writes are best-effort: the PO is cancelled by then, and
   failing the response would tell the operator the opposite of the truth. The
   cancel handler is NOT edited for this — it sits on its size ceiling, and this
   module's whole shape is that the rule lives at the mount.

Putting the reason in the guard rather than in the four screens is what makes it
unskippable: the PO read page, the editor, the list row menu and mobile all
reach the same PATCH, and so does a script.

The two cancel handlers are **not edited** — `mfg-sales-orders.ts` and
`mfg-purchase-orders.ts` sit on their size ceilings, and a middleware at the
mount is the position the write freeze and the migrated-SO lock already occupy.
This means a script or a stray client that sends `CANCELLED` directly is refused
the same way a screen is.

## 4. Who may do what

### 4.0 WHERE the caller's identity comes from — and why it is read twice

`actorOf` / `signerOf` resolve the caller through one helper, `houzsIdentityOf`,
which reads **`houzsUser` first and `user` second**. Both halves are load-bearing
and neither may be dropped.

**Why `user` is read at all.** `houzsUser` is set by each SUB-ROUTER's own
`supabaseAuth`, not globally (`scm/index.ts` — the area guards run *"before each
sub-router's own supabaseAuth"*). `cancelApprovalGuard` and
`cancelExecutionBypass` are mounted at the SCM level, AHEAD of the router:

```ts
scm.use("/mfg-purchase-orders/:id/cancel", cancelApprovalGuard("PO"));
scm.route("/mfg-purchase-orders", mfgPurchaseOrders);   // supabaseAuth is in here
```

So at that moment `houzsUser` does not exist yet and the real Houzs user is still
sitting in `user`. Reading only `houzsUser` there resolved to null and answered
403 `caller_unknown` **to every caller** — nobody could cancel a purchase order
(`docs/bugs/0774`). `lib/write-freeze.ts`'s `callerBypasses` records the same trap
from 2026-08-11 and solves it the same way; `hasHouzsPerm` dual-reads too, which
is why the PERMISSION half of this module kept working while the IDENTITY half
did not.

**Why `user` is nevertheless GATED.** After the bridge, `user` is the pinned
`scm.staff` identity — one uuid for everybody — and using it as an actor id is how
`mfg_so_audit_log` came to name the same person on every row (§ the module header).
So `user` is accepted ONLY while it is still the Houzs shape: a numeric
`public.users.id`. The staff uuid fails `Number.isInteger`, so after the bridge the
helper falls through to null and the `caller_unknown` refusal stands.

That boundary is pinned by a test — a context carrying only the staff uuid must
still be refused — so a later "simplification" to a plain `?? c.get('user')` fails
the suite rather than silently reviving the one-actor-for-everybody bug.

### 4.1 The permission keys

Three permission keys in `backend/src/services/permissions.ts`, verb `approve`:

| key | signs |
|---|---|
| `scm.so_cancel.approve_l1` | level 1 on a Sales Order (also reject) |
| `scm.so_cancel.approve_l2` | level 2 on a Sales Order (also reject) |

**There is no Purchase Order key, and that is the rule rather than an
omission.** `scm.po_cancel.approve` was removed on 2026-09-09 with the approval
itself (and `scm.po_cancel.approve_l1` / `_l2` existed for a few hours on
2026-09-08 while the PO was briefly two-level). `CANCEL_APPROVE_KEY.PO` is `{}`,
so `approveKeysFor('PO')` is empty and every approve / reject path on a PO row
fails closed through that one table — including for a `*` holder. A role row
still carrying the retired key grants nothing, because nothing reads it.

Owner, IT Admin and the Managing Director pass every key via `*`. The rules a
wildcard does **not** lift (`approvalRefusal` in `shared/document-cancel.ts`):

- the requester may not sign their own request (`self_approval`, 403);
- on a Sales Order the level-2 signer must be a different person from the
  level-1 signer (`same_signer`, 403);
- a level needs its own key (`approve_forbidden`, 403); a level the document
  does not have is `not_pending` (409).

**Raising** a request needs no new key — whoever could reach the document and
write to it before (the area guard's `edit`, plus the salesperson row-scope on
a Sales Order) can ask for it to be cancelled.

**Signing needs the key, not the document's area.** The Sales Director holds
no procurement area and the Purchaser has Sales Orders at `view`, so under the
plain area guard neither could sign. The two document mounts in
`backend/src/scm/index.ts` therefore carry `cancelApproverWriteBypass(docType)`
as the area guard's `writeBypass` — it admits ONLY
`POST …/cancel-request/{approve,reject,withdraw}` for a holder of one of that
document's approve keys (the handler still runs the per-request refusals) — and
`/cancel-request` as an `openReadPaths` suffix so the card on the document
loads for them. Raising a request, and every other write on the prefix, still
needs the area's `edit`. (docs/bugs/0713.)

## 5. Notices

`backend/src/services/cancelRequestNotify.ts` — the same private-announcement
delivery `amendmentNotify` uses (`postPersonalNotice`, bell system slice, red
unread count). Audience per event:

A **Purchase Order notifies nobody at any step** — there is no desk to tell.

| event | told |
|---|---|
| raised | holders of the document's first key (`approve_l1` on an SO) |
| level 1 signed (SO only) | holders of `scm.so_cancel.approve_l2` |
| approved (final signature) | the requester |
| rejected | the requester, with the approver's reason |
| withdrawn | nobody |

The keys are literals in the service (a Houzs-side service must not import the
SCM bundle); `cancelRequestNotify.test.ts` asserts they equal the gate's table.

## 6. The screens

- **Sales Order — request**: every former SO Cancel control raises a request
  through `frontend/src/pages/scm-v2/use-cancel-request-action.ts` — one prompt,
  one copy of the words ("nothing is cancelled yet; the approver(s) will read
  this reason"). Sites: `SalesOrderDetail.tsx`, `SalesOrderDetailV2.tsx`, the SO
  list right-click (`row-menus.ts` → `MfgSalesOrdersListV2.tsx`) and
  `frontend/src/mobile/MobileSODetail.tsx`.
- **Purchase Order — ask why, then cancel**:
  `frontend/src/pages/scm-v2/use-po-cancel-action.ts` holds the one prompt and
  the one sentence ("it is cancelled as soon as you confirm — no approval is
  needed — and this reason is kept on the PO"), used by
  `PurchaseOrderDetailV2.tsx` (the read page), `PurchaseOrderDetail.tsx` (the
  editor) and the PO list right-click (`PurchaseOrdersListV2.tsx`). Mobile says
  the same thing through the `reasonPrompt` field on a mobile `DocAction`
  (`frontend/src/mobile/doc-actions.ts` — the action shape, `PO_CANCEL_PROMPT`
  and `askActionReason`, extracted there because `MobileModuleDetail.tsx` is at
  its 2000-line ceiling; that copy is the mirror that must not drift). All four end at
  the same `PATCH /mfg-purchase-orders/:id/cancel` with `{ reason }`, which is
  why the server holds the rule.
- **The card on the document**:
  `frontend/src/vendor/scm/components/CancelRequestPanel.tsx`, above the header
  on both detail pages and the mobile SO detail. Shows the reason, who raised
  it, which signatures are on it, and the buttons the viewer may press
  (`viewerCanApprove` / `viewerCanReject` / `viewerCanWithdraw` in
  `frontend/src/vendor/scm/lib/document-cancel-queries.ts` mirror the server
  rules, and `APPROVAL_LEVELS` there mirrors the depth; the server's answer is
  the gate). The button says "Approve (level 1)" / "Approve & cancel (level 2)"
  on a Sales Order (`approveLabel`); the Purchase Order has no such card any
  more — it was removed from `PurchaseOrderDetail.tsx` with the approval, and a
  PO can no longer have an open request to show. **The final approve runs the
  page's own cancel mutation** —
  the same one the Cancel button always ran. If that is refused, the request
  stays `APPROVED` and **Cancel now** retries it.
- **The inbox**: `frontend/src/pages/scm-v2/CancelRequests.tsx` at
  `/scm/cancel-requests` (route in `frontend/src/App.tsx` and in the executable
  URL contract `frontend/src/routing/routeManifest.ts`, whose drift test pins
  the route count; sidebar entry Procurement → Cancellation Requests in
  `frontend/src/components/Sidebar.tsx`, shown to holders of any of the three
  keys; tab label in `frontend/src/lib/routeLabels.ts`). Both documents, Open /
  All, the same actions on the row; double-click opens the document. A PO row
  is always `EXECUTED` (the record of a cancellation, visible under **All**),
  so it carries no buttons; a legacy `APPROVED` PO request raised before
  2026-09-09 can still be finished with **Cancel now**, which sends the row's
  OWN reason to the cancel.

## 7. What did NOT change

- The cancel handlers, their guards and their side effects — including on
  2026-09-09: the PO cancel's reason is recorded by the guard, in a row of its
  own.
- `PATCH /mfg-purchase-orders/:id/reopen` — a cancelled PO can still be
  reopened; a later cancel needs a fresh request.
- Draft discard on the SO (`DELETE /mfg-sales-orders/:docNo`).
- The status vocabulary: no new status label anywhere; `status-pill.ts` is
  untouched.

## 8. Tests

- `backend/src/scm/shared/document-cancel.test.ts` — the rules, both shapes:
  the SO's two signatures, and that the PO signs nothing (no key, no level, no
  request to raise, and `executionRefusal` never holding it up).
- `backend/src/scm/routes/document-cancel-routes.test.ts` — the routes and the
  guard over the PostgREST fake: request, two signatures by two people on an
  SO, the requester and the double-signer refused, reject / withdraw, the guard
  refusing 0-of-2 / 1-of-2 and stamping `EXECUTED` once, the approver area
  bypass; and for the PO, that a cancel with no reason (or a 2-character one) is
  400 and never reaches the handler, that a good one writes the EXECUTED row
  with the whitespace collapsed and no signatures, that a DRAFT is asked too,
  and that a cancel the handler REFUSED writes no row.
- `backend/src/services/cancelRequestNotify.test.ts` — audiences per document,
  and the key-table referee.
- Frontend: `document-cancel-queries.test.tsx`, `use-cancel-request-action.test.tsx`,
  `use-po-cancel-action.test.tsx` and `mobile/doc-actions.test.ts` (the reason
  is the gate on both surfaces: a dismissed prompt fires nothing),
  `CancelRequestPanel.test.tsx`, `CancelRequests.test.tsx`.
- Staging, 2026-09-08: the whole SO chain and the PO chain driven end to end
  over the API (31 checks) before the depth change; the PO single-signature
  path is pinned by the route suite.
