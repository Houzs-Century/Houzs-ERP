# Sales Order (SCM)

The customer order: start of the document chain (SO -> PO / DO -> SI), and the source of stock demand, commission and the AutoCount sales book.
Used by salespeople (desktop, phone, POS handover, scan-to-SO), purchasing (orders released by the Processing Date), logistics (DO conversion, delivery fee, amendments) and finance (payments, refunds, conversions).
Two companies share the tables: Houzs (company 1, `HC-` / bare numbers) and 2990 (company 2, `2990-`). Related guides: `so-amendment.md`, `so-handover.md`, `document-cancel-approval.md`, `document-status-vocabulary.md`, `delivery-order.md`, `mrp.md`, `autocount-writeback.md`.

## Statuses and flow

Header `scm.mfg_sales_orders.status` (vocabulary and guard: `backend/src/scm/lib/so-lifecycle-guards.ts`):
- Ranked: `DRAFT -> CONFIRMED -> IN_PRODUCTION -> READY_TO_SHIP -> SHIPPED -> DELIVERED -> INVOICED`. `CANCELLED`, `CLOSED`, `ON_HOLD` are unranked side states.
- `DRAFT -> CONFIRMED`: manual (Confirm, or a create not sent as a draft) and runs the confirm gate. Only a DRAFT can be deleted. The From-SO PO picker hides DRAFTs.
- `CONFIRMED <-> IN_PRODUCTION` follows the Processing Date. A header save that sets a date (null -> date) on a CONFIRMED order moves it to IN_PRODUCTION. Clearing the date on an IN_PRODUCTION order moves it back, unless a live DO or SI exists (`shared/so-proceeded-status.ts`, `lib/so-proceed-status-change.ts`).
- A manual `PATCH /:docNo/status` to IN_PRODUCTION needs a date, either on the order or `processingDate` in the body. Without one: 422 `proceed_needs_processing_date`. It never moves an existing date.
- `READY_TO_SHIP` is set automatically by `recomputeSoStockAllocation` (`lib/so-stock-allocation.ts`) on `is_ship_ready`, from CONFIRMED or IN_PRODUCTION. The same sweep moves it back to CONFIRMED when the order is no longer ship-ready.
- `DELIVERED` is set automatically by `lib/so-delivery-sync.ts` when every live line is fully delivered (from CONFIRMED / IN_PRODUCTION / READY_TO_SHIP / SHIPPED). An order at exactly DELIVERED drops to READY_TO_SHIP when it stops being fully delivered. Only DO / delivery-return write routes trigger it; import scripts never advance an SO.
- Automatic writers stand down while a person holds the save lock: line changes commit, and the header move waits for a later sweep.
- `SHIPPED` and `INVOICED` are manual only; nothing writes them automatically. The list has no Shipped tab: the Delivered tab covers SHIPPED + DELIVERED (`lib/so-tab-statuses.ts`), and an Other tab catches unknown values.
- `CLOSED` ("Close remaining") is manual only, never automatic. It stops chasing the undelivered remainder. What was delivered or invoiced stands and still earns commission.
- CLOSED can be entered from any live status and is one-way: a move back to any live status is 409 `illegal_status_transition` (CANCELLED is still allowed). It blocks new DO and PO lines (`SO_UNDELIVERABLE_STATUSES` = `SO_UNORDERABLE_STATUSES`, pinned equal by a test) and is terminal for MRP and allocation.
- `CANCELLED` needs an approved cancellation request with a reason (otherwise 403 `cancel_approval_required`), and is refused while a live DO or SI exists. A NON-migrated cancel is FINAL: any move off it is 409 `so_cancelled_final` (its full ERP cancel — deposit credit, PWP vouchers, stock release — is not unwound). A MIGRATED order (`linked_ac_docno`) CAN be reopened to CONFIRMED (owner 2026-09-18): the reopen claws back any deposit->credit refund (`reverseCancelledSoCredit` writes a negative `SO_REOPEN_CONTRA`) and pushes NOTHING to AutoCount, which has no un-cancel, so the ERP goes live while the book stays cancelled (reconciled by hand).
- `ON_HOLD` is retired as a status. `/status` refuses it as a target (409 `hold_is_not_a_status`) but accepts it as a source; `ON_HOLD -> DRAFT` is refused.
- Hold is now a marker (`on_hold`, `hold_reason`, `held_at`, `held_by`), set by `PATCH /:docNo/hold` (`routes/document-hold-routes.ts`). It never writes `status`.
- A hold blocks raising a DO (`soCanRaiseDo`), a PO (`firstUnorderableSo`), commission (`soEarnsCommission`) and the sales boards and reports. It does not block the automatic move to DELIVERED. The UI shows the status pill plus `HoldChip`; the On Hold tab overlaps the status tabs.
- Transition guard `soStatusTransitionError`: 400 `invalid_status` for an unknown target, 409 for a backward move not listed in `SO_LEGAL_REGRESSIONS`. A blank or unknown source is allowed through.
- `/status` refusals, in order: self-scoped ownership 404, non-migrated cancel-final 409 (a migrated cancel is reopenable), version CAS 409 (428 when no version is sent), edit lease 409, then the downstream lock (CANCELLED only).
- Nobody is offered a status that a machine derives. Right-click menu (`pages/scm-v2/row-menus.ts`): Open, Edit, Print for the SO and each of its DOs and SIs, Transfer to Delivery Order, Confirm (drafts), Put On / Take Off Hold, Close remaining (live orders), Request cancellation. Transfer to Delivery Order only shows when the order is deliverable, not held, and the caller may operate DOs.
- The pill is not the column. `soStatusDisplay` (`vendor/scm/lib/so-status.ts`) shows the stored CANCELLED / CLOSED / ON_HOLD first; otherwise `lifecycle_state` (latest DO / SI / return by business date, `computeSoLifecycle`); otherwise `delivery_state` partial/full; otherwise the stored status.
- Tabs, counts and the status filter read the stored column. The list Status cell (`SoListStatusCell.tsx`) shows the derived label, plus a marker when it differs from the stored status.
- `IN_PRODUCTION` is labelled "In Production" everywhere (`vendor/scm/lib/status-pill.ts`). PDFs use `statusLabel('so', ...)`.

Line and derived states:
- `mfg_sales_order_items.stock_status` (stored `READY` / `PARTIAL` / `PENDING`) is written by the global allocation sweep. SERVICE lines start READY; delivery sync forces delivered lines to READY.
- `stock_state` (live, computed per request by `computeMrp`): `stock` / `po` / `shortage` / `null`. SERVICE is always `stock`. SOFA is `stock` when the stored value is READY, otherwise MRP `po` / `shortage`. Other lines follow MRP.
- `stock_status_effective` (`lib/so-line-effective-stock.ts`) is what the list and detail show. A stored READY wins. PENDING/PARTIAL become READY only when the live value is `stock`, the order has a Processing Date, and the line is not hard-bound. A non-selling warehouse forces PENDING. With no live value, the stored value stands.
- `stock_remark` (`summariseReadiness`, `lib/so-readiness.ts`) names what IS ready: `''`, `READY`, `PARTIAL` (all main lines in, an accessory pending), or `BEDFRAME` / `SOFA` / `MATTRESS` / `ACC`, `/`-joined in that order. It never contains READY while anything is short.
- The ship gate is `is_ship_ready`: every main line ready if the order has one, otherwise every live line; a line-less SO is never ready. Accessories don't block when a main line exists, service-only orders are ready at once, and fully delivered lines count but gate nothing.
- Stock Status column = arrival. Delivered column = `shipped_qty / deliverable_qty` (`vendor/scm/lib/shipped-progress.ts`); a missing figure shows as unknown, never 0.
- `fair_match`: `PICKED`; `PENDING` (the daily pass links it); `AMBIGUOUS` (settle on `/scm/fair-pending`); `UNMATCHED`; NULL = created before the picker, not back-filled.

## Permissions

- `scm.sales.orders`: area guard for `/api/scm/mfg-sales-orders/*`.
- `scm.so.view_all`: see every order in the company. Without it a rep sees their own orders plus their reporting downline (`lib/salesScope.ts`, `canViewAllSales` in `lib/houzs-perms.ts`), plus orders shared with them or flagged `open_to_all`.
- `scm.so.attribute_other`: create an order for another salesperson, or reassign `salesperson_id`. The server enforces it on header PATCH (403 `forbidden_attribute_other`). On a hard-locked order, Edit opens with only the Salesperson field live.
- `scm.so.remove_processing_date`: clear a Processing Date (otherwise `processing_date_remove_forbidden`).
- `scm.so.price_override`: the audited `POST /:docNo/items/:itemId/override` and admin backfill routes. Normal line pricing is gated by session type, not by this key.
- `scm.so_payment.amend`: Finance may edit or delete a payment after its same-day window (never a reconciled one). A role that holds this key literally must give a reason on every payment action (`lib/so-payment-reason.ts`).
- `scm.amendment.create`: raise an SO amendment (Sales-org users and lane approvers may also raise one).
- `scm.amendment.approve_lines` (Purchaser lane), `scm.amendment.approve_delivery` (Logistic lane), and `scm.amendment.approve_price` (Finance / Kris — the 2990 price-only lane), mapped in `LANE_APPROVE_KEY` (`shared/amendment-lane.ts`). `scm.amendment.approve_so` is the legacy fallback; `scm.amendment.approve_po` is for the PO side.
- `*` / `scm.admin`: bypass the write freeze and the migrated-order lock.
- On the client, the line price input is editable when `isAdminLevel || isHatchSales` (the bridge sets `isHatchSales` for `sales` and `super_admin`).

## Rules that must not break

Locks
- Per-line freeze (HARD): a line named by a live DO or SI line (DRAFT counts) cannot be edited, deleted, TBC-filled, price-overridden or amended (409 `so_line_frozen`). Other lines, new lines and dates stay open (`shared/so-line-freeze.ts`, `readSoLineFreeze` in `lib/downstream-lock.ts`).
- Whole-order freeze: new lines are blocked when every live line is frozen, or when any live DO/SI line names no SO line (409 `so_has_downstream`; amendment submit `so_hard_locked`). The payload flags `downstream_frozen` per line and `downstream_fully_frozen` on the header; desktop and phone grey out frozen lines.
- Identity lock (`shared/so-identity-lock.ts`): any live DO or SI blocks cancel and changes to the snapshotted header columns (customer, addresses, contact, currency). Dates, note, payments and salesperson stay editable. This matches AutoCount, which refuses edits to transferred documents.
- Frozen lines are skipped by the header Delivery Date / State cascades (`apply_so_header_cas`, `applySoAmendment`, the client cascades), by the free-gift reconciler and by the delivery-fee rebuild.
- Processing-date lock (SOFT, `soProcessingLocked`): once `processing_date` is before today (MYT) and the status is not DRAFT/CANCELLED, CONTROLLED header fields and line changes must go through an amendment (409 `so_locked_processing`). FREE fields (name, phone, email, note) still save directly (`shared/so-field-policy.ts`).
- PO-raised lock (SOFT, `lib/so-po-lock.ts`) applies only to `2990-` orders: once a live PO (DRAFT counts) covers any line, edits go through an amendment. Houzs orders are never PO-locked.
- Every lock fails closed when its read fails (`downstream_check_failed`). A failed read never counts as zero.
- The save lock covers one save and lasts 60 s (`SO_EDIT_LEASE_MS`, `lib/so-edit-lease.ts`). The holder is recorded and can reclaim their own lock; the refusal says held, expired or missing. Keep it: version CAS cannot see a half-applied multi-request save.
- Status CAS: `useUpdateMfgSalesOrderStatus` sends `{status, version, expectedStatus}`. `expectedStatus` is a required value from the caller (what the operator saw), or `null` when unknown. Never take it from the query cache.
- `DELETE /:docNo` works only for a DRAFT (409 `so_not_draft`) with no live downstream document and no payment (409 `so_has_payments`, `soDiscardBlocked`). Every other order is cancelled.

Validation
- Confirm gate (`lib/so-confirm-gate.ts`), run on DRAFT -> live and on any create not sent as a draft. It requires: every live line in the company catalog; a salesperson (`salesperson_id`, or `agent` text that `resolveAcAgent` accepts); a venue. Returns 422 `validation_failed` listing every problem. It does not check variants.
- Catalog-only lines, on every insert path: unknown code -> 409 `unknown_item_code`; an inactive code on a new pick is refused; blank code with typed text -> 409 `so_free_text_line`; a fully blank placeholder line is allowed on DRAFTs only.
- Processing-Date gate (`collectProcessingGateProblems`, `shared/so-save-problems.ts`) runs whenever a date is set or changed: required variant axes present; no colour-KIV line (`fabric_colour_kiv`); customer name, address line 1, postcode and delivery date filled; no newly entered past dates; processing date <= delivery date. One 422 lists every problem. There is no deposit condition.
- Required axes (`REQUIRED_VARIANT_AXES_BY_CATEGORY` in `shared/so-variant-rule.ts`, with an identical copy under `vendor/shared`): bedframe needs divan, leg, gap, fabric; sofa needs seat, fabric; Sofa Accessory (`fabric_accessory`) needs fabric only.
- Exemptions by item code: DIVAN ONLY skips gap; divanless frames (ADJUSTABLE, (S+S), DOUBLE DECKER, DDB) skip divan, leg and gap; CONSOLE/CT compartments skip seat. `itemCode` stays a required argument.
- Both dates or neither (`soDatePairRefusal`, `shared/so-processing-date.ts`) on every write path (400 `processing_delivery_must_pair`). Saves that leave legacy unpaired dates untouched still pass. Clearing the Processing Date also clears the header and line delivery dates; clearing only the delivery date is refused.
- "Cleared" means the key is present with a null value (`effectiveDateAfterPatch`). Never test it with `typeof === 'string'`.
- A SOFA line may not share an order with a BEDFRAME or MATTRESS line (`lib/main-mix.ts`). Create checks the whole order; edit paths check whether the change introduces the mix (400 `so_sofa_no_other_main`; 409 `sofa_mix_check_unavailable` when the read fails). Client checks: `hasSofaMixConflict` (new orders), `sofaMixIntroduced` (edits).
- HOUZS orders need a derived stock location before an AutoCount create is queued (`lib/so-location-gate.ts`), on a live create and on DRAFT -> live. Errors: `so_state_required` / `so_state_unmapped`. Drafts are exempt. Client twin: `soStockLocationError`.
- Address lines are capped at 40 characters. Inputs spread `addressLineProps` (`frontend/src/lib/acColumnWidths.ts`: the cap plus a word-boundary paste spill into the next line). On the server, `fitSoAddress` re-packs only an overflowing address, fitting all four lines together.
- Setting a Processing Date makes the delivery address required on every create/edit surface: address line 1, postcode and a delivery date; State only for a stock-location company (HOUZS, via `so-location-gate`), never City. Mobile used to demand State+City for every company and refused orders the server accepts — removed, so phone, desktop and server agree.
- Client save/proceed pre-flight is ONE shared evaluator, `collectSoSaveProblems` (`vendor/scm/lib/so-save-problems-client.ts`): it returns the FULL blocker list (required fields, completeness, per-line variant/size/fabric, dates, sofa mix, location, payments), and every create/edit surface — desktop `SalesOrderNew`, mobile `MobileNewSO`, `SalesOrderNewGuided`, `SalesOrderNewFromProducts` — renders it in the same `SaveProblemsList` popup the server's 422 uses, so all reasons show at once on all of them. Its overlapping gates are pinned to the backend's wording (`so-save-problems-client.parity.test.ts`). The `SalesOrderDetail` editor's Save + Submit-amendment use the detail-shaped wrapper `collectSoEditSaveProblems` (phone, variant gaps once a Processing Date is set, sofa mix, blank line/add, the header date fault), delegating name/address/venue/salesperson/location to the server (shown via `notifySaveProblems` on the PATCH); `MobileSODetail` is read-only + amendment actions, so SO-field editing is `MobileNewSO`.
- Venue: `venue: ""` sent beside a real `venueId` is not a clear (`venueNameForHalfWrittenPair`, `lib/venue-binding.ts`); if the venue master can't be read, the venue is dropped from the patch; to clear, send both empty. `venue_id` holds only UUIDs (`venueIdUuidOrNull`), so clients send the venue text. A trigger canonicalises the stored venue, so check writes against `scm.canonicalize_venue(...)`.
- Fair picker (`frontend/src/components/FairPicker.tsx`) on all three SO forms: pick place + organizer, no free text; brand comes from the SKUs. A row reads `VENUE — ORGANIZER (13/08 - 17/08)` — dates on EVERY row since 2026-09-19, part of the pick and not decoration. The period is `fmtDayMonthRange` (`shared/format.ts`, mirrored both sides and refereed byte-for-byte by `format.date.canonical.test.ts`): the house `DD/MM` with the **year dropped**, because the list only spans the 28 days behind the order date. One day renders as `13/08`. Do NOT respell it with a month name — `check-date-formatting.mjs` fails the build, and the owner chose this shape over `Aug 13 - 17` when offered both; a solo roadshow (event type `solo`) reads `VENUE — SOLO` while the pick still carries the real organizer. Changing the venue on header PATCH resets the fair link to PENDING.
- Fair list window (2026-09-19): **28 days back from the order date, inclusive, never forward** (`lookbackWindow`, `scm/lib/fair-options.ts` — the pure module owns it and the SQL imports it). Two groups: `running` (period contains the order date) and `earlier` ("Recently closed (last 4 weeks)", newest first). A fair that has not started is never offered. An **archived** project is never offered either, on any of the four SCM reads — the picker, the save-time resolver, the automatic venue default and the settle-by-hand guard.
- A pick sends `venue` + `fairOrganizer` + `fairStart` + `fairEnd` from the two CREATE forms, and the server matches that exact occurrence (`loadFairsForEvent`) inside the company predicate; a client `project_id` is still never trusted. Nothing re-checks the order date against the fair's period — an order written up after its fair closed is a normal, attributable order, and `so_date` against the project's start/end is what marks it. `POST /:docNo/fair` no longer answers 409 `fair_not_running_on_so_date`; that error is retired. The EDIT screen sends a place only (`startDate: null`), so editing the fair there still drops the link to PENDING for the nightly reconcile.
- The server mints `doc_no` and recomputes pricing. Money travels as `*_sen` integers.

Pricing
- Line price trust depends on the session. A POS PIN session (`origin='pos'`) is rejected (400) if its price drifts from catalog. Every other session (desktop, phone, SSO from the tablet) keeps the typed price. Cost is always a server snapshot.
- `erpLineTrust`: a price of 0 persists only with `zeroPriceIntended`, sent via client `zeroPriceClaim(unit, authored)`. `authored` is required and is false for unpriced SKUs and sofa builds. Imported orders use `'including-zero'`. ADD lines pass `soIsMigrated=false`.
- "Migrated" means the order came FROM AutoCount: `soIsMigratedShape(doc_no, linked_ac_docno)` (`lib/so-is-migrated.ts`; select both columns; fails closed). A set `linked_ac_docno` alone does not make an order migrated.
- Surcharges never change a typed or imported price. On catalog-priced lines, priced add-ons are charged, sofas included. `specialAddonsSurchargeSen` is not wired yet but POS clients that submit prices will need it; keep it.
- An approved amendment price persists only with the approval receipt (`SoAmendmentApproval`, a required argument of `applySoAmendment`). An edited line keeps RM 0; an ADD line at 0 takes the catalog price; a migrated line keeps its stored price. Amendment lines carry `new_discount_sen`.
- The delivery fee is always `SVC-DELIVERY*` lines, written only by `scm.rebuild_mfg_so_delivery_lines` via `lib/so-delivery-fee-rebuild.ts`. The rebuild takes an advisory lock, updates rows in place (DOs link to them), checks for concurrent changes (`p_expect_state`), and after 3 attempts writes nothing. Only the POS handover sends `applyDeliveryFee`; a fee typed in the ERP is a plain unit price.
- To lower a fee, use its line discount: the amount cell stores the typed target as `discountSen` (`vendor/scm/lib/delivery-fee-amount.ts`, mode fixed per mounted line). Raising a fee needs an `SVC-DELIVERY-ADD` line. A blank box writes nothing; type 0 to waive. Keep the output order of `buildDeliveryFeeServiceLines` stable, because rows are matched by position.
- Every product read by `code`, `base_model`, `sku_code` or `barcode` passes `companyId`, because codes collide across companies. `validateItemCodes` and `findServiceLineCodes` take it as a required argument. `item_group` comes from the company catalog; never fall back to `'others'`.

Company scope
- `doc_no` is not a tenant key: every `/:docNo/*` child read uses `scopeToCompany`, and salesperson-tier routes call `selfScopedSalesBlocked(c, docNo)`.
- A NULL company means Houzs to the customer-resolve RPC. Create and header PATCH use `requireActiveCompanyId` (409); never pass `?? null`.
- `pwp_codes` is keyed `(company_id, code)`. Every claim, rollback, exchange, re-stamp and kept-code read carries the company (409 `company_unresolved` when it is unknown). Never widen to all companies.
- Only `so-stock-allocation.ts` and `resolveDoSofaBatchMap` read the catalog without a company filter, and only to classify categories.
- Allocation split (`HARD_BOUND_COMPANY_ID = 1`): Houzs bedframe, sofa, (SP) mattress and Sofa Accessory lines are allocated only from their own PO receipt (sofas try a covering dye lot first). 2990 tries the dedicated PO, then pooled FIFO by (warehouse, code, variant).
- No Processing Date means no allocation: lines stay PENDING (`allocGated` reads only `processing_date`).
- Stock in non-selling warehouses (showroom, display, service; `lib/non-selling-warehouse.ts`) is never allocated. To sell a display piece, stock-transfer it to a selling warehouse first.
- The warehouse follows the order: header `sales_location` (plus a `warehouse_id` snapshot), resolved by `lib/so-warehouse.ts`. A line with no warehouse uses the header's in MRP. Create default: explicit Location, then State mapping, then the operator's own store. A goods line saved without a warehouse logs `[null-warehouse]`.
- MRP and the allocator rank orders by effective delivery date (`shared/effective-delivery.ts`), then `doc_no`.
- `salesperson_id` is the only attribution (commission, PDF, AutoCount). `collaborator_staff_ids` (-> trigger-built `access_staff_ids`) and `open_to_all` only widen who can see the SO (`applySoScope`). DO, SI and reports still filter on `salesperson_id`.
- The salesperson is always a real `scm.staff` row. `soAgentToStamp` (`lib/so-agent.ts`) fills `agent` from the staff name on create and updates it on reassignment.
- On the client, identify the current user with `resolveSelfStaff` (`vendor/scm/lib/self-staff.ts`). Never use `useAuth().staff` from the vendored bridge; only its `role` is set.

AutoCount and integrations
- Every SO mutation queues an AutoCount edit on the response path. Don't move it to `waitUntil` until a check exists that matches audit-log mutations to outbox rows.
- The customer reference goes to AutoCount `Ref` (`ref`, else `customer_so_no`), never to `UDF_ToPONo`.
- The Processing Date goes out as UDF `PDate` (`SO_PROCESSING_DATE_AC_UDF`). Never rename it.
- A payment sends only `UDF.BALANCE` / `UDF.PAYEMENT` (`enqueueSoPaymentEdit`, `lib/ac-so-payment-edit.ts`). AutoCount is push-only.
- Balance = `soBalanceSen` (`shared/so-outstanding.ts`): `total_revenue_sen` if > 0, else `local_total_sen`, minus paid; it can be negative. The write-back clamps it at 0.
- Create returns `acNotSent` problems when the AutoCount write-back refuses the order (dialog: `vendor/scm/lib/ac-not-sent.tsx`). Mobile, POS and DRAFT -> live don't show it yet.
- `enqueueSoCreate` turns a `MissingLocationError` into a `skipped` outbox row.
- The 2990 receiver `POST /api/sync/so-mirror` (`routes/so-mirror.ts`, shared secret) imports each order once. An existing doc returns 200 `skipped_existing`; a delete of an existing doc returns 200 `refused_delete`. Every refusal is a 200. Declines are recorded in `scm.so_mirror_skips`.
- The migrated-order lock `scm.migrated_so_lock` is off by owner ruling: imported orders edit like new ones. Its guard (`lib/migrated-so-readonly.ts`, 409 `so_migrated_readonly`) is still mounted on `/mfg-sales-orders/*` and `/so-amendments/*`. Turning it back on needs a new ruling.
- Cancel settles PWP vouchers (`lib/so-cancel-vouchers.ts`): vouchers issued by the SO -> VOID; vouchers redeemed on it -> AVAILABLE; issued here but redeemed elsewhere -> 409 `pwp_voucher_redeemed_elsewhere`. It runs in `runScmPgCommand` (503 `scm_pg_command_required` without `DATABASE_URL`).
- Money left on a cancelled order is computed, not stored (`orderMoney`, `lib/so-money.ts`). Refund raises a draft Customer Refund voucher. Convert books a `converted` payment row with `convertedFromDocNo` on the new order, after `convertGuard`. Converted rows can be deleted but never PATCHed. Desktop and phone share `OrderMoneyPanel`.
- Payment writers (`lib/so-payment-row.ts`) re-roll linked invoice statuses and book to the GL best-effort (create deposits book too). An edit reposts, but only amount, paid_at, method and merchant change the books.
- `paymentMayChange` (`backend/src/acc/payment-reconciled.ts`) decides payment edits: reconciled -> nobody; same day -> whoever keyed it; otherwise `scm.so_payment.amend`. It fails closed.
- A slip is optional on every payment path. Writers filter drafts by amount only. An upload session that is claimed but doesn't resolve is 400 `slip_required`.
- Payment methods: Merchant, Online and Cash are selectable; `Installment` is kept for history. Pickers read `scm.so_dropdown_options` via `optionsOrFallback`. An edit starts from the stored row exactly as saved.
- Doc numbers: counter `scm.next_doc_no_n` (atomic; never below the current live max). A cancelled order keeps its number, and deleted numbers are never reused. `insertWithDocNoRetry` retries up to 8 times, or once when a PWP code was claimed.

Desktop / mobile parity
- Desktop (`SalesOrderNew`, `SalesOrderDetail`) and phone (`MobileNewSO`) share one module each for: variant cascade, address cascade, `FairPicker`, `so-form-validate.ts`, `so-amendment-submit.ts`, `fabric-pool.ts`, `special-order-surface.ts`, `zeroPriceClaim.ts`, `self-staff.ts`, `line-write-failures.ts`.
- Every surface that shows the per-line Stock or Incoming PO cell (detail, list drill-down, the list quick-view drawer, `MobileSODetail`) must call `GET /:docNo/coverage` and merge the result with `vendor/scm/lib/so-coverage-overlay.ts`, so the coverage-healed verdict is what renders. An empty overlay leaves stored values alone. The quick-view drawer shows the Stock pill only (not the Incoming PO chips), but shares the same overlaid data path as its drill-down twin so the two cannot disagree.
- A cell filled by a second query shows WORKING... while loading and NOT LOADED on failure, never `STOCK` or a dash.
- On SO surfaces the variant cascade is sofa-only (`CASCADE_CATEGORIES`). The first line's latest change overwrites the follower lines; blank follower values get filled; anything else stays. `remark` and `buildKey` are never copied.
- The sofa Leg Height default (`seedSofaLegDefault`, a required prop) is true on SO and Consignment Order forms and false on DO, returns, consignment notes and SI, because it changes the stock bucket.
- Fabric pools: an empty `allowed_options.fabrics` means no restriction; entries may be series or colours; compare only through the shared helpers. `GET /fabric-colours` removes retired series/codes and applies the model pool before its row cap, so pickers must send `itemCode`.
- Special Order panel (`vendor/scm/lib/special-order-surface.ts`): checkboxes only for sofa, bedframe, mattress and fabric_accessory. Accessory and other lines get free text only, because a tick changes the stock bucket. `variants.specialsRecorded` is display-only and never priced.
- 403/409 refusals must reach the operator with the server's reason and no retry advice (`line-write-failures.ts`, `photo-upload-failures.ts`).
- Line discount input (`DiscountInput` in `SoLineCard`): `1000` means RM 1,000, `25%` means a percentage; limited to 0..qty x unit price; disabled on delivery-fee lines.

## Gotchas

- The status filter reads the stored column; the pill reads the lifecycle, so a CONFIRMED order with a DO shows "Delivered". Read both; don't merge them into one.
- `stock_status` and `stock_state` come from different engines. Render `stock_status_effective`, never either input alone.
- `is_main_ready` is true when the order has no main line at all. Gate on `is_ship_ready`.
- `proceeded_at` is retired and waiting to be dropped: add no readers. Use `processing_date` via `SO_PROCESSING_DATE_COLUMN` (`.mjs` scripts: `backend/scripts/lib/so-processing-date.mjs`), never a string literal.
- The Processing Date releases the order to purchasing. There is no production scheduling; MRP orders by delivery date minus lead days.
- Don't remove `target_date` (the POS still writes it), don't rename `PDate` / `ac_udf_pdate`, and don't join `sales_entries` rows to SOs.
- Don't add a deposit condition back into the Processing-Date gate. `proceedGateFailures` / `soProceedGateBlocked` have no callers but still contain one, so don't reuse them on a new path.
- Don't put variant completeness back into the confirm gate; it belongs in the Processing-Date gate.
- Never stamp a Processing Date on confirm or on scan drafts; drafts are created without dates.
- The right-click Reopen on a cancelled row reopens a MIGRATED order to CONFIRMED (claws back the deposit credit, no AutoCount push); a non-migrated one is refused (`so_cancelled_final`) — create a new SO and use Convert to carry the money over.
- Hard delete stays DRAFT-only. Test orders go through `backend/scripts/delete-test-so.mjs` (run plan mode first), and the AutoCount copy must be cancelled by hand.
- Deleting an SO line silently nulls `so_item_id` on PO, DO and SI lines. Any delete-and-reinsert must snapshot the links and relink by (code, colour) via `lib/so-line-relink.ts`, reporting links it had to drop.
- The SO -> PO line link decides batch binding at ship time and COGS. A sofa set that ships short must resolve to one PO (`sofa_set_po_split`).
- Never hand a doc number back to the pool (a reused number once collided with AutoCount). `backend/scripts/reclaim-doc-no.mjs` is the only tool that does this, and it refuses `HC-` series.
- `doc_no` foreign keys are ON UPDATE NO ACTION and most child tables cascade on delete, so an UPDATE rename fails. Rename only with `backend/scripts/renumber-sales-orders.mjs`.
- VIEW-TRAP: `mfg_sales_orders_with_payment_totals` lists its columns explicitly. Add a new header column to the view before putting it in `HEADER`, or the list 500s. Keep `linked_ac_docno` out of `HEADER`. Dropping the view must CASCADE and re-create the three list line-filter functions.
- The header `balance_sen` is not a balance, and the header has no `total_sen`. Use `soBalanceSen` / `deriveBalance` and `local_total_sen`.
- `mfg_so_audit_log` joins on `so_doc_no`; `mfg_sales_order_items` joins on `doc_no`.
- `actor_id` is the same pinned uuid for every SCM caller. System rows are those with `actor_name_snapshot ILIKE 'system%'` (`shared/audit-author.ts`).
- Inside `/api/scm/*`, `user.id` is the scm.staff uuid. Use `houzsUser.id` for bigint columns.
- The "Created by" list filter reads `salesperson_id`, because `created_by` holds the bridge's system uuid.
- `?status=all` means no filter (`effectiveStatusFilter`). A page past the end returns an empty page with the real count. A failed status-count read returns 500 `status_counts_failed`, never zeros.
- List search must cover every field the Reference column can show (`ref`, `customer_so_no`).
- Stored `stock_status` goes stale after best-effort triggers. An unfinished sweep queues a retry row, but a Worker that dies before the sweep leaves nothing. New routes should use `scheduleStockAllocationAfterCommand`.
- Photos: `/photos/:key/signed` can't sign in production, so use `useSoLinePhoto` / `useScmLinePhoto`. Migrated sofa photos sit on the first compartment only, by design. Never store the R2 token as an Actions secret (the repo is public).
- `description2` is rebuilt from variants on every edit. AutoCount's original line text lives in `remark` under `账本原文: `; don't add a second place for it.
- A migrated order's city may be blank. AutoCount `InvAddr4` holds the State; never copy it into city.
- `ac_to_po_no` is AutoCount's list of POs raised from the order, not a customer PO. The AutoCount-mirror header columns (`attention`, `delivery_address1..4`, `display_term`) have no reader or writer in the app.
- A header branding of `NONE` / `N/A` / blank is a placeholder (`isPlaceholderBrandText`). The sofa label is the company house brand (ZANOTTI / 2990s Sofa). The PDF letterhead lookup is per company (`lib/brand-letterhead.ts`).
- Floating pickers use `frontend/src/lib/anchoredPanel.ts`, which sets both `top` and `bottom`. Don't hand-roll `top: rect.bottom + 4`.
- Amendments: a new line field must add the signature entry, payload, column, `applySoAmendment` write and every reader together. The direct half drops amendable keys (`withoutFrozenHeaderFields`) rather than reverting them. `DIRECT_ONLY` skips only the amendment. Line delivery date, description, uom, item group and cost cannot be changed on a locked SO.
- `POST /:docNo/amendments` requires a reason (400 `reason_required`). Header keys go to the Logistic lane, product lines to Purchaser, service lines to Logistic. Each lane gets its own notice. A line whose every requested value equals the stored line is dropped before the split (`lib/amendment-noop-lines.ts`, 2026-09-16) — the phone used to send one per remarked line and open an empty Purchaser approval (`docs/bugs/0944`).
- Leaving `?edit=1` must clear the URL (`returnToDetail` with replace). Submitting an amendment keeps the editor open.
- History drawers must pass `q.error`, so a failed read never shows "No history yet".
- `tests-pg` fixtures must use production column types. Backend typecheck does not cover `tests-pg/`.
- Venue picker (`frontend/src/components/FairPicker.tsx`): a place already on the order is shown as itself, never as "Others"; "Others — pick a place instead" is an action, not a value.
- Save lock: a header PATCH carrying the save's lease token with nothing left to write releases the lock and returns `version`; the same person takes their own lock back instead of waiting.
- The list search is one PostgREST `.or()` built once in `backend/src/scm/lib/so-list-read.ts` (`prepareSoListRead`) and shared by the page rows, the money strip and the line export (`GET /api/scm/mfg-sales-orders/export/rows`); never hand-copy it.

## Where the code is

- Endpoints: see `docs/generated/route-capability-matrix.csv`.
- Main router: `backend/src/scm/routes/mfg-sales-orders.ts`, mounted in `backend/src/scm/index.ts`. The list MRP enrichment router `backend/src/scm/routes/mfg-sales-orders-list-enrichment.ts` is mounted ahead of `/:docNo`.
- Other routes in `backend/src/scm/routes/`: `mfg-so-fairs.ts`, `so-money-routes.ts`, `so-amendments.ts`, `so-mirror.ts`, `document-hold-routes.ts`, `document-cancel-routes.ts`.
- Status and locks, `backend/src/scm/`: `lib/so-lifecycle-guards.ts`, `lib/downstream-lock.ts`, `shared/so-line-freeze.ts`, `shared/so-identity-lock.ts`, `lib/so-po-lock.ts`, `shared/so-field-policy.ts`, `lib/so-edit-lease.ts`, `lib/migrated-so-readonly.ts`, `lib/so-is-migrated.ts`.
- Gates, `backend/src/scm/`: `lib/so-confirm-gate.ts`, `shared/so-save-problems.ts`, `shared/so-processing-date.ts`, `shared/so-proceeded-status.ts`, `lib/so-proceed-status-change.ts`, `shared/so-variant-rule.ts`, `lib/main-mix.ts`, `lib/so-location-gate.ts`, `lib/venue-binding.ts`, `lib/validate-item-codes.ts`.
- Stock and readiness, `backend/src/scm/`: `lib/so-stock-allocation.ts`, `lib/so-delivery-sync.ts`, `lib/so-readiness.ts`, `lib/so-line-effective-stock.ts`, `lib/source-po-trace.ts`, `lib/so-list-mrp-enrichment.ts`, `lib/so-warehouse.ts`, `lib/non-selling-warehouse.ts`, `shared/so-deliverable-states.ts`, `lib/source-document-gates.ts`.
- Pricing, fee and amendment apply, `backend/src/scm/`: `lib/mfg-pricing-recompute.ts`, `shared/pricing.ts`, `shared/service-lines.ts`, `lib/so-delivery-fee-rebuild.ts`, `lib/so-revision.ts`, `shared/amendment-lane.ts`.
- Money: `backend/src/scm/lib/so-payment-row.ts`, `so-money.ts`, `so-cancel-vouchers.ts`, `so-create-payment-slips.ts`, `so-payment-reason.ts`; `backend/src/scm/shared/so-outstanding.ts`; `backend/src/acc/payment-reconciled.ts`, `payment-repost.ts`.
- AutoCount: `backend/src/scm/lib/autocount-outbox.ts`, `ac-so-payment-edit.ts`, `ac-preflight.ts`; `backend/src/services/autocount-writeback.ts`, `autocount-address-fit.ts`.
- List, filters, scope and fairs, `backend/src/scm/`: `lib/so-list-query-filters.ts`, `shared/so-list-filter-model.ts`, `lib/so-list-filters.ts`, `lib/so-tab-statuses.ts`, `lib/salesScope.ts`, `lib/so-list-approval-codes.ts`, `lib/fair-options.ts`, `lib/fair-binding.ts`, `lib/fair-reconcile.ts`.
- Desktop pages, `frontend/src/pages/scm-v2/`: `MfgSalesOrdersListV2.tsx`, `SalesOrderDetailV2.tsx` (routes to the `SalesOrderDetail.tsx` editor on `?edit=1`), `SalesOrderNew.tsx`, `SalesOrderNewFromProducts.tsx`, `row-menus.ts`, `so-list-status.ts`, `SoListStatusCell.tsx`, `SoListFilterBar.tsx`, `FairPending.tsx`.
- Phone, `frontend/src/mobile/`: `MobileSalesOrders.tsx`, `MobileNewSO.tsx` (one form for new and edit), `MobileSODetail.tsx`, `RecordedPayments.tsx`, `MobileOrderMoney.tsx`, `source-chips.tsx`, `MobileSoFilterSheet.tsx`.
- Shared client rules, `frontend/src/vendor/scm/lib/`: `sales-order-queries.ts`, `so-status.ts`, `status-pill.ts`, `so-detail-gates.ts`, `so-form-validate.ts`, `so-amendment-submit.ts`, `so-amendment-line-diff.ts`, `so-amendment-header.ts`, `so-coverage-overlay.ts`, `so-variant-cascade.ts`, `address-cascade.ts`, `shipped-progress.ts`, `special-order-surface.ts`, `self-staff.ts`, `zeroPriceClaim.ts`, `delivery-fee-amount.ts`, `so-line-photo.ts`, `sales-order-pdf.ts`, `pdf-item-photos.ts`, `authed-fetch.ts`.
- Rules shared by backend and frontend (backend copy under `backend/src/scm/shared/`), `frontend/src/vendor/shared/`: `so-variant-rule.ts`, `so-deliverable-states.ts`, `total-height.ts`, `fabric-pool.ts`, `so-list-filter-model.ts`.
- Components: `frontend/src/vendor/scm/components/` (`SoLineCard.tsx`, `PaymentsTable.tsx`, `OrderMoneyPanel.tsx`, `HoldChip.tsx`, `SaveProblemsList.tsx`, `SpecialOrders.tsx`); `frontend/src/components/` (`SoSourceChips.tsx`, `StockRemarkPill.tsx`, `ShippedProgressPill.tsx`, `FairPicker.tsx`); `frontend/src/lib/` (`acColumnWidths.ts`, `soPoChips.ts`, `soListEnrichment.ts`).
- Tables: `scm.mfg_sales_orders`, `scm.mfg_sales_order_items`, `scm.mfg_sales_order_payments`, view `scm.mfg_sales_orders_with_payment_totals`, `scm.so_amendments`, `scm.so_amendment_lines`, `scm.mfg_so_audit_log`, `scm.doc_number_counters`.
- Ops scripts, `backend/scripts/`: `delete-test-so.mjs`, `reclaim-doc-no.mjs`, `renumber-sales-orders.mjs`, `repair-proceeded-status.mjs`, `check-so-noncatalog-lines.mjs`, `check-so-fee-line-integrity.mjs`.
