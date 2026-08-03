/**
 * Route-chunk prefetching — hides the first-click stall on a lazy route.
 *
 * Every page in App.tsx is `lazy()`, so the first visit to a page downloads its
 * chunk BEFORE the page can even start fetching its data: the user clicks, gets
 * <PageSkeleton>, and waits out a network round trip that nothing warned us
 * about. Two cheap predictions cover most of it — warm a short list of routes
 * while the browser is idle (below), and warm a route when the pointer rests on
 * its sidebar link (Sidebar.tsx calls prefetchRoute on hover).
 *
 * This is a pure optimisation: everything here is allowed to fail, be skipped,
 * or never run at all, and the app must behave identically. `lazy()` still owns
 * the real load on click — we only try to have already paid for it.
 */

/**
 * Path -> chunk loader. The keys are pathnames (no query — see routeKey); the
 * values re-issue the SAME dynamic import as the matching `lazy()` in App.tsx.
 *
 * Each specifier MUST resolve to the exact module App.tsx imports. Rollup keys
 * its module graph by RESOLVED path, so `../pages/X` here and `./pages/X` there
 * are one module and one chunk — the `../` is only this file living one
 * directory deeper. What would break it is resolving somewhere ELSE (a barrel
 * that re-exports the page, a near-duplicate filename): that emits a SECOND
 * chunk, so we would download the page twice and make the stall worse instead
 * of shorter. Keep these paths a mirror of App.tsx's, nothing cleverer.
 *
 * Drift is caught by the build, not at runtime: rename a page and this file
 * stops resolving, so `tsc -b && vite build` fails in CI rather than shipping a
 * prefetch that 404s. A route that isn't listed here simply isn't prefetched.
 *
 * Sidebar-reachable pages only — a route nothing links to has no hover to warm
 * it, and the idle list below is deliberately far shorter than this map.
 */
const ROUTE_CHUNKS: Record<string, () => Promise<unknown>> = {
  "/": () => import("../pages/Overview"),
  "/assr": () => import("../pages/ServiceCases"),
  "/my-cases": () => import("../pages/MyCases"),
  "/projects": () => import("../pages/Projects"),
  "/mail-center": () => import("../pages/MailCenter/Inbox"),
  "/announcements": () => import("../pages/Announcements"),
  "/team": () => import("../pages/Team"),
  "/system-health": () => import("../pages/SystemHealth"),
  "/agents": () => import("../pages/Agents"),
  "/settings": () => import("../pages/Settings"),
  // Supply Chain hubs — the /scm landing grid and the six Level-2 sub-group
  // hubs, which all render from the ONE ScmSubgroupHub module.
  "/scm": () => import("../pages/ScmHub"),
  "/scm/sales-order": () => import("../pages/ScmSubgroupHub"),
  "/scm/consignment": () => import("../pages/ScmSubgroupHub"),
  "/scm/procurement": () => import("../pages/ScmSubgroupHub"),
  "/scm/transportation": () => import("../pages/ScmSubgroupHub"),
  "/scm/warehouse": () => import("../pages/ScmSubgroupHub"),
  "/scm/finance": () => import("../pages/ScmSubgroupHub"),
  // Sales Order flow.
  "/scm/sales-orders": () => import("../pages/scm-v2/MfgSalesOrdersListV2"),
  "/scm/amendments": () => import("../pages/scm-v2/Amendments"),
  "/scm/delivery-orders": () => import("../pages/scm-v2/MfgDeliveryOrdersListV2"),
  "/scm/sales-invoices": () => import("../pages/scm-v2/SalesInvoicesListV2"),
  "/scm/delivery-returns": () => import("../pages/scm-v2/DeliveryReturnsListV2"),
  // Consignment.
  "/scm/consignment-orders": () => import("../pages/scm-v2/ConsignmentOrders"),
  "/scm/consignment-notes": () => import("../pages/scm-v2/ConsignmentNotes"),
  "/scm/consignment-returns": () => import("../pages/scm-v2/ConsignmentReturns"),
  "/scm/purchase-consignment-orders": () => import("../pages/scm-v2/PurchaseConsignmentOrders"),
  "/scm/purchase-consignment-receives": () => import("../pages/scm-v2/PurchaseConsignmentReceives"),
  "/scm/purchase-consignment-returns": () => import("../pages/scm-v2/PurchaseConsignmentReturns"),
  // Procurement.
  "/scm/products": () => import("../pages/scm-v2/Products"),
  "/scm/suppliers": () => import("../pages/scm-v2/SuppliersV2Route"),
  "/scm/mrp": () => import("../pages/scm-v2/Mrp"),
  "/scm/purchase-orders": () => import("../pages/scm-v2/PurchaseOrdersListV2"),
  "/scm/grns": () => import("../pages/scm-v2/GoodsReceivedListV2"),
  "/scm/purchase-invoices": () => import("../pages/scm-v2/PurchaseInvoicesListV2"),
  "/scm/purchase-returns": () => import("../pages/scm-v2/PurchaseReturnsListV2"),
  // Transportation.
  "/scm/delivery-planning": () => import("../pages/scm-v2/DeliveryPlanning"),
  "/scm/dp-orders": () => import("../pages/scm-v2/DpOrders"),
  "/scm/fleet": () => import("../pages/scm-v2/Fleet"),
  "/scm/lorry-capacity": () => import("../pages/scm-v2/LorryCapacity"),
  // "/scm/drivers" retired 2026-07-17 (merged into /scm/fleet). Left OUT on
  // purpose: a prefetch entry here would re-import the unmounted page's chunk.
  "/scm/delivery-planning-regions": () => import("../pages/scm-v2/DeliveryPlanningRegions"),
  // Warehouse.
  "/scm/warehouses": () => import("../pages/scm-v2/Warehouses"),
  "/scm/inventory": () => import("../pages/scm-v2/Inventory"),
  "/scm/stock-adjustments": () => import("../pages/scm-v2/StockAdjustments"),
  "/scm/stock-transfers": () => import("../pages/scm-v2/StockTransfersListV2"),
  "/scm/stock-takes": () => import("../pages/scm-v2/StockTakesListV2"),
  // Finance.
  "/scm/accounting": () => import("../pages/scm-v2/Accounting"),
  "/scm/payment-vouchers": () => import("../pages/scm-v2/PaymentVouchers"),
  "/scm/outstanding": () => import("../pages/scm-v2/Outstanding"),
  "/scm/unbilled-deliveries": () => import("../pages/scm-v2/UnbilledDeliveriesV2"),
  "/scm/currencies": () => import("../pages/scm-v2/Currencies"),
  // ── Keys below are NOT pathnames, so a hover can never match them; they
  //    exist only for the idle list to name a chunk the sidebar can't reach. ──
  // Every /scm/* page except the hubs renders inside <Scm2990Shell>, so a first
  // click into ANY of them needs the shell chunk on top of the page chunk. One
  // download, ~100 routes cheaper — which is why it leads the idle list.
  "scm-2990-shell": () => import("../pages/scm-v2/Scm2990Shell"),
  // The SO list's own destination: every row opens this. Keyed by App.tsx's
  // route pattern since the real pathname carries a doc number.
  "/scm/sales-orders/:docNo": () => import("../pages/scm-v2/SalesOrderDetailV2"),
  // ── Document CREATE forms. Every SCM list's most likely next click is its own
  //    "New" button, but each create form is its OWN lazy chunk that was NOT in
  //    this map — so that click cold-loaded the chunk and flashed <PageSkeleton>
  //    (owner: "why does it flash when I click some modules", on
  //    /scm/stock-transfers/new). Keyed by the real `<listpath>/new` pathname so
  //    prefetchDocCreate() / a hover resolve them like any other route. ──
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

/**
 * Routes warmed while the browser is idle, in priority order — the queue is
 * serial, so this IS the download order.
 *
 * Eight of 110, on purpose. Warming everything would pull the whole ~1.3 MB
 * lazy tail (scripts/check-bundle-size.mjs) into every session to save a stall
 * on the two or three pages that session opens — worse than the disease, and
 * billed to every user on every cold load. So the list is only what is either
 * near-certain to be needed or leveraged across many routes:
 *
 *  1. the 2990 shell        — ~1 KB that ~100 /scm/* routes each need on top of
 *                             their own chunk; pays for itself on any SCM click
 *  2. Sales Orders list     — the one page promoted to a top-level sidebar
 *                             shortcut, and the whole of a sales rep's SCM tree
 *  3. Sales Order detail    — every row of (2) opens it
 *  4. Supply Chain hub      — where the "Supply Chain" nav header lands
 *  5. Delivery Orders       — the SO's downstream doc; rep-visible leaf
 *  6. Sales Invoices        — same, one step further downstream
 *  7. My Cases              — where a rep's "Service Cases" header lands, ~4 KB
 *  8. Overview              — costs nothing when the user landed on "/" (already
 *                             in the module cache, so the import resolves with
 *                             no request); covers arriving via a deep link
 *
 * The Service Cases board and Projects are NOT here, though both are top-level
 * sections: they are by far the two largest page modules in the app and would
 * have been ~70% of this list's bytes on their own, spent on whichever team
 * doesn't use them. They are what the hover path is for — a section that big is
 * reached by pointing at its nav entry, which warms it a beat before the click.
 *
 * Not gated on permissions: static and short costs a warehouse-only user a few
 * chunks they won't open, which is cheaper in bytes AND complexity than teaching
 * the prefetcher the auth matrix. Revisit that trade before growing this list.
 */
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

/** Sidebar links carry query strings (/assr?view=hub, /team?tab=members) but a
 *  chunk is per-page, not per-tab — so the map is keyed by pathname alone. */
function routeKey(href: string): string {
  return href.split("?")[0];
}

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * Whether speculative downloading is defensible right now. Prefetching spends
 * someone else's data plan on a guess — worth ~200 ms when it lands, worth real
 * money when it doesn't and the connection is metered (a laptop tethered to a
 * phone at a roadshow venue, which is where this app gets used off-network). If
 * the user asked to save data, or the link is 2g, they pay only for pages they
 * actually open.
 *
 * `connection` is Chromium-only; absent means Safari/Firefox, not "bad link", so
 * the default stays allow.
 */
function connectionAllows(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return conn.effectiveType !== "2g" && conn.effectiveType !== "slow-2g";
}

/** Runs `cb` when the browser has nothing better to do. lib.dom types
 *  requestIdleCallback as always present, but Safari has never shipped it — hence
 *  the runtime check rather than a truthiness test the compiler would reject. A
 *  plain timer is close enough there for work this optional. */
function whenIdle(cb: () => void): void {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(cb);
  else window.setTimeout(cb, 1500);
}

interface Job {
  key: string;
  /** Wait for an idle moment before this one. Set for the warm list, not for a
   *  hover — a hover means the click is a moment away. */
  idle: boolean;
}

/** Per-path dedupe. A chunk requested once is never requested again; the mark is
 *  dropped on failure so a later attempt can retry. */
const prefetched = new Set<string>();
const queue: Job[] = [];
let running = false;

/**
 * Drains `queue` ONE chunk at a time. Never in parallel: a prefetch is a guess
 * about the next page, and it must never contend for connections with the data
 * fetches of the page the user is actually looking at. Being late is free; being
 * in the way is not.
 */
function pump(): void {
  if (running) return;
  // Re-checked per chunk, not just at enqueue: a link can drop to 2g or the data
  // saver can come on mid-session, and the rest of the queue should evaporate
  // rather than ride out a decision the user has since reversed.
  if (!connectionAllows()) {
    for (const job of queue) prefetched.delete(job.key);
    queue.length = 0;
    return;
  }
  if (queue.length === 0) return;
  running = true;
  const start = () => {
    // Read the head HERE, not before the idle wait: a hover can jump the queue
    // while we wait, and it should win the slot it jumped for.
    const job = queue.shift();
    if (!job) {
      running = false;
      return;
    }
    const load = ROUTE_CHUNKS[job.key];
    // Unreachable — enqueue only queues keys that resolve. Skip to the next job
    // anyway: a queue stalled forever is a worse failure than a missed chunk.
    if (!load) {
      running = false;
      pump();
      return;
    }
    load()
      // Swallowed on purpose, and this is the important part: after a deploy the
      // hashed chunk this closure points at can be gone, and a prefetch is the
      // one caller with no user waiting on the answer. Nothing rethrows and
      // nothing reaches React, so a stale-chunk 404 here can't trip
      // RouteFallback's boundary — which would unregister the service worker and
      // reload the page under someone who just moved their mouse. The failure
      // stays a no-op; if they do click, lazy() reports it for real.
      .catch(() => {
        prefetched.delete(job.key);
      })
      .then(() => {
        running = false;
        pump();
      });
  };
  // Yield between every idle chunk rather than chaining the warm list back to
  // back — the list is a background nicety and the tab may have real work. A
  // hover skips the wait: the click is a moment away.
  if (queue[0].idle) whenIdle(start);
  else start();
}

function enqueue(key: string, idle: boolean): void {
  if (prefetched.has(key)) return;
  if (!ROUTE_CHUNKS[key]) return;
  prefetched.add(key);
  // A hover jumps the warm list: the user is pointing at it.
  if (idle) queue.push({ key, idle });
  else queue.unshift({ key, idle });
  pump();
}

/** How long the pointer must rest before we believe it. Sweeping down the
 *  sidebar fires mouseenter on every link it crosses; without this we would
 *  queue a dozen chunks for pages the user never paused on. */
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
