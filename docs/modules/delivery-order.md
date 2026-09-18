# Delivery Order

The sell-side document that takes goods out of stock: raised from Sales Order lines (SO → DO → SI; Delivery Return is the reversal branch), tracked through loading, transit and delivery, and printed as the paper that travels with the lorry.
Office and operations staff work it on desktop and phone; storekeepers and drivers move it by scanning the printed QR (no login) or through Mobile POD; sales staff may view and print DOs raised from their own orders.
Money is integer sen; dates are stored UTC and shown DD/MM/YYYY.

## Statuses and flow

- Enum `scm.do_status`, declared once in `backend/src/scm/shared/do-shipped-states.ts` (vendored twin in `frontend/src/vendor/shared/`): DRAFT, LOADED, DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED, INVOICED, CANCELLED.
- Screen words: LOADED reads **Confirmed**, DISPATCHED reads **Loaded** (goods on the lorry), SIGNED folds into Delivered permanently, INVOICED is written by nothing.
- Create with `asDraft: true` → DRAFT (no stock). Any other create — including `POST /from-sos` with `asDraft` omitted — is born LOADED: stock OUT, SO delivered quantities synced, customer email sent. `body.status` is ignored on create.
- DRAFT → LOADED (Confirm: office button, row menu, phone, scan) writes the inventory OUT. The OUT fires on the first entry into any `DO_SHIPPED_STATES` member (LOADED … INVOICED) and never again.
- LOADED → DISPATCHED → IN_TRANSIT → DELIVERED record progress only, no stock. Moved by the QR scan ladder (one rung per scan), the list row menu (Mark Loaded / Mark In Transit / Mark Delivered, only on stock-out states), the phone action bar (Confirm Loaded, Mark In Transit), and Mobile POD (DELIVERED with signature / photo / GPS).
- Nothing writes SIGNED (the scan ladder's type forbids it); there is no Mark signed or Mark Invoiced control.
- CANCELLED: offered on any status but CANCELLED / INVOICED, needs a reason, reverses the stock, refused while a live SI or DR exists; final — every transition out refuses `do_cancelled_final`; re-deliver with a new DO.
- The status PATCH refuses stock-out → DRAFT (`illegal_status_transition`); DISPATCHED → LOADED is allowed. Revert (`POST /:id/revert`, reason required) is the only way from LOADED back to DRAFT and returns the stock; refused with a live SI or DR.
- Hold is a marker (`on_hold`, `hold_reason`, `held_at`, `held_by`; `PATCH /:id/hold`), never a status: the DO keeps its stage, shows a Hold chip and appears in the overlapping On Hold tab.
- Counts as delivered and as invoiceable: every status except DRAFT and CANCELLED (`doCountsAsDelivered`, `DO_NOT_INVOICEABLE_STATES`). Owner rule: never block invoicing a Confirmed (LOADED) delivery.
- List tabs: one per status from `DO_STATUS_BUCKETS` (`backend/src/scm/lib/do-status-buckets.ts`) plus On Hold. KPI "On the road" = DISPATCHED + IN_TRANSIT; "Delivered" = DELIVERED + INVOICED.
- `delivery_substatus` is a separate whitelisted column (Pending Pickup, Done Shipout, Arrives EM Warehouse, Done Delivered, Confirm, House Not Ready, Request Hold), not the lifecycle.
- An SO may raise a DO unless its status is in `SO_UNDELIVERABLE_STATUSES` (DRAFT, CANCELLED, ON_HOLD, CLOSED) or it is held (`soCanRaiseDo(status, onHold)`). Keep it a deny-list: every forward status is deliverable because orders ship in batches.

## Permissions

- Area `scm.sales.delivery` on `/delivery-orders-mfg/*`, reads inheriting from `scm.sales.orders`: sales staff see DOs of their own / downline SOs (`resolveSalesScopeIds`); `scm.so.view_all` or a director sees all; writes need `scm.sales.delivery` edit.
- `canOperateDeliveryOrders` (`frontend/src/auth/salesAccess.ts`) gates operate controls on desktop and phone alike; sales staff get view + Print; controls they cannot use are absent, not disabled.
- `scm.do.load` (position capability) — reach `PATCH /:id/status` → LOADED without delivery edit.
- `scm.do.dispatch` — → DISPATCHED and the POD chain (IN_TRANSIT / SIGNED / DELIVERED). A driver let in this way completes only a DO already shipped and assigned to their own crew (`not_your_job`); any other target is 403 `capability_required`.
- `scm.do.revert` — the revert route; the handler re-checks the capability (`*` passes).
- Finance visibility (`canViewScmFinance`) — without it `DO_FINANCE_KEYS` (cost, margin, per-category subtotals) are stripped from list and detail; `local_total_sen` stays visible.
- `scm.warehouse.inventory` — the Loading List (`GET /api/scm/loading-list`), read-only.
- `/api/public/do-scan/*` has no login: the token printed on the paper is the credential.
- Endpoints: see `docs/generated/route-capability-matrix.csv`.

## Rules that must not break

Stock
- The OUT is written once per DO: `deductInventoryForDo` existence check plus unique `uq_inv_mov_do_source_v2` (source_doc_type, source_doc_id, item_code, variant_key, COALESCE(correction_seq, 0)).
- On create, the deduction, SO sync and email are gated on `body.asDraft`, never on the status literal.
- Request-sourced lines get `item_group` rewritten to the SKU's `mfg_products.category` (company-scoped) by `resolveItemGroups`, once, before the stock check, commitment planning and insert; later OUT and resync read the stored group.
- Edit-after-ship resync writes correction rows (`correction_seq`) that stay `source_doc_type = 'DO'`; a quantity reduction returns units newest-first at their original lot cost (`fn_return_do_units_at_cost`). Never retag these rows ADJUSTMENT — cancelling an edited DO would silently do nothing.
- Cancel reverses through `scm.fn_reverse_do_out` (original lots and cost, consumptions deleted), falling back to `buildDoReversalRows`; racks return via `returnDoRacksOnCancel`.
- Ship-from warehouse per line: linked SO line's `warehouse_id` → DO header `warehouse_id` → default; a line resolving to none is skipped, never guessed. The branch is a header fact; never add a per-line location.
- Rack stock-out reads and writes always carry the order's company predicate.
- Confirm re-checks over-delivery for linked lines (`findOverDeliveredSoItems`) and for unlinked lines whose item the named SO orders (`findOverDeliveredUnlinkedItems`) → 409 `over_delivery`. Create and add-line refuse an unlinked line for an item the header's SO orders (409 `unlinked_so_lines`).
- A line's source SO line must be the same product (`scm/lib/line-link-item-identity.ts`): 409 `link_material_mismatch`; an unreadable source refuses; a failed read is 503 `link_identity_unavailable`; identity is checked before the quantity cap.
- Ship before arrival: a line resolving one live PO through the live allocator (`allocateExpectedBatches`; sofa sets whole, outstanding commitments subtracted) stores `committed_po_batch_no` at write time. The stored PO→SO link is provenance only (BIND_SHADOW rows). One sofa set binds one PO (`sofa_set_po_split`).
- Stock pre-flight counts by SKU at the warehouse (all spec buckets summed); the OUT and FIFO still key on the full spec. Company 1 hard-bound lines (bedframe, sofa, (SP) mattress) covered by their own received PO are skipped; company 2 pools.
- DO line cards pass `seedSofaLegDefault={false}`: a DO never invents a variant (a phantom bucket ships at cost 0).
- `migrated_no_stock` DOs (AutoCount carry-overs born DELIVERED with no OUT): `resyncInventoryForDo` and `deductInventoryForDo` return without writing.
- `ship_cost_sen` freezes at the first post-ship costing (`freezeShipCost`); `unit_cost_sen`, `line_cost_sen`, `line_margin_sen` restamp live.
- `recomputeTotals` fails closed and never throws (it runs after the line write has committed).
- A drop-ship DO (`is_dropship`) ships before receipt and is netted by the GRN; cancelling that PO is blocked while such an OUT is outstanding.

Locks
- A live (non-cancelled) SI or DR locks the header's customer, address, contact and commercial fields, DO date, customer delivery date, notes and salesperson (409 `do_identity_locked`), plus line add / edit and cancel. One rule, `backend/src/scm/shared/do-header-lock.ts`, read by the PATCH, the desktop edit and the phone edit.
- Still editable with an SI or DR: driver and vehicle, delivery-execution fields (time window, arrival, departure, shipout, port ETA, sub-status), `expected_delivery_at`. `doHeaderLockPartition.test.ts` fails a PATCH column in neither list.
- Line delete is checked per line (`doLineConsumedQty`: refused once that line is invoiced or returned), not by the document lock.
- The header PATCH moves the three SO amend fields (`amendDateFromCustomer`, `amendedDeliveryDate`, `amendReason`) onto the parent SO, audited there; the DO has no revision table.
- Only a `do_status` member may be compared against `status`; hold is read `.eq('on_hold', true)`, never the shared held term. A failed status count returns 500, never 0.
- The status PATCH does not read hold: a held DO is blocked only by the list menu, the scan ladder and the public scan.
- A shipped DO keeps its line rows: DB triggers refuse deleting a header that has an OUT and ending a transaction with a shipped DO at zero lines; the SO sync refuses to release a delivered SO while a delivered DO naming it is empty (`RELEASE_REFUSED`).
- Cancel reason (at least 5 characters) is enforced server-side by `cancelApprovalGuard("DO")` on the status route (400 `reason_required`); after a 2xx it writes the CANCEL history row and an EXECUTED `scm.document_cancel_requests` row.

QR scan and paper
- The printed QR encodes `/d/<token>` (10 characters; older 64-hex tokens still resolve). `DO_SCAN_TOKEN_RE` and the basket's `TOKEN_IN_URL` must accept the same set (`public-do-scan-token-shape.test.ts`).
- The next rung is decided on the server by `doScanStep` (shared ladder, vendored twin): forward only, one rung per scan, nothing on a held, cancelled or finished DO; DRAFT → LOADED is never batched.
- The public scan writes through `patchDeliveryOrderStatusHandler` as `SCM_SYSTEM_STAFF_ID` (no second write path); the company comes only from the token's row; responses never carry price, street address, postcode, phone or email.
- A basket holds at most 60 documents (refused, never truncated) and is processed sequentially; batch routes are registered before `/:token`.
- A revoked token (`qr_revoked_at`) answers exactly like an unknown one; a failed read answers 503; reads and advances are rate-limited per IP and per token.
- The scan's DELIVERED captures no signature, photo or GPS, and the screen says so before the press.
- Loading List projections select no `*_sen` column.
- The PDF QR is armed only by an explicit `loadScanId`; the Consignment Note reuses the renderer and never passes one.
- Printed DO (Epson LQ-310 dot-matrix, 2-ply): black ink only, no fills, helvetica at 9pt or more, Letter page, solid rules of at least 0.25mm.

POD, money, AutoCount
- POD evidence columns are written only when present; Mobile POD sends `signatureData` only after the customer actually drew.
- The DO shows its sales order's payments read-only (`useSalesOrderPayments`; `error` is a required prop). There is no separate DO payment ledger — money is taken on the SO (the removed `delivery_order_payments` endpoints served a table production never had, #3835).
- The DO reaches AutoCount by transfer: the create returns `acNotSent` and the New screen calls `notifyAcNotSent`; it never blocks.
- The status handler's only AutoCount call is `enqueueCancel` on CANCELLED, after the downstream check; a sign-off never reaches AutoCount (its DO has no such field).
- A line added to a DO that AutoCount already holds is declared through `newLineIds`.
- Any `ALTER TABLE` on `scm.delivery_orders` or `scm.delivery_order_items` must bound its lock wait (short `lock_timeout` with retries).

Desktop / mobile parity
- Change together: list (`MfgDeliveryOrdersListV2.tsx` ↔ `MobileModuleList.tsx`), detail (`DeliveryOrderDetailV2.tsx` ↔ `MobileModuleDetail.tsx`), header edit and lock (`DeliveryOrderNewV2.tsx ?edit=` ↔ `MobileDoHeaderEdit.tsx`, both via `do-header-form.ts` and `do-header-lock.ts`), cancel prompt (`use-do-cancel-action.ts` ↔ `mobile/doc-actions.ts` `DO_CANCEL_PROMPT`), cache invalidation (query hooks ↔ `mobile/sharedInvalidate.ts`).
- Mobile convert (`MobileConvertWizard.tsx`) always posts `asDraft: true`; planning-board converts on both surfaces send an `Idempotency-Key`, and `useCreateMfgDeliveryOrder` takes one too (a duplicate DO deducts stock again).
- Mutations that move SO remaining call `releaseSoSideQueries`; status changes also invalidate `['inventory']`; the DO payments query key is never persisted to localStorage.

Forms and display
- A DO opened from an SO takes its DO date, customer delivery date and every line date from the SO's `customer_delivery_date` (today when blank), plus branding; `/from-sos` does the same server-side. A blank DO opens on today.
- Changing the header customer delivery date moves every line not overridden (`cascadeLineDeliveryDate`), on the desktop form and the phone header edit.
- Line payloads use `lineDeliveryDate` and `lineDeliveryDateOverridden`.
- Variants seed from line 1 when a line is added, with no live cascade afterwards (categories `null`).
- The address uses the shared State / City / Postcode cascade; picking a State fills Sales location.
- FOC is computed only by `isFocLine`. The History drawer is keyed on the header UUID, not the DO number.

Migrated documents
- Migrated DOs copy the customer block and `DO_SALES_CARRY` (salesperson, agent, branding, ref) from the SO, and the ship-from branch from `backend/scripts/lib/ac-do-location.mjs` (book header, else unanimous line locations, else NULL and reported).
- Where colour cannot pair an AutoCount line to one SO line the writer writes no link; substituted codes carry `ac_substituted = true` with `so_item_id` NULL; retired duplicates are `qty = 0` with a `[ZEROED` note. All are expected shapes, not errors.

## Gotchas

- Hand-typed status pairs or lists drifted — use the `do-shipped-states.ts` predicates; `doDeliveredOneHome.test.ts` catches copies.
- COMPLETED is not a DO status; a non-enum label in a bucket or `.eq('status', …)` fails with 22P02 — every bucket value must be an enum member.
- The shared `HELD_OR_TERM` on the DO list killed the whole page (`do_status` has no ON_HOLD) — read the marker.
- A Confirm that wrote DISPATCHED skipped Confirmed — Confirm writes LOADED.
- Gating the signature on `canvas.toDataURL()` stored blank PNGs — gate on a real pointer stroke.
- A board button PATCHed DELIVERED with no evidence — send drivers to Mobile POD.
- Trusting the client's `itemGroup` checked and deducted an empty bucket — resolve it from the SKU.
- Empty shipped DOs made the SO sync release delivered orders — never empty or delete a shipped DO; repair by re-parenting lines found by `so_item_id`.
- The desktop line date was posted as `deliveryDate` and silently dropped — keep `lineDeliveryDate`.
- Omitting `asDraft` on `/from-sos` confirms and deducts — send it when a reviewable draft is wanted.
- A persisted payments cache became a driver's balance — keep payment sub-keys out of persistence.
- The sales scope needs the Houzs user id (`houzsUser.id`), not `user.id`; no identity and no view-all is a 403, never an empty list.
- `delivery_state` means three things (SO detail quantity rollup, board derivation, stored manual override) — do not read across them.
- Copying the SO's `customer_delivery_date` or the DO's `do_date` as a migrated DO's delivery date was wrong — dates come from the AutoCount line export (`backend/scripts/repair-delivery-dates-from-book.mjs`).
- `delivery-orders-mfg.ts` is over its size ceiling — add new routes as a separate router on the same prefix (as scan token, photos and revert did).
- The list export `GET /delivery-orders-mfg/export/rows` returns windows of at most 500 delivery orders matching the list's tab, search and sort, one row per line, with no price or amount on a line (the file goes to drivers, 3PLs and customers); money columns are hidden by default.

## Where the code is

- `backend/src/scm/routes/delivery-orders-mfg.ts` — list, detail, create, `/from-sos`, header / line / crew writes, `patchDeliveryOrderStatusHandler`.
- `backend/src/scm/routes/delivery-order-revert.ts`, `delivery-order-scan-token.ts`, `delivery-order-item-photos.ts`, `loading-list.ts`, `document-cancel-routes.ts` (`cancelApprovalGuard`); mounts in `backend/src/scm/index.ts`.
- `backend/src/routes/publicDoScan.ts` — public QR scan; `backend/src/scm/lib/do-scan-token.ts`.
- `backend/src/scm/shared/do-shipped-states.ts`, `do-scan-ladder.ts`, `do-header-lock.ts`, `so-deliverable-states.ts` (twins in `frontend/src/vendor/shared/`); `backend/scripts/lib/do-shipped-states.mjs`.
- `backend/src/scm/lib/do-status-buckets.ts`, `do-status-capability.ts`, `downstream-lock.ts`, `do-line-remaining.ts`, `do-over-delivery.ts`, `do-unlinked-so-lines.ts`, `so-delivery-sync.ts`, `sku-category.ts`, `ship-commitment.ts`, `do-live-allocator.ts`, `do-item-row.ts`, `so-to-do-fields.ts`, `check-stock-availability.ts`, `line-link-item-identity.ts`, `fulfillment-costing.ts`, `do-reversal.ts`.
- `backend/scripts/lib/migrated-do-writer.mjs`, `ac-do-location.mjs`, `customer-block.mjs`.
- `frontend/src/pages/scm-v2/MfgDeliveryOrdersListV2.tsx`, `DeliveryOrderDetailV2.tsx`, `DeliveryOrderNewV2.tsx`, `DeliveryOrderFromSo.tsx`, `DeliveryOrderDetailListing.tsx`, `row-menus.ts`, `do-list-status.ts`, `use-do-cancel-action.ts`, `DoLoadScan.tsx`, `LoadingList.tsx`.
- `frontend/src/pages/PublicDoScan.tsx`, `frontend/src/pages/PublicDoScanBasket.tsx`.
- `frontend/src/vendor/scm/lib/delivery-order-queries.ts`, `do-header-form.ts`, `delivery-order-pdf.ts`, `delivery-order-theme.ts`, `line-delivery-date-cascade.ts`, `foc-line.ts`; `frontend/src/auth/salesAccess.ts`.
- `frontend/src/mobile/MobileModuleList.tsx`, `MobileModuleDetail.tsx`, `MobileDoHeaderEdit.tsx`, `MobilePOD.tsx`, `MobileConvertWizard.tsx`, `MobileDeliveryPlanning.tsx`, `doc-actions.ts`, `sharedInvalidate.ts`.
