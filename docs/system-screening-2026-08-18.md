# System screening — vocabulary drift, defects, doc-drift

<!-- Produced 2026-08-18 by a 12-agent full-codebase read (workflow system-screening).
     This is the WORKLIST for the vocabulary-unification programme, not a generated file. -->

A whole-codebase read (1,360 source files, backend + frontend) clustered every
business concept by the spellings it carries. **True drift** = genuinely different
words for one thing. Casing pairs (`processing_date` DB vs `processingDate` API) are
ONE word by convention and are NOT drift.

## Money is displayed as RM, stored as integer minor units

Owner 2026-08-18: exports must read `35.00`, not `3500`. That is a DISPLAY rule —
format the stored integer as RM at the edge. Storage stays an integer (`19.99 * 100`
is `1998.9999…` as a float; `money.ts` exists to prevent exactly that). The DRIFT to
fix is the NAME: `_centi` / `_sen` / `_cents` are three names for the same integer sen.

## True drift — 33 concepts, by severity

| Sev | Concept | Spellings seen | Canonical |
| --- | --- | --- | --- |
| high | Money minor unit (1/100 MYR) | `*_centi` · `*_sen` · `*_cents` · `amountSen` | `*_centi` |
| high | Salesperson / sales rep | `salesperson_id` · `agent` · `sales_reps` · `sales_agent` · `salesRep` | `salesperson_id` |
| high | Delivery date (customer promise / per-line / effective) | `customer_delivery_date` · `line_delivery_date` · `amended_delivery_date` · `expected_at` · `supplier_delivery_date_2/3/4` | `customer_delivery_date (header) / line_delivery_date (line)` |
| high | Processing date (release-to-purchasing signal) | `processing_date` · `internal_expected_dd` · `proceeded_at` · `PDate` · `target_date` | `processing_date` |
| high | Customer's own reference / their PO number | `customer_so_no` · `po_doc_no` · `customer_po` · `ToPONo` · `ref` | `customer_so_no` |
| high | Product / item / material code (SKU) | `item_code` · `material_code` · `product_code` · `code` · `sku` | `item_code` |
| high | Warehouse / location an order ships from | `warehouse_id` · `sales_location` · `purchase_location_id` · `Location` · `'stock` | `warehouse_id` |
| high | Customer / debtor | `debtor_code` · `customer_id` · `DebtorName` · `hasCustomerName` · `recipientName` | `debtor_code / debtor_name` |
| high | Supplier / creditor | `creditor_code` · `supplier` · `main_supplier` · `payee_name` · `company_name` | `creditor_code / creditor_name` |
| med | Product brand / branding | `branding` · `brand` · `item_brand` · `first_item_branding` · `SOUDF_BRANDING` | `branding` |
| med | Venue | `venue` · `venue_id` · `venue_name` · `project_venues` · `scm.venues` | `venue (text) + venue_source for provenance` |
| med | Sofa fabric / colour code (variant axis) | `fabricCode` · `colorCode` · `colourCode` · `fabricColor` · `fabric_code` | `fabricCode` |
| med | Payment method vocabulary | `merchant` · `credit` · `Cash` · `method` | `cash / transfer / merchant / installment` |
| med | Payment merchant / acquirer / bank | `payment_merchant` · `merchant_provider` · `bank` · `acquirerCode` · `display_name` | `merchant_provider` |
| med | Document-number suffix convention | `*_number` · `*_no` · `doc_no` · `*_doc_no` | `*_no (choose ONE suffix project-wide)` |
| med | Quantity (received / accepted) | `qty` · `qty_accepted` · `received_qty` · `invoiced_qty` · `qty_returned` | `qty (+ explicit accepted/received qualifier)` |
| med | Stock readiness status | `stock_status` · `stock_state` · `stock_status_effective` · `stock_remark` | `stock_status` |
| med | Free-text note / remark | `note` · `notes` · `remark` · `remark2` · `narration` | `note` |
| med | Batch / dye-lot (overloaded onto PO number) | `batch_no` · `allocated_batch_no` · `committed_po_batch_no` · `expectedBatchNo` · `poNumber` | `batch_no` |
| med | Address (structured vs single) | `address1` · `addr1..4` · `address` · `ship_to_address` · `venue_address` | `address1..4` |
| med | Customer / address state | `customer_state` · `state` · `location` | `customer_state` |
| med | Transport cost slug | `transport_pct` · `transport_fee` · `auto:transport` · `transport_setup_dismantle` | `transport_fee` |
| med | 2990 company / brand name (master data) | `2990` · `2990s` · `2990's` · `2990` · `2990s` | `2990` |
| med | Sofa seat-height axis | `seatHeight` · `depth` | `seatHeight` |
| med | Sofa compartment / module code | `compartment` · `moduleId` · `compartmentId` · `buildKey` · `cells[].moduleId` | `compartment` |
| med | Shipped-status display label (homonym collision) | `SO.SHIPPED` · `DO.DISPATCHED` | `distinguish the two labels` |
| low | Sofa leg-height axis | `legHeight` · `sofaLegHeight` | `legHeight` |
| low | Exchange / FX rate | `exchange_rate` · `rate_to_myr` · `operatorRate` · `fxRate` | `exchange_rate` |
| low | Payment slip / proof / R2 media key | `slip_key` · `podKey` · `photoRef` · `logoR2Key` | `*_r2_key (per artifact type)` |
| low | Paid total (running paid figure) | `paid_centi` · `paid_total_centi` · `paidCenti` | `paid_total_centi` |
| low | Installment / online payment sub-fields | `installment_plan` · `online_type` | `installment_months / online_type` |
| low | Amendment SO_APPROVED label | `'SO` · `'Applied'` | `one label per context, documented` |
| low | ASSR case number vs SO document number (overload) | `assr_no` · `doc_no` · `case_no` | `assr_no (cases) / doc_no (SO)` |

### Money minor unit (1/100 MYR)

Both words mean 1/100 MYR = sen. Same value spelled both ways within single files (pi-audit-trail labels the total_centi column 'INTEGER SEN'; delivery-orders-mfg:4804 does the same; recost converts with toMyrSen yet writes unit_cost_sen while cascading into *_centi documents). Rough de-facto split: documents/GL use _centi (~50 route files), inventory/costing/pricing use _sen (27 files), but there is NO rule. money.ts (the canonical parser) speaks sen; scm.ts speaks centi. Biggest single confusion source. Recommend _centi (majority) and migrate the _sen columns.

### Salesperson / sales rep

Three genuinely different identifiers actively reconciled at runtime. consignment-orders stamps BOTH agent and salesperson_id on one insert; so-confirm-gate:2811 accepts 'either identifier'; salesScope maps to a THIRD (sales_reps integer id). salespersonId is just the camel twin, not the drift.

### Delivery date (customer promise / per-line / effective)

autocount-convert-lines:52-56 states it plainly: line_delivery_date on a sales line and delivery_date on a purchase line are 'the same fact under two column names'. so-edit-header stuffs customer_delivery_date into a UDF literally named SalesExemptionExpiryDate. expected_at + supplier_delivery_date_2/3/4 fold into one 'effective delivery'. customerDeliveryDate casing is not the drift.

### Processing date (release-to-purchasing signal)

Migrations 0284-0286 explicitly collapsed internal_expected_dd -> processing_date as 'one name', but internal_expected_dd, proceeded_at and PDate still appear in live reads across be-lib, mobile and scmv2. processingDate is only the camel twin (not drift).

### Customer's own reference / their PO number

autocount-outbox:304-308 — three columns have each held the customer's ref; reading po_doc_no alone 'sent ToPONo nowhere'. Front-end assembles the same node under 3 names AND 3 DIFFERENT fallback orders (po_doc_no||customer_so_no vs customer_so_no||po_doc_no) — a live precedence bug, not just naming.

### Product / item / material code (SKU)

One SKU under three table-family names. LINE_CODE_COL and DocumentLinesExpansion exist solely to bridge them (code = material_code||item_code||product_code). itemCode/materialCode casing twins are not the drift.

### Warehouse / location an order ships from

'Which building ships' resolved from free-text sales_location, per-line warehouse_id, and PO-side purchase_location_id, then mapped to AutoCount SalesLocation/Location. so-form-validate calls it 'stock location', 'warehouse' AND 'Sales Location' in three adjacent strings. salesLocation casing is not the drift.

### Customer / debtor

debtor and customer are the same AR party. acSnapshot/doMirror store debtor_name; order-fulfilment calls the same field hasCustomerName; payments books the AR party from debtor_code on the SI path but customer_name on the SO path. customerName casing is not the drift.

### Supplier / creditor

stockItems writes main_supplier then copies it into assr_cases.creditor_code; po.ts carries creditor_code in the same row; PV lines take supplier{code,name}+payee_name; finance drill reads company_name AS supplier_name. One entity, 4+ words in adjacent columns. missing-creditor reason-code vs 'supplier' UI label.

### Product brand / branding

item_brand is a genuinely different column name for the brand carried elsewhere as branding/brand/first_item_branding. KEEP SEPARATE (homonym, not drift): the be-services 'Branding' company-identity block (companyName/registrationNo/logo_r2_key, keyed branding:<CODE>) is a DIFFERENT concept sharing the word — do not merge it in.

### Venue

One concept across three physical stores; fair-report:540 and MobileFairReport:109 both mark venue_id a 'dead scm.venues FK' with the TEXT venue authoritative. canonical-venue folds mfg_sales_orders.venue and warehouses.venue_name to one name. Retire venue_id. venueId casing is not the drift.

### Sofa fabric / colour code (variant axis)

Five aliases of ONE axis (American/British color/colour AND fabric*/color*), reconciled by an alias list (FABRIC_CODE_KEYS) in every module; GRN editors store fabricColor, SO editors fabricCode. NB fabricCode (cost axis) vs fabricId (selling axis) is a REAL distinction, not drift — do not collapse those two.

### Payment method vocabulary

payment-methods.ts:41 defines merchant/transfer/installment/cash, but schemas/order.schema.ts:87 validates paymentMethod against credit/debit/installment/transfer — a credit/debit vocabulary that exists nowhere else and can reject valid orders. payment_method vs paymentMethod casing is not the drift.

### Payment merchant / acquirer / bank

One acquirer under four names across the posting/reconciliation path. merchantProvider casing is not the drift.

### Document-number suffix convention

reconcile-ledger:2116-2124 reads transfer_no in the same list where every sibling uses *_number. A doc's own number is split between _no and _number with no rule; distinct from the customer-PO-ref drift. poNumber/poDocNo casing is not the drift.

### Quantity (received / accepted)

A GRN line's shipped quantity is qty_accepted while everywhere else it is qty (itemQtyCol/sourceQtyCol pair exists only to bridge). received_qty vs qty_received and qty_returned vs returned_qty are word-order drift for one field.

### Stock readiness status

Two spellings AND two value vocabularies for line readiness, plus a derived stock_status_effective; consumers dual-read stock_status ?? stock_state.

### Free-text note / remark

do-audit-fields:34 audits BOTH ['note','note'] and ['notes','notes'] on the SAME Delivery Order; consignment/amendment lines use remark; GL uses narration. Separately, remark2/remark4 ('Remark 2'/'Remark 4') have become load-bearing status carriers — a distinct risk from the note/notes/remark drift.

### Batch / dye-lot (overloaded onto PO number)

batch_no literally holds the source PO number, and the same physical dye-lot is allocated_batch_no on the SO line, committed_po_batch_no on the DO line, and poNumber at GRN time. Four names + a value overload.

### Address (structured vs single)

Supplier structured address1-4 vs legacy single 'address'; assr uses addr1-4. The ship/bill/install variants are DISTINCT addresses (not drift); the address-vs-address1 split is the drift.

### Customer / address state

do-audit maps customerState->customer_state yet also audits state->state; dp-party reads customer_state on the SO but state on supplier/warehouse/workshop and location on the assr — one address-state field. customerState casing is not the drift.

### Transport cost slug

projectCostRates' own comment records the split: the slug moved transport->transport_fee, the auto_source tag stayed auto:transport, and transport_setup_dismantle holds the human-entered logistics cost. Four spellings of transport in one file.

### 2990 company / brand name (master data)

so-branding-label:71-75 documents a regex that folded 2990/2990's/2990s together and a sofa label spelled both '2990 Sofa' and '2990s Sofa' across master data and code before the 2026-08-18 unification. Partly fixed — verify no residue in seed/master rows.

### Sofa seat-height axis

so-variant-rule aliases depth->seatHeight; variant-key and sofa-combo-pricing each re-implement depth ?? seatHeight. Every POS sofa order once 409'd variants_incomplete because of this split.

### Sofa compartment / module code

The sofa sub-unit is 'compartment' in the base code but moduleId/moduleCode/compartmentId/buildKey elsewhere; normalizeCompartmentCode also folds 1A(LHF)/1A-LHF formats.

### Shipped-status display label (homonym collision)

status-pill:65 vs :76 render two DISTINCT stored states as the identical word 'Shipped'; SO has no DISPATCHED and DO has no SHIPPED, so one word means different states in reports. A label collision, not a stored-column drift.

### Sofa leg-height axis

sofaLegHeight->legHeight aliased three ways (input.sofaLegHeight ?? input.legHeight). Same POS/backend vocabulary split as seat height.

### Exchange / FX rate

exchange_rate is the column; rate_to_myr is a genuinely different name for the same FX rate, and the *Rate function-locals proliferate. exchangeRate/fxRate is casing/synonym; rate_to_myr is the real drift.

### Payment slip / proof / R2 media key

R2-key naming has no convention: the same payment proof is slip_key and slip_image_key; POD, mileage and logo each invent their own. slipKey casing is not the drift.

### Paid total (running paid figure)

ConsignmentOrders reads paid_total_centi ?? paid_centi ?? 0 while the aggregate uses paidCenti — three spellings for one figure in a single file (on top of the system-wide sen/centi unit drift).

### Installment / online payment sub-fields

Tenure is installment_plan in the dropdown category but installment_months on the payment row — genuine drift. online_type/onlineType is casing (not drift).

### Amendment SO_APPROVED label

status-pill:118 vs :129 — the SAME stored status SO_APPROVED renders 'SO Approved' or 'Applied' depending on whether so_amendments.lane is set. Intentional but undocumented.

### ASSR case number vs SO document number (overload)

MobileServiceCase caseNo() reads any of assrNo/assr_no/docNo/doc_no — a case id and an order id are indistinguishable by field name in the same reader. Keep the two number namespaces distinct.

## Defects found in passing — 21

| Sev | File | Defect |
| --- | --- | --- |
| med | `backend/src/scm/routes/delivery-orders-mfg.ts:4365` | PUT /:id/crew updates another company's delivery_orders header and crew — no company predicate on the read or the write. |
| med | `backend/src/scm/lib/dp-no-mint.ts:72` | mintNextDpNo treats a PostgREST query error as 'no DP numbers exist yet' and mints a colliding low number, contradicting the module's own stated guarantee. |
| med | `backend/src/scm/shared/variant-key.ts:128` | Typographic inch marks in maintenance-pool values split inventory variant_key buckets: pricing tolerates them but computeVariantKey does not. |
| med | `backend/src/services/doMirror.ts:99` | doMirror's DO cancelled-detection only matches the string "T" and disagrees with the canonical isCancelled() used by every other AutoCount reader, so a boolean-cancelled Delivery Order is mirrored as NOT cancelled. |
| med | `backend/src/acc/engine.ts:372` | reverseJournal mints the contra's je_no from the ORIGINAL entry_date's month but dates the contra today, so a reversal's number-series month disagrees with its own posting date. |
| med | `frontend/src/mobile/MobileDeliveryPlanning.tsx:1378` | On the way / POD-complete DO status mutations have no error handler, so a failed tap is silent to the driver — the exact class the sibling 'arrive' mutation was just fixed for in the same file. |
| low | `backend/src/scm/routes/so-dropdown-options.ts:211` | POST / has no missing-relation fallback though the module contract promises graceful degradation. |
| low | `backend/src/scm/lib/customer-credits.ts:89` | getCustomerCreditBalance drops the query error and folds a failed read to a 0 balance, the exact anti-pattern the rest of customer-credits.ts guards against. |
| low | `backend/src/scm/lib/check-stock-availability.ts:126` | checkStockAvailability's cross-warehouse 'alternatives' hint scans inventory_balances/warehouses with no company predicate, so it can surface another company's warehouse and stock quantity. |
| low | `backend/src/scm/lib/si-payment-row.ts:1910` | insertSiPaymentRow writes company_id unconditionally, so a null/undefined companyId inserts an UNSCOPED payment row — the exact tenant-boundary hole its sibling so-payment-row.ts guards against. |
| low | `backend/src/scm/shared/schemas/order.schema.ts:87` | order.schema.ts paymentMethod enum uses a payment vocabulary ('credit'/'debit') that contradicts the canonical PaymentMethodCode set. |
| low | `backend/src/services/po.ts:151` | runPOPull reports `inserted` as batch length even though the INSERT uses ON CONFLICT(doc_no,item_code) DO NOTHING, so duplicate (doc_no,item_code) lines are silently dropped while counted as inserted. |
| low | `backend/src/services/salesEntries.ts:51` | replaceItems/replacePayments take companyId as an OPTIONAL param; when a caller omits it the company_id column is dropped and the row is written unscoped — the optional-param-noop class CLAUDE.md warns about. |
| low | `backend/src/acc/payments.ts:201` | backfillSoPayments pages journal_entries with .range() but no .order(), so PostgREST may skip/overlap rows and the postedIds set can be incomplete. |
| low | `frontend/src/pages/scm-v2/sales-doc-relationship-map.ts:231` | Sibling relationship-map builders disagree on the Customer-PO fallback order: buildSiChainNodes prefers customer_so_no over po_doc_no, while buildDoChainNodes and useSoRelationshipMap prefer po_doc_no over customer_so_no. |
| low | `frontend/src/vendor/scm/lib/verified-save.ts:99` | verifiedSave object-field comparison is key-order sensitive, so a genuinely-saved object field can be reported as a 'mismatch' (save not stuck). |
| low | `frontend/src/vendor/scm/lib/warehouse-queries.ts:177` | Stock-moving rack mutations (stock-in/out, create/update) carry onSuccess but no onError, unlike sibling useTransfer — the documented silent-mutation class on a stock path. |
| low | `frontend/src/lib/scm.ts:60` | isCancelledDocStatus counts legacy 'cancel' as cancelled, but scmStatusClasses has no CANCEL case, so a legacy-cancelled SO row is muted yet gets a neutral (not red/err) status pill. |
| low | `frontend/src/components/scm-v2/PoAmendmentCreateModal.tsx:43` | PoAmendmentCreateModal parses buyer money with Math.round(n*100) and Number(myr), the exact float-multiply + silent-NaN pattern money.ts was written to replace. |
| low | `backend/src/db/migrations-pg/0177_scm_warehouse_type_and_unify.sql:2` | Migration 0177's header comment mislabels the file as '0171', a self-contradiction: the file is 0177_scm_warehouse_type_and_unify.sql but its first line reads '-- 0171 — Warehouse TYPE enum + master-list unification'. Other migrations reference siblings by number in prose, so a reader tracing 'mig 0171' lands on the wrong file / a reader of 0177 sees the wrong id. |
| low | `backend/src/db/migrations-pg/0177_scm_warehouse_type_and_unify.sql:76` | In 0177 the comment 'Keep is_showroom = (type = \'showroom\') as an invariant ... this line covers the other direction so a future is_showroom flip still updates type' sits directly above a plain CREATE INDEX idx_warehouses_type, which performs no is_showroom<->type sync. The claimed reverse-sync does not exist here; it is only actually established later by the trigger in 0186. Between 0177 and 0186 an is_showroom flip does NOT update type despite the comment's promise. |

## Doc-drift

- **docs/modules/sales-order.md** — claim: Status table line 101: '`IN_PRODUCTION` | proceeded | `PATCH /:docNo/status` — this is the transition that stamps `proce / reality: The slice states proceeded_at is no longer written by ANY path: so-processing-date.ts:116-124 ('every WRITE went with the reader … the /status IN_PRODUCTION sta
