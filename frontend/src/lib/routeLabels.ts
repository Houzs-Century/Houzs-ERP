// Route → human label resolution. Extracted VERBATIM from TopNavbar.tsx so the
// workspace tab strip (components/WorkspaceTabs.tsx) can label its tabs with
// exactly the strings the breadcrumb fallback uses — one table, no drift.
// TopNavbar keeps consuming labelForPath from here.

// ── Route → label fallback ─────────────────────────────────
// Quick mapping for pages that don't push breadcrumbs themselves.
// Keeps the navbar from rendering as an empty strip.
const ROUTE_LABELS: Array<[RegExp, string]> = [
  [/^\/$/, "Overview"],
  [/^\/orders\/.+$/, "Sales Order"],
  [/^\/orders$/, "Sales Orders"],
  [/^\/delivery-orders$/, "Delivery Orders"],
  [/^\/delivery\/.+$/, "Delivery"],
  [/^\/logistics$/, "Logistics"],
  [/^\/trips\/.+$/, "Trip"],
  [/^\/lorries\/.+$/, "Lorry"],
  [/^\/staff\/.+$/, "Staff"],
  [/^\/po\/.+$/, "Purchase Order"],
  [/^\/po$/, "Purchase Orders"],
  [/^\/creditors\/.+$/, "Creditor"],
  [/^\/assr\/.+$/, "Service Case"],
  [/^\/assr$/, "Service Cases"],
  [/^\/my-cases\/.+$/, "My Case"],
  [/^\/my-cases$/, "My Cases"],
  [/^\/projects\/.+$/, "Project"],
  [/^\/projects$/, "Projects"],
  [/^\/sales$/, "Sales"],
  [/^\/team$/, "Team"],
  [/^\/gamification$/, "Engagement"],
  [/^\/settings$/, "Settings"],
  [/^\/profile$/, "Profile"],
  [/^\/mail-center\/.+$/, "Mail Center"],
  [/^\/mail-center$/, "Mail Center"],
  [/^\/agents$/, "Agent Console"],
  [/^\/system-health$/, "System Health"],
  [/^\/reports\/fair-report$/, "Sales Report"],
  // The Supply Chain hub is a single-segment route, so it never reaches the
  // /scm/* segment table below (which needs a 2nd segment). Curate it here —
  // without this entry labelForPath title-cased the slug to a bare "Scm".
  [/^\/scm$/, "Supply Chain"],
];

// SCM V2 routes ship dozens of /scm/* pages — hand-rolling a regex per page
// bloats the list. Instead the second URL segment picks the label from this
// table: [plural, singular] where plural covers the listing (and its
// action children like /new or /from-*) and singular covers the detail
// page (a trailing entity id). Kept as one central table so adding a new
// SCM route only means one map entry, not two regex lines.
const SCM_SEGMENT_LABELS: Record<string, [string, string]> = {
  // Sales chain
  "sales-orders": ["Sales Orders", "Sales Order"],
  "delivery-orders": ["Delivery Orders", "Delivery Order"],
  "sales-invoices": ["Sales Invoices", "Sales Invoice"],
  "delivery-returns": ["Delivery Returns", "Delivery Return"],
  // Owner 2026-07-27 — the two amendment queues carry SHORT tab names so the
  // workspace strip stays scannable ("SO Amdt." / "PO Amdt."), and the two
  // sides are distinguishable at a glance. Detail pages push their own
  // breadcrumbs, so the descriptive titles live on-page, not here.
  "amendments": ["SO Amdt.", "SO Amdt."],
  // Procurement chain
  "purchase-orders": ["Purchase Orders", "Purchase Order"],
  "po-amendments": ["PO Amdt.", "PO Amdt."],
  "purchase-invoices": ["Purchase Invoices", "Purchase Invoice"],
  "purchase-returns": ["Purchase Returns", "Purchase Return"],
  "grns": ["Goods Received Notes", "Goods Received Note"],
  "mrp": ["MRP", "MRP"],
  "suppliers": ["Suppliers", "Supplier"],
  // Warehouse / stock
  "warehouses": ["Warehouses", "Warehouse"],
  "inventory": ["Inventory", "Inventory"],
  "stock-adjustments": ["Stock Adjustments", "Stock Adjustment"],
  "stock-transfers": ["Stock Transfers", "Stock Transfer"],
  "stock-takes": ["Stock Takes", "Stock Take"],
  // Products
  "products": ["Products", "Product"],
  "categories": ["Categories", "Category"],
  "product-models": ["Product Models", "Product Model"],
  "fabric-tracking": ["Fabric Tracking", "Fabric Tracking"],
  // Finance
  "accounting": ["Accounting", "Accounting"],
  "outstanding": ["Outstanding", "Outstanding"],
  "unbilled-deliveries": ["Not Billed", "Delivered, Not Yet Billed"],
  "payment-vouchers": ["Payment Vouchers", "Payment Voucher"],
  "currencies": ["Currencies", "Currency"],
  // Transportation
  "drivers": ["Drivers", "Driver"],
  "delivery-planning": ["Delivery Planning", "Delivery Planning"],
  "dp-orders": ["DP Orders", "DP Order"],
  "delivery-planning-regions": ["Delivery Planning Regions", "Delivery Planning Regions"],
  "fleet": ["Fleet", "Fleet"],
  "lorry-capacity": ["Lorry Capacity", "Lorry Capacity"],
  // Consignment (sale side)
  "consignment-orders": ["Consignment Orders", "Consignment Order"],
  "consignment-notes": ["Consignment Notes", "Consignment Note"],
  "consignment-returns": ["Consignment Returns", "Consignment Return"],
  // Consignment (purchase side)
  "purchase-consignment-orders": ["Purchase Consignment Orders", "Purchase Consignment Order"],
  "purchase-consignment-receives": ["Purchase Consignment Receives", "Purchase Consignment Receive"],
  "purchase-consignment-returns": ["Purchase Consignment Returns", "Purchase Consignment Return"],
  // Section hubs — the Level-2 sub-group landing pages (ScmSubgroupHub). Their
  // slug is the singular group id and the label mirrors the NAV_TABS group
  // header the hub itself renders as its title (no detail child → singular ==
  // plural). Without these, /scm/<group> title-cased the slug to "Scm".
  "sales-order": ["Sales Order", "Sales Order"],
  "consignment": ["Consignment", "Consignment"],
  "procurement": ["Procurement", "Procurement"],
  "transportation": ["Transportation", "Transportation"],
  "warehouse": ["Warehouse", "Warehouse"],
  "finance": ["Finance", "Finance"],
  // Misc
  "maintenance": ["Maintenance", "Maintenance"],
};

// /scm/reports/<report-slug> — its own table since these live one level
// deeper (segs[2] is the report slug).
const SCM_REPORT_LABELS: Record<string, string> = {
  "sales-order-detail-listing": "SO Detail Listing",
  "delivery-order-detail-listing": "DO Detail Listing",
  "sales-invoice-detail-listing": "SI Detail Listing",
  "delivery-return-detail-listing": "DR Detail Listing",
};

// /scm/hr/<leaf-slug> — HR sits one level deeper too (segs[2] is the leaf) and
// has no /scm/hr hub page, so like reports it gets its own table. Labels mirror
// the NAV_TABS HR leaves. Without this, /scm/hr/* title-cased "scm" to "Scm".
const SCM_HR_LABELS: Record<string, string> = {
  "commission": "Commission",
  "settings": "HR Settings",
};

// Path segments that are actions/children rather than entity IDs — used to
// keep the plural label on /scm/<x>/new, /scm/<x>/from-so, etc. Anything
// not in this set (and not obviously an action prefix) is treated as an
// entity id → singular label.
const SCM_ACTION_SEGMENTS = new Set([
  "new",
  "guided",
  "maintenance",
  "generate",
  "stock-card",
]);

function isScmActionSegment(seg: string): boolean {
  if (SCM_ACTION_SEGMENTS.has(seg)) return true;
  if (seg.startsWith("from-")) return true;
  return false;
}

export function labelForPath(pathname: string): string {
  for (const [re, label] of ROUTE_LABELS) {
    if (re.test(pathname)) return label;
  }
  const segs = pathname.split("/").filter(Boolean);
  // /scm/* — resolve via the segment tables above.
  if (segs[0] === "scm" && segs.length >= 2) {
    if (segs[1] === "reports" && segs[2]) {
      return SCM_REPORT_LABELS[segs[2]] ?? "Report";
    }
    if (segs[1] === "hr" && segs[2]) {
      return SCM_HR_LABELS[segs[2]] ?? "HR";
    }
    const entry = SCM_SEGMENT_LABELS[segs[1]];
    if (entry) {
      const [plural, singular] = entry;
      const isDetail = !!segs[2] && !isScmActionSegment(segs[2]);
      return isDetail ? singular : plural;
    }
    // Unknown /scm/* — fall through to the generic first-segment
    // uppercase so at least it reads something, not blank.
  }
  const seg = segs[0] || "";
  return seg ? seg[0].toUpperCase() + seg.slice(1) : "";
}
