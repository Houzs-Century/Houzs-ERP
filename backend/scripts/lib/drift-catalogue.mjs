/* ---------------------------------------------------------------------------
   drift-catalogue.mjs - the WORKLIST of concepts carrying more than one spelling
   across the system, produced by the 2026-08-18 full-codebase screening.

   REFERENCE, not enforcement. The guard (check-vocabulary.mjs) acts only on
   VOCABULARY in vocabulary.mjs, where a spelling has actually been RETIRED. These
   concepts are documented so a human can look up the agreed word today and the
   glossary can print them - nothing is retired here, because retiring a live column
   is a migration (batch 2), one concept per PR.

   `seen` = spellings the screening found in the tree. `canonical` = the target.
   Casing-only pairs (processing_date vs processingDate) are NOT here: one word.
   --------------------------------------------------------------------------- */

export const DRIFT_CATALOGUE = [
  {
    concept: "Money minor unit (1/100 MYR)",
    canonical: "*_sen",
    severity: "high",
    seen: ["*_centi (unit_price_centi, total_centi, balance_centi, amount_centi, deposit_centi)", "*_sen (unit_cost_sen, total_cost_sen, sell_price_sen, base_price_sen, divan_price_sen, leg_price_sen, special_order_price_sen)", "*_cents (amount_cents)", "amountSen / totalSen / senToRm / parseMoneyToSen / MAX_SEN"],
    note: "Both words mean 1/100 MYR = sen. Same value spelled both ways within single files (pi-audit-trail labels the total_centi column 'INTEGER SEN'; delivery-orders-mfg:4804 does the same; recost converts with toMyrSen yet writes unit_cost_sen while cascading into *_centi documents). Rough de-facto split: documents/GL use _centi (~50 route files), inventory/costing/pricing use _sen (27 files), but there is NO rule. money.ts (the canonical parser) speaks sen; scm.ts speaks centi. Biggest single confusion source. DECIDED 2026-08-18: target is _sen (the Malaysian subunit, what AutoCount speaks and what the GL/inventory/pricing subsystems already use); _centi is the drift despite being the majority. Storage stays an INTEGER minor unit (not a decimal); display formats it as RM at the edge. Batch 2 migrates the _centi columns to _sen.",
  },
  {
    concept: "Salesperson / sales rep",
    canonical: "salesperson_id",
    severity: "high",
    seen: ["salesperson_id (scm.staff uuid — the real identity)", "agent (mfg_sales_orders free-text, legacy)", "sales_reps / rep_id / SR-code (legacy public integer roster)", "sales_agent / SalesAgent (AutoCount mirror)", "salesRep / salespeople / 'SALES PERSON'"],
    note: "Three genuinely different identifiers actively reconciled at runtime. consignment-orders stamps BOTH agent and salesperson_id on one insert; so-confirm-gate:2811 accepts 'either identifier'; salesScope maps to a THIRD (sales_reps integer id). salespersonId is just the camel twin, not the drift.",
  },
  {
    concept: "Delivery date (customer promise / per-line / effective)",
    canonical: "customer_delivery_date (header) / line_delivery_date (line)",
    severity: "high",
    seen: ["customer_delivery_date (SO header)", "line_delivery_date vs delivery_date (sales line vs purchase line — same fact)", "amended_delivery_date", "expected_at (PO header)", "supplier_delivery_date_2/3/4", "SalesExemptionExpiryDate (AutoCount UDF that holds it)", "customer_delivered_date", "effective_delivery_date", "ddate"],
    note: "autocount-convert-lines:52-56 states it plainly: line_delivery_date on a sales line and delivery_date on a purchase line are 'the same fact under two column names'. so-edit-header stuffs customer_delivery_date into a UDF literally named SalesExemptionExpiryDate. expected_at + supplier_delivery_date_2/3/4 fold into one 'effective delivery'. customerDeliveryDate casing is not the drift.",
  },
  {
    concept: "Processing date (release-to-purchasing signal)",
    canonical: "processing_date",
    severity: "high",
    seen: ["processing_date (canonical after 0286)", "internal_expected_dd (retired 0286, still read)", "proceeded_at (timestamp twin, being retired)", "PDate (AutoCount UDF)", "target_date (marketing stamp)", "so_processing_date (derived API field)"],
    note: "Migrations 0284-0286 explicitly collapsed internal_expected_dd -> processing_date as 'one name', but internal_expected_dd, proceeded_at and PDate still appear in live reads across be-lib, mobile and scmv2. processingDate is only the camel twin (not drift).",
  },
  {
    concept: "Customer's own reference / their PO number",
    canonical: "customer_so_no",
    severity: "high",
    seen: ["customer_so_no (only surface still written after PR #140)", "po_doc_no", "customer_po / customer_po_id / customer_po_date", "ToPONo (AutoCount UDF)", "ref", "poRef / customerSoRef"],
    note: "autocount-outbox:304-308 — three columns have each held the customer's ref; reading po_doc_no alone 'sent ToPONo nowhere'. Front-end assembles the same node under 3 names AND 3 DIFFERENT fallback orders (po_doc_no||customer_so_no vs customer_so_no||po_doc_no) — a live precedence bug, not just naming.",
  },
  {
    concept: "Product / item / material code (SKU)",
    canonical: "item_code",
    severity: "high",
    seen: ["item_code (SO/DO/SI/IV lines)", "material_code (PO/GR/PI lines)", "product_code (inventory_movements/lots)", "code", "sku"],
    note: "One SKU under three table-family names. LINE_CODE_COL and DocumentLinesExpansion exist solely to bridge them (code = material_code||item_code||product_code). itemCode/materialCode casing twins are not the drift.",
  },
  {
    concept: "Warehouse / location an order ships from",
    canonical: "warehouse_id",
    severity: "high",
    seen: ["warehouse_id (line)", "sales_location (SO header free-text)", "purchase_location_id (PO header)", "Location / SalesLocation (AutoCount)", "'stock location' / 'warehouse' (labels)", "primaryWh", "showroom_warehouse_id"],
    note: "'Which building ships' resolved from free-text sales_location, per-line warehouse_id, and PO-side purchase_location_id, then mapped to AutoCount SalesLocation/Location. so-form-validate calls it 'stock location', 'warehouse' AND 'Sales Location' in three adjacent strings. salesLocation casing is not the drift.",
  },
  {
    concept: "Customer / debtor",
    canonical: "debtor_code / debtor_name",
    severity: "high",
    seen: ["debtor_code / debtor_name (SO/SI header + AutoCount mirror)", "customer_id / customer_name (mfg_sales_orders, fulfilment agent)", "DebtorName / Attention (AutoCount)", "hasCustomerName / MISSING_CUSTOMER_INFO", "recipientName (email)"],
    note: "debtor and customer are the same AR party. acSnapshot/doMirror store debtor_name; order-fulfilment calls the same field hasCustomerName; payments books the AR party from debtor_code on the SI path but customer_name on the SO path. customerName casing is not the drift.",
  },
  {
    concept: "Supplier / creditor",
    canonical: "creditor_code / creditor_name",
    severity: "high",
    seen: ["creditor_code / creditor_name (case + PO)", "supplier / supplier.code (PV/PI lines)", "main_supplier / MainSupplier (stock item link)", "payee_name", "company_name AS supplier_name"],
    note: "stockItems writes main_supplier then copies it into assr_cases.creditor_code; po.ts carries creditor_code in the same row; PV lines take supplier{code,name}+payee_name; finance drill reads company_name AS supplier_name. One entity, 4+ words in adjacent columns. missing-creditor reason-code vs 'supplier' UI label.",
  },
  {
    concept: "Product brand / branding",
    canonical: "branding",
    severity: "med",
    seen: ["branding", "brand", "item_brand", "first_item_branding", "SOUDF_BRANDING / BRANDING / BRANDING_MAP"],
    note: "item_brand is a genuinely different column name for the brand carried elsewhere as branding/brand/first_item_branding. KEEP SEPARATE (homonym, not drift): the be-services 'Branding' company-identity block (companyName/registrationNo/logo_r2_key, keyed branding:<CODE>) is a DIFFERENT concept sharing the word — do not merge it in.",
  },
  {
    concept: "Venue",
    canonical: "venue (text) + venue_source for provenance",
    severity: "med",
    seen: ["venue (mfg_sales_orders / projects free text — authoritative)", "venue_id (FK to scm.venues — a dead FK)", "venue_name (warehouses)", "project_venues (real master, INTEGER id)", "scm.venues ('empty uuid table')", "venue_source (PMS|SHOWROOM|MANUAL)"],
    note: "One concept across three physical stores; fair-report:540 and MobileFairReport:109 both mark venue_id a 'dead scm.venues FK' with the TEXT venue authoritative. canonical-venue folds mfg_sales_orders.venue and warehouses.venue_name to one name. Retire venue_id. venueId casing is not the drift.",
  },
  {
    concept: "Sofa fabric / colour code (variant axis)",
    canonical: "fabricCode",
    severity: "med",
    seen: ["fabricCode", "colorCode", "colourCode", "fabricColor", "fabric_code", "colourLabel", "colourId"],
    note: "Five aliases of ONE axis (American/British color/colour AND fabric*/color*), reconciled by an alias list (FABRIC_CODE_KEYS) in every module; GRN editors store fabricColor, SO editors fabricCode. NB fabricCode (cost axis) vs fabricId (selling axis) is a REAL distinction, not drift — do not collapse those two.",
  },
  {
    concept: "Payment method vocabulary",
    canonical: "cash / transfer / merchant / installment",
    severity: "med",
    seen: ["merchant / transfer / installment / cash (payment-methods.ts)", "credit / debit / installment / transfer (order.schema.ts)", "Cash / Merchant / Online / Installment (labels)", "method / payment_method"],
    note: "payment-methods.ts:41 defines merchant/transfer/installment/cash, but schemas/order.schema.ts:87 validates paymentMethod against credit/debit/installment/transfer — a credit/debit vocabulary that exists nowhere else and can reject valid orders. payment_method vs paymentMethod casing is not the drift.",
  },
  {
    concept: "Payment merchant / acquirer / bank",
    canonical: "merchant_provider",
    severity: "med",
    seen: ["payment_merchant (dropdown category)", "merchant_provider (delivery_order_payments column)", "bank (editor state + 'Bank' label)", "acquirerCode (daily-bank)", "display_name (acquirer master)"],
    note: "One acquirer under four names across the posting/reconciliation path. merchantProvider casing is not the drift.",
  },
  {
    concept: "Document-number suffix convention",
    canonical: "*_no (choose ONE suffix project-wide)",
    severity: "med",
    seen: ["*_number (po_number, do_number, grn_number, return_number, invoice_number)", "*_no (transfer_no, customer_so_no)", "doc_no (SO PK)", "*_doc_no (references to a doc: so_doc_no, po_doc_no, do_doc_no)"],
    note: "reconcile-ledger:2116-2124 reads transfer_no in the same list where every sibling uses *_number. A doc's own number is split between _no and _number with no rule; distinct from the customer-PO-ref drift. poNumber/poDocNo casing is not the drift.",
  },
  {
    concept: "Quantity (received / accepted)",
    canonical: "qty (+ explicit accepted/received qualifier)",
    severity: "med",
    seen: ["qty", "qty_accepted (GRN line)", "received_qty / qty_received", "invoiced_qty", "qty_returned / returned_qty", "TransferedQty", "RemainingQty / remaining_qty"],
    note: "A GRN line's shipped quantity is qty_accepted while everywhere else it is qty (itemQtyCol/sourceQtyCol pair exists only to bridge). received_qty vs qty_received and qty_returned vs returned_qty are word-order drift for one field.",
  },
  {
    concept: "Stock readiness status",
    canonical: "stock_status",
    severity: "med",
    seen: ["stock_status (READY/PARTIAL/PENDING)", "stock_state (stock/po/shortage)", "stock_status_effective", "stock_remark"],
    note: "Two spellings AND two value vocabularies for line readiness, plus a derived stock_status_effective; consumers dual-read stock_status ?? stock_state.",
  },
  {
    concept: "Free-text note / remark",
    canonical: "note",
    severity: "med",
    seen: ["note", "notes", "remark", "remark2 / remark3 / remark4", "narration (accounting)"],
    note: "do-audit-fields:34 audits BOTH ['note','note'] and ['notes','notes'] on the SAME Delivery Order; consignment/amendment lines use remark; GL uses narration. Separately, remark2/remark4 ('Remark 2'/'Remark 4') have become load-bearing status carriers — a distinct risk from the note/notes/remark drift.",
  },
  {
    concept: "Batch / dye-lot (overloaded onto PO number)",
    canonical: "batch_no",
    severity: "med",
    seen: ["batch_no (inventory_lots = source PO number)", "allocated_batch_no (SO line)", "committed_po_batch_no (DO line)", "expectedBatchNo", "poNumber (= the batch_no the GRN will stamp)"],
    note: "batch_no literally holds the source PO number, and the same physical dye-lot is allocated_batch_no on the SO line, committed_po_batch_no on the DO line, and poNumber at GRN time. Four names + a value overload.",
  },
  {
    concept: "Address (structured vs single)",
    canonical: "address1..4",
    severity: "med",
    seen: ["address1 / address2 / address3 / address4 (supplier)", "addr1..4 (assr)", "address / addr1 (legacy single)", "ship_to_address / bill_to_address / install_to_address", "venue_address"],
    note: "Supplier structured address1-4 vs legacy single 'address'; assr uses addr1-4. The ship/bill/install variants are DISTINCT addresses (not drift); the address-vs-address1 split is the drift.",
  },
  {
    concept: "Customer / address state",
    canonical: "customer_state",
    severity: "med",
    seen: ["customer_state", "state", "location (assr party)"],
    note: "do-audit maps customerState->customer_state yet also audits state->state; dp-party reads customer_state on the SO but state on supplier/warehouse/workshop and location on the assr — one address-state field. customerState casing is not the drift.",
  },
  {
    concept: "Transport cost slug",
    canonical: "SVC-TRANS SKU (there is NO transport column; it is a service SKU)",
    severity: "med",
    seen: ["transport_pct (rate input)", "transport_fee (category slug written)", "auto:transport (auto_source tag)", "transport_setup_dismantle (manual cost slug)"],
    note: "projectCostRates' own comment records the split: the slug moved transport->transport_fee, the auto_source tag stayed auto:transport, and transport_setup_dismantle holds the human-entered logistics cost. Four spellings of transport in one file.",
  },
  {
    concept: "2990 company / brand name (master data)",
    canonical: "2990",
    severity: "med",
    seen: ["2990", "2990s", "2990's", "2990 Sofa", "2990s Sofa", "2990 Mattress"],
    note: "so-branding-label:71-75 documents a regex that folded 2990/2990's/2990s together and a sofa label spelled both '2990 Sofa' and '2990s Sofa' across master data and code before the 2026-08-18 unification. Partly fixed — verify no residue in seed/master rows.",
  },
  {
    concept: "Sofa seat-height axis",
    canonical: "seatHeight",
    severity: "med",
    seen: ["seatHeight (backend)", "depth (POS configurator)"],
    note: "so-variant-rule aliases depth->seatHeight; variant-key and sofa-combo-pricing each re-implement depth ?? seatHeight. Every POS sofa order once 409'd variants_incomplete because of this split.",
  },
  {
    concept: "Sofa compartment / module code",
    canonical: "compartment",
    severity: "med",
    seen: ["compartment (base code)", "moduleId / moduleCode", "compartmentId", "buildKey", "cells[].moduleId"],
    note: "The sofa sub-unit is 'compartment' in the base code but moduleId/moduleCode/compartmentId/buildKey elsewhere; normalizeCompartmentCode also folds 1A(LHF)/1A-LHF formats.",
  },
  {
    concept: "Shipped-status display label (homonym collision)",
    canonical: "distinguish the two labels",
    severity: "med",
    seen: ["SO.SHIPPED -> 'Shipped'", "DO.DISPATCHED -> 'Shipped'"],
    note: "status-pill:65 vs :76 render two DISTINCT stored states as the identical word 'Shipped'; SO has no DISPATCHED and DO has no SHIPPED, so one word means different states in reports. A label collision, not a stored-column drift.",
  },
  {
    concept: "Sofa leg-height axis",
    canonical: "legHeight",
    severity: "low",
    seen: ["legHeight (backend)", "sofaLegHeight (POS configurator)"],
    note: "sofaLegHeight->legHeight aliased three ways (input.sofaLegHeight ?? input.legHeight). Same POS/backend vocabulary split as seat height.",
  },
  {
    concept: "Exchange / FX rate",
    canonical: "exchange_rate",
    severity: "low",
    seen: ["exchange_rate (PI/PV/GRN column)", "rate_to_myr", "operatorRate / masterRate / grnRate / piRate (function-locals)", "fxRate / exchangeRate"],
    note: "exchange_rate is the column; rate_to_myr is a genuinely different name for the same FX rate, and the *Rate function-locals proliferate. exchangeRate/fxRate is casing/synonym; rate_to_myr is the real drift.",
  },
  {
    concept: "Payment slip / proof / R2 media key",
    canonical: "*_r2_key (per artifact type)",
    severity: "low",
    seen: ["slip_key AND slip_image_key (payment proof, dual-read)", "podKey / pod_r2_key / r2Key (POD)", "photoRef (mileage)", "logoR2Key / print_logo_r2_key / letterheadLogoKey (branding logo)"],
    note: "R2-key naming has no convention: the same payment proof is slip_key and slip_image_key; POD, mileage and logo each invent their own. slipKey casing is not the drift.",
  },
  {
    concept: "Paid total (running paid figure)",
    canonical: "paid_total_centi",
    severity: "low",
    seen: ["paid_centi", "paid_total_centi", "paidCenti"],
    note: "ConsignmentOrders reads paid_total_centi ?? paid_centi ?? 0 while the aggregate uses paidCenti — three spellings for one figure in a single file (on top of the system-wide sen/centi unit drift).",
  },
  {
    concept: "Installment / online payment sub-fields",
    canonical: "installment_months / online_type",
    severity: "low",
    seen: ["installment_plan (dropdown) vs installment_months (payment row)", "online_type / onlineType"],
    note: "Tenure is installment_plan in the dropdown category but installment_months on the payment row — genuine drift. online_type/onlineType is casing (not drift).",
  },
  {
    concept: "Amendment SO_APPROVED label",
    canonical: "one label per context, documented",
    severity: "low",
    seen: ["'SO Approved' (granular map)", "'Applied' (lane map)"],
    note: "status-pill:118 vs :129 — the SAME stored status SO_APPROVED renders 'SO Approved' or 'Applied' depending on whether so_amendments.lane is set. Intentional but undocumented.",
  },
  {
    concept: "ASSR case number vs SO document number (overload)",
    canonical: "assr_no (cases) / doc_no (SO)",
    severity: "low",
    seen: ["assr_no / assrNo (case)", "doc_no / docNo (SO PK, and reused for cases)", "case_no"],
    note: "MobileServiceCase caseNo() reads any of assrNo/assr_no/docNo/doc_no — a case id and an order id are indistinguishable by field name in the same reader. Keep the two number namespaces distinct.",
  },
];
