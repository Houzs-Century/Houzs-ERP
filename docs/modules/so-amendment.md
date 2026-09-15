# Module: Sales Order Amendment (SCM)

> **Line numbers here are INDICATIVE, not authoritative.** Resolve a route to its
> current line with the GENERATED artifact, which cannot go stale because it is
> rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

How a **processing-locked Sales Order** gets changed. Once an SO is locked
(date-locked or PO-locked) it is no longer directly editable, so every change
goes through an amendment: someone raises a request, an authorized approver
signs it, and the apply re-derives the SO.

This guide exists because the module did not have one. Its PO sibling has
[`purchase-order-amendment.md`](./purchase-order-amendment.md), while the SO side
— the larger of the two, with lanes, splitting, PO follow-ups and a notification
audience — was documented only in scattered sections of
[`sales-order.md`](./sales-order.md). Those sections remain the authority on
**field routing** and **what an approved amendment does to the line price**; this
page owns the workflow, its API surface, and who gets told.

> Read this before touching the SO amendment code. If your change alters the
> surface (a new endpoint, permission, status, or a field that starts/stops
> being required), update this guide in the same PR.

---

## 1. The two lanes

The owner's 2026-07-27 rework split approval in two
(`backend/src/scm/shared/amendment-lane.ts`, the single source of truth):

| Lane | Covers | Signed by | Touches a PO? |
|---|---|---|---|
| `LINES` | SKU/spec, colour/fabric, qty, sell price, added/removed product lines, **Processing Date** | `scm.amendment.approve_lines` (role Purchaser) | yes — approving auto-raises a follow-up PO Amendment |
| `DELIVERY` | schedule Delivery Date, State/Postcode/City, the address block, disposal, customer contact, **service lines** (disposal / storage / transport — identified by `item_group='service'` on an existing line, or the catalogue category `SERVICE` on an ADDED one, not the `SVC-` prefix alone) | `scm.amendment.approve_delivery` (role Logistic) | never |

Two rules that are easy to get wrong:

- **A mixed submission is SPLIT at create time** into two amendment documents,
  one per lane, each with its own approver and lifecycle. They never wait for
  each other. Numbering stays one `/A{n}` sequence per SO, so a mixed
  submission mints `/A3` and `/A4`.
- **The lane of a LINE change is decided by whether it is a SERVICE line**, not
  by what changed: a service line routes to `DELIVERY` (delivery fees, disposal,
  storage, transport are transport/execution charges wearing a line's clothes),
  every real product line to `LINES`. Service-ness is the full `isServiceLine`
  signal (`item_group` / catalog category / `SVC-` code), resolved server-side —
  NOT the `SVC-` prefix alone, because the go-live / AutoCount lines (DISPOSE,
  STORAGE, TRANSPORTATION CHARGES) carry `item_group='service'` with no prefix
  and used to mis-route to Purchasing (owner 2026-09-11, docs/bugs). An unknown
  identity defaults to `LINES` — a product change mis-routed to purchasing is
  reviewable noise; mis-routed *away* from purchasing it is an unreviewed spec
  change.
- **An ADDED line is judged by its code's CATALOGUE category**, because it has
  no SO row and so no `item_group`. The 2026-09-11 fix covered existing lines
  only; on 2026-09-14 HC-SO-012757/A1 added `TRANSPORTATION CHARGES` × 1
  (RM150, catalogue category `SERVICE`) and still landed on `LINES` — the owner:
  「为什么Service line item还是purchaser approve?」. The submit route now reads
  `catalogCategoriesByCode` (`backend/src/scm/lib/validate-item-codes.ts`, the
  order's company) for every line with no `salesOrderItemId` and passes the
  category into the lane split, refusing the submit 500 if that read fails
  rather than classifying on nothing. The PO follow-up uses the same read, so
  approving such an ADD raises no PO amendment. The lane is still stored ONCE at
  submit: an amendment raised before the fix keeps the lane it got
  (`docs/bugs/0895-an-amendment-that-added-a-service-line-went-to-the-purchaser.md`).

**Legacy rows** (`lane IS NULL`, raised before the rework) keep the original
supplier-confirm two-gate chain and its original keys
(`scm.amendment.supplier_confirm`, `scm.amendment.approve_so`,
`scm.amendment.approve_po`). They are a CLOSED set — no new NULL-lane row can be
created — and mig `0225_legacy_amendment_approver_grants.sql` granted Purchaser +
Logistic the old keys so the finite backlog can actually be cleared.

## 2. API surface

Create lives on the SO mount (it reuses that file's SO guards); everything else
on `/api/scm/so-amendments`.

| Method + path | Gate | Notes |
|---|---|---|
| `POST /mfg-sales-orders/:docNo/amendments` | `scm.amendment.create`, OR a salesperson on their OWN order, OR a lane approver | Splits by lane, one insert per lane |
| `GET /so-amendments` | read | Row-scoped like the SO list (own + downline for a scoped rep). Each row also carries `bound_pos` and, since 2026-09-14, the order's raw `so_ref` + `so_customer_so_no` (§7) |
| `GET /so-amendments/:id` | read | |
| `GET /so-amendments/pending-count` | lane keys, asked LITERALLY (`*` excluded) | **Per-signer** count of `REQUESTED` rows in the lanes THIS caller can sign; 0 for everyone else, the Owner account included. Feeds the sidebar badge (§5). Registered BEFORE `/:id` — Hono matches in order |
| `PATCH /so-amendments/:id/approve-so` | the row's lane key (legacy: `approve_so`) | Applies the SO revision; LINES also raises PO follow-ups |
| `PATCH /so-amendments/:id/reject` | the row's lane key (legacy: `approve_po`) | **Reason required** |
| `PATCH /so-amendments/:id/withdraw` | the requester, or anyone who could reject it | Lands on `REJECTED` with `resolution='WITHDRAWN'` |
| `PATCH /so-amendments/:id/supplier-confirm`, `/approve-po`, `/send` | legacy keys | LEGACY rows only |

## 3. State machine

A lane row lives entirely inside the existing status enum, so no enum migration
was needed:

```
REQUESTED ──approve-so──▶ SO_APPROVED   (terminal: applied)
    │
    ├─────reject────────▶ REJECTED      (terminal: refused, reason required)
    └─────withdraw──────▶ REJECTED      (resolution WITHDRAWN)
```

`SUPPLIER_PENDING` / `PO_APPROVED` / `SENT` are **legacy-only** — a lane row can
never enter them. `REQUESTED` is the one open state, which is why the badge in §5
counts exactly that.

## 4. Who gets told

Amendments used to be raised in silence: the row appeared in Sales Order
Amendment and waited for somebody to happen to open the screen. Since 2026-09-03
(`backend/src/services/amendmentNotify.ts`) each event posts an in-app notice
through the announcements machinery — the full producer model, including the
permission-derived audience and why the `*` wildcard is excluded, is in
[`announcements.md`](./announcements.md).

| Event | Told |
|---|---|
| raised (one notice **per lane**) | the lane's approvers + their upline **minus the top two levels**; separately the SO's salesperson |

Approvers are LITERAL key holders (`permissionHolders.ts`), so a role carrying
only `*` is not on the list — and from 2026-09-09 the Owner role carries the
three real keys precisely so its account IS (see §5).
| approved | the requester + the salesperson |
| rejected | same pair, carrying the rejection reason |
| PO follow-up auto-raised | the purchasing desk |

Nobody is told about their own action, and **withdraw is silent on purpose**.
Nothing here can fail a write: every entry point swallows its own errors, and the
two in-transaction call sites go through `deferScmAfterCommit` so a rolled-back
approval is never announced.

The upline trim exists because the wildcard exclusion alone did not hold — see
`docs/bugs/0743-*.md` for the six days of prod data that showed every notice
reaching the owner anyway.

## 5. The sidebar count

Owner 2026-09-09: *"我需要这里有红色 1/2/3/4 根据目前还有多少单需要被审批 — 在需要
审批人员账号显示, 审批后就根据目前需要的单号改变."*

`frontend/src/components/Sidebar.tsx` renders a red count on the **Sales Order
Amendment** entry (and, by the same mechanism, on **PO Amendments**). A nav entry
declares `badge: "amendment-approvals"`; the count comes from
`frontend/src/hooks/useAmendmentApprovals.ts`.

Four decisions worth keeping:

- **The server decides whose work it is.** `GET /pending-count` counts only the
  lanes the caller can sign, from the same `LANE_APPROVE_KEY` table the approval
  gate reads — so the badge and the button can never disagree. A count that
  included other desks' backlog would never go down for the reader no matter
  what they approved, and a number like that stops being read.
- **The `*` wildcard does NOT put a count on your menu.** The endpoints ask
  `holdsHouzsPermLiterally`, not `hasHouzsPerm` — the one place in the SCM routes
  that deliberately does not honour the wildcard. Owner ruling 2026-09-09, after
  the two surfaces disagreed in production: the notice audience already excluded
  wildcard holders, so the Owner account was silent in the bell while carrying
  every desk's backlog on its menu. One rule now. A wildcard holder can still
  approve anything and still sees every row inside the module; they are simply
  not told it is theirs.

  **How the owner gets it back — a ROLE change, not a code exception**
  (mig `20260909T1000_owner_role_amendment_approver_keys.sql`). The owner signs
  in as the shared `HOUZS CENTURY` account and covers approvals when a desk is
  away, so he needs both the count and the notice. The instrument is the
  narrow one: grant that ONE role the three literal keys, rather than widen the
  badge to every `*` holder — which would also have shown it to four Super
  Admins who are not covering anything. If someone else later needs the same,
  grant the keys; do not reintroduce a wildcard exception here.
- **There is no second visibility rule in the frontend.** "在需要审批人员账号显示"
  is enforced by the count itself: a non-approver gets 0, and the badge renders
  nothing at 0 — which is also what a failed poll produces, so the chrome says
  nothing rather than lying.
- **Invalidation lives at the shared side-effect helper**
  (`invalidateAmendmentSideEffects` in
  `frontend/src/vendor/scm/lib/so-amendment-queries.ts`, and its PO twin in
  `po-amendment-queries.ts`), not on each approve screen. Every gate passes
  through there, so the number drops the moment you sign; a screen that forgot to
  call it would look exactly like the 60s poll being slow.

## 6. Where the rest lives

| Topic | Guide |
|---|---|
| Field kind → department routing, the amendment PDF | [`purchase-order-amendment.md`](./purchase-order-amendment.md) §7 (one table drives SO and PO) |
| What an approved amendment does to the LINE PRICE | [`sales-order.md`](./sales-order.md) |
| What an approved SPEC does to a line's NAME | `backend/src/scm/lib/so-revision.ts` re-resolves `description` + `description2` from the catalogue for the new code, like the ADD branch — so a code swap does not leave the line named by the old product (bug 0781) |
| What an approved SPEC does to a bound PO line's PHOTOS | `reviseBoundPo`'s re-derive re-carries the SO line's CURRENT photos onto the surviving PO line, preserving the PO's own `po-items/` uploads — so a replaced SO line does not leave the PO carrying a dead `so-items/<old>/` key. It used to omit `photo_urls` on the re-derive UPDATE (bug 0790) |
| What an approved SPEC does to a bound PO line's SUPPLIER CODE | When the code moves, `reviseBoundPo`'s re-derive writes the PO supplier's code for the NEW item (`supplierSkuFor`, `lib/po-line-supplier-sku.ts` — the convert path's binding), or clears it with a warning when that supplier has no code for it. An unchanged code keeps its supplier code. It used to move `item_code` + name and leave `supplier_sku` naming the old piece (bug 0887, HC-PO-2609-064) |
| Amendable header fields (the list is code, not prose) | `frontend/src/vendor/scm/lib/so-amendment-header.ts`, asserted against `soAmendableHeaderKeys()` in CI |
| What the DIRECT half of a locked-SO edit sends | `withoutFrozenHeaderFields` in `frontend/src/vendor/scm/lib/so-amendment-header.ts` DROPS every amendable key (and `salesLocation`) from the header PATCH; it never reverts one. A revert had to reproduce the seeded value byte for byte and failed twice (0488: omitted originals became NULL; 0836: it trimmed `"MR LIM "`). Both surfaces call it; the server's lock diffs `col in updates`, so a key never sent cannot 409 |
| The notice delivery model, `source` tags, bell slice | [`announcements.md`](./announcements.md) |
| PO-side workflow | [`purchase-order-amendment.md`](./purchase-order-amendment.md) |
| The queue's simplified status buckets and its open order (Requested first, newest first inside a status — desktop + phone, SO + PO) | [`purchase-order-amendment.md`](./purchase-order-amendment.md), *Status simplification* |

## 7. The queue: who signs it, and the order's reference (2026-09-14)

Two owner asks on the Sales Order Amendment queue, the same day:
「purchaser / logistic - approver需要更明显得看 - 那个是归类purchaser哪个是归类Logistic」 and
「要加上reference number」.

**Approver badge.** `frontend/src/vendor/scm/lib/amendment-approver.ts` is the one
place the lane's signer is named and coloured: `soAmendmentApprover(lane)` gives
`PURCHASER` (LINES), `LOGISTIC` (DELIVERY) or `LEGACY` (lane NULL), shown as
**Purchaser** / **Logistic** / **Legacy** — the ROLE names mig 0216 grants the keys
to, so staff read it as "mine or not". It used to be grey text reading
"Purchasing" / "Logistics", and the detail pages spelled it again by hand. Where
it shows:

- the desktop queue's **Approver** column, as a coloured pill
  (`frontend/src/vendor/scm/components/AmendmentApproverBadge.tsx`);
- each card of the phone queue (`frontend/src/mobile/MobileAmendments.tsx`);
- the PO Amendments queues, on each SO amendment that revises a bound PO. The
  queues take those rows from `frontend/src/vendor/scm/lib/po-amendment-inbox.ts`
  (lane not DELIVERY). The phone queue (`frontend/src/mobile/MobilePoAmendments.tsx`)
  has listed them only since 2026-09-15, and a tap opens the Sales Order — see
  [`purchase-order-amendment.md`](./purchase-order-amendment.md), *Mobile*;
- the words, not the pill, on the amendment job card
  (`frontend/src/pages/scm-v2/AmendmentDetailV2.tsx`: the lane chip, "Purchaser
  approval", "Awaiting Logistic approval"), the SO page's pending banner on both
  surfaces, and the notice after submitting (`so-amendment-submit.ts`).

The colours are deliberately not status tones: Requested / Approved / Rejected
already own burnt, green and red on the same row.

**Reference column.** `GET /so-amendments` reads `ref, customer_so_no` from
`mfg_sales_orders` for the page's doc_nos (company-scoped, one bounded read; a
failed read fails the list with `load_failed` like the main read, because a blank
column would claim the order has no reference) and sends them RAW as `so_ref` /
`so_customer_so_no`. The queue resolves the cell with
`customerRefOf` (`frontend/src/lib/customer-ref.ts`), the rule the Sales Order
list's **Reference** column already uses, so one order cannot show two different
references. Desktop: a **Reference** column after SO No., searchable, sortable,
exported. Phone: a "Ref …" line on the card. Pinned by
`backend/src/scm/routes/soAmendmentListReference.test.ts` and
`frontend/src/pages/scm-v2/amendment-queue-approver-reference.test.tsx`.

**Open order.** Requested stays on top every time the desktop queue opens — see
[`purchase-order-amendment.md`](./purchase-order-amendment.md), *Status
simplification*, for `sortForSessionOnly`.

## 8. One click opens a quick view (2026-09-14)

Owner: 「SO / PO amendment需要单击打开 弹窗 像SO这样」 — the Sales Order list opens a
side drawer on a single click, and the amendment queues should too.

- **Single click** on a desktop queue row opens
  `frontend/src/pages/scm-v2/AmendmentQuickView.tsx` in the shared
  `ResizableDetailDrawer` (the SO / PO / DO list drawers' chrome, same resizable
  width). **Double-click** still opens the job card (`/scm/amendments/:id`);
  `amendmentJobCardPath` is the one place both answers come from, and the
  drawer's **Open full page** goes there too.
- **Read-only**: the amendment number, the Sales Order, the status pill, the
  approver badge, who asked and when, the bound POs, the reason, a withdrawn or
  rejected request's words, the order (header) changes, and the line changes.
  Approve, reject and withdraw stay on the job card, where their permission
  checks and confirmations are.
- **The line cards are the job card's own.** `SoAmendmentDiffCard` now lives in
  `frontend/src/pages/scm-v2/so-amendment-diff-card.tsx` (moved verbatim out of
  `AmendmentDetailV2.tsx`) so the drawer cannot show a change differently from the
  page an approver signs on — and without pulling the job card's PDF generator
  into the queue route. Header rows come from the same `amendmentHeaderDiffRows`.
- **"Remark cleared" / "Discount cleared" on an added line was wrong** and is
  fixed in the one shared rule (`amendmentLineChangedFields`): on an ADD the remark
  and the discount count as changed only when the new line carries one, on a
  REMOVE only when the removed line had one. Before, all 7 lines ever added read
  "Discount cleared" on the job card, the desktop amendment modal and the phone
  sheet (`docs/bugs/0919-an-added-amendment-line-said-remark-cleared-and-discount-cle.md`).
- The phone queue already opened on a tap and is unchanged.
- Pinned by `AmendmentQuickView.test.tsx` and
  `amendment-queue-quick-view.test.tsx` (single click opens it, double-click
  navigates, on both queues).
