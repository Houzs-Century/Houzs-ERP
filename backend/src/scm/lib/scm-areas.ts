// ----------------------------------------------------------------------------
// scm-areas — the L2 area a given /api/scm path belongs to.
//
// WHY THIS TABLE EXISTS. The write freeze (lib/write-freeze.ts) is mounted at
// `scm.use('/*', ...)`, AHEAD of every sub-router, so that a single middleware
// covers the whole surface. That placement is also why it cannot ask the
// area guard which area a request is in: `scmAreaGuard` runs LATER, once Hono
// has matched the sub-router's prefix. To lift the freeze per module, the
// freeze needs the same prefix -> area mapping the guards encode, available
// BEFORE routing. This file is that mapping.
//
// IT IS A COPY, AND A TEST KEEPS IT HONEST. The authority remains the
// `scm.use('/<prefix>/*', scmAreaGuard('<area>'))` lines in scm/index.ts.
// `backend/tests/writeFreezeAreas.test.ts` PARSES that file and asserts this
// table is exactly equal to it, so a new mount that is not mirrored here fails
// CI rather than silently becoming un-liftable (or, worse, liftable under the
// wrong key). Do not hand-edit one without the other.
//
// MATCHING MIRRORS HONO. A mount written `/x/*` covers `/x` and `/x/...`; a
// mount written without the wildcard (`/inventory/adjustments`) matches that
// exact path only — which is what Hono does, and is why `/inventory/adjustments`
// resolves to `scm.warehouse.adjustments` while `/inventory/adjustments/9`
// falls through to `scm.warehouse.inventory` exactly as the guards do today.
// Longest prefix wins; on equal length the exact mount wins.
//
// A PATH WITH NO AREA IS NOT LIFTABLE. `areaForPath` returns null for every
// router mounted without a guard (SCM_UNGUARDED_PREFIXES below), and the freeze
// treats null as "stays frozen". That is deliberate: an area exception can only
// ever name something in this table, so a router nobody mapped can never be
// opened by a typo. See docs/write-freeze-staged-lift.md.
// ----------------------------------------------------------------------------

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
  ["/inventory/adjustments", "scm.warehouse.adjustments"],
  ["/inventory/*", "scm.warehouse.inventory"],
  ["/warehouse/*", "scm.warehouse.inventory"],
  ["/loading-list/*", "scm.warehouse.inventory"],
  ["/stock-transfers/*", "scm.warehouse.transfers"],
  ["/stock-takes/*", "scm.warehouse.stock_take"],
  ["/accounting/*", "scm.finance.accounting"],
  ["/payment-vouchers/*", "scm.finance.accounting"],
  ["/other-debtors/*", "scm.finance.accounting"],
  ["/receipts/*", "scm.finance.accounting"],
  ["/payment-audit-log/*", "scm.finance.accounting"],
  ["/mrp/*", "scm.procurement.mrp"],
  ["/mrp-lead-times/*", "scm.procurement.mrp"],
  ["/outstanding/*", "scm.finance.outstanding"],
  ["/unbilled-deliveries/*", "scm.finance.outstanding"],
  ["/addons/*", "scm.procurement.products"],
  ["/drivers/*", "scm.transportation.drivers"],
  ["/delivery-planning/*", "scm.transportation.drivers"],
  ["/delivery-planning-regions/*", "scm.transportation.drivers"],
  ["/delivery-residence-rules/*", "scm.transportation.drivers"],
  ["/threepl-companies/*", "scm.transportation.drivers"],
  ["/delivery-zones/*", "scm.transportation.drivers"],
  ["/delivery-rate-cards/*", "scm.transportation.drivers"],
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
  ["/helpers/*", "scm.transportation.drivers"],
  ["/lorries/*", "scm.transportation.drivers"],
  ["/lorry-service-records/*", "scm.transportation.drivers"],
  ["/so-dropdown-options/*", "scm.procurement.products"],
  ["/venues/*", "scm.procurement.products"],
  ["/scan-so/*", "scm.sales.orders"],
  ["/scan-payment/*", "scm.sales.orders"],
  ["/slips/*", "scm.sales.orders"],
] as const;

/* Routers mounted with NO scmAreaGuard — the cross-area picklists and the
   read-mostly helpers left on the coarse scm.access umbrella (see the SHARED
   READ HELPERS note in scm/index.ts). They have no L2 key, so no area exception
   can name them and they stay frozen for as long as their company is frozen.
   Listed here so the status endpoint and the runbook can SAY so rather than
   leave the operator to discover it from a still-refused save. The same drift
   test that pins SCM_AREA_MOUNTS pins this list. */
export const SCM_UNGUARDED_PREFIXES: readonly string[] = [
  "/categories",
  "/pos-cart",
  "/personal-quick-picks",
  "/sales-analysis",
  "/state-warehouse-mappings",
  "/entity-audit-log",
  "/autocount-outbox",
  "/currencies",
  "/hr",
  "/localities",
  "/staff",
  "/fabric-colours",
  "/document-flow",
  "/po-so-coverage",
  // "/ar" left this list on 2026-08-13 when it gained an area guard. Both halves
  // have to move together: the drift test derives the guarded set and the
  // unguarded set from the SAME source scan, so gating a router without removing
  // it here fails the mirror in two places at once. It did.
  "/reports",
] as const;

/** Every area key that can appear in a freeze exception. */
export const SCM_AREAS: ReadonlySet<string> = new Set(SCM_AREA_MOUNTS.map(([, a]) => a));

/* Plain-English names for the refusal sentence and the status endpoint. The
   floor does not know what `scm.procurement.grn` is; it knows "goods receipts".
   Kept SHORT — freezeMessage interpolates them and both API clients discard a
   sentence of 200 characters or more (see write-freeze.ts). A test asserts every
   area has a label and that every resulting sentence stays under that cap. */
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

/* Longest-first so the first hit is the most specific mount; the exact
   `/inventory/adjustments` sorts ahead of `/inventory/*` at equal base length
   because a non-wildcard mount is the narrower claim. Computed once. */
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
  // Trailing slash is not significant for a mount match.
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
