import { Hono } from "hono";
import type { Env } from "./env";

import { products } from "./routes/products";
import { categoriesApi, publicCategoriesApi } from "./routes/categories";
import { deliveryFees } from "./routes/delivery-fees";
import { fabricTierAddonConfig } from "./routes/fabric-tier-addon";
import { posPools } from "./routes/pos-pools";
import { sofaQuickPicks } from "./routes/sofa-quick-picks";
import { modelFreeGifts } from "./routes/model-free-gifts";
import { posCart } from "./routes/pos-cart";
import { personalQuickPicks } from "./routes/personal-quick-picks";
import { salesAnalysis } from "./routes/sales-analysis";
import { pwpRules } from "./routes/pwp-rules";
import { pwpCodes } from "./routes/pwp-codes";
import { specialAddons } from "./routes/special-addons";
import { fabricLibrary } from "./routes/fabric-library";
import { mfgProducts } from "./routes/mfg-products";
import { productModels } from "./routes/product-models";
import { sofaCompartmentPhotos } from "./routes/sofa-compartment-photos";
import { maintenanceConfig } from "./routes/maintenance-config";
import { sofaCombos } from "./routes/sofa-combos";
import { sofaComboPresets } from "./routes/sofa-combo-presets";
import { fabricTracking } from "./routes/fabric-tracking";
import { suppliers } from "./routes/suppliers";
import { mfgPurchaseOrders } from "./routes/mfg-purchase-orders";
import { mfgPurchaseOrdersListEnrichment } from "./routes/mfg-purchase-orders-list-enrichment";
import { poLineImport } from "./routes/po-line-import";
import { purchaseOrderItemPhotos } from "./routes/purchase-order-item-photos";
import { purchaseOrderExports } from "./routes/purchase-order-exports";
import {
  CANCEL_REQUEST_OPEN_READ_PATH,
  cancelApprovalGuard,
  cancelExecutionBypass,
  cancelRequestsInbox,
  poCancelRequests,
  soCancelRequests,
} from "./routes/document-cancel-routes";
import { soPaymentBackdateRequests, paymentBackdateInbox } from "./routes/so-payment-backdate-requests";
import { grns } from "./routes/grns";
import { grnsListEnrichment } from "./routes/grns-list-enrichment";
import { grnExports } from "./routes/grn-exports";
import { purchaseInvoices } from "./routes/purchase-invoices";
import { purchaseInvoicesListEnrichment } from "./routes/purchase-invoices-list-enrichment";
import { purchaseInvoiceExports } from "./routes/purchase-invoice-exports";
import { paymentVouchers } from "./routes/payment-vouchers";
import { otherDebtors } from "./routes/other-debtors";
import { apInvoices } from "./routes/ap-invoices";
import { arInvoices } from "./routes/ar-invoices";
import { creditNotes } from "./routes/credit-notes";
import { depositInvoices } from "./routes/deposit-invoices";
import { accEvents } from "./routes/acc-events";
import { officialDocs } from "./routes/official-docs";
import { supplierMaintenance } from "./routes/supplier-maintenance";
import { paymentRequests } from "./routes/payment-requests";
import { productRequests } from "./routes/product-requests";
import { receipts } from "./routes/receipts";
import { entityAuditLog } from "./routes/entity-audit-log";
import { changeLog } from "./routes/change-log";
import { autocountOutbox } from "./routes/autocount-outbox";
import { venturePortalFeed } from "./routes/venture-portal-feed";
import { currencies } from "./routes/currencies";
import { mfgSalesOrders } from "./routes/mfg-sales-orders";
import { mfgSalesOrdersListEnrichment } from "./routes/mfg-sales-orders-list-enrichment";
import { salesOrderExports } from "./routes/sales-order-exports";
import { mfgSoFairs } from "./routes/mfg-so-fairs";
import { mfgSoVpBrand } from "./routes/mfg-so-vp-brand";
import { soAmendmentLanePreview } from "./routes/so-amendment-lane-preview";
import { soAmendments } from "./routes/so-amendments";
import { soHandover } from "./routes/so-handover";
import { poAmendments } from "./routes/po-amendments";
import { stateWarehouseMappings } from "./routes/state-warehouse-mappings";
import { deliveryOrdersMfg } from "./routes/delivery-orders-mfg";
import { deliveryOrderExports } from "./routes/delivery-order-exports";
import { deliveryOrderScanToken } from "./routes/delivery-order-scan-token";
import { deliveryOrderItemPhotos } from "./routes/delivery-order-item-photos";
import { deliveryOrderPodAttempts } from "./routes/delivery-order-pod-attempts";
import { deliveryOrderPodPhotos } from "./routes/delivery-order-pod-photos";
import { salesInvoices } from "./routes/sales-invoices";
import { salesInvoiceExports } from "./routes/sales-invoice-exports";
import { deliveryReturns } from "./routes/delivery-returns";
import { purchaseReturns } from "./routes/purchase-returns";
import { grnFiles, purchaseInvoiceFiles, deliveryReturnFiles, purchaseReturnFiles } from "./routes/flow-doc-files";
import { deliveryReturnExports } from "./routes/delivery-return-exports";
import { purchaseReturnExports } from "./routes/purchase-return-exports";
import { consignmentOrders } from "./routes/consignment-orders";
import { consignmentNotes } from "./routes/consignment-notes";
import { consignmentReturns } from "./routes/consignment-returns";
import { purchaseConsignmentOrders } from "./routes/purchase-consignment-orders";
import { purchaseConsignmentReceives } from "./routes/purchase-consignment-receives";
import { purchaseConsignmentReturns } from "./routes/purchase-consignment-returns";
import { inventory } from "./routes/inventory";
import { inventoryAdjustments } from "./routes/inventory-adjustments";
import { loadingList } from "./routes/loading-list";
import { warehouse } from "./routes/warehouse";
import { stockTransfers } from "./routes/stock-transfers";
import { stockTakes } from "./routes/stock-takes";
import { accounting } from "./routes/accounting";
import { mrp } from "./routes/mrp";
import { mrpLeadTimes } from "./routes/mrp-lead-times";
import { mrpSupplierLeadTimes } from "./routes/mrp-supplier-lead-times";
import { outstanding } from "./routes/outstanding";
import { procurementOverview } from "./routes/procurement-overview";
import { logisticOverview } from "./routes/logistic-overview";
import { unbilledDeliveries } from "./routes/unbilled-deliveries";
import { localities } from "./routes/localities";
import { sgPostcode } from "./routes/sg-postcode";
import { staff } from "./routes/staff";
import { fabricColours } from "./routes/fabric-colours";
import { addons } from "./routes/addons";
import { documentFlow } from "./routes/document-flow";
import { poSoCoverage } from "./routes/po-so-coverage";
import { drivers } from "./routes/drivers";
import { soDropdownOptions } from "./routes/so-dropdown-options";
import { venues } from "./routes/venues";
import { reports } from "./routes/reports";
import { scanSo } from "./routes/scan-so";
import { scanGr } from "./routes/scan-gr";
import { scanGrCheck } from "./routes/scan-gr-check";
import { scanPi } from "./routes/scan-pi";
import { scanPiCheck } from "./routes/scan-pi-check";
import { scanPayment } from "./routes/scan-payment";
import { scanLorryInvoice } from "./routes/scan-lorry-invoice";
import { scanFilesSo, scanFilesPayment, scanFilesPv, scanFilesWorkshop } from "./routes/scan-files";
import { slips } from "./routes/slips";
import { deliveryPlanning } from "./routes/delivery-planning";
import { crewStopPhotos } from "./routes/crew-stop-photos";
import { deliveryJobProgress } from "./routes/delivery-job-progress";
import { doDeliveryIssues, soDeliveryIssues, jobDeliveryIssues, lastMileDeliveryIssues } from "./routes/delivery-issues";
import { deliveryPlanningRegions } from "./routes/delivery-planning-regions";
import { deliveryPlanningRowMarks } from "./routes/delivery-planning-row-marks";
import { deliveryRemarks } from "./routes/delivery-remarks";
import { deliveryPlanningRowOrder } from "./routes/delivery-planning-row-order";
import { deliveryResidenceRules } from "./routes/delivery-residence-rules";
import { deliveryAmendReasons } from "./routes/delivery-amend-reasons";
import { threeplCompanies } from "./routes/threepl-companies";
import { savedLocations } from "./routes/saved-locations";
import { deliveryZones } from "./routes/delivery-zones";
import { deliveryRateCards } from "./routes/delivery-rate-cards";
import { deliveryPlaces } from "./routes/delivery-places";
import { threeplDoCharges } from "./routes/threepl-do-charges";
import { driverLeave } from "./routes/driver-leave";
import { trips } from "./routes/trips";
import { tripScanToken } from "./routes/trip-scan-token";
import { dpOrders } from "./routes/dp-orders";
import { deliveryMessages } from "./routes/delivery-messages";
import { arReconciliation } from "./routes/ar-reconciliation";
import { lorryCapacity } from "./routes/lorry-capacity";
import { lorryRoutes } from "./routes/lorry-routes";
import { helpers } from "./routes/helpers";
import { lorries } from "./routes/lorries";
import { lorryServiceRecords } from "./routes/lorry-service-records";
import { soSettings } from "./routes/so-settings";
import { freeItemCampaigns } from "./routes/free-item-campaigns";
import { quotes } from "./routes/quotes";
import { hr } from "./routes/hr";

import { scmAreaGuard } from "./middleware/area-guard";
import { hasPositionCapability } from "../services/positionCapabilities";
import { isSalesDirectorUser } from "../services/pmsAccess";
import { isTripLocationPing } from "./lib/tripLocation";
import { scmWriteFreeze } from "./lib/write-freeze";
import { venturePortalKick } from "./lib/venture-portal-kick";
import { forgetLiveMrpOnWrite } from "./lib/live-mrp-memo";
import { migratedSoReadonly, migratedSoAmendmentReadonly } from "./lib/migrated-so-readonly";
import { writeFreezeStatus } from "./routes/write-freeze-status";

export const scm = new Hono<{ Bindings: Env }>();

/* ── GLOBAL WRITE FREEZE (owner 2026-08-10, go-live cutover) ────────────────
   Non-GET requests are refused with 503 while app_config['scm.write_freeze']
   is '1', so staff edits stop drifting the data being migrated from AutoCount
   (the AutoCount side is already frozen). Reads stay open; owner / scm.admin
   bypass so IT can still correct data. Toggle with the set-write-freeze
   workflow — no deploy needed. Mounted FIRST so it covers every sub-router.

   The value also carries a PER-MODULE staged lift ('1 - scm.sales.orders' =
   company 1 frozen except sales orders), keyed on the same L2 areas the guards
   below use. Grammar, the UPDATE for each stage, and the rollback:
   docs/write-freeze-staged-lift.md. */
scm.use('/*', scmWriteFreeze());

/* ── VENTURE PORTAL FEED: SEND WITHIN SECONDS (owner 2026-09-13) ────────────
   After a successful non-GET, schedule the Venture Portal outbox drain instead
   of leaving it to the five-minute cron — the owner's 「我要秒级 update 的」.
   Mounted HERE, immediately after the freeze, for two reasons: a frozen write
   returns 503 without calling next(), so the kick is not even entered for a
   save that did not happen; and one mount covers every router that can touch a
   sales order, which a per-handler call could not. It runs AFTER next(), it can
   never fail the request, and both cron sweeps stay exactly as they were — they
   are the zero-loss guarantee and this is only the accelerator. Cost of an idle
   kick, and what it cannot see: lib/venture-portal-kick.ts. */
scm.use('/*', venturePortalKick());

/* HC-0002: the SO list and detail share one live MRP run for 30s per isolate;
   a successful write here drops it so the next read is fresh. lib/live-mrp-memo.ts. */
scm.use('/*', forgetLiveMrpOnWrite());

scm.route("/write-freeze", writeFreezeStatus);


scm.use("/products/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/products", products);
scm.use("/admin/categories/*", scmAreaGuard("scm.procurement.products"));
scm.route("/admin/categories", categoriesApi);
scm.route("/categories", publicCategoriesApi);
scm.use("/delivery-fees/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/delivery-fees", deliveryFees);
scm.use("/fabric-tier-addon/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/fabric-tier-addon", fabricTierAddonConfig);
// openRead (2026-07-20, POS cutover) — PWP (换购) is an in-cart SALE-flow read:
// the POS reads eligibility rules + the seller's reserved codes for every
// salesperson, same class as the SO-FLOW REFERENCE READS above. No cost/margin
// on these reads.
//
// pwp-RULES = admin eligibility config the POS only READS → openRead on the
// Products admin area (writes stay edit-gated for admins). pwp-CODES = the POS
// CART surface (reserve / free / validate — "a salesperson owns their reserved
// codes", pwp-codes.ts), so it is homed on scm.sales.orders with writeLevel
// 'view': a Sales Executive (scm.sales = view) can reserve/free a 换购 voucher
// for their own cart line — the same least-privilege hatch as /quotes + /slips.
// This settles task #13's PWP write-gate under the L2 provisioning model; a flat
// scm.access holder is unaffected (the guard falls through for non-L2 callers).
scm.use("/pwp-rules/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/pwp-rules", pwpRules);
scm.use("/pwp-codes/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/pwp-codes", pwpCodes);
scm.use("/special-addons/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/special-addons", specialAddons);
scm.use("/fabric-library/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/fabric-library", fabricLibrary);
scm.use("/mfg-products/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/mfg-products", mfgProducts);
scm.use("/product-models/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/product-models", productModels);
scm.use("/pos-pools/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/pos-pools", posPools);
scm.use("/maintenance-push/*", scmAreaGuard("scm.procurement.products"));
scm.use("/maintenance-config/sofa-compartments/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/maintenance-config/sofa-compartments", sofaCompartmentPhotos);
scm.use("/maintenance-config/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/maintenance-config", maintenanceConfig);
scm.use("/sofa-combo-presets/*", scmAreaGuard("scm.procurement.products"));
scm.route("/sofa-combo-presets", sofaComboPresets);
scm.use("/sofa-combos/*", scmAreaGuard("scm.procurement.products"));
scm.route("/sofa-combos", sofaCombos);
scm.use("/sofa-quick-picks/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/sofa-quick-picks", sofaQuickPicks);
scm.use("/fabric-tracking/*", scmAreaGuard("scm.procurement.products", { openReadPaths: ["/fabric-tracking/lite"] }));
scm.route("/fabric-tracking", fabricTracking);
scm.use("/so-settings/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/so-settings", soSettings);
scm.use("/free-item-campaigns/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/free-item-campaigns", freeItemCampaigns);
scm.use("/model-free-gifts/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/model-free-gifts", modelFreeGifts);
scm.route("/pos-cart", posCart);
scm.route("/personal-quick-picks", personalQuickPicks);
scm.route("/sales-analysis", salesAnalysis);
scm.use("/quotes/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/quotes", quotes);
scm.use("/suppliers/*", scmAreaGuard("scm.procurement.suppliers"));
scm.route("/suppliers", suppliers);
// ── Purchase Orders / GRN / PI (scm.procurement.*) ──────────────────────────
// The cancel guard runs FIRST. On a Purchase Order it is what makes the REASON
// mandatory (owner 2026-09-09:「PO cancelled 不需要审批，只需要 remark 原因取消」):
// PATCH /:id/cancel without one is refused 400 before the router is reached,
// and the cancellation is recorded with its reason afterwards. No approval, so
// nothing here signs and the bypass below admits nobody on this prefix — it and
// the open-read suffix stay because the mount is shared with the Sales Order's
// approvers, whose keys DO open …/cancel-request (docs/bugs/0717,
// routes/document-cancel-routes.ts).
scm.use("/mfg-purchase-orders/:id/cancel", cancelApprovalGuard("PO"));
scm.use("/mfg-purchase-orders/*", scmAreaGuard("scm.procurement.po", {
  openReadPaths: [CANCEL_REQUEST_OPEN_READ_PATH],
  writeBypass: cancelExecutionBypass("PO"),
}));
scm.route("/mfg-purchase-orders", mfgPurchaseOrdersListEnrichment);
// PO line import (owner 2026-09-15): POST /line-import/preview + /apply. Static
// paths, mounted ahead of the main router's `/:id` routes; same area guard.
scm.route("/mfg-purchase-orders", poLineImport);
scm.route("/mfg-purchase-orders", purchaseOrderExports);
// Cancellation needs a reason + the PO's one approval (owner 2026-09-08). The
// request routes ride this prefix's area guard; the guard in front of
// PATCH /:id/cancel is mounted above, ahead of the area guard.
// routes/document-cancel-routes.ts — the PO router itself is not edited.
scm.route("/mfg-purchase-orders", poCancelRequests);
scm.route("/mfg-purchase-orders", mfgPurchaseOrders);
scm.route("/mfg-purchase-orders", purchaseOrderItemPhotos);
scm.use("/po-amendments/*", scmAreaGuard("scm.procurement.po"));
scm.route("/po-amendments", poAmendments);
scm.use("/grns/*", scmAreaGuard("scm.procurement.grn"));
scm.route("/grns", grnsListEnrichment);
scm.route("/grns", grnExports);
scm.route("/grns", grnFiles);
scm.route("/grns", grns);
scm.use("/purchase-invoices/*", scmAreaGuard("scm.procurement.pi"));
scm.route("/purchase-invoices", purchaseInvoicesListEnrichment);
scm.route("/purchase-invoices", purchaseInvoiceExports);
scm.route("/purchase-invoices", purchaseInvoiceFiles);
scm.route("/purchase-invoices", purchaseInvoices);
// ── Sales Orders (scm.sales.orders) ─────────────────────────────────────────
// Same key-not-area admission as the PO mount above: the Purchaser signs
// level 2 on a Sales Order cancel with Sales Orders at `view`.
// Cancel guard first, for the same reason as the PO mount above: the Purchaser
// signs level 2 with Sales Orders at `view` and must still be able to run the
// cancel they just approved (docs/bugs/0717).
scm.use("/mfg-sales-orders/:docNo/status", cancelApprovalGuard("SO"));
scm.use("/mfg-sales-orders/*", scmAreaGuard("scm.sales.orders", {
  openReadPaths: [CANCEL_REQUEST_OPEN_READ_PATH],
  writeBypass: cancelExecutionBypass("SO"),
}));
/* MIGRATED sales orders are READ-ONLY while the cutover finishes (owner
   2026-09-08, 「只开新单，旧单暂时不能改」). A NEW order saves normally; one
   carried across from AutoCount does not, because sync-ac-delta can still
   overwrite an edit unannounced and AutoCount payments taken since 2026-08-28
   have not reached the ERP, so its balance on screen is wrong.

   Mounted HERE rather than inside the router because the router is a
   12,000-line file on its size ceiling, and because this is the same position
   the write freeze occupies: a document-level rule and a module-level one
   belong next to each other, not one of them buried in a route file. It is
   scoped to this prefix, so it is the SO surface only, and `POST /` carries no
   doc number in its path and is never reached — 「只开新单」 in one line of
   control flow. Switch + runbook: docs/migrated-so-lock.md. */
scm.use("/mfg-sales-orders/*", migratedSoReadonly());
scm.route("/mfg-sales-orders", mfgSalesOrdersListEnrichment);
scm.route("/mfg-sales-orders", salesOrderExports);
// Cancellation needs a reason + TWO approvals (owner 2026-09-08). Request routes
// on this prefix (behind the area guard AND the migrated-SO lock); the guard on
// the status route — which only wakes when the body says CANCELLED — is mounted
// above, ahead of the area guard. routes/document-cancel-routes.ts.
scm.route("/mfg-sales-orders", soCancelRequests);
// A payment whose slip is older than the 14-day window, as a request an admin
// approves (owner 2026-09-30). routes/so-payment-backdate-requests.ts.
scm.route("/mfg-sales-orders", soPaymentBackdateRequests);
// The fair picker (owner 2026-09-13). Mounted BEFORE the main router for the same
// reason as the enrichment above: its static `/fair-options` and `/fair-pending`
// paths must resolve ahead of `/:docNo`. In its own file because
// mfg-sales-orders.ts is already over its file-size ceiling.
scm.route("/mfg-sales-orders", mfgSoFairs);
// Which brand a bill is for, for the Venture Portal (owner 2026-09-27): the
// answer to the question the form asks after a save whose products name no
// brand. Own file for the same ceiling reason. routes/mfg-so-vp-brand.ts.
scm.route("/mfg-sales-orders", mfgSoVpBrand);
// Lane preview (owner 2026-09-15, option B): which desk an amendment WILL go to,
// read from the same resolver the submit route stores from. Own file for the
// same ceiling reason; ahead of the main router so `/:docNo/amendments/lane-preview`
// is matched before its `/:docNo/amendments`. routes/so-amendment-lane-preview.ts.
scm.route("/mfg-sales-orders", soAmendmentLanePreview);
scm.route("/mfg-sales-orders", soDeliveryIssues);
scm.route("/mfg-sales-orders", mfgSalesOrders);
scm.use("/so-amendments/*", scmAreaGuard("scm.sales.orders"));
scm.use("/so-amendments/*", migratedSoAmendmentReadonly());
scm.route("/so-amendments", soAmendments);
scm.use("/so-handover/*", scmAreaGuard("scm.sales.orders"));
scm.route("/so-handover", soHandover);
scm.route("/cancel-requests", cancelRequestsInbox);
scm.use("/payment-backdate-requests/*", scmAreaGuard("scm.sales.orders"));
scm.route("/payment-backdate-requests", paymentBackdateInbox);
scm.route("/state-warehouse-mappings", stateWarehouseMappings);
scm.use(
  "/delivery-orders-mfg/*",
  scmAreaGuard("scm.sales.delivery", {
    readInheritsFrom: "scm.sales.orders",
    writeBypass: (c) => {
      const u = c.get("user") as unknown as Parameters<typeof hasPositionCapability>[0];
      if (c.req.method === "PATCH" && c.req.path.endsWith("/status")) {
        return (
          hasPositionCapability(u, "scm.do.load") ||
          hasPositionCapability(u, "scm.do.dispatch")
        );
      }
      if (c.req.method === "PATCH" && c.req.path.endsWith("/arrival")) {
        return hasPositionCapability(u, "scm.do.dispatch");
      }
      if (c.req.method === "POST" && c.req.path.endsWith("/revert")) {
        return hasPositionCapability(u, "scm.do.revert");
      }
      if (c.req.method === "POST" && c.req.path.endsWith("/delivery-issue")) {
        return hasPositionCapability(u, "scm.do.dispatch");
      }
      return false;
    },
  }),
);
/* Cancelling a delivery order costs a REASON (owner 2026-09-14, 「DO cancel need
   pop out window for reason」) — the Purchase Order's rule, on the DO's status
   route: the guard wakes only when the body asks for CANCELLED, refuses 400
   without a reason, and records the cancellation with it
   (routes/document-cancel-routes.ts). Mounted AFTER the area guard, unlike the PO
   and SO guards: no approver has to be admitted past it, so a caller is asked
   who they are before they are asked why. The DO router itself is not edited. */
scm.use("/delivery-orders-mfg/:id/status", cancelApprovalGuard("DO"));
scm.route("/delivery-orders-mfg", deliveryOrderScanToken);
scm.route("/delivery-orders-mfg", deliveryOrderItemPhotos);
scm.route("/delivery-orders-mfg", deliveryOrderExports);
scm.route("/delivery-orders-mfg", doDeliveryIssues);
scm.route("/delivery-orders-mfg", deliveryOrderPodAttempts);
scm.route("/delivery-orders-mfg", deliveryOrderPodPhotos);
scm.route("/delivery-orders-mfg", deliveryOrdersMfg);
scm.use("/sales-invoices/*", scmAreaGuard("scm.sales.invoices", { readInheritsFrom: "scm.sales.orders" }));
scm.route("/sales-invoices", salesInvoiceExports);
scm.route("/sales-invoices", salesInvoices);
scm.use("/delivery-returns/*", scmAreaGuard("scm.sales.returns"));
scm.route("/delivery-returns", deliveryReturnExports);
scm.route("/delivery-returns", deliveryReturnFiles);
scm.route("/delivery-returns", deliveryReturns);
scm.use("/purchase-returns/*", scmAreaGuard("scm.procurement.pr"));
scm.route("/purchase-returns", purchaseReturnExports);
scm.route("/purchase-returns", purchaseReturnFiles);
scm.route("/purchase-returns", purchaseReturns);
scm.use("/consignment-orders/*", scmAreaGuard("scm.consignment.orders"));
scm.route("/consignment-orders", consignmentOrders);
scm.use("/consignment-notes/*", scmAreaGuard("scm.consignment.notes"));
scm.route("/consignment-notes", consignmentNotes);
scm.use("/consignment-returns/*", scmAreaGuard("scm.consignment.returns"));
scm.route("/consignment-returns", consignmentReturns);
scm.use("/purchase-consignment-orders/*", scmAreaGuard("scm.consignment.po_orders"));
scm.route("/purchase-consignment-orders", purchaseConsignmentOrders);
scm.use("/purchase-consignment-receives/*", scmAreaGuard("scm.consignment.po_receives"));
scm.route("/purchase-consignment-receives", purchaseConsignmentReceives);
scm.use("/purchase-consignment-returns/*", scmAreaGuard("scm.consignment.po_returns"));
scm.route("/purchase-consignment-returns", purchaseConsignmentReturns);
scm.use("/inventory/adjustments/*", scmAreaGuard("scm.warehouse.adjustments"));
scm.route("/inventory/adjustments", inventoryAdjustments);
scm.use(
  "/inventory/*",
  scmAreaGuard("scm.warehouse.inventory", { openReadPaths: ["/inventory/warehouses"] }),
);
scm.route("/inventory", inventory);
scm.use("/warehouse/*", scmAreaGuard("scm.warehouse.inventory"));
scm.route("/warehouse", warehouse);
// Loading queue (owner 2026-08-25) — the storekeeper's no-price "what to load
// today" list. Gated on scm.warehouse.inventory (the Storekeeper's existing
// grant, positionPolicy.STOREKEEPER_ROWS) so the warehouse line reaches it
// without scm.sales.delivery; the payload carries no money by construction (see
// routes/loading-list.ts). Read-only router — no writes to gate.
scm.use("/loading-list/*", scmAreaGuard("scm.warehouse.inventory"));
scm.route("/loading-list", loadingList);
scm.use("/stock-transfers/*", scmAreaGuard("scm.warehouse.transfers"));
scm.route("/stock-transfers", stockTransfers);
scm.use("/stock-takes/*", scmAreaGuard("scm.warehouse.stock_take"));
scm.route("/stock-takes", stockTakes);
scm.use("/accounting/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/accounting", accounting);
scm.use("/payment-vouchers/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/payment-vouchers", paymentVouchers);
// Other Debtors (owner 2026-09-03) — registry + debtor bills + receipts; the
// same area and the same PV permission family gate the handlers inside.
scm.use("/other-debtors/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/other-debtors", otherDebtors);
// Receipts (owner 2026-09-03, later the same day) — the unified money-in list
// plus general receipts that post directly; same area, same key family.
scm.use("/receipts/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/receipts", receipts);
// AP Invoices (owner 2026-09-06) — the non-stock supplier bill beside the
// purchase invoices it is paid alongside; same area, same PV key family.
scm.use("/ap-invoices/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/ap-invoices", apInvoices);
// AR Invoices (owner 2026-09-29) — the AP list's twin for the money owed TO
// the company: sales invoices mirrored beside the other-debtor bills. Reads
// only; the bill's writes stay on /other-debtors. Same area guard.
scm.use("/ar-invoices/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/ar-invoices", arInvoices);
// Credit and debit notes (owner 2026-09-12; docs/bugs/0827) — the customer's
// CN / DN and the supplier's SCN, raised by Finance; same area, same PV key
// family as the AP invoice beside it.
scm.use("/credit-notes/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/credit-notes", creditNotes);
// Deposit invoices (owner 2026-09-12; docs/bugs/0828) — born with a customer
// payment when the company's switch is on; Finance reads, cancels, re-posts,
// and holds the switch. Same area as the notes and receipts beside it.
scm.use("/deposit-invoices/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/deposit-invoices", depositInvoices);
// Events on the money side (owner 2026-09-30, 5a) — the event picker for voucher
// and AP invoice lines, the event cost report, and changing a paid voucher
// line's event. Same area as the vouchers it serves.
scm.use("/acc-events/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/acc-events", accEvents);
// Official invoices owed (owner 2026-10-01, payment-request item 3) — the
// payments made on a proforma or quotation, still owing the real invoice:
// Finance's list and its owed / checked marks. Same area as the vouchers.
scm.use("/official-docs/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/official-docs", officialDocs);
// Supplier Maintenance (owner 2026-10-02) — Finance's own supplier list in
// Money out: what the books say each supplier is owed, its advances, credit
// left and open invoices. Reads only; the record is edited through /suppliers.
scm.use("/supplier-maintenance/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/supplier-maintenance", supplierMaintenance);
scm.use("/payment-audit-log/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/entity-audit-log", entityAuditLog);
scm.route("/change-log", changeLog);
scm.route("/autocount-outbox", autocountOutbox);
scm.route("/venture-portal-feed", venturePortalFeed);
scm.route("/currencies", currencies);
// 申请付款 (owner 2026-09-30) — NO area guard: a sales PIC asking Finance to pay
// an event's rental holds no SCM area, only the flat scm.payment_request.create,
// which requireScmAccess admits for this prefix alone. Each handler checks that
// key or Finance's scm.payment_voucher.create, and a requester sees their own.
scm.route("/payment-requests", paymentRequests);
// Product request (owner 2026-10-06) — NO area guard, for the same reason: a
// salesperson (Sales 都能提) holds no consignment or procurement area and the
// Purchaser holds no sales area. requireScmAccess admits a Sales caller and the
// two flat scm.product_request.* keys for this prefix alone; each handler checks
// the caller, and a requester sees their own requests only.
scm.route("/product-requests", productRequests);
scm.route("/hr", hr);
scm.use("/mrp/*", scmAreaGuard("scm.procurement.mrp"));
scm.route("/mrp", mrp);
scm.use("/mrp-lead-times/*", scmAreaGuard("scm.procurement.mrp"));
scm.route("/mrp-lead-times", mrpLeadTimes);
scm.use("/mrp-supplier-lead-times/*", scmAreaGuard("scm.procurement.mrp"));
scm.route("/mrp-supplier-lead-times", mrpSupplierLeadTimes);
// Ported 2026-06-20 — Outstanding dashboard (v_*_outstanding views), MY
// State/City/Postcode reference (my_localities). /fabric-library already
// mounted above — its GET list was added to the existing route, not remounted.
// Procurement Overview (owner 2026-10-16): the PO side of procurement. Read-only,
// and open to a Sales Director too (owner 2026-11-24).
scm.use("/procurement-overview/*", scmAreaGuard("scm.procurement.po", { readBypass: isSalesDirectorUser }));
scm.route("/procurement-overview", procurementOverview);
// Logistic Overview (owner 2026-10-16): weekly DO / delivered / runs history.
scm.use("/logistic-overview/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/logistic-overview", logisticOverview);
scm.use("/outstanding/*", scmAreaGuard("scm.finance.outstanding"));
scm.route("/outstanding", outstanding);
scm.use("/unbilled-deliveries/*", scmAreaGuard("scm.finance.outstanding"));
scm.route("/unbilled-deliveries", unbilledDeliveries);
scm.route("/localities", localities);
scm.route("/sg-postcode", sgPostcode);
scm.route("/staff", staff);
scm.route("/fabric-colours", fabricColours);
scm.use("/addons/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/addons", addons);
scm.route("/document-flow", documentFlow);
scm.route("/po-so-coverage", poSoCoverage);
scm.use("/drivers/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/drivers", drivers);
scm.use("/delivery-planning/*", scmAreaGuard("scm.transportation.drivers", { readInheritsFrom: "scm.transportation.last_mile" }));
scm.use(
  "/delivery-jobs/*",
  scmAreaGuard("scm.transportation.drivers", {
    readInheritsFrom: "scm.transportation.last_mile",
    writeBypass: (c) =>
      c.req.method === "POST" &&
      hasPositionCapability(
        c.get("user") as unknown as Parameters<typeof hasPositionCapability>[0],
        "scm.do.dispatch",
      ),
  }),
);
scm.route("/delivery-jobs", jobDeliveryIssues);
scm.route("/delivery-jobs", crewStopPhotos);
scm.route("/delivery-jobs", deliveryJobProgress);
scm.route("/delivery-planning", lastMileDeliveryIssues);
scm.route("/delivery-planning", deliveryPlanning);
scm.use("/delivery-planning-regions/*", scmAreaGuard("scm.transportation.drivers", { openRead: true }));
scm.route("/delivery-planning-regions", deliveryPlanningRegions);
scm.use("/delivery-planning-row-marks/*", scmAreaGuard("scm.transportation.drivers", { openRead: true }));
scm.route("/delivery-planning-row-marks", deliveryPlanningRowMarks);
scm.use("/delivery-remarks/*", scmAreaGuard("scm.transportation.drivers", { openRead: true }));
scm.route("/delivery-remarks", deliveryRemarks);
scm.use("/delivery-planning-row-order/*", scmAreaGuard("scm.transportation.drivers", { openRead: true }));
scm.route("/delivery-planning-row-order", deliveryPlanningRowOrder);
scm.use("/delivery-residence-rules/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/delivery-residence-rules", deliveryResidenceRules);
scm.use("/delivery-amend-reasons/*", scmAreaGuard("scm.transportation.drivers", { openRead: true }));
scm.route("/delivery-amend-reasons", deliveryAmendReasons);
scm.use("/threepl-companies/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/threepl-companies", threeplCompanies);

scm.use("/saved-locations/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/saved-locations", savedLocations);
scm.use("/delivery-zones/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/delivery-zones", deliveryZones);
scm.use("/delivery-rate-cards/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/delivery-rate-cards", deliveryRateCards);
scm.use("/delivery-places/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/delivery-places", deliveryPlaces);
// HC-0031 - the 3PL invoice keyed in after delivery, tallied per DO against the
// rate cards above. Same Transportation area gate.
scm.use("/threepl-do-charges/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/threepl-do-charges", threeplDoCharges);
scm.use("/driver-leave/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/driver-leave", driverLeave);
scm.use(
  "/trips/*",
  scmAreaGuard("scm.transportation.drivers", {
    writeBypass: (c) => isTripLocationPing(c.req.method, c.req.path),
  }),
);
scm.route("/trips", tripScanToken);
scm.route("/trips", trips);
scm.use("/dp-orders/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/dp-orders", dpOrders);
scm.use("/delivery-messages/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/delivery-messages", deliveryMessages);
/* AR receivables reconciliation. AREA-GATED as of 2026-08-13 (owner decision,
   asked directly: "加上和兄弟页面一样的门").

   It used to ride the coarse scm.access umbrella "like the other cross-area read
   helpers", which was not true of its actual siblings: /outstanding (:428) and
   /unbilled-deliveries (:437) both sit behind scm.finance.outstanding. So a
   caller explicitly DENIED finance.outstanding was refused by those two and got
   the same book — debtor names, totals, paid, remaining and drift for up to 2000
   open orders — from this one. */
scm.use("/ar/*", scmAreaGuard("scm.finance.outstanding"));
scm.route("/ar", arReconciliation);
scm.use("/scan-lorry-invoice/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/scan-lorry-invoice", scanLorryInvoice);
scm.use("/lorry-capacity/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/lorry-capacity", lorryCapacity);
scm.use("/lorry-routes/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/lorry-routes", lorryRoutes);
scm.use("/helpers/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/helpers", helpers);
scm.use("/lorries/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/lorries", lorries);
scm.use("/lorry-service-records/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/lorry-service-records", lorryServiceRecords);
scm.use("/so-dropdown-options/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/so-dropdown-options", soDropdownOptions);
scm.use("/venues/*", scmAreaGuard("scm.procurement.products", { openRead: true }));
scm.route("/venues", venues);
scm.route("/reports", reports);
scm.use("/scan-so/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/scan-so", scanSo);
scm.use("/scan-gr/check/*", scmAreaGuard("scm.procurement.grn", { writeLevel: "view" }));
scm.use("/scan-gr/*", scmAreaGuard("scm.procurement.grn", { writeLevel: "view" }));
scm.route("/scan-gr/check", scanGrCheck);
scm.route("/scan-gr", scanGr);
scm.use("/scan-pi/check/*", scmAreaGuard("scm.procurement.pi", { writeLevel: "view" }));
scm.use("/scan-pi/*", scmAreaGuard("scm.procurement.pi", { writeLevel: "view" }));
scm.route("/scan-pi/check", scanPiCheck);
scm.route("/scan-pi", scanPi);
scm.use("/scan-payment/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/scan-payment", scanPayment);
/* Original scans (HC-0006 T7) — one router per kind, each behind the area
   guard of the document it belongs to. */
scm.use("/scan-files/so/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/scan-files/so", scanFilesSo);
scm.use("/scan-files/payment/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/scan-files/payment", scanFilesPayment);
scm.use("/scan-files/pv/*", scmAreaGuard("scm.finance.accounting"));
scm.route("/scan-files/pv", scanFilesPv);
scm.use("/scan-files/workshop/*", scmAreaGuard("scm.transportation.drivers"));
scm.route("/scan-files/workshop", scanFilesWorkshop);
scm.use(
  "/slips/*",
  scmAreaGuard("scm.sales.orders", {
    writeLevel: "view",
    openReadPaths: ["/slips/field-photos", "/image"],
    writeBypass: (c) =>
      c.req.method === "POST" &&
      hasPositionCapability(
        c.get("user") as unknown as Parameters<typeof hasPositionCapability>[0],
        "scm.do.dispatch",
      ),
  }),
);
scm.route("/slips", slips);

export default scm;
