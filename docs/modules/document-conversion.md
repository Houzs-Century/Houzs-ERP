# Document conversion (Transfer to / Transfer from)

Cross-cutting SCM mechanism that turns one document's lines into the next document (SO -> DO -> SI, SO -> PO -> GRN -> PI/PR, consignment chains), plus the row right-click menu and chain printing built on it.
Used by sales, delivery, purchasing and warehouse staff on every document list/detail, and on the phone via one convert wizard.
Every conversion is a picker page owned by the DESTINATION document; source-side buttons only navigate to it with a scope.

## Statuses and flow

- Pairs that exist (source -> destination: picker route):
  - SO -> DO: `/scm/delivery-orders/from-so`; also Delivery Planning board (single and bulk) and phone planning "Create DO".
  - SO -> PO: `/scm/purchase-orders/from-so` (PO editor appends with `?poId=`); MRP page "Proceed PO". No transfer button on the SO list or SO detail.
  - DO -> SI: `/scm/sales-invoices/from-do`. DO -> Delivery Return: `/scm/delivery-returns/from-do`.
  - PO -> GRN: `/scm/grns/from-po` (GRN appends with `?appendToGrn=`); PO detail, PO list row, PO list bulk bar.
  - GRN -> PI: `/scm/purchase-invoices/from-grn`. GRN -> PR and PO -> PR: `/scm/purchase-returns/new` with `grnId` / `poId` (no from-grn picker page).
  - Consignment Order -> Consignment Note: `/scm/consignment-notes/from-order`; CO list/detail "Create Consignment Note" prefills the WHOLE order via `?fromConsignmentOrder=`.
  - Consignment Note -> Consignment Return: `/scm/consignment-returns/from-note`; CN detail "Create Consignment Return" (`?fromConsignmentNote=`).
  - PC Order -> PC Receive: `/scm/purchase-consignment-receives/from-pc-order`; PC Receive -> PC Return: `/scm/purchase-consignment-returns/from-receive` (no source-side button on either).
- Do not exist: Quotation -> SO (quotes API has no UI), SO -> SI (SIs are built only from DOs via `POST /sales-invoices/from-dos`), SO -> Consignment Note (a CN is free-entry).
- All ten pickers multi-select at LINE level; most also across several source documents. Picking creates nothing — Continue carries picks to the New-document form.
- Source eligibility: an SO feeds DO / PO only when `soCanRaiseDo(status, on_hold)` (`shared/so-deliverable-states.ts`; PO's `SO_UNORDERABLE_STATUSES` pinned equal). A DO feeds an SI only in `SI_TRANSFERABLE_DO_STATES` = LOADED, DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED (`shared/do-shipped-states.ts`, mirrored backend/frontend).
- `DO_SHIPPED_STATES` (LOADED ... INVOICED) = first entry writes the inventory OUT; Confirm (DRAFT -> LOADED) is where stock leaves.
- Documents at the end of a chain (PI, PR, DR, Stock Transfer, Stock Take) have no transfer out.

## Permissions

- A convert rides the DESTINATION route's area guard: `/delivery-orders-mfg` `scm.sales.delivery`, `/sales-invoices` `scm.sales.invoices`, `/delivery-returns` `scm.sales.returns`, `/mfg-purchase-orders` `scm.procurement.po`, `/grns` `scm.procurement.grn`, `/purchase-invoices` `scm.procurement.pi`, `/purchase-returns` `scm.procurement.pr`, `/consignment-notes` `scm.consignment.notes`, `/consignment-returns` `scm.consignment.returns`, `/purchase-consignment-receives` `scm.consignment.po_receives`, `/purchase-consignment-returns` `scm.consignment.po_returns`, `/mrp` `scm.procurement.mrp`.
- Phone wizard targets are offered only through `canOperateDeliveryOrders`, `canOperateSalesInvoices`, `canOperateGoodsReceipts`, `canOperatePurchaseOrders` (`auth/salesAccess.ts`), wired per target in `MobileApp.tsx`; the wizard imports no auth of its own, so a new target must get its own gate there (withheld `onNew` = no `+`).
- Row-menu transfer entries are gated per row by the list's own predicates (`canDeliver`, `canReceive`, `canInvoice`, `canReturn`, `canBill`).

## Rules that must not break

Link contract (`frontend/src/lib/convertScope.tsx`)
- `CONVERT_LINKS` names each scope parameter ONCE: `poToGrn`->`poId`, `grnToPi`->`grnId`, `grnToPr`->`grnId`, `poToPr`->`poId`, `doToSi`->`doId`, `doToDr`->`doId`, `soToDo`->`soDocNo`.
- Source buttons build URLs only with `convertToLink(pair, keys)`; destinations read with `readConvertScope(pair, searchParams, alsoKnown)` and render `<UnrecognisedScopeNotice>`. Never hand-write a query onto a convert path (tree scan in `convertScope.test.tsx` fails).
- A parameter is named for what it carries (`soDocNo`, because the SO picker rows carry doc numbers, not ids).
- Value is a comma-separated list, so one and many use the same parameter; no parameter = full, unscoped picker (legitimate).
- A scoped picker filters AND pre-ticks the source's remaining lines at full qty, offers a "Show all" escape, and its empty state says the SCOPED document has nothing left.
- An unrecognised parameter is shown, never dropped. `alsoKnown` is required (pass `[]`); append targets (`appendToGrn`, `poId` on from-so) and search `q` are declared there, never added to `CONVERT_LINKS`.

Vocabulary (`backend/src/scm/shared/transfer-vocabulary.ts` = `frontend/src/vendor/shared/transfer-vocabulary.ts`, script twin `backend/scripts/lib/transfer-vocabulary.mjs`)
- Buttons: `transferToLabel(dest)` on the source (primary, footer) and `transferFromLabel(source)` on the destination (secondary, header). Full document names from `TRANSFER_DOC`, always singular, never abbreviations, never string literals.
- Lineage column headers: `transferFromColumnLabel` / `transferToColumnLabel` ("Transfer From (SO)").
- `TRANSFER_FLOWS` lists every recognised pair; it is vocabulary, not capability.
- Mirrors are refereed by `transfer-vocabulary.canonical.test.ts` and `backend/scripts/check-shared-mirrors.mjs`.
- Never rename DB columns `transfer_to` or AutoCount's `TransferTo` / `TransferFrom` / `FromDocDtlKey`. Never rename a DataTable column `key` (saved layouts reset) — e.g. PO detail keeps key `transferTo` labelled "To Warehouse".
- "Source PO" columns (from stock `batch_no`) are inventory facts, not lineage; keep that title.

Provenance note (a stored data contract)
- `POST /mfg-purchase-orders/from-sos` (incl. MRP Proceed PO) writes `purchase_orders.notes = provenanceNote('so', docNos)` -> `Transfer from Sales Order: SO-..., SO-...`.
- Readers: `document-flow.ts`, `po-so-coverage.ts`, `po-relationship-map.ts`, `purchase-order-pdf.ts` ("Your Ref No." / "For SO"), and backfill/repair scripts. All parse via `parseProvenanceNote` / `provenanceNoteRe`.
- `PROVENANCE_NOTE_LABELS` keeps legacy `From SOs` and `From SO` forever. SQL candidate filters must be built with `provenanceNoteSqlPattern()`, never typed. Parsers share `backend/tests/fixtures/provenance-note-corpus.json`.

Consumption and caps (application code only; no DB constraint except the PO allocation triggers)
- Once-only pairs use a per-LINE quantity ceiling: converted so far + this conversion <= source qty. Never a document-level "already converted" flag (orders ship in batches).
- SO -> PO is not once-only (MRP shortage is the authority); it keeps the `po_qty_picked` over-convert cap (`po-over-convert.ts`). Consignment Order -> Note is uncapped by ruling (a loaner ships what is on the shelf).
- Sales chain is derived live (`lib/do-line-remaining.ts`: SO -> DO `qty - delivered + returned`; DO -> SI/DR `delivered - invoiced - returned`). Purchase chain reads stored counters: `purchase_order_items.received_qty` (`recomputePoReceived`), `grn_items.invoiced_qty` (`recomputeGrnInvoiced`), `grn_items.returned_qty`, PC `received_qty` / `returned_qty` (`qty-cap.ts` `qtyCapRefusal`).
- `DoPendingBasis` is a REQUIRED argument: `'invoiceable'` (DO -> SI; LOADED counts) vs `'delivered'` (DO -> DR and unbilled report). The SI write cap uses the same basis as the SI gate.
- A DRAFT SO->DO, PO->GRN or GRN->PI downstream does not consume the source line; the cap is re-checked at confirm/post (`PATCH /purchase-invoices/:id/post` counts the draft being confirmed via `verifyGrnLinesNotOverInvoiced`).
- Post-insert re-check (delete + 409 on a lost race) exists on DO, DR, GRN, PI, PR, SI and both PC routes; SO -> PO, CO -> CN and CN -> CR have none.
- Unlinked back door: a hand-added line whose material IS on the named parent must be linked. Create paths guard SO->DO, DO->SI, DO->DR, PO->GRN, GRN->PR and GRN->PI (`findUnlinkedPiLines`; parent set = header GRN plus receipts behind the invoice's lines; fails closed 500 `unlinked_check_failed`).
- Edit re-point guard `unlinkedEditRefusal` (`lib/unlinked-line-edit-guard.ts`) on GRN, PR, DR, SI, consignment return and PC return line PATCH: 409 `unlinked_line_repoint`; a failed parent read fails closed.
- Identity: a client-supplied line link must name the SAME item code as its source line (SI, PI, GRN, PR, DR, DO line links; checked on create, add-line and the effective post-PATCH code): 409 `link_material_mismatch`, fails closed 503 `link_identity_unavailable` (`lib/line-link-item-identity.ts`, via `assertSourceLinesInCompany` / `assertLinkedLineItemsMatch`).
- Source lines must belong to the active company (`assertSourceLinesInCompany`).

Phone (`frontend/src/mobile/MobileConvertWizard.tsx`)
- Four targets only: DO (from one SO), SI (from one DO), GRN (many POs of ONE supplier), PO (from one SO); reads the same remaining endpoints as the desktop pickers.
- DO, SI and GRN arms always send `asDraft: true`; the operator confirms on the document (that is where stock / AR is written). Do not add an arm for a destination whose converter cannot create a draft (Delivery Return, PI convert handlers, PC receive/return, consignment pairs).
- Step 1 filters sources with the same gates: SO by `soCanRaiseDo`, DO by `SI_TRANSFERABLE_DO_STATES`.
- Picker caches live under `CONVERT_PICKER_ROOTS` and are refreshed by `invalidateConvertShared` (`mobile/sharedInvalidate.ts`); add a root there, never a private key at a call site. Server `over_remaining` / 409 stays the real guard across devices.
- Desktop-only pairs: GRN -> PI, GRN -> PR, DO -> DR, consignment and purchase-consignment pairs, planning bulk convert, MRP -> PO.

Variants on picker rows
- Every document-line picker row shows `buildVariantSummary` (desktop `vendor/scm/components/VariantDescription.tsx`, phone `variantLineOf`). The row's endpoint must SELECT `variants`, or the component silently renders empty. Catalogue pickers (`SalesOrderNewFromProducts`, `SoFromProducts`) show none by design.

Right-click row menu (`frontend/src/pages/scm-v2/row-menus.ts`, `lib/rowMenu.ts`)
- `buildRowMenu` groups in fixed order: open / edit / print(s) · transfer to · status changes · cancel (red, last); empty groups are dropped (no stray divider).
- Every entry calls a handler the page already has; a menu never invents behaviour. Transfer entries are built on `convertToLink`, so they land exactly where the button lands.
- Current menus: SO (Transfer to DO; Confirm, Hold/Take off hold, Close remaining, Reopen; Cancel; migrated read-only rows get Open + Print only). DO (Transfer to SI / DR; Confirm, Mark Loaded / In Transit / Delivered on stock-out states, Hold; Cancel). PO (Transfer to GRN; Hold; Cancel). GRN (Transfer to PI / PR; Confirm; Hold; Cancel). SI (Record payment; no cancel). PI (Copy as new; Confirm; Hold; Cancel). PR (Confirm; Cancel). DR (Cancel only). Stock Transfer and Stock Take (Open, Print, Cancel; no Edit).
- Statuses the system decides, or that need figures the row lacks, stay off menus (DR Inspected/Refunded, PR Complete, PI Mark paid, SO READY_TO_SHIP/DELIVERED, Stock Take post).
- Every list offers Print on every status (pinned by `row-menus-remaining-lists.test.ts`).
- PI "Copy as new" only navigates to `/scm/purchase-invoices/new?copyFrom=<id>`: content copied, identity fresh (new number, today, no GRN links, no supplier ref).

Chain printing
- `PrintChainProvider` mounts the single `PrintPreviewModal` once in `Scm2990Shell` and exposes `usePrintDocument()`; list rows print their chain in place. Print goes through the PDF (`action: 'print'`), never `window.print()` (prints blank).
- `lib/printChain.ts` decides which documents a row may print; an entry is built only where the row carries an address (UUID; SO by doc_no). Nothing is fetched to build a menu.
- MRP-projected `assigned_sos` (`source: 'mrp'`) never builds an entry — only `linked` / `delivered`. Bare-string GRN chips build none.
- One entry per downstream document up to `PRINT_CHAIN_MAX` (5); the rest become one "+N more <Document> — Open to print" entry. Labels come from `TRANSFER_DOC`.
- `lib/printDocumentPdf.ts` maps type -> detail endpoint -> generator and also feeds the lists' batch PDF export. The DO branch arms the public scan token (`armDoScanToken`); a failed mint prints no QR, never the staff-login link.
- Stock Transfer / Stock Take print navigates to the detail with `?print=1`; their sheets show no money; a blind open take prints without system qty/variance.
- Printed statuses go through `statusLabel(docType, status)`, never a title-cased stored value.
- A print whose code chunk was removed by a deploy reopens via `trackPrintAction` (`lib/chunkActionRecovery.ts`).

AutoCount
- Conversions reach AutoCount as TRANSFERS (`so_to_do`, `po_to_gr`, `do_to_iv`, `gr_to_pi`), whose route applies a narrower header than an edit. The payload derives from `AcDownstreamSpec.facts`; fields it cannot carry come back on the create as `acNotSent` with code `ac_sent_incomplete` (document arrived, part did not) and the New screen shows them via `notifyAcNotSent`. Never blocks.
- Never adopt AutoCount's Full Transfer semantics (closes the source regardless of qty); keep per-line, per-quantity partial semantics. A book value-outstanding figure is not a quantity; expect orphaned `DocTransfer` rows in sync.

FOC
- `isFocLine` (`vendor/scm/lib/foc-line.ts`) is the only rule: `variants.freeGift` set, OR unit price 0/absent AND line total 0. Discounted to zero is not FOC. Never re-derive it in a component.

## Gotchas

- A source button whose parameter the picker never reads drops the operator into the global list; a misspelt parameter (`fromGrn` vs `grnId`) opened a blank form. Always go through `CONVERT_LINKS`.
- Do not re-add `/scm/sales-invoices/from-so`; SO -> SI does not exist.
- "New from quotation" on the SO list still opens the guided sofa configurator (`/scm/sales-orders/new/guided`); it has nothing to do with quotations.
- Do not blind-replace "convert": unit/currency/date conversion, the Fabric Converter tool and agent governance ("Convert to firm order") legitimately use it.
- A second PO against an already-purchased SO line is legitimate (MRP); do not add a once-only guard to SO -> PO.
- The SO list's multi-select drives Print all only; bulk SO -> DO is on Delivery Planning, bulk SO -> PO on MRP.
- The phone list caches paged lists under `mobile-module-paged`; invalidating `["mobile-module"]` does not reach them — use `invalidateMobileLists`.
- The DO list row cannot print its SIs / DRs (payload carries numbers, no ids); do not build entries that would 404.
- `frontend/tsconfig.app.json` has `noUnusedLocals: false`: a handler built and wired to nothing (list cancels) goes unnoticed — check the menu reaches it.
- Required menu parameters (e.g. `setHold` on `purchaseInvoiceRowMenu`) exist so a new menu cannot silently omit a capability the page has.
- A drill-down fed by a second query shows WORKING… / NOT LOADED while pending/failed, never `STOCK` or a dash.
- The purchase-chain counters are caches recomputed best-effort; when auditing against AutoCount (`backend/scripts/check-ac-transfer-counters.mjs`) compare fractions, not subtraction — one book sofa line is several ERP rows. SO -> DO and DO -> SI have no stored counter; their only failure is a missing link.
- Some backend converters have no frontend caller (`POST /mfg-purchase-orders/:id/convert-from-so`, `POST /sales-invoices/:id/items/from-do/:doId`, PC `from-pcos` / `from-pc-receives`); check before building a new endpoint.
- Several list routers sit at their file-size ceiling (`scripts/file-size-ceilings.json` may only fall); prefer shared helpers over per-list additions.

## Where the code is

Frontend
- `frontend/src/lib/convertScope.tsx` (+ `convertScope.test.tsx`), `frontend/src/pages/scm-v2/convert-scope-pickers.test.tsx`.
- Pickers: `frontend/src/pages/scm-v2/PurchaseOrderFromSo.tsx`, `GrnFromPo.tsx`, `PurchaseInvoiceFromGrn.tsx`, `SalesInvoiceFromDo.tsx`, `DeliveryOrderFromSo.tsx`, `DeliveryReturnFromDo.tsx`, `ConsignmentNoteFromOrder.tsx`, `ConsignmentReturnFromNote.tsx`, `PurchaseConsignmentReceiveFromOrder.tsx`, `PurchaseConsignmentReturnFromReceive.tsx`, `PurchaseReturnNew.tsx`.
- Menus and print: `frontend/src/pages/scm-v2/row-menus.ts`, `frontend/src/lib/rowMenu.ts`, `frontend/src/lib/printChain.ts`, `frontend/src/lib/printDocumentPdf.ts`, `frontend/src/components/scm-v2/PrintChainProvider.tsx`, `frontend/src/components/scm-v2/PrintPreviewModal.tsx`, `frontend/src/lib/chunkActionRecovery.ts`, `frontend/src/vendor/scm/lib/do-scan-token-arm.ts`.
- Shared: `frontend/src/vendor/shared/transfer-vocabulary.ts`, `frontend/src/vendor/shared/do-shipped-states.ts`, `frontend/src/vendor/shared/so-deliverable-states.ts`, `frontend/src/vendor/scm/components/VariantDescription.tsx`, `frontend/src/vendor/scm/lib/foc-line.ts`, `frontend/src/vendor/scm/lib/ac-not-sent.tsx`.
- Phone: `frontend/src/mobile/MobileConvertWizard.tsx`, `frontend/src/mobile/sharedInvalidate.ts`, `frontend/src/mobile/MobileApp.tsx`, `frontend/src/auth/salesAccess.ts`.

Backend
- `backend/src/scm/shared/transfer-vocabulary.ts`, `backend/scripts/lib/transfer-vocabulary.mjs`, `backend/src/scm/shared/do-shipped-states.ts`, `backend/src/scm/shared/so-deliverable-states.ts`.
- Caps and guards: `backend/src/scm/lib/do-line-remaining.ts`, `qty-cap.ts`, `po-over-convert.ts`, `bound-line-ordered.ts`, `unlinked-line-edit-guard.ts`, `return-unlinked-lines.ts`, `line-link-item-identity.ts`, `ref-in-company.ts`, `pi-grn-source-guard.ts`, `convert-ceilings.test.ts`.
- Converter routes: `backend/src/scm/routes/delivery-orders-mfg.ts`, `sales-invoices.ts`, `delivery-returns.ts`, `mfg-purchase-orders.ts`, `grns.ts`, `purchase-invoices.ts`, `purchase-returns.ts`, `consignment-notes.ts`, `consignment-returns.ts`, `purchase-consignment-receives.ts`, `purchase-consignment-returns.ts`; relationship graph `document-flow.ts`.
- AutoCount: `backend/src/scm/lib/ac-preflight.ts`, `backend/src/scm/lib/autocount-outbox.ts`.

Endpoints: see `docs/generated/route-capability-matrix.csv`.
