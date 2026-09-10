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
| `LINES` | SKU/spec, colour/fabric, qty, sell price, added/removed product lines, **Processing Date** | `scm.amendment.approve_lines` (Purchasing) | yes — approving auto-raises a follow-up PO Amendment |
| `DELIVERY` | schedule Delivery Date, State/Postcode/City, the address block, disposal, customer contact, **service lines** (the SVC- family) | `scm.amendment.approve_delivery` (Logistics) | never |

Two rules that are easy to get wrong:

- **A mixed submission is SPLIT at create time** into two amendment documents,
  one per lane, each with its own approver and lifecycle. They never wait for
  each other. Numbering stays one `/A{n}` sequence per SO, so a mixed
  submission mints `/A3` and `/A4`.
- **The lane of a LINE change is decided by its ITEM CODE**, not by what changed:
  a service SKU routes to `DELIVERY` (delivery fees, disposal, lifting are
  transport charges wearing a line's clothes), every real product line to
  `LINES`. An unknown code defaults to `LINES` — a product change mis-routed to
  purchasing is reviewable noise; mis-routed *away* from purchasing it is an
  unreviewed spec change.

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
| `GET /so-amendments` | read | Row-scoped like the SO list (own + downline for a scoped rep) |
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
| Amendable header fields (the list is code, not prose) | `frontend/src/vendor/scm/lib/so-amendment-header.ts`, asserted against `soAmendableHeaderKeys()` in CI |
| The notice delivery model, `source` tags, bell slice | [`announcements.md`](./announcements.md) |
| PO-side workflow | [`purchase-order-amendment.md`](./purchase-order-amendment.md) |
