import { NavLink, useLocation } from "react-router-dom";
import { BACKDATE_DECIDER_PERMS } from "../vendor/scm/lib/payment-backdate-perms";
import { markWorkspaceOpenIntent } from "../lib/workspaceTabs";

function markOpenIntentOnPlainClick(e: { button?: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): void {
  if ((e.button ?? 0) === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
    markWorkspaceOpenIntent();
  }
}

import {
  ClipboardList,
  Zap,
  Settings as SettingsIcon,
  Store,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronDown,
  ChevronRight,
  Users,
  LogOut,
  Calendar,
  AlertTriangle,
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
  LifeBuoy,
  CalendarDays,
  History,
  CalendarOff,
  type LucideIcon, Landmark, CreditCard, Banknote, Receipt, Server, Sparkles, ScanLine, ListChecks } from "lucide-react";
import { cn } from "../lib/utils";
import { booleanRecordPreference, useIdentityPreference } from "../hooks/useIdentityPreference";
import { useAuth } from "../auth/AuthContext";
import type { CapabilityKey } from "../auth/capabilities";
import { collapsedEntryIsLit, collapsedEntryTo, makeNavFilter, navToIsActive } from "./navFilter";
import { REPORT_NAV_MEMBERS } from "../pages/scm-v2/reports-catalog";
import { readLastReport } from "../pages/scm-v2/reports/lastReport";
import { useItSupportConnected, withoutUnconnectedItSupport } from "../hooks/useItSupportConnected";
import { CompanyMark } from "./CompanyMark";
import { PresencePanel } from "./PresencePanel";
import { GlobalSearchTrigger } from "./GlobalSearch";
import { NotificationBell } from "./NotificationBell";
import {
  useApprovalBadgeCounts,
  type ApprovalBadgeSource,
  BADGE_MEANING,
} from "../hooks/useAmendmentApprovals";

function prefetchRoute(href: string): void {
  void import("../lib/prefetch-routes").then((m) => m.prefetchRoute(href)).catch(() => {});
}

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

/**
 * Single source of truth for the app's nav tree. Used by the desktop
 * Sidebar and re-rendered as a grid in the mobile MenuModal so the
 * two never drift. Add a route here, it shows up in both places.
 */
export interface NavTab {
  section?: "workspace" | "operations" | "system";
  to?: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  perm?: string;
  anyPerm?: string[];
  anyAccess?: string[];
  hidePerm?: string;
  pageAccess?: string;
  pageAccessFull?: string;
  requireFinanceViewer?: boolean;
  requireFairReport?: boolean;
  hideForSales?: boolean;
  showForSales?: boolean;
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
  hideForSalesRep?: boolean;
  showForSalesRep?: boolean;
  /** Live red count rendered on this entry. The only source today is
   *  amendments waiting for THIS user's signature, SO or PO (owner 2026-09-09).
   *  Named rather than passed as a number so the nav tree
   *  stays a static description: the tree is built in a dozen branches, and a
   *  count threaded through all of them would have to be fetched whether or not
   *  the entry survives the visibility filter. Renders nothing at 0, which is
   *  also what a non-approver and a failed poll both produce. */
  badge?: ApprovalBadgeSource;
  requireCapability?: CapabilityKey;
  salesRepOnly?: boolean;
  salesRepTo?: string;
  children?: NavTab[];
  groupId?: string;
  collapsed?: boolean;
  alsoActive?: string;
  notWithParam?: string;
}

/**
 * Sidebar tab registry — flat root list. Use `children` on a tab to
 * nest sub-entries under an expandable group header (see Project
 * Management). Tabs declare permission via `perm` / `anyPerm`; the
 * filter recurses so groups with no visible kids hide entirely.
 */
export const NAV_TABS: NavTab[] = [
  {
    section: "workspace",
    to: "/",
    label: "Overview",
    icon: LayoutDashboard,
    end: true,
  },
  {
    section: "workspace",
    to: "/scm/sales-orders",
    label: "Sales Orders",
    icon: ShoppingCart,
    anyPerm: ["*", "scm.access"],
    anyAccess: ["scm.sales.orders"],
    showForSalesRep: true,
  },
  // 申请付款 (owner 2026-09-30): whoever holds scm.payment_request.create — a PIC
  // paying an event's rental — asks Finance to pay a bill here. Finance works
  // the same page from Money out. The key alone shows it: the sales team was
  // left out of the grant (owner 2026-10-01, 除了 sales team), so a sales rep
  // without it no longer sees an entry the route and the server refuse.
  // Finance (scm.payment_voucher.create, `*` included) keeps only the Money out
  // entry — the same page twice was noise (owner 2026-10-08).
  // Since 2026-10-14 (option A) the refund a salesperson asks for from a Sales
  // Order is a payment request of their own: Sales staff and anyone who works
  // Sales Orders see this entry to read their own requests — without the key
  // the page offers no New request, and the server raises nothing for them.
  {
    section: "workspace",
    to: "/scm/payment-requests",
    label: "Payment Requests",
    icon: HandCoins,
    anyPerm: ["*", "scm.payment_request.create"],
    anyAccess: ["scm.sales.orders"],
    showForSales: true,
    hidePerm: "scm.payment_voucher.create",
  },
  // Sales Entries — Nico 2026-07-09: "sales entries 我不要了". Sidebar
  // entry removed. The /sales route + Sales.tsx page + backend endpoints
  // are intentionally left intact so any deep-link / bookmark keeps
  // resolving until we consciously retire the module. Re-add this block
  // to restore the sidebar shortcut.
  //   { section: "workspace", to: "/sales", label: "Sales Entries",
  //     icon: ReceiptText, pageAccess: "sales" },

  {
    section: "operations",
    label: "Service Cases",
    icon: Zap,
    groupId: "service",
    to: "/assr?view=hub",
    anyPerm: ["service_cases.read"],
    showForSales: true,
    salesRepTo: "/my-cases",
    children: [
      {
        // Owner 2026-10-16: each module opens with its overview, listed first.
        to: "/assr?view=metrics",
        label: "Quality Overview",
        icon: ShieldCheck,
        perm: "service_cases.read",
        pageAccess: "service_cases.metrics",
        hideForSalesRep: true,
      },
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
        to: "/assr?view=settings",
        label: "Service Maintenance",
        icon: Wrench,
        perm: "service_cases.manage",
        // RBAC rebuild batch 3 (owner 2026-10-20 "全部拆开"): the dormant
        // service_cases.settings key is wired onto this tab, ANDed with the
        // existing service_cases.manage perm. Zero-change on day one: in prod
        // every role holding service_cases.manage stores service_cases.settings =
        // full (wildcards short-circuit to full), so no one who sees Service
        // Maintenance today loses it (teamServiceSubpageSplit.test.ts).
        pageAccess: "service_cases.settings",
        hideForSalesRep: true,
      },
      {
        to: "/my-cases",
        label: "My Cases",
        icon: ClipboardCheck,
        perm: "service_cases.read",
        showForSales: true,
      },
    ],
  },

  {
    section: "operations",
    label: "Projects",
    icon: FolderKanban,
    groupId: "projects",
    to: "/projects?view=hub",
    pageAccess: "projects",
    children: [
      {
        to: "/projects?view=finances",
        label: "Project Overview",
        icon: DollarSign,
        pageAccess: "projects.finances",
        // Directors open it without the page-access row (owner 2026-10-20: they
        // check which orders were not opened); still finance viewers only.
        showForDirector: true,
        requireFinanceViewer: true,
      },
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
        to: "/projects?view=defects",
        label: "Defect List",
        icon: AlertTriangle,
        pageAccess: "projects.list",
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

  {
    section: "operations",
    label: "Supply Chain",
    icon: Boxes,
    groupId: "scm",
    to: "/scm",
    anyPerm: ["*", "scm.access"],
    anyAccess: [
      "scm",
      "scm.sales",
      "scm.procurement",
      "scm.consignment",
      "scm.transportation",
      "scm.warehouse",
      "scm.finance",
    ],
    showForSalesRep: true,
    salesRepTo: "/scm/sales-orders",
    children: [
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
      // Product Request leaf for EVERY Sales position, director included (owner
      // 2026-10-06: Sales 都能提; 2026-10-13: the Sales Director saw no entry —
      // salesRepOnly cut directors and the Consignment child needs an area a
      // director does not hold). showForSales admits Sales by org field; the
      // anyPerm admits a non-Sales holder of the create key. The office path is
      // the Consignment child below, hidden from Sales so nobody sees two rows.
      {
        to: "/scm/product-requests",
        label: "Product Request",
        icon: Sofa,
        showForSales: true,
        anyPerm: ["scm.product_request.create"],
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
      {
        hideForSalesRep: true,
        label: "Sales Order",
        icon: ShoppingCart,
        groupId: "scm-sales",
        to: "/scm/sales-order",
        anyPerm: ["*", "scm.access"],
        anyAccess: ["scm.sales", "scm.sales.orders", "scm.sales.delivery", "scm.sales.invoices", "scm.sales.returns"],
        children: [
          { to: "/scm/sales-orders", label: "Sales Orders", icon: ShoppingCart, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.orders"] },
          // Orders with no fair link, for the office to settle (owner 2026-10-19:
          // 「先做 Fair links to settle 菜单」). The page existed only by URL; the
          // red number is how many it lists, from the same server read.
          { to: "/scm/fair-pending", label: "Fair Links to Settle", icon: MapPinned, anyPerm: ["*", "scm.access"], anyAccess: ["scm.sales.orders"], hideForSalesRep: true, badge: "fair-links-to-settle" },
          { to: "/scm/amendments", label: "Sales Order Amendment", icon: History, anyPerm: ["*", "scm.access", "scm.amendment.create", "scm.amendment.supplier_confirm", "scm.amendment.approve_so", "scm.amendment.approve_po", "scm.so_cancel.approve_l1", "scm.so_cancel.approve_l2"], anyAccess: ["scm.sales.orders"], hideForSalesRep: true, badge: "amendment-approvals" },
          { to: "/scm/payment-backdate-requests", label: "Payment Backdate Requests", icon: ClipboardCheck, anyPerm: BACKDATE_DECIDER_PERMS, hideForSalesRep: true, badge: "payment-backdate-approvals" },
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
          // Product request (owner 2026-10-06): what a Purchase Consignment Order
          // is raised from. The office / Purchaser path; a rep reaches it via the
          // rep-only leaf above. Either flat key shows it too, like PO Amendments.
          { to: "/scm/product-requests", label: "Product Request", icon: Sofa, anyPerm: ["*", "scm.access", "scm.product_request.create", "scm.product_request.approve"], anyAccess: ["scm.consignment.po_orders", "scm.procurement.po", "scm.procurement.products"], hideForSales: true, badge: "product-request-approvals" },
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
          { to: "/scm/procurement-overview", label: "Procurement Overview", icon: LayoutDashboard, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.po"], hideForSalesRep: true, showForSalesDirector: true },
          { to: "/scm/products", label: "Products & Maintenance", icon: Sofa, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.products"], hideForSalesRep: true },
          { to: "/scm/suppliers", label: "Suppliers", icon: Truck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.suppliers"], hideForSalesRep: true },
          { to: "/scm/mrp", label: "MRP · Stock Status", icon: Calculator, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.mrp"], hideForSalesRep: true },
          { to: "/scm/purchase-orders", label: "Purchase Orders", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.procurement.po"], hideForSalesRep: true },
          { to: "/scm/po-amendments", label: "PO Amendments", icon: History, anyPerm: ["*", "scm.access", "scm.po_amendment.create", "scm.po_amendment.approve"], anyAccess: ["scm.procurement.po"], hideForSalesRep: true, badge: "po-amendment-approvals" },
          { to: "/scm/cancel-requests", label: "Cancellation Requests", icon: ClipboardCheck, anyPerm: ["*", "scm.access", "scm.so_cancel.approve_l1", "scm.so_cancel.approve_l2"], anyAccess: ["scm.procurement.po", "scm.sales.orders"], hideForSalesRep: true },
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
        anyAccess: ["scm.transportation", "scm.transportation.drivers", "scm.transportation.overview", "scm.transportation.planning", "scm.transportation.dp_orders", "scm.transportation.last_mile", "scm.transportation.lorry_map", "scm.transportation.lorry_capacity", "scm.transportation.crew_leave", "scm.transportation.coverage"],
        children: [
          { to: "/scm/logistic-overview", label: "Logistic Overview", icon: LayoutDashboard, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.overview"], hideForSalesRep: true },
          { to: "/scm/delivery-planning", label: "Delivery Planning", icon: Send, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.planning"], hideForSalesRep: true },
          { to: "/scm/delivery-planning-driver", label: "Last Mile Delivery (Driver)", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.last_mile"], hideForSalesRep: true },
          { to: "/scm/dp-orders", label: "DP Orders", icon: ClipboardList, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.dp_orders"], hideForSalesRep: true },
          // Delivery Date / Time Arrangement menu entries removed (owner 2026-10-20):
          // all date/time/crew arranging now happens inline on Delivery Planning,
          // which schedules onto trips directly. The /scm/auto-schedule and
          // /scm/trips routes still resolve by direct URL (auto-propose optimiser).
          { to: "/scm/fleet-day", label: "Last Mile Delivery", icon: MapPinned, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.last_mile"], hideForSalesRep: true },
          { to: "/scm/driver-leave", label: "Crew Leave", icon: CalendarOff, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.crew_leave"], hideForSalesRep: true },
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
            anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers", "scm.transportation.coverage"], hideForSalesRep: true,
            children: [
              { to: "/scm/delivery-maintenance", label: "Coverage & Fleet", icon: Map, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.coverage"], hideForSalesRep: true },
              { to: "/scm/delivery-zones", label: "Delivery Zones", icon: MapPinned, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.drivers"], hideForSalesRep: true },
              { to: "/scm/delivery-rate-cards", label: "Carriers & Rates", icon: Handshake, anyPerm: ["*", "scm.access"], anyAccess: ["scm.transportation.coverage"], hideForSalesRep: true },
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
          { to: "/scm/warehouses", label: "Warehouses", icon: Warehouse, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"], hideForSalesRep: true },
          // Racks & Bins (owner 2026-09-11) — promoted from a button on the
          // Warehouses page to its own nav item, sitting under Warehouses. Same
          // gate as Inventory (the rack overview / floor plan + stock I/O page).
          { to: "/scm/warehouses/racks", label: "Racks & Bins", icon: Boxes, anyPerm: ["*", "scm.access"], anyAccess: ["scm.warehouse.inventory"], hideForSalesRep: true },
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
          { to: "/scm/stock-take-approvals", label: "Stock Take Approvals", icon: ClipboardCheck, anyPerm: ["*", "scm.stock_take.supervise"], anyAccess: ["scm.warehouse.stock_take"], hideForSalesRep: true, badge: "stock-take-approvals" },
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
      { to: "/scm/finance", end: true, label: "To do", icon: ListChecks, badge: "finance-todo", anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.accounting"] },
      { to: "/scm/daily-bank?view=board", label: "Money today", icon: Landmark, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.bank"] },
      // ── SIX GROUPS, BY THE JOB (owner 2026-09-12: finance 的 function 分到很散,
      //    我希望我要 maintenance 的东西一个子 side bar, report 一个 side bar;
      //    docs/bugs/0824). Fifteen flat entries and the Accounting page's
      //    thirteen tabs were two lists to hunt through. Every entry below is
      //    the SAME entry it was, gates untouched; the Accounting tabs are
      //    reached by deep link (/scm/accounting?tab=…, read by the page), so
      //    a report is one click from here. A group carries no gate of its
      //    own: it is shown when any of its entries is, hidden when none are
      //    (makeNavFilter), and the outer Finance gate still ANDs onto all.
      {
        label: "Money in",
        icon: HandCoins,
        groupId: "scm-finance-in",
        children: [
          { to: "/scm/receipts", label: "Receipts", icon: Receipt, anyPerm: ["*", "scm.access", "scm.payment_voucher.create", "scm.payment_voucher.post", "scm.sales_order.write"], anyAccess: ["scm.finance.money_in"] },
          // Invoices (owner 2026-09-29: AR invoices, the AP list's twin; the
          // owner's Claude Design, batch 5 step 5): the sales invoices mirrored
          // beside the other-debtor bills, the deposit invoices (owner
          // 2026-09-12; docs/bugs/0828) folded in as a kind — so the gate is the
          // two old rows' together; inside, each kind shows to whoever saw its
          // old row. /scm/deposit-invoices redirects here; its switch is in Setup.
          { to: "/scm/ar-invoices", label: "Invoices", icon: FileText, anyPerm: ["*", "scm.access", "scm.payment_voucher.create", "scm.payment_voucher.post", "scm.sales_order.write"], anyAccess: ["scm.finance.money_in"] },
          { to: "/scm/other-debtors", label: "Debtor maintenance", icon: SettingsIcon, anyPerm: ["*", "scm.access", "scm.payment_voucher.create"], anyAccess: ["scm.finance.money_in"] },
          // Credit and debit notes (owner 2026-09-12; docs/bugs/0827) — the
          // customer's CN / DN and an other debtor's CN; the supplier's moved to
          // Money out (owner 2026-10-28). The PV key family, like the AP invoice.
          // The redesign's names and order (owner's Claude Design, batch 5):
          // Receipts, Invoices, Debtor maintenance, Credit / debit notes,
          // Outstanding, Not yet billed — the same pages behind the same gates.
          { to: "/scm/credit-notes", label: "Credit / debit notes", icon: FileText, anyPerm: ["*", "scm.access", "scm.payment_voucher.create"], anyAccess: ["scm.finance.money_in"] },
          { to: "/scm/outstanding", label: "Outstanding", icon: AlertCircle, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.outstanding"] },
          { to: "/scm/unbilled-deliveries", label: "Not yet billed", icon: HandCoins, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.outstanding"] },
        ],
      },
      {
        label: "Money out",
        icon: Wallet,
        groupId: "scm-finance-out",
        children: [
          { to: "/scm/payment-vouchers", label: "Payment vouchers", icon: Wallet, anyPerm: ["*", "scm.access", "scm.payment_voucher.create", "scm.payment_voucher.write", "scm.payment_voucher.post", "scm.payment_voucher.cancel"], anyAccess: ["scm.finance.money_out"] },
          // The day's payments, a line each with the bank (owner 2026-11-08: 每天要过账的listing).
          { to: "/scm/payment-listing", label: "Payment listing", icon: ListChecks, anyPerm: ["*", "scm.access", "scm.payment_voucher.create", "scm.payment_voucher.write", "scm.payment_voucher.post", "scm.payment_voucher.cancel"], anyAccess: ["scm.finance.money_out"] },
          // 申请付款 (owner 2026-09-30) — the requests waiting for a voucher.
          { to: "/scm/payment-requests", label: "Payment requests", icon: HandCoins, anyPerm: ["*", "scm.payment_voucher.create"], badge: "payment-requests-waiting" },
          { to: "/scm/ap-invoices", label: "Supplier bills", icon: FileText, anyPerm: ["*", "scm.access", "scm.payment_voucher.create"], anyAccess: ["scm.finance.money_out"] },
          // Supplier Maintenance (owner 2026-10-02: 放在 money out 的 sidebar) — Finance's own
          // supplier list: what each is owed, its bank, and the ones Finance keeps to itself.
          { to: "/scm/supplier-maintenance", label: "Supplier maintenance", icon: Truck, anyPerm: ["*", "scm.access", "scm.payment_voucher.create"], anyAccess: ["scm.finance.money_out"] },
          // 欠正式单 (owner 2026-10-01) — payments made on a proforma, still owing the official invoice.
          { to: "/scm/official-docs", label: "Official invoices owed", icon: FileText, anyPerm: ["*", "scm.payment_voucher.create"] },
          // The supplier's (and an other creditor's) credit notes, moved here from
          // Money in (owner 2026-10-28: supplier & other creditor cn / dn 分出来).
          { to: "/scm/supplier-notes", label: "Supplier & other creditor CN / DN", icon: FileText, anyPerm: ["*", "scm.access", "scm.payment_voucher.create"], anyAccess: ["scm.finance.money_out"] },
        ],
      },
      {
        label: "Bank & cards",
        icon: Landmark,
        groupId: "scm-finance-bank",
        children: [
          { to: "/scm/merchant-recon", label: "Merchant reports", icon: CreditCard, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.bank"] },
          { to: "/scm/bank-recon", label: "Bank statements", icon: Banknote, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.bank"] },
          { to: "/scm/daily-bank", label: "Daily Bank", icon: Landmark, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.bank"] },
          // The owner's cash book, a second Daily Bank beside the original (2026-11-23:
          // 原版的daily bank还是要保留哦，我这算是新的daily bank) — same gate.
          { to: "/scm/daily-bank-cashbook", label: "Daily Bank (cash book)", icon: Wallet, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.bank"] },
          // Card AND transfer payments not matched yet, one list (owner
          // 2026-09-30: 我有没有一个表是显示全部还没 match 的); the recon key family.
          { to: "/scm/unmatched-payments", label: "Unmatched Payments", icon: AlertCircle, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.bank"] },
        ],
      },
      {
        label: "Books",
        icon: BookOpen,
        groupId: "scm-finance-books",
        children: [
          { to: "/scm/accounting?tab=je", label: "Journal entries", icon: BookOpen, notWithParam: "in", anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.books"] },
          { to: "/scm/accounting?tab=gl", label: "General ledger", icon: FileText, notWithParam: "in", anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.books"] },
          { to: "/scm/accounting?tab=tb", label: "Trial balance", icon: Receipt, notWithParam: "in", anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.books"] },
          { to: "/scm/accounting?tab=check", label: "Self-check", icon: ClipboardCheck, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.books"] },
          { to: "/scm/accounting?tab=close", label: "Stock close", icon: History, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.books"] },
          { to: "/scm/accounting?tab=commrel", label: "Commission release", icon: History, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.books"] },
        ],
      },
      {
        label: "Reports",
        icon: BarChart3,
        groupId: "scm-finance-reports",
        collapsed: true,
        alsoActive: "/scm/accounting?in=reports",
        children: REPORT_NAV_MEMBERS,
      },
      {
        label: "Setup",
        icon: SettingsIcon,
        groupId: "scm-finance-setup",
        children: [
          { to: "/scm/chart-of-accounts", label: "Chart of accounts", icon: SettingsIcon, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.setup"] },
          // The books' opening (owner 2026-10-28: opening balance maintainence 表) — accounts, creditors, other debtors, stock; locked once final.
          { to: "/scm/opening-balance", label: "Opening balance", icon: SettingsIcon, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.setup"] },
          { to: "/scm/accounting?tab=groups", label: "Item groups", icon: SettingsIcon, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.setup"] },
          { to: "/scm/settlement-setup", label: "Recon setup", icon: SettingsIcon, anyPerm: ["*", "scm.access", "scm.payment_voucher.post"], anyAccess: ["scm.finance.setup"] },
          { to: "/scm/currencies", label: "Currencies", icon: DollarSign, anyPerm: ["*", "scm.currency.manage"] },
          // The deposit invoice switch (owner 2026-09-12; docs/bugs/0828), moved off the old
          // Deposit invoices page (Claude Design, batch 5 step 5) — gated as that row was.
          { to: "/scm/finance/deposit-invoices", label: "Deposit invoices", icon: Receipt, anyPerm: ["*", "scm.access", "scm.payment_voucher.post", "scm.sales_order.write"], anyAccess: ["scm.finance.money_in"] },
          { to: "/scm/finance/rules", label: "To do rules", icon: ListChecks, anyPerm: ["*", "scm.access"], anyAccess: ["scm.finance.accounting"] },
        ],
      },
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
    anyPerm: ["*", "scm.hr.read", "scm.hr.manage", "hr.employees.read", "hr.employees.manage", "hr.attendance.read", "hr.ot.confirm"],
    children: [
      // Employees & Attendance (HC-0125): its own flat keys, payroll is granted
      // to different people than commission. hr.attendance.read / hr.ot.confirm
      // open it to the Attendance / OT tabs alone (see HrEmployees narrow mode).
      { to: "/hr/employees", label: "Employees & Attendance", icon: Users, anyPerm: ["*", "hr.employees.read", "hr.employees.manage", "hr.attendance.read", "hr.ot.confirm"] },
      { to: "/scm/hr/commission", label: "Commission", icon: DollarSign, anyPerm: ["*", "scm.hr.read", "scm.hr.manage"] },
      { to: "/scm/hr/settings", label: "HR Settings", icon: SlidersHorizontal, anyPerm: ["*", "scm.hr.manage"] },
    ],
  },

  {
    section: "operations",
    to: "/mail-center",
    label: "Mail Center",
    icon: Mail,
    anyPerm: ["mail_center.read"],
    badge: "mail-waiting",
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


  {
    section: "system",
    label: "Team",
    icon: Users,
    groupId: "team",
    to: "/team?tab=hub",
    anyPerm: ["users.read", "roles.read"],
    pageAccess: "team",
    showForSalesDirector: true,
    children: [
      // Redesigned Team screens (2026-08 handoff). The classic tabs stay
      // URL-reachable (?tab=members / orgchart / departments / mail) during
      // review but are no longer surfaced in navigation.
      // RBAC rebuild batch 3 (owner 2026-10-20 "全部拆开"): each Team sub-page now
      // gates on its OWN page key (was the parent `team`), so a role can be given
      // Directory but not Roles & Permissions. The group HEADER keeps `pageAccess:
      // "team"` + anyPerm as the master gate (unchanged), so visibility of the
      // group is byte-identical; only which leaves show changes, and in prod every
      // team.* child equals its `team` parent so day-1 is unchanged
      // (teamServiceSubpageSplit.test.ts). perm gates unchanged.
      { to: "/team?tab=directory", label: "Directory", icon: Users, perm: "users.read", pageAccess: "team.members", showForSalesDirector: true },
      // No Positions leaf (owner: "那個team的矩陣拆掉"), and none for Roles. The
      // Titles tab came back into the Team page's own strip on 2026-09-15
      // (docs/bugs/0931-a-new-title-could-not-be-created-anywhere-the-positions-tab.md)
      // and is reached from there; the phone menu is built from these rows and
      // keeps Positions out (mobileMenuGates.test.ts), so no leaf here.
      { to: "/team?tab=orgchart2", label: "Org Chart", icon: Network, perm: "users.read", pageAccess: "team.org_chart", showForSalesDirector: true },
      { to: "/team?tab=departments2", label: "Departments", icon: Building2, perm: "users.read", pageAccess: "team.departments" },
      { to: "/team?tab=mail2", label: "Mailboxes", icon: Mail, perm: "mail_center.manage", pageAccess: "team.mailboxes" },
      { to: "/team?tab=permissions", label: "Roles & Permissions", icon: ShieldCheck, perm: "roles.read", pageAccess: "team.roles" },
    ],
  },
  {
    section: "system",
    label: "IT",
    icon: Server,
    groupId: "it",
    requireCapability: "it.pages.view",
    children: [
      { to: "/system-health", label: "System Health", icon: Activity, requireCapability: "it.pages.view" },
      { to: "/ai-usage", label: "AI Usage", icon: Sparkles, requireCapability: "it.pages.view" },
    ],
  },
  // AI Connector (owner 2026-11-25): connect Claude / ChatGPT read-only with
  // your own permissions; the owner approves and disconnects here. Open to
  // everyone (request access lives on the page); the server decides the rest.
  {
    section: "system",
    to: "/ai-connector",
    label: "AI Connector",
    icon: Bot,
  },
  {
    section: "system",
    to: "/autocount-sync",
    label: "AutoCount Sync",
    icon: RefreshCw,
    anyPerm: ["*", "scm.autocount.read", "settings.manage"],
  },
  {
    section: "system",
    to: "/venture-portal-feed",
    label: "Venture Portal Feed",
    icon: Send,
    anyPerm: ["*", "scm.venture_portal.read", "settings.manage"],
  },
  {
    section: "system",
    to: "/change-log",
    label: "Change Log",
    icon: History,
    anyPerm: ["*", "scm.changelog.read", "settings.manage"],
  },
  {
    section: "system",
    to: "/assistant",
    label: "Assistant",
    icon: Bot,
    // Open to staff, EXCEPT the field crew + Sales (owner 2026-07-18/19). Who
    // gets no surface at all is decided server-side (capabilities.org.assistant.use,
    // composing assistant-scope.canUseAssistant) — the same answer the /assistant
    // route guard reads, so the nav link and the page can no longer disagree.
    requireCapability: "org.assistant.use",
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
    to: "/meetings",
    label: "Meetings",
    icon: CalendarDays,
    badge: "meetings-unread",
  },
  {
    section: "system",
    to: "/it-support",
    label: "IT Support",
    icon: LifeBuoy,
    badge: "it-support-replies",
  },
  {
    section: "system",
    to: "/ocr",
    label: "OCR",
    icon: ScanLine,
    requireCapability: "it.pages.view",
  },
  {
    section: "system",
    to: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    perm: "settings.manage",
  },
  {
    section: "system",
    to: "/pos-admin",
    label: "POS Admin",
    icon: Store,
    anyPerm: ["*", "pos.manage"],
  },
];

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

const SECTION_LABELS: Record<NonNullable<NavTab["section"]>, string> = {
  workspace: "Workspace",
  operations: "Operations",
  system: "System",
};
const SECTION_ORDER = ["workspace", "operations", "system"] as const;

export function Sidebar({ collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
  const { user, can, pageAccess, logout } = useAuth();
  /* One poll per source for the whole rail, read by renderTab's closure. The
     server answers 0 for anyone who cannot sign, so this is also the "在需要
     审批人员账号显示" gate — there is no second visibility rule here to keep in
     step with the backend's. */
  const badgeCounts = useApprovalBadgeCounts();
  const location = useLocation();
  const effectiveCollapsed = collapsed;

  const [groupExpanded, setGroupExpanded] = useIdentityPreference(
    "sidebar:groups:v2-accordion",
    {},
    booleanRecordPreference,
  );
  function isGroupOpen(id: string, active: boolean): boolean {
    const v = groupExpanded[id];
    return v === undefined ? active : v;
  }
  function toggleGroup(id: string, active: boolean) {
    setGroupExpanded((prev) => {
      const cur = prev[id] === undefined ? active : prev[id];
      const willOpen = !cur;
      const next = { ...prev, [id]: willOpen };
      if (willOpen) for (const sib of GROUP_SIBLINGS[id] ?? []) next[sib] = false;
      return next;
    });
  }
  function openGroup(id: string) {
    setGroupExpanded((prev) => {
      const next = { ...prev, [id]: true };
      for (const sib of GROUP_SIBLINGS[id] ?? []) next[sib] = false;
      return next;
    });
  }

  function tabIsActive(to: string, end?: boolean, notWithParam?: string): boolean {
    return navToIsActive(to, location, end, notWithParam);
  }
  const collapsedLit = (tab: NavTab): boolean => collapsedEntryIsLit(tab, location);

  const filterTab = makeNavFilter({ user, can, pageAccess });

  const itSupportConnected = useItSupportConnected();
  const visibleTabs = withoutUnconnectedItSupport(
    NAV_TABS.map(filterTab).filter((t): t is NavTab => t !== null),
    itSupportConnected,
  );

  function renderTab(tab: NavTab, depth = 0, lit?: boolean): React.ReactNode {
    const Icon = tab.icon;

    if (tab.collapsed && tab.children && tab.children.length > 0) {
      const target = collapsedEntryTo(tab.children, readLastReport());
      return target ? renderTab({ ...tab, children: undefined, to: target }, depth, collapsedLit(tab)) : null;
    }

    if (tab.children && tab.children.length > 0) {
      const gid = tab.groupId || tab.label;
      const headerTo = tab.to;
      const hasActiveDescendant = (n: NavTab): boolean => (
        n.collapsed
          ? collapsedLit(n)
          : (n.to ? tabIsActive(n.to, n.end, n.notWithParam) : false) || (n.children?.some(hasActiveDescendant) ?? false)
      );
      const selfActive = tab.to ? tabIsActive(tab.to, tab.end) : false;
      const headerActive = selfActive || tab.children.some(hasActiveDescendant);
      const open = isGroupOpen(gid, headerActive);
      if (collapsed) {
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

    if (!tab.to) return null;
    const to = tab.to;
    const active = lit ?? tabIsActive(to, tab.end, tab.notWithParam);
    return (
      <NavLink
        key={to}
        to={to}
        end={tab.end}
        onClick={markOpenIntentOnPlainClick}
        onMouseEnter={() => prefetchRoute(to)}
        title={
          tab.badge && badgeCounts[tab.badge] > 0
            ? `${tab.label} · ${badgeCounts[tab.badge]} ${BADGE_MEANING[tab.badge]}`
            : collapsed
              ? tab.label
              : undefined
        }
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
        {!collapsed && <span className="flex-1">{tab.label}</span>}
        {tab.badge && badgeCounts[tab.badge] > 0 && (
          <span
            className={cn(
              "flex items-center justify-center rounded-full bg-err font-mono text-[9px] font-bold text-white shadow-sm",
              collapsed
                ? "absolute right-1 top-1 h-4 min-w-[16px] px-1"
                : "h-4 min-w-[18px] px-1"
            )}
          >
            {badgeCounts[tab.badge] > 99 ? "99+" : badgeCounts[tab.badge]}
          </span>
        )}
      </NavLink>
    );
  }

  return (
    <>
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
          "fixed inset-y-0 left-0 z-50 w-[88vw] max-w-[280px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "lg:relative lg:max-w-none lg:translate-x-0 lg:transition-[width]",
          effectiveCollapsed ? "lg:w-16" : "lg:w-[232px]"
        )}
      >
      <div className="pointer-events-none absolute right-0 top-0 h-full w-px bg-gradient-to-b from-transparent via-accent/35 to-transparent" />

      <div
        className={cn(
          "relative flex h-20 items-center border-b border-sidebar-border",
          collapsed ? "justify-center" : "justify-between px-5"
        )}
      >
        {collapsed ? (
          <CompanyMark
            variant="mark"
            imgClassName="h-9 w-9 object-contain brightness-0 invert"
            uploadedImgClassName="h-9 w-9 object-contain"
            textClassName="text-[15px] font-bold tracking-wide text-sidebar-ink"
          />
        ) : (
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

      <div
        className={cn(
          "border-b border-sidebar-border lg:hidden",
          collapsed ? "px-2 py-3" : "px-3 py-3"
        )}
      >
        <GlobalSearchTrigger collapsed={collapsed} />
      </div>

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

      {user && (
        <div className="lg:hidden">
          <PresencePanel collapsed={collapsed} />
        </div>
      )}

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
