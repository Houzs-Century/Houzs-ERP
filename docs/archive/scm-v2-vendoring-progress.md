> **ARCHIVED 2026-08-13.** Vendoring finished: zero `/scm/*-v2` routes remain in `frontend/src/App.tsx`, and the native `pages/scm/` tree this file calls "untouched" has since been deleted. Superseded by `docs/CODEBASE-MAP.md` §3. (Moved out of `frontend/src/pages/scm-v2/` on 2026-08-13.) Kept for history; do not follow it as a current instruction.

# SCM 2990-vendoring progress (Houzs)

Goal: replace native `/scm/*` pages with 2990's ACTUAL pages (verbatim layout, Houzs backend).
Vendored pages live in `pages/scm-v2/`, mounted at temporary `/scm/<x>-v2` routes (additive; native untouched).
Verify locally: `npm run dev`, inject `auth:token` from a prod tab into `localhost:5173` localStorage, open `/scm/<x>-v2`.

## DONE (vendored + routed + render-verified or build-green)
- Suppliers (list + detail)  /scm/suppliers-v2 (+/:id)
- Purchase Orders: list / new / detail / from-so
- Goods Received (GRN): list / detail / new / from-po
- Purchase Invoices (PI): list / detail / new / from-grn
- Purchase Returns (PR): list / detail / new
- Stock Adjustments: list / new
- Stock Transfers: list / new / detail
- Stock Takes: list / new / detail
- Inventory hub + Stock Card
- Warehouses
- MRP, Accounting, Outstanding, Fabric Tracking
- Product Models: list / detail
- Drivers
- Sales Invoices (SI): list (/scm/sales-invoices-v2) + new + from-do + detail (/:id)
- Delivery Returns (DR): list (/scm/delivery-returns-v2) + new + from-do + detail (/:id)
  - Note: sales-invoice-queries.ts owns DoRemainingLine + the invoiceable picker;
    delivery-return-queries.ts re-exports the type + re-exports useMfgDeliveryOrderDetail
    from the DO slice. SI list renderPdf repointed off supabase → authedFetch.
    sales-invoice-pdf + delivery-return-pdf STUBBED (jspdf). Finishes the sales chain.
- Sales Orders READ side: list (/scm/sales-orders-v2) + detail (/:docNo) + maintenance (/maintenance)
  - Note: live SalesOrderDetail.tsx is the pre-extraction MONOLITH (defines its
    cards/VariantsPills/TotalsCard/OverridePriceModal/HistoryPanel inline); the
    2990 pages/sales-order/* subcomponents are DEAD (imported by nothing) and were
    NOT vendored. SoLineCard + PaymentsTable + SlipUploadField + PromptDialog +
    ListingPickerDialog vendored; ScanOrderModal STUBBED (OCR → SO-create wave),
    sales-order-pdf STUBBED (jspdf), Toast SHIMmed → useNotify, useStaff /
    useFabricColoursActive / useModelAllowedOptionsByCode return empty (were
    supabase-direct).

## REMAINING (Phase 1 — vendor the page)
- Sales Orders WRITE side: new (sofa configurator) / from-products (LATER wave)
  - NOTE: Consignment ORDER new (below) is the FIRST create-form vendored — it
    proved out PaymentsTable+SoLineCard in draft mode against the vendored auth
    bridge; the real SO new can follow the same path.
- Consignment ORDERS + NOTES (sales-side) — DONE this wave:
  - ORDERS: list (/scm/consignment-v2) + new (/new) + detail (/:docNo)
  - NOTES:  list (/scm/consignment-note-v2) + new (/new) + from-order (/from-order) + detail (/:id)
  - Vendored vendor/scm/lib/consignment-order-queries.ts + consignment-note-queries.ts
    (supabase dropped; all reads/writes + the per-line photo multipart POST route
    through authedFetch; serviceNotify bridged). Pages reuse SoLineCard /
    PaymentsTable / PhoneInput / DataGrid / ListingPickerDialog UNCHANGED.
  - sales-order-pdf stub gained a 6th optional docOptions arg (CO relabel);
    delivery-order-pdf stub already had the 3rd opts arg (CN relabel). Both still throw.
  - vendor/scm/lib/auth.ts StaffProfile extended with optional name/staffCode/venueId
    (bridge returns null) so the create form's locked-Salesperson + venue seed compile.
  - ConsignmentNoteDetail's "Issue return" still points at /consignment-return/new
    (NOT -v2) — Consignment RETURNS are the next wave.
- Consignment RETURNS + Purchase-Consignment ORDERS — DONE this wave:
  - RETURNS: list (/scm/consignment-return-v2) + new (/new) + from-note (/from-note) + detail (/:id)
  - PC ORDERS: list (/scm/purchase-consignment-v2) + new (/new) + detail (/:id)
  - Vendored vendor/scm/lib/consignment-return-queries.ts (DR-clone, supabase dropped)
    + purchase-consignment-order-queries.ts (PO-clone, supabase import dropped; reuses
    suppliers-queries PO types). Both route through authedFetch + serviceNotify.
  - New component PcVariantEditor vendored (only SO-CSS import path repointed); reuses
    SoLineCard / PaymentsTable / DataGrid / MoneyInput / ActionResultDialog / etc. UNCHANGED.
  - delivery-return-pdf stub gained an optional 3rd opts arg (CR relabel: docTitle/
    docNoLabel/amountLabel/totalLabel); CR detail Print reuses it. purchase-order-pdf
    stub reused as-is for the PC-order Print. Both still throw (jspdf not installed).
  - PC-Order Detail's "Receive Goods" / "Raise Return" buttons NOW repointed to
    /scm/purchase-consignment-receive-v2/new + /scm/purchase-consignment-return-v2/new
    (done in the receives/returns wave below).
- Purchase Consignment RECEIVES + RETURNS — DONE this wave (finishes consignment):
  - RECEIVES: list (/scm/purchase-consignment-receive-v2) + new (/new) + from-pc-order
    (/from-pc-order) + detail (/:id)
  - RETURNS:  list (/scm/purchase-consignment-return-v2) + new (/new) + from-receive
    (/from-receive) + detail (/:id)
  - Vendored vendor/scm/lib/purchase-consignment-receive-queries.ts (GRN-clone) +
    purchase-consignment-return-queries.ts (PR-clone). Both: supabase import dropped
    (was unused — all calls already went through authedFetch), route through
    authedFetch + serviceNotify.
  - No new components/utils needed — pages reuse DataGrid / MoneyInput / ConfirmDialog /
    NotifyDialog / StatusPill / RelationshipMapButton / Skeleton / ActionResultDialog /
    PcVariantEditor + lib (suppliers/mfg-products/fabric/inventory/category-badges/dates/
    status-pill/purchase-consignment-order) UNCHANGED.
  - PDF: ReceiveDetail Print reuses the grn-pdf stub ({docTitle:'CONSIGNMENT RECEIVE',
    docNoLabel:'Receive No'}); ReturnDetail Print reuses the purchase-return-pdf stub
    ({docTitle:'PURCHASE CONSIGNMENT RETURN', docNoLabel/amountLabel/totalLabel}). Both
    stubs already had the matching opts signatures — NO stub changes. Both still throw
    (jspdf not installed); dynamic-import paths repointed ../lib → ../../vendor/scm/lib.
  - Cross-links: ReceiveDetail "Raise Return" → /scm/purchase-consignment-return-v2/new
    ?fromPcReceive; ReceiveNew/ReturnNew from-pickers → -v2. All repointed.
  - tsc + build both green. CONSIGNMENT VERTICAL COMPLETE.
- Products (single ~4822-LOC page) — DONE this wave  /scm/products-v2
  - Page `pages/scm-v2/Products.tsx` (SKU Master + Modular + Order Add-ons +
    Maintenance + Combo Pricing + Fabric Converter tabs) + colocated CSS.
  - New components vendored: vendor/scm/components/SofaComboTab.tsx +
    SpecialAddonsTab.tsx (both reuse DataGrid/DateField/Notify/Confirm UNCHANGED).
  - New query module vendor/scm/lib/sofa-combos-queries.ts (supabase import dropped
    — was unused; all hooks already authedFetch). mfg-products-queries.ts EXTENDED
    with the SKU price/CRUD/maintenance/photo/special-addon hooks Products needs.
  - New shared modules vendored: sofa-build / sofa-combo-pricing / sofa-quick-presets
    / sofa-tier (barreled in vendor/shared/index.ts; sofa-combo-pricing NOT starred
    to avoid the SofaComboRow/comboChargedPrices re-export clash — its 2 needed
    symbols named-re-exported).
  - verified-save VENDORED (localStorage token + /api/scm base; supabase auth
    dropped) — backs useUpdateMfgProductPrices' write→readback→compare.
  - Order Add-ons (`addons` table) hooks STUBBED (no supabase, no /api/scm addons
    route): read=empty, write=friendly notify. xlsx workbook import STUBBED
    (vendor/scm/lib/xlsx-stub.ts → "use CSV"); CSV import path works.
  - **UN-STUBBED SupplierDetail**: its Maintenance + Combo Pricing tabs now import
    the REAL MaintenanceTab (from ./Products) + SofaComboTab (from vendored
    components); SupplierDetailStubs.tsx DELETED.
  - 1-line strict-compat fix in vendored sofa-build.ts (`base` annotated
    `EdgeType[] | undefined`; Houzs lacks 2990s's noUncheckedIndexedAccess).
  - tsc + build both green.
- Reports: sales-order / delivery-order / sales-invoice / delivery-return detail-listings

## BACKEND RECONCILE (mount/port on /api/scm — vendored FE calls these but backend lacks)
- `/outstanding/:module` + `/outstanding/summary`  (Outstanding page shows all 0 until mounted)
- `GET /fabric-library`  (ProductModelDetail sofa "fabrics offered" checklist empty)
- `GET /localities`  (SupplierDetail MY postcode cascade; falls back to free-text)
- Verify all other flagged endpoints exist (PO/GRN/PI/PR/stock/inventory/product-models — believed mounted).

## STUBS / SHIMS to resolve (Phase 2)
- PDF export STUBBED (jspdf not installed): PO, GRN, PI, PR (+ future DO/SI). Enable: `npm i jspdf jspdf-autotable`, vendor real *-pdf modules, unstub.
- xlsx import STUBBED (SupplierDetail bindings .xlsx + Products SKU .xlsx import → vendor/scm/lib/xlsx-stub.ts): `npm i xlsx`, repoint dynamic imports back to `'xlsx'`.
- Products Order Add-ons (`addons` table) STUBBED — needs an `/api/scm/addons` route (then swap the 4 stub hooks in mfg-products-queries.ts for authedFetch).
- SupplierDetail Maintenance + Combo Pricing tabs — UN-STUBBED (Products wave); SupplierDetailStubs.tsx deleted.
- react-virtual + clsx already shimmed in vendor/design-system + vendor/scm/lib.

## PHASE 2 (after all pages vendored)
1. Backend reconcile (above).
2. PDF/xlsx enable.
3. Swap nav + routes: native `/scm/*` -> vendored; delete native pages; drop `-v2` suffix.
4. Polish: StockAdjustmentNew still uses window.alert/confirm (verbatim) -> in-app dialog; decide fonts (2990 Poppins vs Houzs Manrope) + colors (2990 vs Houzs brass).
