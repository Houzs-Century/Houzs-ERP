# Purchase Order (SCM)

The BUY-side document: procurement raises POs to suppliers, by hand or converted from Sales Orders (SO -> PO -> GRN -> PI).
Used by purchasers on desktop (full editor) and phone (list, detail, direct create, add line). Money is integer sen; dates stored UTC, shown DD/MM/YYYY.
A PO moves NO inventory at any status; stock IN happens at GRN post. What it moves is a counter (`mfg_sales_order_items.po_qty_picked`).

## Statuses and flow

- `scm.po_status`: `DRAFT | SUBMITTED | PARTIALLY_RECEIVED | RECEIVED | CANCELLED`; the `ON_HOLD` label stays in the enum for legacy rows only — nothing writes it.
- Create `POST /`: `asDraft: true` -> DRAFT (`submitted_at` null, no quota claimed); otherwise SUBMITTED.
- Confirm `PATCH /:id/confirm` is the ONLY commit verb (DRAFT -> SUBMITTED): stamps `submitted_at`, runs `recomputeSoPicked`; idempotent on SUBMITTED / PARTIALLY_RECEIVED, 409 otherwise. `PATCH /:id/submit` no longer exists.
- Confirm gates: warehouse gap (409 `purchase_location_id_required`) and variant gate (422, every sofa/bedframe line missing core axes listed at once; shared `missingVariantAxes`; fails closed on read error).
- `PARTIALLY_RECEIVED` / `RECEIVED` are derived by `recomputePoReceived` (grns.ts) from live GRN lines; it never resurrects a CANCELLED PO.
- Cancel `PATCH /:id/cancel` -> CANCELLED: body must carry `reason` (`cancelApprovalGuard('PO')`, else 400 `reason_required`, at every status incl. DRAFT); no approval step. Refused on RECEIVED, when a live GRN exists, or when a drop-ship DO OUT shipped against this PO's number. Releases SO quota, deletes the line allocation slices, queues the AutoCount cancel.
- Reopen `PATCH /:id/reopen`: CANCELLED -> SUBMITTED; 409 `cancel_is_final` if the PO has `linked_ac_docno` (AutoCount has no un-cancel — raise a new PO); runs the warehouse gate; stamps `submitted_at`; re-claims quota; allocation slices are NOT restored.
- Hold `PATCH /:id/hold` (shared `document-hold-routes.ts`): sets the marker `on_hold / hold_reason / held_at / held_by`; status is unchanged. List shows real pill + Hold chip; On Hold tab reads the flag.
- No document-level delete. CANCELLED is terminal (reopen aside). Line delete and allocation delete still exist.
- List tabs (`lib/po-status-buckets.ts`): draft, open (SUBMITTED), partial, received, cancelled, on_hold, and `outstanding` = SUBMITTED + PARTIALLY_RECEIVED — a roll-up that overlaps open + partial, so tab counts do not sum to all.
- Revisions: a PO is revised IN PLACE — `revision` bumps, prior version snapshotted to `scm.po_revisions`; number shows as `<po_number>_R<revision-1>` (`poDisplayNumber`) on screen and print. Two engines: `reviseBoundPo` (SO-amendment follow-up, lines re-derived by `rederivePoLineFromSoLine`) and `applyPoAmendment` (`/po-amendments` router).
- Pre-DO, every PO <-> SO pairing is floating (MRP pooled allocator); `so_item_id` and allocation slices are procurement PROVENANCE. At DO creation the live allocator (`do-live-allocator.ts`) binds `committed_po_batch_no`; post-DO records are anchored history.

## Permissions

- Area `scm.procurement.po` on `/api/scm/mfg-purchase-orders/*` and `/po-amendments/*`: GET needs `view`, POST/PATCH/PUT/DELETE need `edit` — enforced only for `scm_l2_configured` users; others pass on the coarse `scm.access` umbrella; `*` always passes.
- Desktop routes `/scm/purchase-orders[/new|/from-so|/:id]` and `/scm/po-amendments` sit behind `<ScmGuard area="scm.procurement.po">`.
- Frontend write gate `canOperatePurchaseOrders(can, pageAccess)` (`auth/salesAccess.ts`, mirrors the area guard): phone `+` (`mayCreatePurchaseDoc`), phone add line (`mayAddLine`), line import, photo controls, convert target.
- PO amendments: `scm.po_amendment.create` (raise), `scm.po_amendment.approve` (approve, reject; withdraw = requester or approver).
- Line import preview AND apply are POSTs, so both need `edit`.
- `POST /:id/send-to-supplier` also requires the `purchase_order` email channel enabled (fails closed).
- PO chasing list `GET /api/scm/outstanding/po-lines` is behind `scm.finance.outstanding` and is cross-company (`scopeToAllowedCompanies`).

## Rules that must not break

Locks and required fields
- Any non-cancelled GRN on the PO -> header PATCH, line add/edit/delete and cancel all 409 (`poHasDownstream`, `lib/downstream-lock.ts`); convert-to-GRN stays allowed. Same rule AutoCount applies to transferred documents.
- UI lock `purchaseOrderLinesLocked` (`vendor/scm/lib/line-add-lock.ts`): editable only in DRAFT / SUBMITTED / PARTIALLY_RECEIVED with no children; used by desktop editor and phone — never inline a copy.
- Create requires `supplierId` and `purchaseLocationId` (400); `expectedAt` blank defaults to today (MYT).
- No PO may reach SUBMITTED (confirm, reopen) while header `purchase_location_id` is blank and any line lacks `warehouse_id`.
- Send-to-supplier refused for DRAFT and CANCELLED (`poSendRefusalForStatus`); re-send is allowed, with a 60 s double-click window.
- A GRN may not receive against a held PO: receive gates read the ROW via `isReceivablePo` (status + `on_hold`), never status alone.

Linking PO lines to SO lines
- A line sourced from an SO in `DRAFT / CANCELLED / ON_HOLD / CLOSED` is refused (`SO_UNORDERABLE_STATUSES`); must stay equal to `SO_UNDELIVERABLE_STATUSES` (pinned by `backend/tests/duplicatedDecisionPins.test.ts`).
- `soLinkTargetRefusal` on POST /, add-line, line PATCH and allocations: SO line in the ACTIVE company (404 `so_line_not_found`), not cancelled (409 `so_line_cancelled`), same `item_code` (409 `so_link_material_mismatch`), same category when either side is hard-bound (409 `so_link_category_mismatch`). Allocations also require same spec (409 `so_link_spec_mismatch`).
- Over-convert cap: a bound line is capped at SO `qty - po_qty_picked` -> 409 `qty_exceeds_remaining` unless `confirmOverConvert: true`; an edit on the same SO line credits its own stored qty back, a rebind does not.
- Line PATCH `soItemId`: absent key keeps the link, explicit null/'' unbinds (stock PO stays valid); old and new SO lines are both recounted.
- `recomputeSoPicked` re-sums qty per `so_item_id`; excludes `from_mrp` lines and CANCELLED / DRAFT POs; best-effort (never fails the write).
- Hard-bound lines (`isHardBoundLine`: sofa, bedframe, `fabric_accessory`, mattress code ending `(SP)`) in company 1: cap uses `boundAwarePicked` (`lib/bound-line-ordered.ts`); unlinking refused 409 `hard_bound_unlink_refused`; splitting refused 409 `hard_bound_line_not_splittable`.
- Never feed the stored `so_item_id` link into new execution paths (DO binding, coverage precedence); it is provenance.

Line identity, variants, order
- `item_group` is the SKU's (`mfg_products.category`, company-scoped) on create, add-line, both convert arms (`poConvertLineRow` takes the resolved group as a required arg), line PATCH (`editedLineGroup`) and PO amendment; caller value only for uncatalogued codes. It decides the stock bucket (`computeVariantKey`) and hard-binding.
- `description2` is server-owned: rebuilt from `buildVariantSummary` only when `item_group` or `variants` change (`lib/po-line-description2.ts`).
- Categories that show the variant editor on PO/PC forms are defined once in `vendor/scm/lib/variant-editor-groups.ts` (`showsVariantEditor`).
- `variants` jsonb has several writers: always MERGE owned keys, never rebuild the object.
- `line_no` is 1-based dense and MIRRORS the SO line order; set at write time on all six write paths via `lib/po-line-order.ts` (pinned by `backend/tests/poLineOrderWiring.test.ts`); reads order `line_no NULLS FIRST, created_at, id`; display never re-derives it; the PDF sorts table and photo block from the same stored order.
- `POST /from-sos` buckets per `po-grouping.ts` `groupKeyFor`, key always starts (warehouse, supplier). PER-SO: each (SO, category) own PO. COMBINE: sofa per SO with that SO's accessories riding on it (`sofaSoDocNos`); bedframe per SO either way; mattress per supplier within a Monday-anchored 7-day delivery window; standalone accessory merges across SOs; `fabric_accessory` keyed as sofa.

Allocations (`scm.purchase_order_item_allocations`)
- Slices `(seq, qty, so_item_id | NULL=stock)`; positive integer qty, SUM <= line qty (409 `allocation_exceeds_line_qty`, DB triggers are the concurrency backstop); line qty cannot shrink below allocated (409 `line_qty_below_allocated`); seq resequenced dense on delete.
- Attribution only — no stock, money or quota; allowed on received POs, refused on CANCELLED. When present, coverage reads the slices instead of the line's `so_item_id` (never both).

Money
- `line_total_sen = max(0, qty * unit_price_sen - discount_sen)`; header `subtotal_sen = total_sen = SUM(line_total_sen)`. Any repair writes discount, line total and header together.
- Currency `MYR | RMB | CNY | USD | SGD`; the PO has no exchange rate — FX to MYR happens at the GRN.
- Line PATCH stores prices as sent; spec-edit re-pricing (`computeMfgPoUnitCost`) runs in the browser (`PurchaseOrderDetail.tsx`).
- Supplier cost never leaks to sales: `loadSupplierSofaCombos` excludes `supplier_id IS NULL` rows; `/sofa-combos` is not openRead.

Company scope
- Every read/write is scoped to the active company; SO-line reads used for binding must carry the company predicate (service role bypasses RLS).
- Inside `/api/scm/*`, `user.id` is the scm.staff UUID; use `houzsUser.id` for the public bigint.

AutoCount
- Every PO write queues AutoCount: create/confirm `enqueuePoCreate`, edits `queueAcPoEdit`, cancel `enqueueCancel`. DRAFT is not sent.
- Lines inserted by `POST /:id/items` and `POST /:id/convert-from-so` are passed as `newLineIds` (sent `IsNewLine` -> `AddDetail`); any other keyless line refuses the whole document; a removed line goes as a retirement (Qty 0); a new line with no warehouse uses the PO's.
- `linked_ac_dtlkey` is indexed, never unique (one AutoCount sofa line = one ERP row per compartment). A wrong key is worse than NULL (edits append instead of editing).
- `POST /`, `POST /from-sos` (per created PO) and confirm return `acNotSent: SaveProblem[]` when the composer refuses; the save is never blocked. `noteReadFailure` and `acNotSentProblems` must list the same error classes (pinned in `ac-preflight.test.ts`).
- Supplier delivery dates go as header UDFs `EDate / EDate2 / EDate3` from `supplier_delivery_date_2/3/4`; a blank slot is omitted (clearing in ERP never clears the book); per-line slots are not sent.
- Line `notes` never reach AutoCount (not in `PO_ITEM_COLS`); header `notes` -> Description.

Photos (`purchase_order_items.photo_urls`, text[] NOT NULL default '{}')
- Every SO -> PO path copies the SO line's KEYS (same R2 objects), derived server-side from `so_item_id` — never trust a client array.
- `po-items/...` keys are PO-owned (upload/delete on PO); carried `so-items/...` keys are read-only on the PO (403 `carried_photo_readonly`). Upload refused on a CANCELLED PO; an unsaved line has no key path.
- Read: `/signed` first, falling back to `{ mode: 'proxy' }`; the proxy needs the auth header, so fetch as blob -> object URL, never `<img src>`. Photos are per line, never deduplicated across a PO.

Desktop / mobile parity (change both)
- List columns: `PurchaseOrdersListV2.tsx` <-> `MobileModuleList.tsx` `MODULE_CONFIGS["mfg-purchase-orders"]` (+ `SERVER_PAGINATED`).
- Detail and status actions: `PurchaseOrderDetailV2.tsx` / `PurchaseOrderDetail.tsx` <-> `MobileModuleDetail.tsx`.
- Create: `PurchaseOrderNew.tsx` <-> `MobilePurchaseDocNew.tsx` (`kind = "po"`, same `useCreatePurchaseOrder`); SO -> PO: `PurchaseOrderFromSo.tsx` <-> `MobileConvertWizard.tsx` (`target = "po"`).
- Add line: editor add row <-> `MobileAddLine.tsx`, same hook and body.
- Cache: mutation hooks in `suppliers-queries.ts` <-> `mobile/sharedInvalidate.ts` (maps to `mfg-purchase-orders`, `-paged`, `mfg-purchase-order-detail`).
- Phone gaps (known, not parity): no option editor, no supplier price auto-fill, MYR only, sofa/bedframe lines save as DRAFT only; no per-line editor, SO-link picker or allocation editor (chips display-only); no photos, import, export or chasing list.

Line import (`/line-import/preview`, `/line-import/apply`)
- Editable fields only: Delivery Date (line), Estimate Delivery Date 1/2/3 (PO-level -> `supplier_delivery_date_2/3/4` + every line), Item Description 2, Remarks (`notes`). Qty, price, item never change by import.
- Rows matched by Line ID, Doc No must be the line's PO (number or `_R<n>`); absent column = unchanged; blank cell = value.
- Refusals: `unknown_line, other_company, po_cancelled, po_received, po_locked, invalid_value, doc_no_mismatch, duplicate_line`; rows of one PO disagreeing on an edited estimate date refuse that PO's estimate change.
- Apply is one transaction; any drift since preview -> 409 `import_conflict`, nothing written; audit pre-flight 409 `audit_trail_unavailable`; max 500 line / 200 PO changes.
- One `enqueueEdit` per PO, only when a delivery or estimate date moved; a Description 2 change alone is not pushed.
- Column mapping is mirrored `backend/src/scm/lib/po-line-import.ts` = `frontend/src/vendor/scm/lib/po-line-import.ts`; labels from `po-line-export-columns.ts` (also mirrored) are the import contract.

Export and print
- One toolbar Export via `GET /export/rows`: every PO the list filters match, one row per line, visible columns only, money in ringgit (never sen); stops at 20,000 orders with `truncated: true`, which the page refuses to write.
- `purchase-order-pdf.ts` is the only PO print generator; it fetches sofa compartment art itself. Print all goes through `PrintPreviewBatchModal`.
- Right-click Print chain: no entry for an `assigned_sos` item with `source: 'mrp'` or a bare-string GRN chip.

## Gotchas

- PO hooks live in `vendor/scm/lib/suppliers-queries.ts`, not a purchase-order-queries file.
- The desktop list key `mfg-purchase-orders-paged` is not localStorage-persisted — a cold open really loads.
- `GET /` without `?page` is the legacy path capped at 500 rows (still used by `GrnNew.tsx`); do not build new pickers on it.
- List search `q` covers only `po_number` and `notes`, not supplier name.
- A status count that cannot be read must return 500 `status_counts_failed`, never 0.
- Assigned SO / Delivered columns arrive later from `GET /list-mrp-enrichment`; while loading show WORKING… / NOT LOADED, never `STOCK` or a dash.
- `/outstanding-so-items` shows only lines with pooled MRP shortage > 0; a line MRP did not plan reads the same as a covered one. A DRAFT SO is never convertible — confirm it first.
- Do not write `ON_HOLD` to status or re-derive status in a way that erases a hold; the hold is the marker columns.
- SO-drift compare must strip `DISPLAY_ONLY_VARIANT_KEYS` (e.g. `fabricSupplierCode`) from both sides; add any new read-side stamp there the same day.
- Do not pass `sofaPhotos` from new print callers; `po-print-paths-draw-the-sofa.test.ts` counts callers. Generated PDF strings stay English-only.
- Sofa piece ordering (LHF first, RHF last) is applied when lines are created (`orderSofaCellsForNewLines`), never at display time — that would re-sequence old orders.
- `PoLineCard` is shared with PI/PC pages: its Remarks box is opt-in (`showRemarks`) and only safe when the parent sends `notes` in both add and update payloads; photos come through a render slot, never an own uploader.
- Special Order panel on a PO has an empty add-on pool by design; carried picks render read-only "from the Sales Order", never "retired".
- A migrated line's special add-ons go to `variants.specialsRecorded`, not `variants.specials` (the latter reprices on next spec edit).
- Never read a foreign-currency total gap as a discount; PO repairs refuse non-MYR documents and a snapshot with no currency columns. Do not seed a `scm.currencies` CNY row at rate 1.
- A repair over migrated POs must walk what the ERP holds (`linked_ac_docno`), not only the still-outstanding AutoCount scope.
- A link repair does not recompute readiness: run Recompute SO stock allocation, then Recompute SO po_qty_picked.
- Any writer of `so_item_id` (incl. delta sync) must check both rows' item codes match before binding; never stamp an inferred/FIFO guess into `so_item_id` — use allocation slices.
- Do not key sofa repair tools on the purchase row's `item_group`; `{model}-1S` is both a placeholder and a real one-seater.
- The sofa batch guard (`sofa-batch-guard.ts`) is never relaxed to make a document pass.
- History drawer is keyed on the header UUID; passing the doc number returns an empty history that looks real.
- `PurchaseOrderFromSo.tsx` does not yet surface `acNotSent`; `PurchaseOrderNew.tsx` does, before navigating.
- "migration NNNN" in code comments may be 2990-repo numbering; check the filename.

## Where the code is

Backend
- `backend/src/scm/routes/mfg-purchase-orders.ts` — main router (list, detail, create, from-sos, convert-from-so, line CRUD, allocations, bulk supplier date, confirm, send, cancel, reopen, hold mount).
- `backend/src/scm/routes/mfg-purchase-orders-list-enrichment.ts`, `purchase-order-exports.ts`, `po-line-import.ts`, `purchase-order-item-photos.ts`, `po-gates.ts`, `po-amendments.ts`, `document-hold-routes.ts`, `document-cancel-routes.ts`, `outstanding.ts`.
- `backend/src/scm/index.ts` — mounts and guards (`cancelApprovalGuard`, `scmAreaGuard`); `backend/src/scm/middleware/area-guard.ts`.
- `backend/src/scm/lib/`: `po-status-buckets.ts`, `po-list-read.ts`, `po-grouping.ts`, `po-convert-line.ts`, `po-line-order.ts`, `po-line-description2.ts`, `po-line-rederive.ts`, `po-revision.ts`, `so-revision.ts`, `po-allocations.ts`, `hard-bound-po-line.ts`, `bound-line-ordered.ts`, `so-stock-allocation.ts`, `downstream-lock.ts`, `source-document-gates.ts`, `so-po-drift.ts`, `po-supplier-date-cascade.ts`, `po-line-export.ts`, `po-line-export-columns.ts`, `po-line-import.ts`, `po-line-import-classify.ts`, `po-email.ts`, `ac-preflight.ts`, `autocount-outbox.ts`, `photoProxyFallback.ts`, `dropship-batch.ts`, `do-live-allocator.ts`, `sku-category.ts`.
- `backend/src/services/autocount-po-supplier-dates.ts` — supplier date UDFs.
- `backend/src/db/migrations-pg/20260912T1000_scm_po_outstanding_lines_view.sql` — `scm.v_po_outstanding_lines`.

Frontend
- `frontend/src/pages/scm-v2/PurchaseOrdersListV2.tsx`, `PurchaseOrderDetailV2.tsx` (read), `PurchaseOrderDetail.tsx` (edit), `PurchaseOrderNew.tsx`, `PurchaseOrderFromSo.tsx`, `po-list-line-columns.tsx`, `Outstanding.tsx` (PO Chasing tab).
- `frontend/src/components/scm-v2/PoLineAllocationsModal.tsx`, `PoLineImportModal.tsx`.
- `frontend/src/vendor/scm/lib/suppliers-queries.ts` (hooks), `purchase-order-pdf.ts`, `pdf-item-photos.ts`, `po-status.ts`, `line-add-lock.ts`, `variant-editor-groups.ts`, `po-line-import.ts`, `po-line-export-columns.ts`, `po-list-export.ts`, `warehouse-label.ts`, `ac-not-sent.tsx`.
- `frontend/src/auth/salesAccess.ts` (`canOperatePurchaseOrders`).
- Mobile: `frontend/src/mobile/MobileModuleList.tsx`, `MobileModuleDetail.tsx`, `MobilePurchaseDocNew.tsx`, `mobile-purchase-doc.ts`, `MobileConvertWizard.tsx`, `MobileAddLine.tsx`, `mobile-add-line.ts`, `sharedInvalidate.ts`, `MobileApp.tsx`.

Endpoints: see `docs/generated/route-capability-matrix.csv`.
