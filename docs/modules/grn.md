# Goods Received Note / GRN (SCM)

The receiving step of the buy chain: PO → GRN → PI, with GRN → Purchase Return
as the send-back branch. This is the document that **creates FIFO stock** —
posting it writes inventory IN movements, so it carries more inventory
machinery than the sibling sales/purchase documents. Used by warehouse /
procurement staff on desktop and mobile. Money is integer sen; all reads/writes
go through `/api/scm/grns`.

## Statuses and flow

- Vocabulary: `DRAFT | POSTED | CANCELLED | CLOSED`. Filter buckets: `draft`=DRAFT,
  `posted`=POSTED+CLOSED (a CLOSED GRN's stock IN still stands), `cancelled`=CANCELLED.
- `DRAFT`: create with `asDraft:true`. Commits no stock and no PO rollup. Sending
  `status:'DRAFT'` directly in the body is rejected — `asDraft` is the only way in.
- `POSTED`: set by create-as-posted, `PATCH /:id/post`, or the from-PO converts —
  all funnel through the one chokepoint `postGrnAndRollup` (`grns.ts`), which flips
  status first (atomic CAS on the observed status) and only then recounts the PO's
  `received_qty`, so this GRN's own lines are included.
- `CANCELLED`: `PATCH /:id/cancel`. A DRAFT short-circuits (flip only, nothing to
  reverse). A POSTED GRN reverses the IN per line and is blocked if the stock was
  already consumed downstream.
- `CLOSED`: nothing in the backend writes this anymore; it is a read-only legacy
  terminal that still blocks a re-post.
- `ON_HOLD` is a marker beside the status, not a status overwrite (`PATCH /:id/hold`).
  A held GRN still reads POSTED and its stock stands; the only effect is that the
  three PI-from-GRN billing paths must check `on_hold` explicitly and refuse
  (`grn_on_hold`) — the status alone no longer excludes it.
- `migrated_no_stock` marks the AutoCount-cutover receipts: POSTED, but with no
  inventory movement behind them on purpose (their stock entered via the AutoCount
  balance snapshot). All stock-side effects (cancel reversal, relocate, line
  add/edit/delete deltas) are skipped for these; paperwork (PO rollup, audit row,
  AutoCount outbox, header totals) still runs.
- Two DRAFT GRNs may legitimately coexist against the same PO line (a DRAFT commits
  no `received_qty`); only one can win the CAS at post, the loser gets `already_posting`.
- No revision/amendment mechanism exists (no `grn_revisions` table). Correct a GRN
  by editing while still editable, or cancel + re-create; once a PI/PR has drawn on
  it, the sanctioned fix is a Purchase Return.

## Permissions

- Backend: every `/api/scm/grns/*` route sits behind `scmAreaGuard("scm.procurement.grn")`
  (`backend/src/scm/index.ts`).
- Desktop route: `<ScmGuard area="scm.procurement.grn">` (`frontend/src/App.tsx`).
- Mobile create (`+` on the list, the convert wizard, direct create): gated by
  `canOperateGoodsReceipts(can, pageAccess)` (`frontend/src/auth/salesAccess.ts`),
  which mirrors the backend area guard's `edit` requirement — a view-only mobile
  user can no longer reach a create/convert flow that only 403s at the end.
- Mobile add-line: `mayAddLine` (`frontend/src/mobile/mobile-add-line.ts`) — same
  `canOperateGoodsReceipts` check plus the shared line-lock state.

## Rules that must not break

- All stock/status mutation goes through `postGrnAndRollup`; the flip is a CAS on
  the *observed* status, never a blind `.neq('status', 'CLOSED')` update.
- `PATCH /:id` (header) and all three create paths must scope by company on both
  the read and the write — the service-role client bypasses RLS, so the app-level
  predicate is the only isolation; use `maybeSingle()` on the scoped update, not
  `single()`, so a genuine zero-row (out-of-company) match reports 404, not 500.
- Cross-company PO is refused at create (`firstCrossCompanyPo`) — receiving another
  company's PO would post its stock and cost into the active company's books.
- A non-MYR GRN must have a positive exchange rate (master or operator-entered)
  before it can post — `422 foreign_rate_unset`. Never default an unset rate to 1.
- A line that would receive stock at zero cost, for a SKU previously received at a
  real price, is refused (`422 zero_cost_receipt`) unless the operator enters a
  price or ticks per-line "Received free" with a reason; the ack columns
  (who/when) are stamped from the session, never from the request body.
- `findUnlinkedPoLines` refuses adding a line for a material the header's PO
  already carries without linking it (`409 unlinked_po_lines`) on `POST /` and
  `POST /:id/items` — prevents the same delivery being received twice under two
  different lines.
- A `purchase_order_item_id` passed from the client must name the SAME product as
  the GRN line, checked by `line-link-item-identity.ts` (`409
  link_material_mismatch`); a failed identity read must refuse (503), never pass.
- `grnHasDownstream` blocks line add/edit/delete **and cancel** once any line has
  `invoiced_qty > 0` or `returned_qty > 0` (a PI/PR has drawn on it).
- `grnReverseWouldGoNegative` blocks cancel and warehouse relocation once the
  received stock has been consumed downstream (shipped/used) — directs the
  operator to a Purchase Return instead.
- Header PATCH: once a live PI/PR exists, `supplier_id` / `currency` /
  `exchange_rate` / `allocation_method` freeze (`409 grn_header_inherited_locked`);
  other header fields, including warehouse, stay editable — a warehouse change on
  a POSTED GRN physically moves stock (OUT of old + IN to new) and is NOT gated by
  `grnHasDownstream`.
- Service/freight lines never create inventory movements (goods lines only); their
  amount is pooled and spread across goods lines by the header's `allocation_method`.
- `item_group` / stock variant key for a hand-entered line is resolved server-side
  from `mfg_products.category`, never trusted from the caller's raw value — it
  decides the stock bucket a sofa/bedframe SKU lands in.
- `queueAcGrnEdit` (the AutoCount outbox call on header PATCH / line add / edit /
  delete) requires the caller's own `sb` client explicitly — it must be the same
  client as any surrounding transaction, or a rollback can leave the outbox row
  committed for a document write that never happened.
- Line DELETE and cancel (`DELETE /:id/items/:itemId`, `PATCH /:id/cancel`) run
  inside one DB transaction (`runScmPgCommand`): document write, stock reversal,
  audit row, AutoCount outbox row and SO-allocation recompute request commit
  together or not at all; answers `503` if no direct DB connection is available
  rather than risk a half-written reversal. The other four GRN write paths are
  still best-effort.
- Every pre-write refusal must release the request's idempotency key
  (`refuseWithoutWriting` / `refuseZeroCostReceipt`) so a corrected resubmit is not
  permanently blocked by its own failed first attempt.
- `total_sen` on the list is always the stored header value, never a re-sum of
  lines (a line sum ignores `discount_sen`).
- Every mutation that can move inventory must invalidate the `['inventory']` query
  key on the frontend, or Stock Card / inventory list goes stale after a post,
  from-PO convert, header warehouse change, or line CRUD on a POSTED GRN.
- Desktop and mobile must share the same helpers rather than re-implement: the
  zero-cost remedy (`vendor/scm/lib/zero-cost-refusal.ts`), the add-line lock
  (`vendor/scm/lib/line-add-lock.ts`), and the per-line PO reference
  (`vendor/scm/lib/line-po-link.ts`).

## Gotchas

- Don't read `PATCH /:id/post`'s 200 as success alone — it can carry
  `movementErrors` in-band (stock write partially refused); always surface
  `reportInBandFailure`, not just the HTTP status.
- Don't leave a stock-moving mutation hook without `onError` — a refused post must
  tell the operator the stock was NOT received, not fail silently.
- Don't cap or client-side-filter the from-PO picker read — a `.limit()` combined
  with JS-side filtering silently hides genuinely outstanding PO lines; filter
  dead statuses in SQL, page without a cap, and apply `?poId=` server-side.
- Don't let an empty picker result imply "everything is received" — it must say
  *why* it is empty (`scope` payload), and only a verified-complete case may claim
  completion.
- Don't give a picker's scope parameter a default — `useOutstandingPoItems(poIds)`
  requires it, because an optional scope silently gets every forgetful caller the
  unscoped (slower, looser) read.
- Don't assume `grnReverseWouldGoNegative` is a safety net for migrated receipts —
  it passes for `migrated_no_stock` GRNs too (the units really are on hand from the
  snapshot), so those documents must be excluded from reversal explicitly, not
  relying on this guard alone.
- Don't retype a line's `item_code` after creation without re-running the
  unlinked-line guard — the edit path (`PATCH /:id/items/:itemId`) currently skips
  it, so a hand-added line can be walked onto a PO's own material in two legal
  steps (known open gap, same shape on Purchase Return / DO / SI edit paths).
- Don't hoist a route handler's body out of its inline `grns.<verb>(...)`
  registration — `autocountWritebackCells.test.ts` and
  `grnPreWriteRefusalsReleaseKey.test.ts` anchor on the route block text; a hoisted
  body falls outside what they scan.
- Don't trust `linked_ac_docno` as the receipt's own AutoCount number — it holds
  the **purchase order's** AutoCount number; the receipt's own number is
  `linked_ac_gr_docno`.
- Don't seed a currency's master exchange rate to `1` as a shortcut (e.g. for
  CNY/RMB) — that is exactly the mis-costing the FX guard exists to prevent; leave
  it unset so the guard forces a real rate at post time.
- Don't add a remedy (e.g. zero-cost ack) to only one surface — the mobile app
  needs its own UI for every refusal desktop can clear, or a correct, readable
  refusal still dead-ends a warehouse-floor user.
- Don't assume `grn_items.variants` self-corrects when the parent PO line is
  fixed — it is a snapshot taken at receipt and nothing re-syncs it; a wrong value
  survives every later correction upstream.

## Where the code is

- Routes: `backend/src/scm/routes/grns.ts` (mounted at `/api/scm/grns`),
  `backend/src/scm/routes/grn-exports.ts`.
- Backend libs: `backend/src/scm/lib/outstanding-po-lines.ts` (from-PO picker read),
  `grn-unlinked-po-lines.ts`, `zero-cost-receipt-guard.ts`,
  `line-link-item-identity.ts`, `grn-inherited-lock.ts`, `ac-grn-outbox.ts`,
  `grn-cancel-reversal.ts`, `fx-guard.ts`, `recost.ts`, `sku-category.ts`,
  `line-po-ref.ts`, `downstream-lock.ts`.
- Desktop: `frontend/src/pages/scm-v2/GoodsReceivedListV2.tsx` (list),
  `GoodsReceivedDetailV2.tsx` (read), `GoodsReceivedDetail.tsx` (edit),
  `GrnNew.tsx` (create), `GrnFromPo.tsx` (from-PO convert).
- Frontend data hooks: `frontend/src/vendor/scm/lib/grn-queries.ts`.
- Shared vendor libs: `frontend/src/vendor/scm/lib/zero-cost-refusal.ts`,
  `line-po-link.ts`, `line-add-lock.ts`, `add-line-handoff.ts`,
  `special-order-surface.ts`, `grn-list-export.ts`, `status-pill.ts`,
  `warehouse-label.ts`.
- Mobile: `frontend/src/mobile/MobileModuleList.tsx`, `MobileModuleDetail.tsx`,
  `MobileConvertWizard.tsx`, `MobilePurchaseDocNew.tsx`, `MobileGrnZeroCost.tsx`,
  `MobileLinePoRef.tsx`, `MobileAddLine.tsx`.
- Auth: `frontend/src/auth/salesAccess.ts` (`canOperateGoodsReceipts`).
