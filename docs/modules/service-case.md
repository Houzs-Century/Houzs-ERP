# Service Case (ASSR)

After-sales service cases from intake to close: complaint capture, repair
pipeline, supplier/logistics coordination, and the customer/supplier/survey
portals. Used by Service Admin, Logistic Admin, and Sales (their own/raised
cases). Table `assr_cases` lives in the `public` schema, not `scm`; all
endpoints are under `/api/assr` plus the token-gated portals.

## Statuses and flow

Every case now runs the full **7-stage pipeline** (the old 5-stage
internal-resolution shortcut was retired 2026-09-04 — an in-house repair also
collects/returns/QCs the item):

1. `pending_review` (Review)
2. `pending_solution` (Solution) — Solution now runs BEFORE Verification
3. `under_verification` (Verify)
4. `pending_supplier_pickup` — stage renamed **"Pickup / Return"**
5. `pending_item_ready` (Pending Item Ready)
6. `pending_delivery_service` (Delivery) — owned by Logistic Admin
7. `completed` (Completed) — system-set

`voided` is an **eighth, terminal alt-outcome** (case ruled invalid /
not-warranty), parallel to `completed`, never a pipeline step — it has no row
in the ordered stage table but is a legal value everywhere else. Both
`completed` and `voided` stamp `closed_at`; only `completed` stamps
`completion_date` and feeds the CSAT survey.

Sub-statuses exist inside two stages only: Under Verification
(`pending_inspection` / `qc_issue_result`); Pickup/Return has **three** legs —
enters on `pending_customer_pickup` (collect from customer), then
`pending_supplier_pickup` / `pending_supplier_return`.

`mark-opened` auto-advances `pending_review → pending_solution` on first open
(no-op otherwise). **"Open"** (backlog/aging/SLA/escalation) means neither
terminal stage AND not archived — both terminal stages must be excluded, not
just `completed`.

## Permissions

- `service_cases.read` / `.create` / `.write` / `.manage` / `.approve`.
- **Read + create admission** (`requireServiceCaseAccess`): passes if the
  caller holds any listed permission, **or** holds any company grant
  (`holdsAnyCompanyGrant`), **or** is a director. Not job-title based.
- **Every mutation/manage/approve route**: plain `requirePermission`.
- **Row visibility** (list/detail/aggregates): `*`/`.manage`/director sees
  everything; everyone else is scoped to their reporting subtree via
  `assrVisibilityPredicateSql` — an ERP-native-SO case keys on
  creator/assignee/salesperson id in the subtree; an AutoCount-mirror or
  unresolved-SO case is visible to anyone the **company** predicate admits
  (no agent test). `assr_case_access` is a 6th arm granting named staff
  (+upline) visibility without taking an assignee/salesperson slot.
- `/my-cases` answers "did I raise or am I named on this" — `created_by` in
  subtree OR legacy `sales_agent` text match — a different, narrower question
  than the main list.

## Rules that must not break

- Any reader of `assr_cases` must import `assrCompanySql`, never hand-write
  the company predicate — it has drifted/been missed at least three times
  (global search, the Delivery Planning board).
- The JSON detail route and the printable route must both apply company scope
  AND visibility scope explicitly — an **unresolved** scope (`undefined`,
  pre-migration/cold start) skips the check; an **empty** scope (`[]`, no
  grants) must 404. Never collapse the two.
- `complained_date` is server-stamped at create and immutable after —
  deliberately absent from `PATCH_FIELDS`.
- `items[]` is NOT required at create — a case need not be about a defective
  product. Create refuses a duplicate open case for the same
  `item_code`+`doc_no` (409 `duplicate_open_case`).
- `service_category` is an ARRAY join table — every save must send the
  complete list; `PATCH` rewrites the join rows from exactly what it is
  given, so a partial list silently deletes categories.
- The SO-search access gate is `holdsHouzsCompanyGrant`, not a job-title
  string match.
- The attachment stream sends `X-Content-Type-Options: nosniff`.
- The escalation cron's "open" predicate (`assrOpenStageSql`) must exclude
  both terminal stages and archived cases, or a closed case keeps escalating.
- `order_pos` (read-only, merged: the SO's raised purchase orders) must never
  be confused with `po_no` (the case's own service PO — hand-edited or
  `generate-po`, refuses once set).
- The pre-auth form-intake endpoints scope strictly by the caller's **secret**
  → company mapping; an unmapped secret 503s, it must never fall back to "no
  predicate" (that would leak both companies' PII).
- A logistics leg reaches the HC Delivery sheet ONLY when its own-team marker
  AND its date are both set: inspection (`inspection_by='own'` +
  `inspection_visit_at`), pickup (`pickup_by='customer'` + `customer_pickup_at`),
  delivery (`delivery_by='own'` + `do_date`). Supplier / 3PL / unset legs never
  sync. `GET /api/delivery-sheet/assr-legs` is the own-team-gated feed
  (`delivery-sheet-assr-feed.ts`); the Delivery Planning board is deliberately
  NOT gated (it shows every dated leg), so board and sheet differ on purpose.
- **Supplier returns (返厂)** are rows in `assr_supplier_returns` (`round_no`
  1..N, added freely; an archived trip keeps its number, never reused). The list
  is the source of truth for each trip's out/back dates; the case's
  `supplier_pickup_at` / `items_ready_at` MIRROR the current (highest `round_no`)
  row via `reprojectLatestSupplierReturn` — the Delivery board + HC sheet read
  those two columns, so never write them directly, edit the trip in the Supplier
  Returns list (the Item-Ready InspectionCard shows the return date read-only so
  the two can't drift). Adding a return on a completed/voided case reopens it
  onto `pending_supplier_pickup` (clears `closed_at`). Endpoints:
  `POST`/`PATCH`/`DELETE /api/assr/:id/supplier-returns` (`service_cases.write`,
  under the `enforceCaseScope` `/:id` guard). `qc_receipt_date` stays a
  Verification-stage field, NOT a supplier-return date.

## Gotchas

- `voided` needs a real label everywhere (`assr-stage-labels.ts`) — pipeline
  ORDER and stage WORDS are two separate tables; a surface that invents its
  own word for a non-step value is how the raw slug `voided` leaked onto the
  customer portal stepper before.
- The stage counter and the "change to" dropdown must both read the SAME
  filtered stage list — one reading the unfiltered table produced "Step 2/5"
  next to a 7-item list.
- The server's sub-status allowlist must match the frontend's set exactly —
  a missing `pending_customer_pickup` once meant a case could enter that leg
  but never be switched back (400).
- Surface `useSoSearch`/similar errors to the user; do not let a fetch error
  render as an honest "no results" — the SO-picker gate silently 403ing once
  looked identical to a genuinely empty search.
- Reuse ONE predicate string across list / aggregate / detail / print readers
  (ask the DB with it, don't restate it in TypeScript) — a rule enforced on
  only one of two routes serving the same content (JSON detail vs. print) is
  not enforced.
- The frontend `PageGuard` gate (`org.sales.staff`) is currently **narrower**
  than the backend's company-grant gate — a HOUZS grantee without a Sales
  title needs an explicit page grant even though the API would answer them.
  Known and deliberate; do not "fix" by loosening the backend instead.
- Desktop and mobile must change together (one shared file each) for: the
  stage pipeline (`stages.ts`), the sub-status list, stage labels, intake
  required fields (server guard is the source), enum option lists, the
  note-audience wording, the Order PO reader, `PATCH_FIELDS`, product
  category, the own-team leg markers (`inspection_by` / `pickup_by` /
  `delivery_by`) that gate the delivery-sheet sync, the Supplier Returns list
  (`components/assr/SupplierReturnsList.tsx` desktop, `MobileFactoryTrips` in
  `MobileServiceCase.tsx` mobile — shared logic in `assr/returns.ts`),
  survey-email fallback, SO typeahead, attachment upload, access
  gating, and the "a Sales rep may not edit" redirect
  (`auth/salesAccess.isSalesNonDirector`). Hand-copying any of these is what
  drifted before.

## Where the code is

- `frontend/src/pages/ServiceCases.tsx`, `frontend/src/pages/MyCases.tsx` —
  desktop list/detail/"my cases".
- `frontend/src/mobile/MobileServiceCase.tsx`,
  `frontend/src/mobile/MobileMyCaseDetail.tsx` — mobile (editable / read-only
  for a non-director Sales rep).
- `frontend/src/vendor/scm/lib/assr/stages.ts` — pipeline order (no words).
- `backend/src/scm/shared/assr-stage-labels.ts` +
  `frontend/src/vendor/scm/lib/assr-stage-labels.ts` — stage WORDS
  (byte-identical pair).
- `frontend/src/vendor/scm/lib/assr-sub-statuses.ts` +
  `backend/src/scm/shared/assr-sub-statuses.ts` — sub-status list.
- `backend/src/routes/assr.ts` — the ~50-endpoint router.
- `backend/src/services/assr.ts` — create/list/transition logic.
- `backend/src/services/assrVisibility.ts` — company + row visibility.
- `backend/src/services/assrStages.ts`, `assrSla.ts`, `assrEscalation.ts`,
  `assrOrderPos.ts` — open-stage predicate, SLA targets, escalation sweep,
  Order PO merge.
- `backend/src/routes/assr_print.ts` — the printable route.
- `backend/src/routes/assrFormIntake.ts`, `deliverySheetSync.ts`,
  `backend/src/lib/intake-company.ts` — pre-auth sheet/intake integrations.
