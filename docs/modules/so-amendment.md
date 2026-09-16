# Sales Order Amendment

How a processing-locked Sales Order gets changed. Once an SO is locked (date-locked or PO-locked) it is no longer directly editable — every change goes through an amendment: someone raises a request, an authorized approver signs it, and the apply re-derives the SO. PO-side sibling: `docs/modules/purchase-order-amendment.md`. Field routing and what an approved amendment does to line price live in `docs/modules/sales-order.md`.

## Statuses and flow

Two lanes, split by what changed:

| Lane | Covers | Signed by (role) | Touches a PO? |
|---|---|---|---|
| `LINES` | SKU/spec, colour/fabric, qty, sell price, added/removed product lines, Processing Date | `scm.amendment.approve_lines` (Purchaser) | yes — approving auto-raises a PO Amendment follow-up |
| `DELIVERY` | Delivery Date, address block, disposal, customer contact, service lines | `scm.amendment.approve_delivery` (Logistic) | never |

- A mixed submission is SPLIT at create time into two separate amendment documents, one per lane, each with its own approver and lifecycle — they never wait on each other. Both share the SO's one `/A{n}` numbering sequence.
- A LINE change routes by whether it is a SERVICE line (the full identity signal — `item_group` / catalogue category / `SVC-` code — not the prefix alone); an unknown identity defaults to `LINES` rather than silently skipping review. An ADDED line (no SO row yet) is judged by its code's catalogue category, resolved server-side at submit; that read failing refuses the submit rather than guessing.
- A stored lane can only be moved by a dedicated repair script, never from a screen, and only for a `REQUESTED`, lane-bearing, line-only amendment whose lines all agree with the target lane under today's service-line signal.
- Legacy rows (`lane IS NULL`, pre-rework) keep the original supplier-confirm two-gate chain and its own permission keys — a closed set, no new null-lane row can be created.

State machine (a lane row lives inside the existing status enum): `REQUESTED -> approve-so -> SO_APPROVED` (terminal); `REQUESTED -> reject -> REJECTED` (reason required); `REQUESTED -> withdraw -> REJECTED` (resolution `WITHDRAWN`). `SUPPLIER_PENDING` / `PO_APPROVED` / `SENT` are legacy-only and unreachable by a lane row.

## Permissions

- `POST .../amendments` — `scm.amendment.create`, OR the salesperson on their own order, OR a lane approver. A reason is required before the SO is even read. The lane is COMPUTED, not chosen; the submit dialog shows the requester which desk it goes to and lets them flag it with a note (`so_amendments.lane_flag_note`, trimmed, ≤500 chars) when the computed approver looks wrong — the request still goes where the rule says, the note travels with it.
- `PATCH .../approve-so` and `/reject` — the row's own lane key (`approve_lines` or `approve_delivery`; legacy rows use `approve_so`/`approve_po`).
- `PATCH .../withdraw` — the requester, or anyone who could reject it.
- `GET .../pending-count` asks the lane keys LITERALLY — a `*` wildcard holder gets 0 unless their role was separately granted the literal keys (done for the Owner's shared login so it gets both the badge and the notice). This is deliberate and is the one place in the SCM routes that does not honour the wildcard for visibility; a wildcard holder can still see and approve every row.

## Rules that must not break

- `GET /pending-count` must count only lanes the caller can sign, from the exact same table the approval gate itself reads — the badge and the approve button must never disagree.
- Approval/rejection/raise notices go only to LITERAL key holders (never a `*` wildcard) — extending an account's visibility means granting it the specific lane keys via its role, not exempting the wildcard.
- Nobody is notified of their own action, and a withdrawal is silent on purpose; a notification must never be able to fail the underlying write (best-effort, deferred until after commit).
- The amendable header field list is defined in code (`so-amendment-header.ts`) and asserted in CI — don't let a second hand-written list of amendable fields drift from it.
- A locked SO's direct header PATCH must DROP every amendable key rather than attempt to revert it to a prior value — reproducing a byte-exact original has failed before.
- An approved SPEC change must re-resolve the line's `description`/`description2` from the catalogue for the new code, and must re-carry the SO line's current photos and re-derive the supplier code onto any bound PO line.
- A line that asks for nothing must never reach an approver. The submit route and the lane preview both run `dropNoopAmendmentLines` (`lib/amendment-noop-lines.ts`) BEFORE the empty check and the lane split: a SPEC / QTY line on an existing line whose every carried field equals the stored line is dropped (variants compared WITHOUT the `remark` key, in canonical key order; an omitted field cannot make a change; ADD / REMOVE always kept; a failed read refuses 500). Owner 2026-09-16, HC-SO-011410: the phone copied the line remark into `variants.remark`, every remarked imported line read as a spec change, and a Delivery Date change opened a second, empty Purchaser approval — 41 such approvals had already raised 32 PO amendments (`docs/bugs/0944-a-delivery-date-change-on-the-phone-raised-a-second-amendment.md`). The phone now compares and sends variants through `amendmentVariants` (`vendor/scm/lib/so-amendment-line-diff.ts`); the remark rides `newRemark` only.

## Gotchas

- Don't infer an amendment's lane from what changed — infer it from whether the line is a service line; a delivery/disposal/storage/transport line must route to `DELIVERY` even though it looks like a normal line item.
- Don't hand-move a stored lane by editing the row — use the repair script, which refuses anything not cleanly `REQUESTED` and line-only, and which posts no notice (the target desk's inbox re-reads by lane on its own).
- A single click on the desktop queue opens a read-only quick-view drawer; approve/reject/withdraw only exist on the full job card. The drawer reuses the job card's own diff-card components — don't build a second renderer for the same diff.
- The Approver badge (Purchaser / Logistic / Legacy) and the Reference column both read from shared helpers also used elsewhere (the SO list, the PO Amendments queue) — don't recompute either locally, or a document can show two different answers to the same question.

## Where the code is

- `backend/src/scm/shared/amendment-lane.ts` — the lane classification, single source of truth.
- `backend/src/scm/routes/so-amendments.ts` — API surface.
- `backend/src/scm/lib/so-revision.ts` — apply engine, catalogue re-resolve on SPEC change.
- `backend/src/scm/lib/amendment-noop-lines.ts` — drops no-change lines before the split (submit + preview); `variantsForCompare` is also what the PO follow-up's `VARIANT` test reads.
- `backend/src/scm/lib/amendment-lane-resolve.ts` + `routes/so-amendment-lane-preview.ts` — the one lane resolver, and the read-only preview the submit dialog shows.
- `backend/src/services/amendmentNotify.ts` — notice audience per event.
- `backend/scripts/relane-so-amendment.mjs` — the only way to move a stored lane.
- `frontend/src/vendor/scm/lib/so-amendment-header.ts` — amendable header field list.
- `frontend/src/pages/scm-v2/AmendmentDetailV2.tsx`, `AmendmentQuickView.tsx`, `so-amendment-diff-card.tsx` — desktop job card, quick view, shared diff card.
- `frontend/src/hooks/useAmendmentApprovals.ts` — sidebar badge count.
