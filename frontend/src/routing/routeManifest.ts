/**
 * Executable URL contract for the SPA.
 *
 * This deliberately records addresses and surface ownership only. Permission
 * policy remains in the existing route guards and, ultimately, on the server.
 * Keeping those concerns separate lets the drift tests answer "does this URL
 * still exist?" without accidentally creating a second permission system.
 */

export const STAFF_ROUTE_PATTERNS = [
  "/",
  "/assr",
  "/assr/:id",
  "/sales",
  "/my-cases",
  "/my-cases/:id",
  "/projects",
  "/fair-report-fill",
  "/schedule-reconcile",
  "/setup-invoice",
  "/projects/:id",
  "/settings",
  "/agents",
  "/assistant",
  "/system-health",
  "/autocount-sync",
  "/team",
  "/announcements",
  "/fleet-health",
  "/fleet-health/:lorryId",
  "/mail-center",
  "/mail-center/:id",
  "/scm/suppliers",
  "/scm/purchase-orders",
  "/scm/purchase-orders/new",
  "/scm/purchase-orders/from-so",
  "/scm/purchase-orders/:id",
  "/scm/po-amendments",
  "/scm/po-amendments/:id",
  "/scm/mrp",
  "/scm/accounting",
  "/scm/daily-bank",
  "/scm/merchant-recon",
  "/scm/bank-recon",
  "/scm/settlement-setup",
  "/scm/outstanding",
  "/scm/unbilled-deliveries",
  "/scm/currencies",
  "/scm/fabric-tracking",
  // Warehouse loading queue (no-price "what to load" list, scm.warehouse.inventory).
  "/scm/loading-list",
  "/scm/warehouses",
  "/scm/warehouses/racks",
  "/scm/products",
  "/scm/categories",
  "/scm/product-models",
  "/scm/product-models/:id",
  "/scm/grns",
  "/scm/grns/new",
  "/scm/grns/from-po",
  "/scm/grns/:id",
  "/scm/purchase-invoices",
  "/scm/purchase-invoices/new",
  "/scm/purchase-invoices/from-grn",
  "/scm/purchase-invoices/:id",
  "/scm/payment-vouchers",
  "/scm/payment-vouchers/new",
  "/scm/payment-vouchers/scan",
  "/scm/payment-vouchers/:id",
  "/scm/stock-adjustments",
  "/scm/stock-adjustments/new",
  "/scm/stock-transfers",
  "/scm/stock-transfers/new",
  "/scm/stock-transfers/:id",
  "/scm/stock-takes",
  "/scm/stock-takes/new",
  "/scm/stock-takes/:id",
  "/scm/hr/commission",
  "/scm/hr/settings",
  "/scm/purchase-returns",
  "/scm/purchase-returns/new",
  "/scm/purchase-returns/:id",
  "/scm/inventory",
  "/scm/inventory/stock-card/:itemCode",
  "/scm/suppliers/:id",
  "/scm/delivery-planning",
  "/scm/dp-orders",
  "/scm/trips",
  "/scm/delivery-planning-regions",
  "/scm/delivery-residence-rules",
  "/scm/delivery-zones",
  "/scm/delivery-rate-cards",
  "/scm/auto-schedule",
  "/scm/driver-leave",
  "/scm/threepl-companies",
  "/scm/fleet",
  "/scm/delivery-maintenance",
  "/scm/fleet-day",
  "/scm/fleet-run-sheet",
  "/scm/lorry-capacity",
  "/scm",
  "/scm/sales-order",
  "/scm/consignment",
  "/scm/procurement",
  "/scm/transportation",
  "/scm/warehouse",
  "/scm/finance",
  "/scm/sales-orders",
  "/scm/amendments",
  "/scm/amendments/:id",
  "/scm/sales-orders/maintenance",
  "/scm/sales-orders/new",
  "/scm/sales-orders/new/guided",
  "/scm/sales-orders/new/from-products",
  "/scm/sales-orders/generate",
  "/scm/sales-orders/:docNo",
  "/scm/reports/sales-order-detail-listing",
  "/scm/reports/delivery-order-detail-listing",
  "/scm/reports/sales-invoice-detail-listing",
  "/scm/reports/delivery-return-detail-listing",
  "/reports/fair-report",
  "/scm/delivery-orders",
  "/scm/delivery-orders/new",
  "/scm/delivery-orders/from-so",
  "/scm/delivery-orders/:id",
  // The DO print's "SCAN . MARK LOADED" QR lands here (warehouse loading confirmation).
  "/scm/do-load",
  "/scm/sales-invoices",
  "/scm/sales-invoices/new",
  "/scm/sales-invoices/from-do",
  "/scm/sales-invoices/:id",
  "/scm/delivery-returns",
  "/scm/delivery-returns/new",
  "/scm/delivery-returns/from-do",
  "/scm/delivery-returns/:id",
  "/scm/consignment-orders",
  "/scm/consignment-orders/new",
  "/scm/consignment-orders/:docNo",
  "/scm/consignment-notes",
  "/scm/consignment-notes/new",
  "/scm/consignment-notes/from-order",
  "/scm/consignment-notes/:id",
  "/scm/consignment-returns",
  "/scm/consignment-returns/new",
  "/scm/consignment-returns/from-note",
  "/scm/consignment-returns/:id",
  "/scm/purchase-consignment-orders",
  "/scm/purchase-consignment-orders/new",
  "/scm/purchase-consignment-orders/:id",
  "/scm/purchase-consignment-receives",
  "/scm/purchase-consignment-receives/new",
  "/scm/purchase-consignment-receives/from-pc-order",
  "/scm/purchase-consignment-receives/:id",
  "/scm/purchase-consignment-returns",
  "/scm/purchase-consignment-returns/new",
  "/scm/purchase-consignment-returns/from-receive",
  "/scm/purchase-consignment-returns/:id",
  "/scm/maintenance",
  "/notifications",
  "/profile",
] as const;

/** Live compatibility route, not a page of its own. */
export const STAFF_LEGACY_REDIRECT_PATTERNS = ["/roles"] as const;

export const PUBLIC_ROUTE_PATTERNS = [
  "/survey/:token",
  "/track",
  "/portal/case/:ref/:token",
  "/portal/case/:token",
  "/portal/supplier/:token",
  "/reset/:token",
  "/invite/:token",
  "/privacy",
] as const;

export type RouteContract = {
  pattern: string;
  audience: "staff" | "public";
  kind: "page" | "legacy-redirect";
};

export const ROUTE_CONTRACT: readonly RouteContract[] = [
  ...STAFF_ROUTE_PATTERNS.map((pattern) => ({ pattern, audience: "staff" as const, kind: "page" as const })),
  ...STAFF_LEGACY_REDIRECT_PATTERNS.map((pattern) => ({ pattern, audience: "staff" as const, kind: "legacy-redirect" as const })),
  ...PUBLIC_ROUTE_PATTERNS.map((pattern) => ({ pattern, audience: "public" as const, kind: "page" as const })),
];

function locationPath(location: string): string {
  const raw = (location || "/").split("#", 1)[0].split("?", 1)[0] || "/";
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/** Small exact segment matcher for the manifest's `:param` patterns. */
export function routePatternMatches(pattern: string, location: string): boolean {
  const path = locationPath(location);
  const expected = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  if (expected.length !== actual.length) return false;
  return expected.every(
    (segment, index) =>
      segment.startsWith(":") || segment.toLowerCase() === actual[index].toLowerCase(),
  );
}

export function isKnownStaffLocation(location: string): boolean {
  return [...STAFF_ROUTE_PATTERNS, ...STAFF_LEGACY_REDIRECT_PATTERNS]
    .some((pattern) => routePatternMatches(pattern, location));
}
