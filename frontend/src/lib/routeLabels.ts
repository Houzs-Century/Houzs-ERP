// Route → human label resolution. Extracted VERBATIM from TopNavbar.tsx so the
// workspace tab strip (components/WorkspaceTabs.tsx) can label its tabs with
// exactly the strings the breadcrumb fallback uses — one table, no drift.
// TopNavbar keeps consuming labelForPath from here.

// ── Route → label fallback ─────────────────────────────────
// Quick mapping for pages that don't push breadcrumbs themselves.
// Keeps the navbar from rendering as an empty strip.
const ROUTE_LABELS: Array<[RegExp, string]> = [
  [/^\/$/, "Overview"],
  // Money in's documents, each a page of its own (Claude Design, batch 5 §8).
  [/^\/scm\/ar-invoices\/deposit\/.+$/, "Deposit invoice"],
  [/^\/scm\/ar-invoices\/bills\/.+$/, "Debtor bill"],
  [/^\/scm\/ar-invoices\/sales\/.+$/, "Sales invoice"],
  [/^\/scm\/receipts\/official\/.+$/, "Official receipt"],
  [/^\/scm\/receipts\/debtor\/.+$/, "Debtor receipt"],
  [/^\/scm\/receipts\/sundry\/.+$/, "Receipt"],
  [/^\/scm\/ap-invoices\/duplicates$/, "Duplicate supplier bills"],
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
  [/^\/reports\/fair-report$/, "Sales report"],
  [/^\/hr\/employees$/, "Employees & Attendance"],
  // The Supply Chain hub is a single-segment route, so it never reaches the
  // /scm/* segment table below (which needs a 2nd segment). Curate it here —
  // without this entry labelForPath title-cased the slug to a bare "Scm".
  [/^\/scm$/, "Supply Chain"],
];

// SCM V2 routes ship dozens of /scm/* pages — hand-rolling a regex per page
// bloats the list. Instead the second URL segment picks the label from this
// table. A bare string is used where the listing and the detail page read the
// same; a [plural, singular] pair where they differ — plural covers the listing
// (and its action children like /new or /from-*), singular the detail page (a
// trailing entity id). One central table, so a new SCM route is one map entry,
// not two regex lines. EVERY /scm section in routeManifest must have an entry
// (routeLabels.test.ts walks the manifest and fails CI otherwise), so a tab
// always shows the page's own title and never falls through to a bare "Scm".
type SegmentLabel = string | [string, string];
export const SCM_SEGMENT_LABELS: Record<string, SegmentLabel> = {
  // Sales chain
  "sales-orders": ["Sales Orders", "Sales Order"],
  "delivery-orders": ["Delivery Orders", "Delivery Order"],
  "sales-invoices": ["Sales Invoices", "Sales Invoice"],
  "delivery-returns": ["Delivery Returns", "Delivery Return"],
  // The DO print's "SCAN . MARK LOADED" QR lands on this one-shot page.
  "do-load": "Scan Delivery Order",
  // Owner 2026-07-27 — the two amendment queues carry SHORT tab names so the
  // workspace strip stays scannable ("SO Amdt." / "PO Amdt."), and the two
  // sides are distinguishable at a glance. Detail pages push their own
  // breadcrumbs, so the descriptive titles live on-page, not here.
  "amendments": "SO Amdt.",
  // Procurement chain
  "purchase-orders": ["Purchase Orders", "Purchase Order"],
  "po-amendments": "PO Amdt.",
  "cancel-requests": ["Cancellation Requests", "Cancellation Request"],
  "payment-backdate-requests": ["Payment Backdate Requests", "Payment Backdate Request"],
  "purchase-invoices": ["Purchase Invoices", "Purchase Invoice"],
  "purchase-returns": ["Purchase Returns", "Purchase Return"],
  "grns": ["Goods Received", "Goods Received Note"],
  "mrp": "MRP",
  "suppliers": ["Suppliers", "Supplier"],
  "supplier-maintenance": "Supplier Maintenance",
  "payment-listing": "Payment Listing",
  // Warehouse / stock
  "warehouses": ["Warehouses", "Warehouse"],
  "inventory": "Inventory",
  "stock-adjustments": ["Stock Adjustments", "Stock Adjustment"],
  "stock-transfers": ["Stock Transfers", "Stock Transfer"],
  "stock-takes": ["Stock Takes", "Stock Take"],
  "fabric-tracking": "Fabric Converter",
  "loading-list": "Loading List",
  // Products
  "products": ["Products", "Product"],
  "categories": ["Categories", "Category"],
  "product-models": ["Product Models", "Product Model"],
  "product-requests": ["Product Requests", "Product Request"],
  // Finance
  "accounting": "Accounting",
  "outstanding": "Outstanding",
  // Money in's pages carry the redesign's names (owner's Claude Design, batch 5).
  "unbilled-deliveries": "Not yet billed",
  "payment-vouchers": ["Payment Vouchers", "Payment Voucher"],
  "payment-requests": ["Payment Requests", "Payment Request"],
  "currencies": ["Currencies", "Currency"],
  "chart-of-accounts": "Chart of accounts",
  "other-debtors": ["Debtor maintenance", "Other debtor"],
  "receipts": ["Receipts", "Receipt"],
  "official-receipts": ["Official receipts", "Official receipt"],
  "ap-invoices": ["Supplier Bills", "Supplier Bill"],
  "ar-invoices": ["Invoices", "Invoice"],
  "credit-notes": ["Credit / debit notes", "Credit / debit note"],
  "deposit-invoices": ["Deposit invoices", "Deposit invoice"],
  "official-docs": "Official Invoices Owed",
  "supplier-notes": "Supplier CN / DN",
  "opening-balance": "Opening balance",
  "forecast": "Forecast P&L",
  "finance-dashboard": "Dashboard",
  "daily-bank": "Daily Bank",
  "merchant-recon": "Merchant Reports",
  "bank-recon": "Bank Statements",
  "unmatched-payments": "Unmatched Payments",
  "settlement-setup": "Recon setup",
  "fair-pending": "Fair Links to Settle",
  // Transportation
  "drivers": ["Drivers", "Driver"],
  "delivery-planning": "Delivery Planning",
  "delivery-planning-driver": "Last Mile Delivery (Driver)",
  "dp-orders": ["DP Orders", "DP Order"],
  "auto-schedule": "Delivery Date Arrangement",
  "trips": "Delivery Time Arrangement",
  "fleet-day": "Last Mile Delivery",
  "fleet-run-sheet": "Driver Run-Sheet",
  "driver-leave": "Crew Leave",
  "delivery-planning-regions": "Delivery Regions",
  "delivery-residence-rules": "Residence Rules",
  "delivery-zones": ["Delivery Zones", "Delivery Zone"],
  "delivery-rate-cards": ["Delivery Rate Cards", "Delivery Rate Card"],
  "delivery-maintenance": "Coverage & Fleet",
  "threepl-companies": ["3PL Companies", "3PL Company"],
  "saved-locations": ["Saved Locations", "Saved Location"],
  "fleet": "Fleet",
  "lorry-capacity": "Lorry Capacity",
  "lorry-live-map": "Lorry Live Map",
  "logistic-overview": "Logistic Overview",
  "procurement-overview": "Procurement Overview",
  // Consignment (sale side)
  "consignment-orders": ["Consignment Orders", "Consignment Order"],
  "consignment-notes": ["Consignment Notes", "Consignment Note"],
  "consignment-returns": ["Consignment Returns", "Consignment Return"],
  // Consignment (purchase side)
  "purchase-consignment-orders": ["Purchase Consignment Orders", "Purchase Consignment Order"],
  "purchase-consignment-receives": ["Purchase Consignment Receives", "Purchase Consignment Receive"],
  "purchase-consignment-returns": ["Purchase Consignment Returns", "Purchase Consignment Return"],
  // Section hubs — the Level-2 sub-group landing pages (ScmSubgroupHub). The
  // slug is the singular group id and the label mirrors the NAV_TABS group
  // header the hub renders as its title. Without these, /scm/<group> title-cased
  // the slug to "Scm".
  "sales-order": "Sales Order",
  "consignment": "Consignment",
  "procurement": "Procurement",
  "transportation": "Transportation",
  "warehouse": "Warehouse",
  "finance": "Finance",
  // Misc
  "maintenance": "Maintenance",
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

// Last-resort label for a URL segment with no curated entry: the slug, dashes
// turned to spaces and each word capitalised ("fleet-day" -> "Fleet Day").
// It is only a SAFETY NET — a real page belongs in a table above so its tab
// carries its on-screen title, not a prettied slug — but it guarantees a /scm/
// page can never again collapse to a bare "Scm" (which is what an uncurated
// second segment used to do: it fell through to the FIRST segment, "scm").
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
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
      // A bare string means listing and detail read the same.
      const [plural, singular] = typeof entry === "string" ? [entry, entry] : entry;
      const isDetail = !!segs[2] && !isScmActionSegment(segs[2]);
      return isDetail ? singular : plural;
    }
    // Unknown /scm/<seg> — label it from the SECTION segment (the second one),
    // never the first: the first is always "scm", and collapsing to "Scm" is
    // exactly the bug this guards against. Curate the page above to give it its
    // real title; this keeps it readable until someone does.
    return titleCaseSlug(segs[1]);
  }
  const seg = segs[0] || "";
  return seg ? titleCaseSlug(seg) : "";
}
