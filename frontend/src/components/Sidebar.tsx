import { NavLink, useLocation } from "react-router-dom";
import { markWorkspaceOpenIntent } from "../lib/workspaceTabs";

// Workspace tab strip: a plain left-click on a sidebar destination is the ONE
// gesture that opens/activates a tab (lib/workspaceTabs.ts). Modified clicks
// (Ctrl/Cmd/Shift/Alt — a real browser window) must not mark, and the mark
// itself expires if no navigation follows.
function markOpenIntentOnPlainClick(e: { button?: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): void {
  if ((e.button ?? 0) === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    markWorkspaceOpenIntent();
  }
}

import {
  ClipboardList,
  Zap,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronRight,
  Users,
  LogOut,
  Calendar,
  DollarSign,
  Wrench,
  FolderKanban,
  ShieldCheck,
  Activity,
  RefreshCw,
  Bot,
  Boxes,
  Package,
  Truck,
  PackageCheck,
  ReceiptText,
  Wallet,
  Undo2,
  Warehouse,
  ArrowLeftRight,
  SlidersHorizontal,
  ClipboardCheck,
  ShoppingCart,
  Send,
  RotateCcw,
  Sofa,
  Calculator,
  BookOpen,
  AlertCircle,
  Handshake,
  FileText,
  CornerUpLeft,
  HandCoins,
  PackageOpen,
  Reply,
  Mail,
  Network,
  Building2,
  LayoutDashboard,
  BarChart3,
  Map,
  MapPinned,
  Megaphone,
  History,
  Wand2,
  CalendarOff,
  type LucideIcon, Landmark, CreditCard, Banknote } from "lucide-react";
import { cn } from "../lib/utils";
import { booleanRecordPreference, useIdentityPreference } from "../hooks/useIdentityPreference";
import { useAuth } from "../auth/AuthContext";
import { makeNavFilter } from "./navFilter";
import { CompanyMark } from "./CompanyMark";
import { PresencePanel } from "./PresencePanel";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";

/* Hover prefetch, behind a dynamic import. The route map in lib/prefetch-routes
   holds an import() per route, so importing it statically drags the whole table
   into the initial bundle — that put initial JS at 131.5/130 KB gzip and failed
   the budget gate. Deferring it costs nothing real: the table's own chunk is
   fetched on Layout's idle warm, long before a hand reaches the rail.
   Swallow everything — a prefetch must never surface an error, least of all
   from a mouse-over (RouteFallback treats a chunk error as cause to unregister
   the SW and reload the page). */
function prefetchRoute(href: string): void {
  void import("../lib/prefetch-routes").then((m) => m.prefetchRoute(href)).catch(() => {});
}

interface Props {
  /** Desktop-only collapsed state (lg+). */
  collapsed: boolean;
  /** Toggles the desktop collapsed state. */
  onToggle: () => void;
  /** Mobile-only drawer open state (below lg). */
  mobileOpen?: boolean;
  /** Closes the mobile drawer. Called when the backdrop is tapped. */
  onMobileClose?: () => void;
}

/**
 * Single source of truth for the app's nav tree. Used by the desktop
 * Sidebar and re-rendered as a grid in the mobile MenuModal so the
 * two never drift. Add a route here, it shows up in both places.
 */
export interface NavTab {
  /** Which sidebar section this TOP-LEVEL item sits in — drives the
   *  Workspace / Operations / System grouping. Defaults to "operations". */
  section?: "workspace" | "operations" | "system";
  /** Click target. Omit when this is a pure group header with `children`. */
  to?: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Permission key required to see/use this tab. Omit = always visible. */
  perm?: string;
  /** Show when the user has at least one of the listed permissions.
   *  Paired with `perm` it's `any` OR `perm` — rarely needed together. */
  anyPerm?: string[];
  /** ADDITIVE page-access OR-gate. Show when ANY listed page-access key
   *  resolves to !== 'none'. When combined with `anyPerm` on the same tab,
   *  the tab is shown if EITHER the permission OR a page-access key passes
   *  (OR semantics — used for the SCM nav so a position granted just one
   *  SCM area sees it without holding the broad `scm.access` permission).
   *  Wildcard `*` short-circuits inside `pageAccess(...)` to 'full'. */
  anyAccess?: string[];
  /** If the user has this permission, the tab is hidden — used to suppress
   *  legacy entries when a richer replacement is available (e.g. hide the
   *  flat Delivery list from dispatchers who already have the Trips Queue
   *  tab). */
  hidePerm?: string;
  /** Page-access key required (default minLevel: partial). Use for tabs
   *  whose visibility should follow the new per-page matrix instead of
   *  legacy permission keys. */
  pageAccess?: string;
  /** Same as `pageAccess` but requires `full` access — for admin-only
   *  tabs (e.g. Project Maintenance). */
  pageAccessFull?: string;
  /** Additionally require the DIRECTOR-level finance-viewer flag
   *  (`user.project_finance_viewer`). ANDed with any `pageAccess` gate —
   *  used to hide the Projects "Finances" sub-page from sales staff. */
  requireFinanceViewer?: boolean;
  /** Show ONLY to the Fair Report cohort — management + the Sales Director
   *  (auth/salesAccess.canViewFairReport), the exact union the backend
   *  fairReportAccess admits. A hard gate keyed off org fields (no `perm` /
   *  `pageAccess`), so ordinary sales AND non-director office never see it. */
  requireFairReport?: boolean;
  /** Sales-access model (code-keyed off org fields — auth/salesAccess.ts):
   *  hide this entry from ALL Sales-department users, INCLUDING the Sales
   *  Director (owner rule 2026-07 — Delivery Returns is off for the whole Sales
   *  cohort, director too). Non-sales staff are unaffected. Only Delivery
   *  Returns gets this treatment; every other sales-restricted item stays
   *  director-visible. */
  hideForSales?: boolean;
  /** Sales-access model: ADDITIVELY show this entry to Sales-department users
   *  even when they lack the usual `perm` / `anyPerm` / `pageAccess` gate —
   *  keyed off department, NOT the permission matrix. Used so "My Cases"
   *  appears for Sales staff without granting them `service_cases.read`. */
  showForSales?: boolean;
  /** Sales-access model: ADDITIVELY show this entry to a Sales Director
   *  (auth/salesAccess.isSalesDirectorUser) even without the usual
   *  `perm`/`pageAccess` gate — keyed off the exact "Sales Director" position.
   *  Used for the scoped Team entries (Members / Org Chart / Departments); the
   *  Positions leaf deliberately OMITS this so it stays hidden from him. */
  showForSalesDirector?: boolean;
  /** Sales-access model: ADDITIVELY show this entry to ANY director
   *  (auth/salesAccess.isDirectorUser — Sales Director / Super Admin / Finance
   *  Manager / Owner-IT `*`) even without the usual `perm`/`pageAccess` gate.
   *  Owner 2026-07-15: used so a Sales Director gets the full Service-Cases
   *  board on DESKTOP (the backend /api/assr already grants a director every
   *  case — assrVisibleUserIds), matching what the mobile Service-Cases screen
   *  already shows. Broader than showForSalesDirector, which is anchored to the
   *  exact "Sales Director" position only. */
  showForDirector?: boolean;
  /** Sales-access model (owner rule 2026-07): HIDE this entry from a
   *  NON-director Sales user (auth/salesAccess.isSalesNonDirector). Keyed off
   *  the org chart in code, NOT the config matrix — so a rep sees exactly the
   *  owner-approved cut regardless of their page-access grants. Used to trim the
   *  Supply Chain nav down to Sales-Orders-only and to drop the Service-Cases
   *  board / metrics / maintenance leaves for reps. Sales Directors + office are
   *  UNAFFECTED (they keep the broad view). Checked before the show-bypasses. */
  hideForSalesRep?: boolean;
  /** Sales-access model: ADDITIVELY show this entry to a NON-director Sales user
   *  even without the usual `perm`/`anyPerm`/`anyAccess`/`pageAccess` gate —
   *  keyed off org fields, NOT the matrix. Used so the Supply Chain GROUP header
   *  survives for a rep (its only surviving child is the rep Sales-Orders leaf)
   *  no matter what SCM page-access the rep's position happens to hold. */
  showForSalesRep?: boolean;
  /** Positions (exact, lowercased) that must NOT see this entry. Checked before
   *  every `showFor*` bypass, so a show-flag cannot re-open it. The backend is
   *  still the control — this only avoids offering a tap that 403s. */
  hideForPositions?: readonly string[];
  /** Sales-access model: show this entry ONLY to a NON-director Sales user and
   *  hide it from everyone else (office/director). Bypasses the permission
   *  gates. Used for the single rep-facing "Sales Orders" leaf mounted directly
   *  under Supply Chain so a rep's SCM tree is exactly one item deep. */
  salesRepOnly?: boolean;
  /** Sales-access model: for a NON-director Sales user, override this group
   *  header's click target with `salesRepTo` (the plain `to` still applies to
   *  everyone else). Used so a rep clicking "Supply Chain" lands on the
   *  reachable /scm/sales-orders list instead of the /scm Hub (which 403s on
   *  `scm` area) and "Service Cases" lands on /my-cases instead of the board
   *  hub. Non-Sales / director behaviour is unchanged. */
  salesRepTo?: string;
  /** Optional sub-entries. When present, this tab renders as an
   *  expandable group header instead of a click target. */
  children?: NavTab[];
  /** Stable id used for the per-group expanded/collapsed memory. Only
   *  required when `children` is present. */
  groupId?: string;
}

/**
 * Sidebar tab registry — flat root list. Use `children` on a tab to
 * nest sub-entries under an expandable group header (see Project
 * Management). Tabs declare permission via `perm` / `anyPerm`; the
 * filter recurses so groups with no visible kids hide entirely.
 */
export const NAV_TABS: NavTab[] = [
  // ══ WORKSPACE ════════════════════════════════════════════════
  {
    section: "workspace",
    to: "/",
    label: "Overview",
    icon: LayoutDashboard,
    end: true,
  },
  // Sales Orders promoted to a top-level shortcut (also reachable under
  // Supply Chain → Sales Order).
  {
    section: "workspace",
    to: "/scm/sales-orders",
    label: "Sales Orders",
    icon: ShoppingCart,
    anyPerm: ["*", "scm.access"],
    anyAccess: ["scm.sales.orders"],
    // A rep always keeps this top-level shortcut even if their position lacks
    // the scm.sales.orders page-access (the route itself allows Sales — see
    // App.tsx ScmGuard allowSales).
    showForSalesRep: true,
  },
  // Sales Entries — Nico 2026-07-09: "sales entries 我不要了". Sidebar
  // entry removed. The /sales route + Sales.tsx page + backend endpoints
  // are intentionally left intact so any deep-link / bookmark keeps
  // resolving until we consciously retire the module. Re-add this block
  // to restore the sidebar shortcut.
  //   { section: "workspace", to: "/sales", label: "Sales Entries",
  //     icon: ReceiptText, pageAccess: "sales" },

  // ══ OPERATIONS ═══════════════════════════════════════════════
  // ── Service — quality + ASSR. Header links to the Cases page; the
  // chevron still expands the sub-menu (Quality Metrics / Maintenance).
  {
    section: "operations",
    label: "Service Cases",
    icon: Zap,
    groupId: "service",
    to: "/assr?view=hub",
    anyPerm: ["service_cases.read"],
    // Sales-access model: Sales staff see this group (for My Cases) even
    // without service_cases.read. The child gates below still hide the
    // permission-only sub-tabs (Cases / Metrics / Maintenance) from them, so
    // only the sales-visible My Cases leaf survives.
    showForSales: true,
    // Owner rule 2026-07: a NON-director Sales rep gets ONLY "My Cases" here —
    // never the full board hub. Retarget the group header to /my-cases (the
    // /assr?view=hub board stays for office/director) and hide the board /
    // metrics / maintenance leaves for reps (below).
    salesRepTo: "/my-cases",
    children: [
      {
        to: "/assr?view=cases",
        label: "Service Cases",
        icon: ClipboardList,
        perm: "service_cases.read",
        pageAccess: "service_cases.cases",
        hideForSalesRep: true,
        // Owner 2026-07-15: a director (incl. a Sales Director who lacks the
        // service_cases.read matrix grant) sees the full board on DESKTOP too —
        // desktop parity with mobile, where the board already renders for a
        // director. The backend /api/assr already returns every case to a
        // director (assrVisibleUserIds unrestricted). hideForSalesRep still
        // wins for a NON-director rep (checked first), so reps keep My-Cases-only.
        showForDirector: true,
      },
      {
        to: "/assr?view=metrics",
        label: "Quality Metrics",
        icon: ShieldCheck,
        perm: "service_cases.read",
        pageAccess: "service_cases.metrics",
        hideForSalesRep: true,
      },
      {
        // Lead Time Portal merged into Service Maintenance as a tab.
        // Sidebar entry removed; reach it via Service Maintenance →
        // Lead Time tab. Old /assr?view=lead_time URL still works
        // (redirects in ServiceCases.tsx).
        to: "/assr?view=settings",
        label: "Service Maintenance",
        icon: Wrench,
        perm: "service_cases.manage",
        hideForSalesRep: true,
      },
      {
        // Sales-side view of the cases the current user raised.
        // Filter is server-side (LOWER(sales_agent) contains user's name);
        // any user with service_cases.read gets the tab but they'll see
        // an empty list until a case's sales_agent matches their name.
        to: "/my-cases",
        label: "My Cases",
        icon: ClipboardCheck,
        perm: "service_cases.read",
        // Sales staff get My Cases without the service_cases.read permission.
        showForSales: true,
      },
    ],
  },

  // ── Projects — exhibitions, solo events ──────────────────────
  // Gated on page-access (mig 073). Each sub-tab uses `pageAccess`
  // so a role with calendar-only access only sees the Calendar entry.
  {
    section: "operations",
    label: "Projects",
    icon: FolderKanban,
    groupId: "projects",
    to: "/projects?view=hub",
    pageAccess: "projects",
    children: [
      {
        to: "/projects?view=list",
        label: "Project List",
        icon: ClipboardList,
        pageAccess: "projects.list",
      },
      {
        to: "/projects?view=calendar",
        label: "Calendar",
        icon: Calendar,
        pageAccess: "projects.calendar",
      },
      {
        to: "/projects?view=finances",
        label: "Finances",
        icon: DollarSign,
        pageAccess: "projects.finances",
        requireFinanceViewer: true,
      },
      {
        to: "/projects?view=maintenance",
        label: "Project Maintenance",
        icon: Wrench,
        pageAccessFull: "projects.maintenance",
      },
    ],
  },

  // ── Sales Report was here as a flat top-level entry; owner 2026-07-22
  //    moved it INTO the Finance submenu below (it is fundamentally a
  //    finance/reporting page, and the top-level slot was overloading the
  //    left rail). The entry now lives inside the Finance group's children.

  // ── Supply Chain — ported 2990's furniture SCM (/api/scm) ────
  // Header links to the /scm Hub; chevron expands the inline subtree.
  {
    section: "operations",
    label: "Supply Chain",
    icon: Boxes,
    groupId: "scm",
    // Points at the Hub landing page instead of expanding inline (the Hub
    // surfaces every module one click deep). The children stay here as the
    // single source of truth the Hub renders from + for visibility filtering.
    to: "/scm",
    anyPerm: ["*", "scm.access"],
    // Umbrella shows if ANY SCM area is granted per-position (additive). The
    // recursive filter also hides this group when no child survives, so this
    // list is belt-and-suspenders with the children's own anyAccess keys.
    anyAccess: [
      "scm",
      "scm.sales",
      "scm.procurement",
      "scm.consignment",
      "scm.transportation",
      "scm.warehouse",
      "scm.finance",
    ],
    // Owner rule 2026-07: a NON-director Sales rep's Supply Chain nav is trimmed
    // to ONLY "Sales Orders". showForSalesRep keeps this group header visible
    // for the rep (its only surviving child is the rep Sales-Orders leaf below),
    // and salesRepTo sends the header straight to the reachable /scm/sales-orders
    // list instead of the /scm Hub (which 403s on the `scm` area for a rep).
    // Every OTHER SCM subgroup below carries hideForSalesRep. Office / director
    // are unaffected.
    showForSalesRep: true,
    salesRepTo: "/scm/sales-orders",
    children: [
      // Rep-only Sales-Orders leaf — the single SCM entry a non-director Sales
      // rep sees under Supply Chain (salesRepOnly hides it from office/director,
      // who reach Sales Orders via the Sales Order subgroup below). Bypasses the
      // page-access gate; the route itself allows Sales (App.tsx ScmGuard
      // allowSales).
      {
        to: "/scm/sales-orders",
        label: "Sales Orders",
        icon: ShoppingCart,
        salesRepOnly: true,
      },
      // Rep-only Amendments leaf (owner rule 2026-07-16 — a salesperson must see
      // the amendments for their OWN Sales Orders, they raise them). It has to be
      // a rep leaf HERE and not the Amendments child of the Sales Order subgroup
      // below: that subgroup carries hideForSalesRep, and the tree filter drops a
      // hidden group WITHOUT mapping its children, so the child's deliberate
      // "no hideForSalesRep" exemption never got the chance to run and the rule
      // sat dead on desktop while the phone (which gates leaves directly) showed
      // the row. Same shape + same reasoning as the DO / SI leaves below.
      {
        to: "/scm/amendments",
        // Owner 2026-07-27 — spelled out so the sales side reads unambiguously
        // against the Procurement group's "PO Amendments".
        label: "Sales Order Amendment",
        icon: History,
        salesRepOnly: true,
      },
      // Rep-only Delivery Orders + Sales Invoices leaves (owner rule 2026-07-16):
      // a salesperson must be able to find the DO / invoice generated from their
      // OWN Sales Orders (e.g. to resend a customer's invoice). The routes carry
      // allowSales and the backend row-scopes every read to own+downline and
      // strips cost/margin, so a rep sees only their customers' documents. Hidden
      // from office/director (salesRepOnly) — they reach these via the Sales Order
      // subgroup below.
      {
        to: "/scm/delivery-orders",
        label: "Delivery Orders",
        icon: Send,
        salesRepOnly: true,
      },
      {
        to: "/scm/sales-invoices",
        label: "Sales Invoices",
        icon: FileText,
        salesRepOnly: true,
      },
      // 1:1 with 2990's backend Sidebar sectioning + order: Sales Order ->
      // Consignment -> Procurement -> Transportation -> Warehouse (then Finance,
      // which 2990 keeps top-level; Houzs nests it under Supply Chain). MRP +
      // Products & Maintenance live under Procurement exactly as in 2990.
      // Product Models + Fabric Tracking are tabs-in-Products in 2990 → NOT
      // separate nav items here either (reach them via Products & Maintenance /
      // their /scm/* routes). Consignment labels match 2990 verbatim: singular
      // "Consignment Order/Note/Return" + full "Purchase Consignment ...".
      // Each leaf carries its own L2 page-access key (additive — still ORed
      // with ["*","scm.access"]). The GROUP header keeps its L1 key AND lists
      // every child L2 key in `anyAccess`, so granting either the L1 area or
      // any single L2 child shows the group; the recursive filter then hides
      // any leaf whose own L2 key resolves to "none". Result: set scm.sales =
      // full → all four sales leaves show (inherit); override scm.sales.delivery
      // = none → just Delivery Orders disappears while the rest stay.
      {
        // A rep never sees this subgroup (they get the flat rep Sales-Orders
        // leaf above instead); office/director keep the full Sales-Order flow.
        hideForSalesRep: true,
        label: "Sales Order",
        icon: ShoppingCart,
        groupId: "scm-sales",
        to: "/scm/sales-order",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.sales", "scm.sales.orders", "scm.sales.delivery", "scm.sales.invoices", "scm.sales.returns"],
        children: [
          { to: "/scm/sales-orders", label: "Sales Orders", icon: ShoppingCart, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.orders"] },
          // The office / director path to Amendments. A rep reaches it via the
          // rep-only leaf above instead, so this carries hideForSalesRep like its
          // DO / SI siblings — belt-and-braces against the parent's flag being
          // removed, which would otherwise render the row TWICE for a rep.
          { to: "/scm/amendments", label: "Sales Order Amendment", icon: History, anyPerm: ["*", "scm.access", "scm.amendment.create", "scm.amendment.supplier_confirm", "scm.amendment.approve_so", "scm.amendment.approve_po"], anyAccess: ["scm.sales.orders"], hideForSalesRep: true },
          { to: "/scm/delivery-orders", label: "Delivery Orders", icon: Send, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.delivery"], hideForSalesRep: true },
          { to: "/scm/sales-invoices", label: "Sales Invoices", icon: FileText, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.invoices"], hideForSalesRep: true },
          { to: "/scm/delivery-returns", label: "Delivery Returns", icon: RotateCcw, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.returns"], hideForSales: true },
        ],
      },
      {
        hideForSalesRep: true,
        label: "Consignment",
        icon: Handshake,
        groupId: "scm-consignment",
        to: "/scm/consignment",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.consignment", "scm.consignment.orders", "scm.consignment.notes", "scm.consignment.returns", "scm.consignment.po_orders", "scm.consignment.po_receives", "scm.consignment.po_returns"],
        children: [
          { to: "/scm/consignment-orders", label: "Consignment Order", icon: Handshake, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.orders"] },
          { to: "/scm/consignment-notes", label: "Consignment Note", icon: FileText, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.notes"] },
          { to: "/scm/consignment-returns", label: "Consignment Return", icon: CornerUpLeft, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.returns"] },
          { to: "/scm/purchase-consignment-orders", label: "Purchase Consignment Order", icon: HandCoins, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.po_orders"] },
          { to: "/scm/purchase-consignment-receives", label: "Purchase Consignment Receive", icon: PackageOpen, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.po_receives"] },
          { to: "/scm/purchase-consignment-returns", label: "Purchase Consignment Return", icon: Reply, anyPerm: ["*", "scm.access"], anyAccess: ["scm.consignment.po_returns"] },
        ],
      },
      {
        hideForSalesRep: true,
        label: "Procurement",
        icon: Package,
        groupId: "scm-procurement",
        to: "/scm/procurement",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.procurement", "scm.procurement.products", "scm.procurement.suppliers", "scm.procurement.mrp", "scm.procurement.po", "scm.procurement.grn", "scm.procurement.pi", "scm.procurement.pr"],
        children: [
          { to: "/scm/products", label: "Products & Maintenance", icon: Sofa, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.products"], hideForSalesRep: true },
          { to: "/scm/suppliers", label: "Suppliers", icon: Truck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.suppliers"], hideForSalesRep: true },
          { to: "/scm/mrp", label: "MRP · Stock Status", icon: Calculator, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.mrp"], hideForSalesRep: true },
          { to: "/scm/purchase-orders", label: "Purchase Orders", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.po"], hideForSalesRep: true },
          { to: "/scm/po-amendments", label: "PO Amendments", icon: History, anyPerm: ["*", "scm.access", "scm.po_amendment.create", "scm.po_amendment.approve"], anyAccess: ["scm.procurement.po"], hideForSalesRep: true },
          { to: "/scm/grns", label: "Goods Receipt", icon: PackageCheck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.grn"], hideForSalesRep: true },
          { to: "/scm/purchase-invoices", label: "Purchase Invoices", icon: ReceiptText, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.pi"], hideForSalesRep: true },
          { to: "/scm/purchase-returns", label: "Purchase Returns", icon: Undo2, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.pr"], hideForSalesRep: true },
        ],
      },
      {
        hideForSalesRep: true,
        label: "Transportation",
        icon: Truck,
        groupId: "scm-transportation",
        to: "/scm/transportation",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.transportation", "scm.transportation.drivers"],
        children: [
          // Daily dispatch flow — the pages used every day, in workflow order.
          { to: "/scm/delivery-planning", label: "Delivery Planning", icon: Send, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          { to: "/scm/dp-orders", label: "DP Orders", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          { to: "/scm/auto-schedule", label: "Delivery Date Arrangement", icon: Wand2, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          { to: "/scm/trips", label: "Delivery Time Arrangement", icon: Send, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          { to: "/scm/fleet-day", label: "Last Mile Delivery", icon: MapPinned, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          // Fleet operations — capacity and leave. Fleet Health moved DOWN into
          // Maintenance (2026-08-02): it is reference-data upkeep on the in-house
          // lorries, not a daily dispatch view. The lorry/driver REGISTRY
          // (/scm/fleet) is in Maintenance too.
          { to: "/scm/lorry-capacity", label: "Lorry Capacity", icon: BarChart3, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          { to: "/scm/driver-leave", label: "Crew Leave", icon: CalendarOff, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
          /* "Drivers" (/scm/drivers) retired 2026-07-17 — it duplicated the Drivers
             section of Fleet above, and sat here with the SAME Truck icon and the
             SAME scm.transportation.drivers access key, which is what made the
             duplication invisible. The area key is unchanged and still gates every
             row in this group, so no permission moves. Do not re-add. */
          // Set-once master-data + the lorry/driver/helper REGISTRY (/scm/fleet) —
          // tucked into a collapsible "Maintenance" sub-group (the ERP's own word
          // for reference-data upkeep, cf. SO Maintenance) so the daily-use rows
          // above stay uncluttered. Fleet lives here (you record a lorry) while
          // Fleet Health above is the read-only board (you monitor the fleet).
          // Pure header (no `to`); the groupId gives it expand/collapse memory.
          /* SIX rows become THREE, and each one goes to a real page. Owner
             2026-08-01: "我们需要把 Sidebar 以及它的整个模块——包括 3PL Company 和
             Rate Card——统一整合在一个模块里", then 2026-08-02 on what the three
             should LAND on: "我要原本的UI" and "delivery zones和carriers 根本都不
             需要dropdown啊 就那么少的info".

             So consolidation happened where three screens really are one thing
             (Regions + Residence Rules + Fleet -> /scm/delivery-maintenance,
             "Coverage & Fleet"), and the other two keep their own original
             pages. 3PL Companies is not a row: it opens from the top right of
             Rate Cards, because a rate card is priced per carrier.

             Every target is a route App.tsx already registers with the SAME
             `scm.transportation.drivers` guard these rows carry, so nothing
             about access moves. Do NOT point a child at a bare ?open= variant
             of another page — that is what made all three land on one screen. */
          {
            label: "Maintenance", icon: SlidersHorizontal, groupId: "scm-transportation-maintenance",
            to: "/scm/delivery-maintenance",
            anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true,
            children: [
              { to: "/scm/delivery-maintenance", label: "Coverage & Fleet", icon: Map, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
              { to: "/scm/delivery-zones", label: "Delivery Zones", icon: MapPinned, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
              { to: "/scm/delivery-rate-cards", label: "Carriers & Rates", icon: Handshake, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
              /* Fleet Health joined Maintenance 2026-08-02 (owner: "你把 Fleet
                 Health 加进去 Maintenance 的地方"). It keeps its OWN gate —
                 `fleet.read`, not the scm.transportation.drivers area key the
                 three rows above share — because compliance and workshop spend
                 are read by people who do not dispatch. A row's gate travels
                 with the row, not with the group it is filed under. */
              { to: "/fleet-health", label: "Fleet Health", icon: Wrench, perm: "fleet.read", hideForSalesRep: true },
            ],
          },
        ],
      },
      {
        hideForSalesRep: true,
        label: "Warehouse",
        icon: Warehouse,
        groupId: "scm-warehouse",
        to: "/scm/warehouse",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.warehouse", "scm.warehouse.inventory", "scm.warehouse.adjustments", "scm.warehouse.transfers", "scm.warehouse.stock_take"],
        children: [
          // Loading List (owner 2026-08-25) — the storekeeper's daily "what to
          // load" queue (no prices). Same gate as Inventory (scm.warehouse.inventory,
          // the Storekeeper's grant) so the warehouse line sees it first.
          { to: "/scm/loading-list", label: "Loading List", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"], hideForSalesRep: true },
          // Warehouses master sits at the TOP of the group (2990 parity) — it's
          // the location registry every other warehouse doc binds against.
          { to: "/scm/warehouses", label: "Warehouses", icon: Warehouse, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"], hideForSalesRep: true },
          { to: "/scm/inventory", label: "Inventory", icon: Package, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"], hideForSalesRep: true },
          // Stock ADJUSTMENT is its own permission now (owner 2026-07-18):
          // POST /inventory/adjustments is gated on scm.warehouse.adjustments by a
          // real area-guard sub-mount (scm/index.ts) — adjusting stock changes
          // valuation, so it is separable from merely viewing inventory. Gate the
          // nav on that same key so a position with inventory-view but no
          // adjustments grant (e.g. Storekeeper) sees Inventory but NOT Adjustments.
          { to: "/scm/stock-adjustments", label: "Adjustments", icon: SlidersHorizontal, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.adjustments"], hideForSalesRep: true },
          { to: "/scm/stock-transfers", label: "Transfers", icon: ArrowLeftRight, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.transfers"], hideForSalesRep: true },
          { to: "/scm/stock-takes", label: "Stock Take", icon: ClipboardCheck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.stock_take"], hideForSalesRep: true },
        ],
      },
    ],
  },

  // ── Finance — LIFTED OUT of Supply Chain (owner 2026-07-18: "finance and HR
  // is not under supply chain"). Nothing about the gate changed: the group keeps
  // the SAME anyPerm / anyAccess / hideForSalesRep it carried as an SCM child,
  // and every child keeps its own key and its URL. Only its position in the tree
  // moved, so no route and no bookmark changes.
  //
  // WHY THIS DOES NOT WIDEN ACCESS (the thing a lift like this silently breaks):
  // a hidden parent drops its whole subtree UNMAPPED (navFilter.filterTab), so
  // as a child this group was gated on parent AND self. Removing the parent's
  // half is only safe because the parent's condition was IMPLIED by this one:
  //   · anyPerm was IDENTICAL on both (["*", "scm.access"]).
  //   · page-access is hierarchical (services/pageAccess.ts: a parent at "none"
  //     denies every child), so scm.finance.accounting / .outstanding can only be
  //     non-none when scm.finance AND scm — BOTH listed in the old parent's
  //     anyAccess — are non-none too.
  // So every user who passes this group's own gate already passed Supply Chain's.
  // Nobody gains a row. Do not add an anyAccess key here that is not a descendant
  // of `scm`, or that reasoning stops holding.
  {
    section: "operations",
    hideForSalesRep: true,
    label: "Finance",
    icon: BookOpen,
    groupId: "scm-finance",
    to: "/scm/finance",
    anyPerm: ["*", "scm.access"],
    anyAccess: ["scm.finance", "scm.finance.accounting", "scm.finance.outstanding"],
    children: [
      { to: "/scm/accounting", label: "Accounting", icon: BookOpen, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.accounting"] },
      { to: "/scm/daily-bank", label: "Daily Bank", icon: Landmark, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.accounting"] },
      // The two screens that empty settlement-in-transit, named the way the
      // owner names the work: the merchant statement first, the bank statement
      // after. Both gated on the same GL key the backend checks
      // (scm.payment_voucher.post) — front and back both.
      { to: "/scm/merchant-recon", label: "Merchant Recon", icon: CreditCard, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.accounting"] },
      { to: "/scm/bank-recon", label: "Bank Recon", icon: Banknote, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.accounting"] },
      // Maintained across companies from one screen (owner, 2026-08-18).
      { to: "/scm/settlement-setup", label: "Recon Setup", icon: SettingsIcon, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.accounting"] },
      { to: "/scm/chart-of-accounts", label: "Chart of Accounts", icon: SettingsIcon, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.accounting"] },
      { to: "/scm/payment-vouchers", label: "Payment Vouchers", icon: Wallet, anyPerm: ["*", "scm.access", "scm.payment_voucher.create", "scm.payment_voucher.write", "scm.payment_voucher.post", "scm.payment_voucher.cancel"], anyAccess: ["scm.finance.accounting"] },
      { to: "/scm/outstanding", label: "Outstanding", icon: AlertCircle, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.outstanding"] },
      // Delivered-but-not-billed, aged. Sits next to Outstanding and on the
      // SAME area key: it is the money answer to the question Outstanding's
      // DO tab asks with a header-status flag and no money column.
      { to: "/scm/unbilled-deliveries", label: "Not Yet Billed", icon: HandCoins, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.outstanding"] },
      // Currencies master (Phase 1-A FX) — owner-maintained currency + rate
      // table for GRN / PI / PV foreign-currency posting. Gated on the flat
      // scm.currency.manage permission (Owner / IT Admin via *).
      { to: "/scm/currencies", label: "Currencies", icon: DollarSign, anyPerm: ["*", "scm.currency.manage"] },
      // Sales Report — moved from the top-level slot (owner 2026-07-22).
      // Gate: requireFairReport (management + Sales Director cohort). The
      // parent Finance group's anyPerm/anyAccess would AND onto this child
      // and hide it from the Sales Director (who has fairReport but often
      // not the SCM finance areas), so the child ALSO carries its own
      // anyPerm/anyAccess that admits the fair-report cohort explicitly.
      { to: "/reports/fair-report", label: "Sales Report", icon: BarChart3, requireFairReport: true, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance", "scm.finance.accounting", "scm.finance.outstanding", "projects.finances"] },
    ],
  },

  // ── HR — LIFTED OUT of Supply Chain (owner 2026-07-18: "finance and HR is not
  // under supply chain"). Gate, children and URLs are unchanged; only the tree
  // position moved.
  //
  // THIS LIFT DOES CHANGE WHO SEES THE ROW, and that is the point — read before
  // "restoring" the old behaviour. As an SCM child this group was gated on
  // parent AND self, so the parent's ["*", "scm.access"] / SCM-area condition was
  // silently ANDed onto HR's own flat keys. That contradicted BOTH the comment
  // below and the routes: /scm/hr/commission and /scm/hr/settings are guarded on
  // anyPerm ["*","scm.hr.read","scm.hr.manage"] ALONE (App.tsx — no ScmGuard, no
  // scm.access), and the backend gates on the same flat keys. So a holder of
  // scm.hr.read WITHOUT scm.access could already open the page by typing the URL;
  // the nav just refused to show them the door. Lifting HR makes the nav agree
  // with the route instead of hiding a reachable page. Nobody gains ACCESS —
  // only a row for a page they were already permitted to open.
  {
    section: "operations",
    hideForSalesRep: true,
    label: "HR",
    icon: Users,
    groupId: "scm-hr",
    // No /scm/hr hub page exists, so the group header lands on the report.
    to: "/scm/hr/commission",
    // FLAT keys only, deliberately no `scm.access` and no `anyAccess`: HR has
    // no L2 page-access area, and /commission returns every colleague's pay.
    // Riding the SCM umbrella here is exactly the mistake scm/index.ts warns
    // about ("READ-ONLY IS NOT THE SAME AS SAFE").
    //
    // These are the two ENTRY keys. HR has four in total — scm.hr.close and
    // scm.hr.reopen gate the payout approval actions and are checked on the
    // Commission page itself (per-button), not here: they grant an action
    // inside the module, never admittance to it. Neither is usable without
    // scm.hr.read anyway, since the API refuses to show the period first.
    anyPerm: ["*", "scm.hr.read", "scm.hr.manage"],
    children: [
      { to: "/scm/hr/commission", label: "Commission", icon: DollarSign, anyPerm: ["*", "scm.hr.read", "scm.hr.manage"] },
      // Settings is an EDITOR — read-only holders are not shown a page whose
      // every control the API would reject (2990 bounces them to the report).
      { to: "/scm/hr/settings", label: "HR Settings", icon: SlidersHorizontal, anyPerm: ["*", "scm.hr.manage"] },
    ],
  },

  // ── Mail Center — in-ERP shared inbox (ported from Hookka). Flat entry;
  // the page carries its own Inbox/Sent/folder rail.
  {
    section: "operations",
    to: "/mail-center",
    label: "Mail Center",
    icon: Mail,
    anyPerm: ["mail_center.read"],
  },

  // ── Announcements — office-wide notices + read receipts (ported from Hookka).
  // Flat entry; the page hosts the composer + list inline.
  //
  // UNGATED (owner approved 2026-07-21), like Overview: no perm / anyPerm /
  // pageAccess, so navVisible admits every signed-in user. It used to carry
  // anyPerm: ["announcements.read"] + showForSalesDirector, which was the
  // ADMIN verb — no ordinary salesperson holds it, so the entry was invisible
  // to exactly the people the notices are written for. #957 opened the PAGE to
  // every authed user but left this nav row behind, which meant a rep could
  // reach it from the notice pop-up's CTA or by URL and then never find it
  // again. The mobile shell has always shown it to everyone (MobileApp's row
  // carries alwaysShow), so this closes the last half of that divergence.
  //
  // Nothing is exposed by showing the row: GET /api/announcements is audience-
  // filtered server-side (a plain reader sees only live rows addressed to
  // them — the same set /banner already showed them), and the composer / edit
  // / remind / delete controls on the page stay behind announcements.write.
  // showForSalesDirector is gone because it is now redundant, not revoked —
  // a Sales Director is a signed-in user and passes on that alone.
  {
    section: "operations",
    to: "/announcements",
    label: "Announcements",
    icon: Megaphone,
  },

  // Fleet Health moved into SCM > Transportation (2026-07-26) so the fleet-wide
  // compliance/health board sits with the other daily fleet views instead of
  // floating as a top-level operations item. It keeps its fleet.read gate — see
  // the Transportation children above. The /fleet-health route is unchanged.

  // ══ SYSTEM ═══════════════════════════════════════════════════
  // ── Team — header links to the Team Hub; chevron expands the sub-pages
  // (which are tabs on the Team page). Mirrors the Supply Chain pattern.
  {
    section: "system",
    label: "Team",
    icon: Users,
    groupId: "team",
    to: "/team?tab=hub",
    anyPerm: ["users.read", "roles.read"],
    pageAccess: "team",
    // Sales Director → scoped Team (own-dept Members / Org Chart / Departments +
    // Invite). Bypasses the perm/pageAccess gate on the group header + those
    // three leaves ONLY; Mailboxes deliberately omits the flag so it stays
    // hidden. Backend scopes every leaf to his department.
    showForSalesDirector: true,
    children: [
      // Redesigned Team screens (2026-08 handoff). The classic tabs stay
      // URL-reachable (?tab=members / orgchart / departments / mail) during
      // review but are no longer surfaced in navigation.
      { to: "/team?tab=directory", label: "Directory", icon: Users, perm: "users.read", pageAccess: "team", showForSalesDirector: true },
      // Positions leaf removed from the nav (owner: "那個team的矩陣拆掉") — the
      // same treatment Roles got, which is why there is no Roles leaf here either.
      // The position_page_access matrix and its read path are unchanged; the
      // editor stays live and reachable at /team?tab=positions as its sole-writer
      // escape hatch, just no longer surfaced in navigation. Re-add to restore.
      { to: "/team?tab=orgchart2", label: "Org Chart", icon: Network, perm: "users.read", pageAccess: "team", showForSalesDirector: true },
      { to: "/team?tab=departments2", label: "Departments", icon: Building2, perm: "users.read", pageAccess: "team" },
      { to: "/team?tab=mail2", label: "Mailboxes", icon: Mail, perm: "mail_center.manage", pageAccess: "team" },
      { to: "/team?tab=permissions", label: "Roles & Permissions", icon: ShieldCheck, perm: "roles.read", pageAccess: "team" },
    ],
  },
  {
    section: "system",
    to: "/system-health",
    label: "System Health",
    icon: Activity,
    pageAccess: "system_health",
  },
  // Next to System Health because it answers the same shape of question — "is
  // the thing that runs in the background still working" — and because the
  // owner's is "did my sales order reach AutoCount". anyPerm mirrors the two
  // keys GET /api/scm/autocount-outbox accepts; the server is still the
  // boundary, this only decides whether the row is worth showing.
  {
    section: "system",
    to: "/autocount-sync",
    label: "AutoCount Sync",
    icon: RefreshCw,
    anyPerm: ["*", "scm.autocount.read", "settings.manage"],
  },
  {
    section: "system",
    to: "/assistant",
    label: "Assistant",
    icon: Bot,
    // Open to staff, EXCEPT the field crew (owner 2026-07-18). What the rest may
    // SEE is scoped server-side by position; this list is who gets no surface at
    // all. Mirrors auth/assistantAccess.ts — a lockstep fixture, not a 2nd source.
    hideForPositions: ["driver", "helper", "storekeeper", "storekeeper supervisor"],
  },
  {
    section: "system",
    to: "/agents",
    label: "Agent Console",
    icon: Bot,
    anyPerm: ["*"],
  },
  {
    section: "system",
    to: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    perm: "settings.manage",
  },
];

// Accordion sibling map — each expandable group's same-level peers. Opening a
// group collapses its siblings (top-level groups are mutually exclusive; so are
// the SCM sub-groups) so the rail never piles up. Built once from NAV_TABS.
const GROUP_SIBLINGS: Record<string, string[]> = (() => {
  const m: Record<string, string[]> = {};
  const walk = (tabs: NavTab[]) => {
    const ids = tabs.filter((t) => t.children?.length && t.groupId).map((t) => t.groupId!);
    for (const t of tabs) {
      if (t.children?.length) {
        if (t.groupId) m[t.groupId] = ids.filter((g) => g !== t.groupId);
        walk(t.children);
      }
    }
  };
  walk(NAV_TABS);
  return m;
})();

// Section labels for the Workspace / Operations / System grouping.
const SECTION_LABELS: Record<NonNullable<NavTab["section"]>, string> = {
  workspace: "Workspace",
  operations: "Operations",
  system: "System",
};
const SECTION_ORDER = ["workspace", "operations", "system"] as const;

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { user, can, pageAccess, logout } = useAuth();
  const location = useLocation();
  // On mobile the drawer is always full-width — collapsed state is
  // a desktop-only concept.
  const effectiveCollapsed = collapsed;

  // Per-group expanded memory (accordion). undefined = auto (open iff the group
  // holds the current route); true/false = explicit after a click.
  const [groupExpanded, setGroupExpanded] = useIdentityPreference(
    "sidebar:groups:v2-accordion",
    {},
    booleanRecordPreference,
  );
  function isGroupOpen(id: string, active: boolean): boolean {
    const v = groupExpanded[id];
    return v === undefined ? active : v;
  }
  // Opening a group collapses its same-level siblings (accordion). `active`
  // resolves the auto/default state before flipping.
  function toggleGroup(id: string, active: boolean) {
    setGroupExpanded((prev) => {
      const cur = prev[id] === undefined ? active : prev[id];
      const willOpen = !cur;
      const next = { ...prev, [id]: willOpen };
      if (willOpen) for (const sib of GROUP_SIBLINGS[id] ?? []) next[sib] = false;
      return next;
    });
  }
  // Force a group open + collapse siblings — used when clicking a group's own
  // link (e.g. Supply Chain → Hub) so the tree settles to just that branch.
  function openGroup(id: string) {
    setGroupExpanded((prev) => {
      const next = { ...prev, [id]: true };
      for (const sib of GROUP_SIBLINGS[id] ?? []) next[sib] = false;
      return next;
    });
  }

  /** True when a tab's `to` matches the current pathname + relevant query
   *  params. NavLink doesn't compare query strings on its own, so for
   *  entries like /projects?view=calendar we have to match manually. */
  function tabIsActive(to: string, end?: boolean): boolean {
    const [path, search] = to.split("?");
    if (end ? location.pathname !== path : !location.pathname.startsWith(path)) {
      // For non-end matches, allow startsWith for nested routes (e.g.
      // /projects/123 still highlights /projects).
      if (location.pathname !== path) return false;
    }
    if (!search) return true;
    const wanted = new URLSearchParams(search);
    const have = new URLSearchParams(location.search);
    for (const [k, v] of wanted.entries()) {
      if (have.get(k) !== v) return false;
    }
    return true;
  }

  // Filter tabs the current user can't access, plus tabs explicitly
  // suppressed by hidePerm. Recursive — a group with no visible children is
  // itself hidden. The full gate logic lives in ./navFilter so the mobile
  // MenuModal (MobileTabBar) filters identically and can never drift.
  const filterTab = makeNavFilter({ user, can, pageAccess });

  const visibleTabs = NAV_TABS.map(filterTab).filter(
    (t): t is NavTab => t !== null,
  );

  // Recursive renderer for tabs — handles plain links and nested groups.
  function renderTab(tab: NavTab, depth = 0): React.ReactNode {
    const Icon = tab.icon;

    // Group header (has children) — expandable section. A group that ALSO
    // carries its own `to` (Supply Chain → /scm Hub) makes its LABEL a link to
    // the Hub while the chevron still toggles the inline subtree — so the
    // sidebar keeps the submenu AND the Hub is one click away.
    if (tab.children && tab.children.length > 0) {
      const gid = tab.groupId || tab.label;
      // Bound once so the hover handlers below close over a narrowed string
      // (TS drops narrowing on `tab.to` inside a callback).
      const headerTo = tab.to;
      const hasActiveDescendant = (n: NavTab): boolean =>
        (n.to ? tabIsActive(n.to, n.end) : false) ||
        (n.children?.some(hasActiveDescendant) ?? false);
      const selfActive = tab.to ? tabIsActive(tab.to, tab.end) : false;
      const headerActive = selfActive || tab.children.some(hasActiveDescendant);
      const open = isGroupOpen(gid, headerActive);
      if (collapsed) {
        // Collapsed: children render flat. A Hub-linked group leads with its
        // icon as a link to the Hub so it's still reachable.
        return (
          <div key={gid}>
            {headerTo && (
              <NavLink
                to={headerTo}
                title={tab.label}
                onClick={markOpenIntentOnPlainClick}
                onMouseEnter={() => prefetchRoute(headerTo)}
                className={cn(
                  "group relative my-0.5 flex items-center justify-center rounded-md px-2 py-2 transition-all duration-150",
                  headerActive
                    ? "bg-sidebar-active text-sidebar-ink"
                    : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
                )}
              >
                <Icon size={15} strokeWidth={headerActive ? 2.4 : 2} className={headerActive ? "text-primary" : ""} />
              </NavLink>
            )}
            {tab.children.map((k) => renderTab(k, depth))}
          </div>
        );
      }
      const headerInner = (
        <>
          <Icon size={15} strokeWidth={headerActive ? 2.4 : 2} className={headerActive ? "text-primary" : ""} />
          <span className="flex-1">{tab.label}</span>
        </>
      );
      return (
        <div key={gid} className="my-0.5">
          {/* Header row: label = link (when `to`) or toggle; chevron always toggles. */}
          <div
            className={cn(
              "group relative flex w-full items-center gap-3 rounded-md pl-3 pr-1.5 text-left text-[12.5px] font-medium transition-all duration-150",
              headerActive
                ? "text-sidebar-ink"
                : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
              tab.to && selfActive && "bg-sidebar-active shadow-[inset_0_0_0_1px_rgba(231,234,228,0.12)]",
            )}
          >
            {tab.to && selfActive && (
              <span className="absolute -left-[10px] top-2 bottom-2 w-[2px] rounded-r bg-primary" />
            )}
            {headerTo ? (
              <NavLink
                to={headerTo}
                onClick={(e) => {
                  markOpenIntentOnPlainClick(e);
                  openGroup(gid);
                }}
                onMouseEnter={() => prefetchRoute(headerTo)}
                className="flex min-w-0 flex-1 items-center gap-3 py-2"
              >
                {headerInner}
              </NavLink>
            ) : (
              <button
                onClick={() => toggleGroup(gid, headerActive)}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left"
              >
                {headerInner}
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleGroup(gid, headerActive);
              }}
              className="hidden shrink-0 rounded p-1 text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:inline-flex"
              aria-label={open ? "Collapse" : "Expand"}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
          {/* Children: always visible on mobile; on lg+ obey the `open` flag. */}
          <div
            className={cn(
              "ml-3 border-l border-sidebar-border pl-2",
              !open && "lg:hidden",
            )}
          >
            {tab.children.map((k) => renderTab(k, depth + 1))}
          </div>
        </div>
      );
    }

    // Leaf — needs `to`. (filterTab + types ensure it.)
    if (!tab.to) return null;
    const to = tab.to;
    const active = tabIsActive(to, tab.end);
    return (
      <NavLink
        key={to}
        to={to}
        end={tab.end}
        onClick={markOpenIntentOnPlainClick}
        onMouseEnter={() => prefetchRoute(to)}
        // We compute active state ourselves so query strings match.
        className={() =>
          cn(
            "group relative my-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-[12.5px] font-medium transition-all duration-150",
            active
              ? "bg-sidebar-active text-sidebar-ink shadow-[inset_0_0_0_1px_rgba(231,234,228,0.12)]"
              : "text-sidebar-ink-muted hover:bg-sidebar-hover hover:text-sidebar-ink",
            collapsed && "mx-1 justify-center px-2"
          )
        }
      >
        {active && !collapsed && (
          <span className="absolute -left-[10px] top-2 bottom-2 w-[2px] rounded-r bg-primary" />
        )}
        <Icon
          size={15}
          strokeWidth={active ? 2.4 : 2}
          className={active ? "text-primary" : ""}
        />
        {!collapsed && <span>{tab.label}</span>}
      </NavLink>
    );
  }

  return (
    <>
      {/* Mobile backdrop — only rendered when the drawer is open. */}
      {mobileOpen && (
        <button
          onClick={onMobileClose}
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm lg:hidden animate-fade-in"
        />
      )}

      <aside
        className={cn(
          "flex flex-col border-r border-sidebar-border bg-sidebar text-sidebar-ink transition-transform duration-200",
          // Mobile: fixed drawer that slides in from the left. Width is
          // 88vw with a 280 px ceiling so a 320 px device retains a
          // ~38 px tap-out gutter. On `lg+` the explicit w-* below
          // overrides this entirely.
          "fixed inset-y-0 left-0 z-50 w-[88vw] max-w-[280px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop (lg+): static, takes part in flex layout, no transform.
          "lg:relative lg:max-w-none lg:translate-x-0 lg:transition-[width]",
          effectiveCollapsed ? "lg:w-16" : "lg:w-[232px]"
        )}
      >
      {/* Brass hairline along the right edge — refined separator on top of the border */}
      <div className="pointer-events-none absolute right-0 top-0 h-full w-px bg-gradient-to-b from-transparent via-accent/35 to-transparent" />

      {/* ── Brand header ────────────────────────────────────── */}
      <div
        className={cn(
          "relative flex h-20 items-center border-b border-sidebar-border",
          collapsed ? "justify-center" : "justify-between px-5"
        )}
      >
        {collapsed ? (
          // Collapsed: just the square mark. HOUZS keeps the bundled asset
          // (whitewashed by brightness-0 invert, as before); another company's
          // UPLOADED logo skips the whitewash (it would blank a colour logo),
          // and the no-logo fallback is a two-letter glyph.
          <CompanyMark
            variant="mark"
            imgClassName="h-9 w-9 object-contain brightness-0 invert"
            uploadedImgClassName="h-9 w-9 object-contain"
            textClassName="text-[15px] font-bold tracking-wide text-sidebar-ink"
          />
        ) : (
          // Expanded: the horizontal wordmark fills the available width.
          // The 1:4 aspect ratio + h-10 yields a comfortable ~40×160 box.
          <CompanyMark
            variant="wordmark"
            imgClassName="h-10 w-auto max-w-[160px] object-contain brightness-0 invert"
            uploadedImgClassName="h-10 w-auto max-w-[160px] object-contain"
            textClassName="truncate text-[15px] font-bold tracking-tight text-sidebar-ink"
          />
        )}
        {!collapsed && (
          <button
            onClick={onToggle}
            className="hidden text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:block"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        )}
        {/* Mobile drawer close button — only visible below lg */}
        {onMobileClose && (
          <button
            onClick={onMobileClose}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-sidebar-ink-muted transition-colors hover:text-sidebar-ink lg:hidden"
            aria-label="Close menu"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {!collapsed && (
        <button
          onClick={onToggle}
          className="absolute right-3 top-3 hidden text-sidebar-ink-muted hover:text-sidebar-ink"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      )}
      {collapsed && (
        <button
          onClick={onToggle}
          className="absolute right-2 top-2 hidden text-sidebar-ink-muted hover:text-sidebar-ink lg:block"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen size={14} />
        </button>
      )}

      {/* ── Global search trigger (mobile drawer only; desktop nav bar owns it) */}
      <div
        className={cn(
          "border-b border-sidebar-border lg:hidden",
          collapsed ? "px-2 py-3" : "px-3 py-3"
        )}
      >
        <GlobalSearchTrigger collapsed={collapsed} />
      </div>

      {/* ── Flat root nav ─────────────────────────────────────── */}
      <nav className="no-scrollbar flex-1 overflow-y-auto px-2 pb-4 pt-3">
        {SECTION_ORDER.map((sec) => {
          const items = visibleTabs.filter((t) => (t.section ?? "operations") === sec);
          if (items.length === 0) return null;
          return (
            <div key={sec} className={collapsed ? "" : "mb-1"}>
              {!collapsed && (
                <div className="px-3 pb-1 pt-3 font-mono text-[9.5px] font-bold uppercase tracking-brand text-sidebar-ink-muted">
                  {SECTION_LABELS[sec]}
                </div>
              )}
              {items.map((tab) => renderTab(tab))}
            </div>
          );
        })}
      </nav>

      {/* ── Notification bell (mobile drawer only; desktop nav bar owns it) */}
      {user && (
        <div
          className={cn(
            "border-t border-sidebar-border lg:hidden",
            collapsed ? "flex justify-center px-2 py-2" : "px-2 py-2"
          )}
        >
          <NotificationBell collapsed={collapsed} direction="up" align="start" />
        </div>
      )}

      {/* ── Active members (mobile drawer only; desktop nav bar owns it) */}
      {user && (
        <div className="lg:hidden">
          <PresencePanel collapsed={collapsed} />
        </div>
      )}

      {/* ── User identity + sign out (mobile drawer only; desktop nav bar owns the avatar) */}
      {user && (
        <div className="border-t border-sidebar-border lg:hidden">
          {collapsed ? (
            <NavLink
              to="/profile"
              className="flex h-12 w-full items-center justify-center text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent"
              aria-label="Profile"
              title={`${user.name || user.email} · Profile`}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-sidebar-active text-[9px] font-bold uppercase text-accent-bright">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </span>
            </NavLink>
          ) : (
            <div className="flex items-center gap-2.5 px-5 py-3.5">
              <NavLink
                to="/profile"
                className="group flex min-w-0 flex-1 items-center gap-2.5"
                title="Open profile"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-active text-[10px] font-bold uppercase text-accent-bright shadow-[inset_0_0_0_1px_rgba(161,106,46,0.25)] group-hover:bg-accent group-hover:text-white">
                  {(user.name || user.email).slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-sidebar-ink group-hover:text-accent">
                    {user.name || user.email.split("@")[0]}
                  </div>
                  <div className="truncate text-[10px] text-sidebar-ink-muted">
                    {user.role_name}
                  </div>
                </div>
              </NavLink>
              <button
                onClick={() => logout()}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-sidebar-ink-muted transition-colors hover:bg-sidebar-hover hover:text-accent"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      </aside>
    </>
  );
}
