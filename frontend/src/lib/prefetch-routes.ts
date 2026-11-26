
const ROUTE_CHUNKS: Record<string, () => Promise<unknown>> = {
  "/": () => import("../pages/Overview"),
  "/assr": () => import("../pages/ServiceCases"),
  "/my-cases": () => import("../pages/MyCases"),
  "/projects": () => import("../pages/Projects"),
  "/mail-center": () => import("../pages/MailCenter/Inbox"),
  "/announcements": () => import("../pages/Announcements"),
  "/team": () => import("../pages/Team"),
  "/system-health": () => import("../pages/SystemHealth"),
  "/ai-usage": () => import("../pages/AiUsage"),
  "/ocr": () => import("../pages/OcrDashboard"),
  "/agents": () => import("../pages/Agents"),
  "/settings": () => import("../pages/Settings"),
  "/scm": () => import("../pages/ScmHub"),
  "/scm/sales-order": () => import("../pages/ScmSubgroupHub"),
  "/scm/consignment": () => import("../pages/ScmSubgroupHub"),
  "/scm/procurement": () => import("../pages/ScmSubgroupHub"),
  "/scm/transportation": () => import("../pages/ScmSubgroupHub"),
  "/scm/warehouse": () => import("../pages/ScmSubgroupHub"),
  "/scm/finance": () => import("../pages/ScmSubgroupHub"),
  "/scm/sales-orders": () => import("../pages/scm-v2/MfgSalesOrdersListV2"),
  "/scm/amendments": () => import("../pages/scm-v2/Amendments"),
  "/scm/delivery-orders": () => import("../pages/scm-v2/MfgDeliveryOrdersListV2"),
  "/scm/sales-invoices": () => import("../pages/scm-v2/SalesInvoicesListV2"),
  "/scm/delivery-returns": () => import("../pages/scm-v2/DeliveryReturnsListV2"),
  "/scm/consignment-orders": () => import("../pages/scm-v2/ConsignmentOrders"),
  "/scm/consignment-notes": () => import("../pages/scm-v2/ConsignmentNotes"),
  "/scm/consignment-returns": () => import("../pages/scm-v2/ConsignmentReturns"),
  "/scm/purchase-consignment-orders": () => import("../pages/scm-v2/PurchaseConsignmentOrders"),
  "/scm/product-requests": () => import("../pages/scm-v2/ProductRequests"),
  "/scm/purchase-consignment-receives": () => import("../pages/scm-v2/PurchaseConsignmentReceives"),
  "/scm/purchase-consignment-returns": () => import("../pages/scm-v2/PurchaseConsignmentReturns"),
  "/scm/products": () => import("../pages/scm-v2/Products"),
  "/scm/suppliers": () => import("../pages/scm-v2/SuppliersV2Route"),
  "/scm/mrp": () => import("../pages/scm-v2/Mrp"),
  "/scm/purchase-orders": () => import("../pages/scm-v2/PurchaseOrdersListV2"),
  "/scm/grns": () => import("../pages/scm-v2/GoodsReceivedListV2"),
  "/scm/purchase-invoices": () => import("../pages/scm-v2/PurchaseInvoicesListV2"),
  "/scm/purchase-returns": () => import("../pages/scm-v2/PurchaseReturnsListV2"),
  "/scm/delivery-planning": () => import("../pages/scm-v2/DeliveryPlanning"),
  "/scm/delivery-planning-driver": () => import("../pages/scm-v2/DeliveryPlanningDriver"),
  "/scm/dp-orders": () => import("../pages/scm-v2/DpOrders"),
  "/scm/fleet": () => import("../pages/scm-v2/Fleet"),
  "/scm/lorry-capacity": () => import("../pages/scm-v2/LorryCapacity"),
  "/scm/delivery-planning-regions": () => import("../pages/scm-v2/DeliveryPlanningRegions"),
  "/scm/warehouses": () => import("../pages/scm-v2/Warehouses"),
  "/scm/inventory": () => import("../pages/scm-v2/Inventory"),
  "/scm/stock-adjustments": () => import("../pages/scm-v2/StockAdjustments"),
  "/scm/stock-transfers": () => import("../pages/scm-v2/StockTransfersListV2"),
  "/scm/stock-takes": () => import("../pages/scm-v2/StockTakesListV2"),
  "/scm/accounting": () => import("../pages/scm-v2/Accounting"),
  "/scm/payment-vouchers": () => import("../pages/scm-v2/PaymentVouchers"),
  "/scm/outstanding": () => import("../pages/scm-v2/Outstanding"),
  "/scm/unbilled-deliveries": () => import("../pages/scm-v2/UnbilledDeliveriesV2"),
  "/scm/currencies": () => import("../pages/scm-v2/Currencies"),
  "scm-2990-shell": () => import("../pages/scm-v2/Scm2990Shell"),
  "/scm/sales-orders/:docNo": () => import("../pages/scm-v2/SalesOrderDetailV2"),
  "/scm/purchase-orders/new": () => import("../pages/scm-v2/PurchaseOrderNew"),
  "/scm/grns/new": () => import("../pages/scm-v2/GrnNew"),
  "/scm/purchase-invoices/new": () => import("../pages/scm-v2/PurchaseInvoiceNew"),
  "/scm/payment-vouchers/new": () => import("../pages/scm-v2/PaymentVoucherNew"),
  "/scm/stock-adjustments/new": () => import("../pages/scm-v2/StockAdjustmentNew"),
  "/scm/stock-transfers/new": () => import("../pages/scm-v2/StockTransferNew"),
  "/scm/stock-takes/new": () => import("../pages/scm-v2/StockTakeNew"),
  "/scm/purchase-returns/new": () => import("../pages/scm-v2/PurchaseReturnNew"),
  "/scm/sales-orders/new": () => import("../pages/scm-v2/SalesOrderNew"),
  "/scm/delivery-orders/new": () => import("../pages/scm-v2/DeliveryOrderNewV2"),
  "/scm/sales-invoices/new": () => import("../pages/scm-v2/SalesInvoiceNew"),
  "/scm/delivery-returns/new": () => import("../pages/scm-v2/DeliveryReturnNew"),
  "/scm/consignment-orders/new": () => import("../pages/scm-v2/ConsignmentOrderNew"),
  "/scm/consignment-notes/new": () => import("../pages/scm-v2/ConsignmentNoteNew"),
  "/scm/consignment-returns/new": () => import("../pages/scm-v2/ConsignmentReturnNew"),
  "/scm/purchase-consignment-orders/new": () => import("../pages/scm-v2/PurchaseConsignmentOrderNew"),
  "/scm/purchase-consignment-receives/new": () => import("../pages/scm-v2/PurchaseConsignmentReceiveNew"),
  "/scm/purchase-consignment-returns/new": () => import("../pages/scm-v2/PurchaseConsignmentReturnNew"),
};

const IDLE_ROUTES = [
  "scm-2990-shell",
  "/scm/sales-orders",
  "/scm/sales-orders/:docNo",
  "/scm",
  "/scm/delivery-orders",
  "/scm/sales-invoices",
  "/my-cases",
  "/",
];

function routeKey(href: string): string {
  return href.split("?")[0];
}

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

function connectionAllows(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return conn.effectiveType !== "2g" && conn.effectiveType !== "slow-2g";
}

function whenIdle(cb: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(cb);
  else window.setTimeout(cb, 1500);
}

interface Job {
  key: string;
  idle: boolean;
}

const prefetched = new Set<string>();
const queue: Job[] = [];
let running = false;

function pump(): void {
  if (running) return;
  if (!connectionAllows()) {
    for (const job of queue) prefetched.delete(job.key);
    queue.length = 0;
    return;
  }
  if (queue.length === 0) return;
  running = true;
  const start = () => {
    const job = queue.shift();
    if (!job) {
      running = false;
      return;
    }
    const load = ROUTE_CHUNKS[job.key];
    if (!load) {
      running = false;
      pump();
      return;
    }
    load()
      .catch(() => {
        prefetched.delete(job.key);
      })
      .then(() => {
        running = false;
        pump();
      });
  };
  if (queue[0].idle) whenIdle(start);
  else start();
}

function enqueue(key: string, idle: boolean): void {
  if (prefetched.has(key)) return;
  if (!ROUTE_CHUNKS[key]) return;
  prefetched.add(key);
  if (idle) queue.push({ key, idle });
  else queue.unshift({ key, idle });
  pump();
}

const HOVER_INTENT_MS = 120;
let hoverTimer: number | null = null;

/**
 * Warm the chunk for `href` — call on sidebar link hover. Takes the link's `to`
 * verbatim (query and all); unknown paths are a no-op, so a nav entry with no
 * map entry is simply not prefetched.
 *
 * Only one link can be hovered at a time, so one shared timer is enough: each
 * new hover cancels the last, and a sweep across the rail resolves to the single
 * link the pointer settled on.
 */
export function prefetchRoute(href: string): void {
  if (hoverTimer !== null) window.clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    hoverTimer = null;
    enqueue(routeKey(href), false);
  }, HOVER_INTENT_MS);
}

/** Queue the idle warm list. Called once from the app shell (Layout). */
export function prefetchTopRoutes(): void {
  for (const key of IDLE_ROUTES) enqueue(key, true);
}

/**
 * Warm the "New document" form chunk for a list the operator is currently on —
 * call with the list pathname (the SCM shell does this on every navigation). The
 * create route is always `<listpath>/new`, so we derive the key rather than keep
 * a second table; `enqueue` no-ops when that key isn't a known chunk (a detail
 * page, a list with no create form). Idle, not urgent: the operator is reading
 * the list, and the New click is a beat away — this only tries to have already
 * paid for it, exactly like the hover warm.
 */
export function prefetchDocCreate(listPathname: string): void {
  enqueue(`${listPathname}/new`, true);
}
