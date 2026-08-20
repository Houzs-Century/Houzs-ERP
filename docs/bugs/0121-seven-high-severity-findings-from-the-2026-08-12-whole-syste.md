## Seven high-severity findings from the 2026-08-12 whole-system review, still live on main [high]

Landed together because they came from one pass and no other open PR claimed
them. Three of the fixes are EXTRACTIONS rather than in-place edits, because the
repo's file-size ratchet holds `mfg-sales-orders.ts`, `routes/assr.ts` and
`DataGrid.tsx` to "may only shrink" and it was right to: the SO status-transition
table and the discard guards now live in `scm/lib/so-lifecycle-guards.ts` (they
were being reasoned about apart, which is how the ON_HOLD edge and the DRAFT-only
delete became a way to destroy a delivered order); case visibility + the creditor
strip live in `services/assrVisibility.ts` (a `services/` module is the only
place BOTH the JSON route and the print route can import from); and the DataGrid
layout overlay is materialised in `dataGridLayoutStorage.ts`, next to the shape
it edits. The review was 19 parallel deep reads with an adversarial refutation round
(42 high-severity candidates, 37 confirmed); these are the confirmed ones that
were still true of `origin/main@4851a9ec7` when re-read against the SOURCE on
2026-08-14, and that PRs #2140 / #2127 do not touch. Each was verified by
reading the current code, not by trusting the review's own write-up.

### The P&L drill-down did not apply the filters its own total applies [high]

- **Symptom.** Open the cross-module P&L, click a cost bucket, and the row list
  cannot be made to add up to the number you clicked.
- **Root cause.** `bucketDrilldown`'s project-cost and service-cost queries were
  hand-written second copies of `rawProjectCost` / `rawServiceCost`, and the
  copies carried neither the `company_id` predicate nor the `projects.archived_at
  IS NULL` join. The two sales/PO queries in the same function DID carry the
  company filter, which is what made it look deliberate. So the total was Houzs
  and the list was Houzs + 2990 + the archived FAIR PNL seeds (RM 6,290,856 of
  archived project cost, measured 2026-07-29).
- **Fix.** One `FROM … WHERE` fragment per source (`projectCostFrom`,
  `serviceCostFrom`) with one bind builder, interpolated by BOTH the total and
  the drill-down. A filter added in future cannot reach one and miss the other.
  `backend/tests/reviewHighFindings.test.ts` asserts the two predicates are the
  same text.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/finance.ts`.

### A POS tablet could shed `origin='pos'` in one request [high]

- **Symptom.** None visible — that is the problem. The SO pricing envelope
  refuses a POS-side edit that drops the bill below the order's own total; a
  tablet could walk past it.
- **Root cause.** `POST /api/pos/exchange-web-session` minted a NEW session for
  the same user and deliberately dropped the origin marker, and the comment said
  so ("so the drift gate treats this like an ordinary desktop session"). But
  `origin='pos'` is the whole hinge `isPosTabletCaller` reads, so the four drift
  refusals plus `trustOperatorSelling` and `posTablet` were all gated on a flag
  the caller could discard by asking for a second token.
- **Fix.** The exchange CARRIES the caller's origin. An exchange must never widen
  the session it was exchanged from. Office sessions have no origin to carry and
  are unaffected, so the SSO handoff still works.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/pos.ts`.

### Any sales user could free another rep's held PWP vouchers [high]

- **Symptom.** A rep's RESERVED promo codes disappear from their cart with no
  error anywhere.
- **Root cause.** `DELETE /scm/pwp-codes/reserve` took the client-supplied
  `cart_line_key` as its whole authority. Company scope had been added; owner
  scope had not. Every other writer in that file — the reserve insert, the
  surplus trim, the stray trim, all three reads — pairs company with
  `owner_staff_id`; this one verb did not, and it answers `{ok:true}` whether it
  matched your row, someone else's, or nothing.
- **Fix.** `.eq('owner_staff_id', userId)`, resolved the same way the POST path
  resolves it. An unlinked staff account frees nothing rather than everything.
- **Ref** — this PR, 2026-08-14. `backend/src/scm/routes/pwp-codes.ts`.

### The printable service case ignored the row-level rule the JSON one enforces [high]

- **Symptom.** A visibility-scoped salesperson could render ANY service case in
  their company as a letterheaded document by walking the id — and see the
  supplier identity the JSON route withholds from them.
- **Root cause.** `GET /api/assr-print/:id` had the COMPANY check and stopped
  there. The row-level scope (self + downline + legacy agent-name reach) and
  `stripCreditorFields` lived inline inside `GET /api/assr/:id` and had no second
  caller. Two routes emit the same content; the rule was on one of them.
- **Fix.** The rule is now `assrCaseRowInScope` / `assrCallerIsScoped` in
  `routes/assr.ts`, called by both. Nick 2026-07-15 「这个我要 office, supplier
  看到而已」 is applied to the office print variant too.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/assr_print.ts`, `assr.ts`.

### A voided service case kept aging, kept breaching, and kept emailing people [high]

- **Symptom.** Staff receive SLA escalation mail about cases somebody closed
  precisely so they would stop mattering; backlog and aging tiles count them.
- **Root cause.** There are TWO terminal stages, `completed` and `voided` — both
  stamp `closed_at`, both render as "Closed" — and roughly thirty hand-written
  copies of `stage != 'completed'` named only one. The daily cron then stamped
  `escalated_at`, wrote an activity row and mailed the assignee plus every
  `service_cases.manage` holder. The escalation query also never checked
  `archived_at`.
- **Fix.** `backend/src/services/assrStages.ts` — one `assrOpenStageSql(alias)`,
  applied to all 24 open-case predicates and the three `is_breached` CASE arms.
  The CLOSED side (`stage = 'completed'`, which drives resolved counts and
  average resolution time) is deliberately NOT collapsed: a voided case was not
  resolved. `archived_at IS NULL` added to the escalation candidates.
- **Ref** — this PR, 2026-08-14. `assrStages.ts`, `assrEscalation.ts`,
  `services/assr.ts`, `routes/assr.ts`.

### ON_HOLD was a laundry that turned a delivered order into a deletable draft [high]

- **Symptom.** A DELIVERED or INVOICED sales order can be hard-deleted, taking
  its payment ledger and its entire audit log with it, and leaving the DO and the
  invoice pointing at nothing.
- **Root cause.** Two independent halves. (1) `soStatusTransitionError` returned
  `null` unconditionally on BOTH ON_HOLD edges, so `DELIVERED>DRAFT` — which the
  rank table and `SO_LEGAL_REGRESSIONS` both refuse — was legal in two PATCHes:
  `DELIVERED>ON_HOLD` passes on `to`, `ON_HOLD>DRAFT` passes on `from`. (2)
  `DELETE /:docNo` authorised on `status === 'DRAFT'` alone; its own header
  comment stated the assumption ("a DRAFT has no DO/SI"). The cascade takes
  `mfg_sales_order_items`, `_payments`, `mfg_so_price_overrides`,
  `mfg_so_status_changes` and `mfg_so_audit_log`; `delivery_orders.so_doc_no` and
  `sales_invoices.so_doc_no` are ON DELETE SET NULL.
- **Fix.** Both halves. `ON_HOLD>DRAFT` is refused (every other resume target is
  untouched — nothing legitimately resumes into "not yet written"), and DELETE
  now consults `soHasDownstream` — the same lock CANCELLED already uses — and
  refuses when a payment row exists, failing CLOSED if the ledger cannot be read.
- **Ref** — this PR, 2026-08-14. `backend/src/scm/routes/mfg-sales-orders.ts`.

### Every AutoCount sales-order pull has failed since the Postgres cutover [high]

- **Symptom.** The `sales_orders` mirror has taken nothing, and
  `pull_checkpoint` refetches the same window forever. Invisible: the per-row
  failure is caught and counted, and `runPull` only advances the checkpoint when
  `failed === 0`.
- **Root cause.** `upsertSalesOrder` named SEVEN columns `public.sales_orders`
  has never had — `transfer_to`, `note`, `inv_addr1..4`, `sync_error` — carried
  over verbatim from the D1 schema at the cutover. Postgres answers 42703 and
  refuses the statement. `company_id` (NOT NULL, no default, mig 0083) was never
  written either, so a fixed statement would have hit 23502 on the first new doc.
- **Fix.** The seven phantom columns removed from both the INSERT and the ON
  CONFLICT branch; `company_id` resolved in SQL from the companies master exactly
  as 0083's own backfill did. `SALES_ORDERS_MIRROR_COLUMNS` is exported and the
  test holds the statement to it, because these seven survived every review of
  this file for the whole life of the cutover.
- **Ref** — this PR, 2026-08-14. `backend/src/services/pull.ts`.

### Three front-end findings from the same review [high]

- **A blank signature was stored on every mobile POD.** `MobilePOD` gated the
  payload on `canvas.toDataURL()`, which returns a valid non-empty PNG for an
  untouched, transparent canvas — so `sig` was truthy on every confirm and every
  delivery filed a blank image into `delivery_orders.signature_data`. Worse than
  storing nothing: a blank PNG is indistinguishable from a real POD that failed
  to render, and it is the only customer-side evidence the DO carries. Now gated
  on `hasSignature`, which the pad sets on the first pointerdown. `podKey` and
  `gps` in the same object literal were already gated on real capture.
- **Mobile offered the convert "+" to view-only PO / GRN users.** `MobileApp`
  gated the DO and SI convert targets and fell through to a literal `: true` for
  the other two. `MobileConvertWizard` imports no auth of its own, so nothing
  downstream stopped them; the 403 arrived after the whole wizard was filled in.
  New `canOperatePurchaseOrders` / `canOperateGoodsReceipts` mirror the backend
  area guard, and the chain has no default arm, so a new target that forgets its
  gate will not typecheck.
- **"Show <column>" did nothing on a never-adjusted grid.** `effectiveHidden`
  overlays `defaultHidden` when `order` and `hidden` are both empty, so a mutator
  that writes those fields without materialising the overlay first is writing
  against a layout that does not exist. `showColumn` filtered an empty array;
  `hideColumn` pushed one key and silently un-hid every other default-hidden
  column; `pinLeft` un-hid all of them. One `materialize` helper now writes BOTH
  fields, and all four mutators start from it (`toggleColumn` was half-right and
  is now whole).
- **Ref** — this PR, 2026-08-14. `MobilePOD.tsx`, `MobileApp.tsx`,
  `salesAccess.ts`, `DataGrid.tsx`.

### A finance write reached the other company for every non-scope-to-PIC caller [high]

- **Symptom.** None on screen. `PATCH /projects/:id/finance` updated — or
  CREATED — the other company's `project_finance` snapshot and then ran
  `recomputeAutoCostLines` over their project.
- **Root cause.** The `activeCompanySql` predicate sat INSIDE the
  `isScopedProjectUser` branch, and the comment above it recorded the rest as
  "deferred, tracked separately". In practice that meant no company predicate was
  evaluated anywhere on the path for the majority of `projects.write` holders.
- **Fix.** The project is resolved in the active company FIRST, for every caller,
  and the PIC rule is applied to the row that load returned. Out of company reads
  as "Not found", the same answer as a nonexistent id.
- **Ref** — this PR, 2026-08-14. `backend/src/routes/projects.ts`.
