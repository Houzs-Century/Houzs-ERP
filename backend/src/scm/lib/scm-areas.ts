
/** prefix (under the /api/scm mount) -> L2 area key. Mirrors scm/index.ts. */
export const SCM_AREA_MOUNTS: ReadonlyArray<readonly [string, string]> = [
  ["/products/*", "scm.procurement.products"],
  ["/admin/categories/*", "scm.procurement.products"],
  ["/delivery-fees/*", "scm.procurement.products"],
  ["/fabric-tier-addon/*", "scm.procurement.products"],
  ["/pwp-rules/*", "scm.procurement.products"],
  ["/pwp-codes/*", "scm.sales.orders"],
  ["/special-addons/*", "scm.procurement.products"],
  ["/fabric-library/*", "scm.procurement.products"],
  ["/mfg-products/*", "scm.procurement.products"],
  ["/product-models/*", "scm.procurement.products"],
  ["/pos-pools/*", "scm.procurement.products"],
  ["/maintenance-push/*", "scm.procurement.products"],
  ["/maintenance-config/sofa-compartments/*", "scm.procurement.products"],
  ["/maintenance-config/*", "scm.procurement.products"],
  ["/sofa-combo-presets/*", "scm.procurement.products"],
  ["/sofa-combos/*", "scm.procurement.products"],
  ["/sofa-quick-picks/*", "scm.procurement.products"],
  ["/fabric-tracking/*", "scm.procurement.products"],
  ["/so-settings/*", "scm.procurement.products"],
  ["/free-item-campaigns/*", "scm.procurement.products"],
  ["/model-free-gifts/*", "scm.procurement.products"],
  ["/quotes/*", "scm.sales.orders"],
  ["/suppliers/*", "scm.procurement.suppliers"],
  ["/mfg-purchase-orders/*", "scm.procurement.po"],
  ["/po-amendments/*", "scm.procurement.po"],
  ["/grns/*", "scm.procurement.grn"],
  ["/purchase-invoices/*", "scm.procurement.pi"],
  ["/mfg-sales-orders/*", "scm.sales.orders"],
  ["/so-amendments/*", "scm.sales.orders"],
  ["/so-handover/*", "scm.sales.orders"],
  ["/payment-backdate-requests/*", "scm.sales.orders"],
  ["/delivery-orders-mfg/*", "scm.sales.delivery"],
  ["/sales-invoices/*", "scm.sales.invoices"],
  ["/delivery-returns/*", "scm.sales.returns"],
  ["/purchase-returns/*", "scm.procurement.pr"],
  ["/consignment-orders/*", "scm.consignment.orders"],
  ["/consignment-notes/*", "scm.consignment.notes"],
  ["/consignment-returns/*", "scm.consignment.returns"],
  ["/purchase-consignment-orders/*", "scm.consignment.po_orders"],
  ["/purchase-consignment-receives/*", "scm.consignment.po_receives"],
  ["/purchase-consignment-returns/*", "scm.consignment.po_returns"],
  ["/inventory/adjustments/*", "scm.warehouse.adjustments"],
  ["/inventory/*", "scm.warehouse.inventory"],
  ["/warehouse/*", "scm.warehouse.inventory"],
  ["/loading-list/*", "scm.warehouse.inventory"],
  ["/stock-transfers/*", "scm.warehouse.transfers"],
  ["/stock-takes/*", "scm.warehouse.stock_take"],
  ["/accounting/*", "scm.finance.accounting"],
  ["/payment-vouchers/*", "scm.finance.accounting"],
  ["/other-debtors/*", "scm.finance.accounting"],
  ["/receipts/*", "scm.finance.accounting"],
  ["/ap-invoices/*", "scm.finance.accounting"],
  ["/ar-invoices/*", "scm.finance.accounting"],
  ["/credit-notes/*", "scm.finance.accounting"],
  ["/deposit-invoices/*", "scm.finance.accounting"],
  ["/acc-events/*", "scm.finance.accounting"],
  ["/official-docs/*", "scm.finance.accounting"],
  ["/supplier-maintenance/*", "scm.finance.accounting"],
  ["/payment-audit-log/*", "scm.finance.accounting"],
  ["/mrp/*", "scm.procurement.mrp"],
  ["/mrp-lead-times/*", "scm.procurement.mrp"],
  ["/mrp-supplier-lead-times/*", "scm.procurement.mrp"],
  ["/procurement-overview/*", "scm.procurement.po"],
  ["/logistic-overview/*", "scm.transportation.drivers"],
  ["/outstanding/*", "scm.finance.outstanding"],
  ["/unbilled-deliveries/*", "scm.finance.outstanding"],
  ["/addons/*", "scm.procurement.products"],
  ["/drivers/*", "scm.transportation.drivers"],
  ["/delivery-planning/*", "scm.transportation.drivers"],
  ["/delivery-jobs/*", "scm.transportation.drivers"],
  ["/delivery-planning-regions/*", "scm.transportation.drivers"],
  ["/delivery-planning-row-marks/*", "scm.transportation.drivers"],
  ["/delivery-remarks/*", "scm.transportation.drivers"],
  ["/delivery-planning-row-order/*", "scm.transportation.drivers"],
  ["/delivery-residence-rules/*", "scm.transportation.drivers"],
  ["/delivery-amend-reasons/*", "scm.transportation.drivers"],
  ["/threepl-companies/*", "scm.transportation.drivers"],
  ["/saved-locations/*", "scm.transportation.drivers"],
  ["/delivery-zones/*", "scm.transportation.drivers"],
  ["/delivery-rate-cards/*", "scm.transportation.drivers"],
  ["/delivery-places/*", "scm.transportation.drivers"],
  ["/threepl-do-charges/*", "scm.transportation.drivers"],
  ["/driver-leave/*", "scm.transportation.drivers"],
  ["/trips/*", "scm.transportation.drivers"],
  ["/dp-orders/*", "scm.transportation.drivers"],
  ["/delivery-messages/*", "scm.transportation.drivers"],
  /* AR reconciliation joined the guarded set on 2026-08-13 (owner: "加上和兄弟
     页面一样的门"). It rode the coarse scm.access umbrella while its two real
     siblings, /outstanding and /unbilled-deliveries, both sat behind
     scm.finance.outstanding — so a caller explicitly DENIED that key got the
     same receivables book from this router. Position matters: the drift test
     asserts this table matches scm/index.ts IN ORDER. */
  ["/ar/*", "scm.finance.outstanding"],
  ["/scan-lorry-invoice/*", "scm.transportation.drivers"],
  ["/lorry-capacity/*", "scm.transportation.drivers"],
  ["/lorry-routes/*", "scm.transportation.drivers"],
  ["/helpers/*", "scm.transportation.drivers"],
  ["/lorries/*", "scm.transportation.drivers"],
  ["/lorry-service-records/*", "scm.transportation.drivers"],
  ["/so-dropdown-options/*", "scm.procurement.products"],
  ["/venues/*", "scm.procurement.products"],
  ["/scan-so/*", "scm.sales.orders"],
  ["/scan-gr/check/*", "scm.procurement.grn"],
  ["/scan-gr/*", "scm.procurement.grn"],
  ["/scan-pi/check/*", "scm.procurement.pi"],
  ["/scan-pi/*", "scm.procurement.pi"],
  ["/scan-payment/*", "scm.sales.orders"],
  ["/scan-files/so/*", "scm.sales.orders"],
  ["/scan-files/payment/*", "scm.sales.orders"],
  ["/scan-files/pv/*", "scm.finance.accounting"],
  ["/scan-files/workshop/*", "scm.transportation.drivers"],
  ["/slips/*", "scm.sales.orders"],
] as const;

export const SCM_UNGUARDED_PREFIXES: readonly string[] = [
  "/categories",
  "/pos-cart",
  "/personal-quick-picks",
  "/sales-analysis",
  "/state-warehouse-mappings",
  "/entity-audit-log",
  "/change-log",
  "/autocount-outbox",
  "/venture-portal-feed",
  "/currencies",
  /* 申请付款 (2026-09-30): the requester holds no SCM area — a sales PIC asking
     Finance to pay a bill. Authorization is the flat scm.payment_request.create
     key (own requests) or scm.payment_voucher.create (Finance) inside the route. */
  "/payment-requests",
  "/product-requests",
  "/hr",
  "/localities",
  "/sg-postcode",
  "/staff",
  "/fabric-colours",
  "/document-flow",
  "/po-so-coverage",
  "/cancel-requests",
  "/reports",
] as const;

/** Every area key that can appear in a freeze exception. */
export const SCM_AREAS: ReadonlySet<string> = new Set(SCM_AREA_MOUNTS.map(([, a]) => a));

export const SCM_AREA_LABELS: Readonly<Record<string, string>> = {
  "scm.sales.orders": "sales orders",
  "scm.sales.delivery": "delivery orders",
  "scm.sales.invoices": "sales invoices",
  "scm.sales.returns": "delivery returns",
  "scm.procurement.po": "purchase orders",
  "scm.procurement.grn": "goods receipts",
  "scm.procurement.pi": "purchase invoices",
  "scm.procurement.pr": "purchase returns",
  "scm.procurement.mrp": "MRP",
  "scm.procurement.products": "product setup",
  "scm.procurement.suppliers": "suppliers",
  "scm.consignment.orders": "consignment orders",
  "scm.consignment.notes": "consignment notes",
  "scm.consignment.returns": "consignment returns",
  "scm.consignment.po_orders": "consignment purchase orders",
  "scm.consignment.po_receives": "consignment receives",
  "scm.consignment.po_returns": "consignment purchase returns",
  "scm.warehouse.inventory": "inventory",
  "scm.warehouse.adjustments": "stock adjustments",
  "scm.warehouse.transfers": "stock transfers",
  "scm.warehouse.stock_take": "stock takes",
  "scm.finance.accounting": "accounting",
  "scm.finance.outstanding": "outstanding balances",
  "scm.transportation.drivers": "delivery planning",
};

/** Label if we have one, else the raw key — never undefined in a sentence. */
export function areaLabel(area: string): string {
  return SCM_AREA_LABELS[area] ?? area;
}

const MATCHERS = SCM_AREA_MOUNTS.map(([prefix, area]) => {
  const wildcard = prefix.endsWith("/*");
  const base = wildcard ? prefix.slice(0, -2) : prefix;
  return { base, wildcard, area };
}).sort((a, b) => b.base.length - a.base.length || Number(a.wildcard) - Number(b.wildcard));

/**
 * The L2 area a request path belongs to, or null when the path is not behind
 * any area guard. Accepts the full request path — a leading `/api/scm` is
 * stripped — and ignores the query string.
 */
export function areaForPath(path: string): string | null {
  let p = String(path ?? "").split("?")[0];
  if (p.startsWith("/api/scm")) p = p.slice("/api/scm".length);
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  for (const m of MATCHERS) {
    if (m.wildcard ? p === m.base || p.startsWith(`${m.base}/`) : p === m.base) return m.area;
  }
  return null;
}

/** Every prefix an area exception would open. Used by the status surface. */
export function prefixesForArea(area: string): string[] {
  return SCM_AREA_MOUNTS.filter(([, a]) => a === area).map(([p]) => p);
}
