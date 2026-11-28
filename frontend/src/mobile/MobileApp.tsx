import { lazy, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders, canDriverCompleteDelivery, canOperateSalesInvoices, canOperateGoodsReceipts, canOperatePurchaseOrders, canViewFairReport, isSalesDirectorUser } from "../auth/salesAccess";
import { memberEditFormFor, memberInviteFormFor } from "./member-invite-form";
import { supplierFormFor } from "./supplier-form";
import { capability, type CapabilityKey } from "../auth/capabilities";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { makeNavVisible } from "../components/navFilter";
import { NotifyProvider, useNotify } from "../vendor/scm/components/NotifyDialog";
import { ConfirmProvider, useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { PromptProvider } from "../vendor/scm/components/PromptDialog";
import { ChoiceProvider } from "../vendor/scm/components/ChoiceDialog";
import { VpBrandPromptBridge } from "../vendor/scm/components/VpBrandPromptBridge";
import { registerDialogService } from "../vendor/scm/lib/dialog-service";
import { invalidateSoShared } from "./sharedInvalidate";
import { useApplyHtmlLang } from "./mobileI18n";
import { useAnnouncementUnread } from "./useAnnouncementUnread";
import { MobileCrashBoundary } from "./MobileCrashBoundary";
import { IosInstallGuide } from "../components/IosInstallGuide";
import { AndroidInstallGuide } from "../components/AndroidInstallGuide";
import { MobileModuleList, MODULE_CONFIGS, FORM_MEMBERS_EDIT } from "./MobileModuleList";
import { MobileInvitations } from "./MobileInvitations";
import { mobileDestinationMatches, resolveMobileRoute, type MobileRoute } from "./mobileRoute";
import { useItSupportConnected, withoutUnconnectedItSupport } from "../hooks/useItSupportConnected";
import { useItSupportUnread } from "../hooks/useAmendmentApprovals";
import type { FlowDocNav, FlowNav } from "./relationship-map-model";
import type { SearchNav } from "./MobileSearch";
import type { MobileScanPrefill } from "./MobileScan";
import type { MobileConvertPrefill } from "./MobileOrderMoney";
import type { ConvertTarget } from "./MobileConvertWizard";
import { MODULE_TO_PURCHASE_DOC, convertInsteadFor, mayCreatePurchaseDoc, type PurchaseDocKind } from "./mobile-purchase-doc";
import { ScanInvoiceLauncher } from "./MobileScanInvoiceLauncher";
import { MobilePackingLists } from "./MobilePackingLists";
const MobileSalesOrders = lazy(() => import("./MobileSalesOrders").then((m) => ({ default: m.MobileSalesOrders })));
const MobileAmendments = lazy(() => import("./MobileAmendments").then((m) => ({ default: m.MobileAmendments })));
const MobilePoAmendments = lazy(() => import("./MobilePoAmendments").then((m) => ({ default: m.MobilePoAmendments })));
const MobilePoAmendmentDetail = lazy(() => import("./MobilePoAmendmentDetail").then((m) => ({ default: m.MobilePoAmendmentDetail })));
const MobileSODetail = lazy(() => import("./MobileSODetail").then((m) => ({ default: m.MobileSODetail })));
const MobileDoHeaderEdit = lazy(() => import("./MobileDoHeaderEdit").then((m) => ({ default: m.MobileDoHeaderEdit })));
const MobileNewSO = lazy(() => import("./MobileNewSO").then((m) => ({ default: m.MobileNewSO })));
const MobileCalendar = lazy(() => import("./MobileCalendar").then((m) => ({ default: m.MobileCalendar })));
const MobileSearch = lazy(() => import("./MobileSearch").then((m) => ({ default: m.MobileSearch })));
const MobileInbox = lazy(() => import("./MobileInbox").then((m) => ({ default: m.MobileInbox })));
const MobileServiceCase = lazy(() => import("./MobileServiceCase").then((m) => ({ default: m.MobileServiceCase })));
const MobilePMS = lazy(() => import("./MobilePMS").then((m) => ({ default: m.MobilePMS })));
const MobilePmsDefectList = lazy(() => import("./MobilePmsDefectList").then((m) => ({ default: m.MobilePmsDefectList })));
const MobileMailCenter = lazy(() => import("./MobileMailCenter").then((m) => ({ default: m.MobileMailCenter })));
const MobileRoles = lazy(() => import("./MobileRoles").then((m) => ({ default: m.MobileRoles })));
const MobileTitles = lazy(() => import("./MobileTitles").then((m) => ({ default: m.MobileTitles })));
const MobileAnnouncements = lazy(() => import("./MobileAnnouncements").then((m) => ({ default: m.MobileAnnouncements })));
const MobileAnnouncementPopup = lazy(() => import("./MobileAnnouncementPopup").then((m) => ({ default: m.MobileAnnouncementPopup })));
const MobileModuleDetail = lazy(() => import("./MobileModuleDetail").then((m) => ({ default: m.MobileModuleDetail })));
const MobileModuleForm = lazy(() => import("./MobileModuleForm").then((m) => ({ default: m.MobileModuleForm })));
const MobileDeliveryPlanning = lazy(() => import("./MobileDeliveryPlanning").then((m) => ({ default: m.MobileDeliveryPlanning })));
const MobileScan = lazy(() => import("./MobileScan").then((m) => ({ default: m.MobileScan })));
const MobileScanInvoice = lazy(() => import("./MobileScanInvoice").then((m) => ({ default: m.MobileScanInvoice })));
const MobileGrnScan = lazy(() => import("./MobileGrnScan").then((m) => ({ default: m.MobileGrnScan })));
const MobileConvertWizard = lazy(() => import("./MobileConvertWizard").then((m) => ({ default: m.MobileConvertWizard })));
const MobilePOD = lazy(() => import("./MobilePOD").then((m) => ({ default: m.MobilePOD })));
const MobileOverview = lazy(() => import("./MobileOverview").then((m) => ({ default: m.MobileOverview })));
const MobileMileageCapture = lazy(() => import("./MobileMileageCapture").then((m) => ({ default: m.MobileMileageCapture })));
const MobilePunch = lazy(() => import("./MobilePunch").then((m) => ({ default: m.MobilePunch })));
const MobileProfile = lazy(() => import("./MobileProfile").then((m) => ({ default: m.MobileProfile })));
const MobileStockCard = lazy(() => import("./MobileStockCard").then((m) => ({ default: m.MobileStockCard })));
const MobileStockTransferNew = lazy(() => import("./MobileStockTransferNew").then((m) => ({ default: m.MobileStockTransferNew })));
const MobilePurchaseDocNew = lazy(() => import("./MobilePurchaseDocNew").then((m) => ({ default: m.MobilePurchaseDocNew })));
const MobileRacks = lazy(() => import("./MobileRacks").then((m) => ({ default: m.MobileRacks })));
const MobilePaymentRequests = lazy(() => import("./MobilePaymentRequests").then((m) => ({ default: m.MobilePaymentRequests })));
const MobileProductRequests = lazy(() => import("./MobileProductRequests").then((m) => ({ default: m.MobileProductRequests })));
const MobileFairReport = lazy(() => import("./MobileFairReport").then((m) => ({ default: m.MobileFairReport })));
const MobileAutoCountSync = lazy(() => import("./MobileAutoCountSync").then((m) => ({ default: m.MobileAutoCountSync })));
const MobileVenturePortalFeed = lazy(() => import("./MobileVenturePortalFeed").then((m) => ({ default: m.MobileVenturePortalFeed })));
const MobileChangeLog = lazy(() => import("./MobileChangeLog").then((m) => ({ default: m.MobileChangeLog })));
const MobileItSupport = lazy(() => import("./MobileItSupport").then((m) => ({ default: m.MobileItSupport })));
const MobileMeetings = lazy(() => import("./MobileMeetings").then((m) => ({ default: m.MobileMeetings })));
const ScmSalesOrderMaintenance = lazy(() => import("../pages/scm-v2/SalesOrderMaintenance").then((m) => ({ default: m.SalesOrderMaintenance })));
const Scm2990Shell = lazy(() => import("../pages/scm-v2/Scm2990Shell"));
import "./mobile.css";
import { LazySlot } from "../components/LazySlot";

const PendingTasksReminder = lazy(() =>
  import("../components/PendingTasksReminder").then((m) => ({ default: m.PendingTasksReminder })));

type Tab = "orders" | "service" | "calendar" | "profile";
type Screen =
  | { t: "tab" }
  | { t: "search" }
  | { t: "so-detail"; docNo: string }
  | { t: "amendments" }
  | { t: "po-amendments" }
  | { t: "po-amendment-detail"; id: string }
  | { t: "so-maintenance" }
  | { t: "fair-report" }
  | { t: "autocount-sync" }
  | { t: "venture-portal-feed" }
  | { t: "change-log" }
  | { t: "new-so"; mode: "new" | "edit" | "edit-draft"; docNo?: string; scanPrefill?: MobileScanPrefill; addLine?: boolean; convertFrom?: MobileConvertPrefill }
  | { t: "scan" }
  | { t: "scan-pi" }
  | { t: "grn-scan"; key: string; title: string }
  | { t: "module"; key: string; title: string }
  | { t: "module-detail"; key: string; row: any; title: string }
  | { t: "stock-transfer-new"; key: string; row: any; title: string }
  | { t: "module-form"; key: string; mode: "new" | "edit"; row?: any }
  /* Delivery Order header edit (owner 2026-09-12 parity). Its own screen, not the
     generic module form: it needs the address cascade and the SI/DR lock. */
  | { t: "do-edit"; key: string; row: Record<string, unknown>; title: string }
  | { t: "convert"; key: string; title: string; target: ConvertTarget; initialSourceId?: string }
  /* DIRECT create for PO / GRN / PI (owner 2026-09-12: create directly, not
     only by converting). Entered from that module list's "+"; returns to it. */
  | { t: "purchase-doc-new"; key: string; title: string; kind: PurchaseDocKind }
  | { t: "pod"; docNo: string; companyCode?: string | null; from?: "delivery-planning" | "delivery-planning-driver" }
  | { t: "mileage-capture" }
  /* Punch In / Out (HC-0125) — the employee's own clock; phone-only path. */
  | { t: "punch" }
  | { t: "racks" }
  /* 申请付款 (owner 2026-09-30) — a PIC asks Finance to pay a bill, photo and all. */
  | { t: "payment-requests" }
  | { t: "product-requests" }
  | { t: "service"; startNew?: boolean }
  | { t: "delivery-planning"; completedDoNumber?: string | null }
  | { t: "delivery-planning-driver"; completedDoNumber: string | null }
  | { t: "overview"; kind: "logistic" | "procurement" }
  | { t: "pms"; projectId?: number }
  | { t: "pms-defects" }
  | { t: "mail" }
  | { t: "roles" }
  | { t: "titles" }
  | { t: "announcements" }
  | { t: "inbox" }
  | { t: "it-support" }
  | { t: "meetings" }
  | { t: "locked"; label: string }
  | { t: "desktop-only"; path: string }
  | { t: "not-found"; path: string }
  | { t: "stub"; title: string };

type DestinationTarget = Screen | { t: "orders-tab" };

export function destinationScreen(to: string, label: string): DestinationTarget {
  const path = (to || "").split("?")[0];
  if (path === "/scm/sales-orders") return { t: "orders-tab" };
  if (path === "/scm/sales-orders/maintenance") return { t: "so-maintenance" };
  if (path === "/reports/fair-report") return { t: "fair-report" };
  if (path === "/autocount-sync") return { t: "autocount-sync" };
  if (path === "/venture-portal-feed") return { t: "venture-portal-feed" };
  if (path === "/change-log") return { t: "change-log" };
  if (path === "/scm/amendments") return { t: "amendments" };
  if (path === "/scm/po-amendments") return { t: "po-amendments" };
  if (path === "/assr") return { t: "service" };
  if (path === "/projects") {
    const view = new URLSearchParams((to.split("?")[1] || "")).get("view");
    return view === "defects" ? { t: "pms-defects" } : { t: "pms" };
  }
  if (path === "/mail-center") return { t: "mail" };
  if (path === "/announcements") return { t: "announcements" };
  if (path === "/it-support") return { t: "it-support" };
  if (path === "/meetings") return { t: "meetings" };
  if (path === "/activity-inbox") return { t: "inbox" };
  if (path === "/roles") return { t: "roles" };
  if (path === "/titles") return { t: "titles" };
  if (path === "/scm/delivery-planning") return { t: "delivery-planning" };
  if (path === "/scm/delivery-planning-driver") return { t: "delivery-planning-driver", completedDoNumber: null };
  if (path === "/scm/logistic-overview") return { t: "overview", kind: "logistic" };
  if (path === "/scm/procurement-overview") return { t: "overview", kind: "procurement" };
  if (path === "/scm/warehouses/racks") return { t: "racks" };
  if (path === "/scm/payment-requests") return { t: "payment-requests" };
  if (path === "/scm/product-requests") return { t: "product-requests" };
  if (path === "/fleet-health") return { t: "mileage-capture" };
  if (path === "/hr/punch") return { t: "punch" };
  if (path === "/team") {
    const tab = new URLSearchParams((to.split("?")[1] || "")).get("tab");
    const teamKey =
      tab === "directory" || tab === "members"
        ? "members"
        : tab === "departments2" || tab === "departments"
          ? "departments"
          : null;
    if (teamKey && MODULE_CONFIGS[teamKey]) return { t: "module", key: teamKey, title: label };
    return { t: "stub", title: label };
  }
  const key = ROUTE_TO_CONFIG[path];
  if (key && MODULE_CONFIGS[key]) return { t: "module", key, title: label };
  return { t: "stub", title: label };
}

function initialScreenFor(route: MobileRoute): Screen {
  switch (route.t) {
    case "home":
    case "tab":
      return { t: "tab" };
    case "so-detail":
      return { t: "so-detail", docNo: route.docNo };
    case "locked":
      return { t: "locked", label: route.label };
    case "desktop-only":
      return { t: "desktop-only", path: route.path };
    case "not-found":
      return { t: "not-found", path: route.path };
    case "menu": {
      const target = destinationScreen(route.to, route.label);
      return target.t === "orders-tab" ? { t: "tab" } : target;
    }
  }
}

const MODULE_TO_CONVERT: Record<string, ConvertTarget> = {
  "delivery-orders-mfg": "do",
  "sales-invoices": "si",
};

const ROUTE_TO_CONFIG: Record<string, string> = {
  "/scm/sales-invoices": "sales-invoices",
  "/scm/delivery-orders": "delivery-orders-mfg",
  "/scm/delivery-returns": "delivery-returns",
  "/scm/mrp": "mrp",
  "/scm/purchase-orders": "mfg-purchase-orders",
  "/scm/grns": "grns",
  "/scm/purchase-invoices": "purchase-invoices",
  "/scm/purchase-returns": "purchase-returns",
  "/scm/products": "products",
  "/scm/suppliers": "suppliers",
  "/scm/fleet": "fleet",
  "/scm/drivers": "drivers",
  "/scm/warehouses": "warehouse",
  "/scm/inventory": "inventory",
  "/scm/stock-transfers": "stock-transfers",
  "/scm/stock-takes": "stock-takes",
  "/scm/helpers": "helpers",
  "/scm/delivery-planning-regions": "delivery-planning-regions",
  "/scm/consignment-orders": "consignment-orders",
  "/scm/consignment-notes": "consignment-notes",
  "/scm/consignment-returns": "consignment-returns",
  "/scm/purchase-consignment-orders": "purchase-consignment-orders",
  "/scm/purchase-consignment-receives": "purchase-consignment-receives",
  "/scm/purchase-consignment-returns": "purchase-consignment-returns",
  "/scm/accounting": "accounting",
};

const CONFIG_TO_ROUTE: Record<string, string> = Object.fromEntries(
  Object.entries(ROUTE_TO_CONFIG).map(([path, key]) => [key, path]),
);

/** The mobile Menu mirrors the owner's design prototype `var MENU`
 *  (Houzs Mobile.html) — same groups, order, and labels, EXCEPT the
 *  Organisation group, which the owner moved into the Profile screen
 *  (2026-07 "这全部在 profile 里面" — see PROFILE_ORG_ITEMS below). Each item
 *  opens a real mobile screen and is still permission-gated by the matching
 *  desktop nav entry (an item whose nav tab isn't visible for the user's
 *  position is hidden). The bottom tabs cover Sales Orders / Calendar /
 *  Inbox / Profile.
 *
 *  `gateVia` — gate this row on ANOTHER path's nav entry. Needed when a mobile
 *  screen outlives its desktop route: `allowed()` now fails CLOSED for a path with
 *  no NAV_TABS match, so a row pointing at a retired desktop path would go from
 *  gated to HIDDEN for everyone (its cohort included). Point it at a live entry
 *  carrying the same gate so the right positions keep the row.
 *
 *  EVERY row must state its gate in ONE of four ways — `mobileMenuGates.test.ts`
 *  fails CI for a row that states none, so a row can neither ship as a public page
 *  (the old fail-open) nor silently vanish for its cohort (the new fail-closed):
 *    1. a live NAV_TABS entry at `to` (the normal case — the desktop nav's own
 *       anyPerm/anyAccess becomes this row's gate),
 *    2. `gateVia` pointing at a live NAV_TABS entry carrying the same gate (for a
 *       mobile-only or retired-on-desktop path),
 *    3. `capability` — a SERVER-DECIDED answer from /auth/me (auth/capabilities),
 *       which bypasses `allowed()` entirely. This is the preferred gate for a
 *       destination with no NAV_TABS entry: it is the same boolean the backend
 *       gate resolved, so the row and the endpoint cannot disagree. It replaced
 *       `directorOnly`, which asked the FRONTEND to re-derive isDirectorUser and
 *       got a cohort the API did not use (see the SO Maintenance row below),
 *    4. `alwaysShow` + membership in that test's UNGATED_BY_DESIGN list, which
 *       is where a deliberately ungated row must be justified in writing. */
export type MobileMenuItem = {
  to: string;
  label: string;
  alwaysShow?: boolean;
  capability?: CapabilityKey;
  gateVia?: string;
};

export const MOBILE_MENU_GROUPS: { group: string; items: MobileMenuItem[] }[] = [
  /* Punch In / Out (HC-0125): every account may open it; the server answers
     only for the employee linked to that account and says so when none is. */
  { group: "Attendance", items: [
    { to: "/hr/punch", label: "Punch In / Out", alwaysShow: true },
  ]},
  { group: "Sales & Finance", items: [
    { to: "/scm/sales-orders", label: "Sales Orders" },
    { to: "/scm/amendments", label: "Sales Order Amendment" },
    /* SO Maintenance — gated on the BACKEND's own answer, `scm.maintenance.open`.
       This row said `directorOnly` (auth/salesAccess.isDirectorUser = {`*`,
       Super Admin, Sales Director, Finance Manager}) and so did the desktop
       button and route. That is not the cohort the API serves: every write on
       the page passes houzs-perms.canWriteScmConfig, which admits
       Procurement/Purchasing, Operation Manager, Operation Executive and
       Logistic Admin — the positions the owner ruled on 2026-07-18 must be able
       to DO the master-data writes they can see. All four were bounced at the
       door on both surfaces while the API would have accepted their edits.
       The capability is the union of the write tier and the director read tier,
       resolved server-side once, so phone and desktop now ask one question and
       get one answer. Still OFF, not hidden: a caller without it never gets the
       row and never mounts the screen. */
    { to: "/scm/sales-orders/maintenance", label: "SO Maintenance", capability: "scm.maintenance.open" },
    { to: "/scm/delivery-orders", label: "Delivery Orders" },
    { to: "/scm/sales-invoices", label: "Sales Invoices" },
    { to: "/scm/delivery-returns", label: "Delivery Returns" },
    { to: "/scm/accounting", label: "Chart of Accounts" },
    /* Sales Report — moved from the Projects PMS group into the Finance
       cluster (owner 2026-07-22, to match the desktop Sidebar move). Same
       gate as before: `allowed("/reports/fair-report")` resolves to the
       fair-report cohort (management + Sales Director), so an ordinary
       salesperson never gets this row. Routes to the MOBILE screen
       (MobileFairReport), NOT the desktop table. */
    { to: "/reports/fair-report", label: "Sales Report" },
    /* 申请付款 (owner 2026-09-30): the PIC at a fair asks Finance to pay the
       organiser, photo of the bill and all. Gated by its own NAV_TABS entries —
       the requester's key (Workspace) or Finance's voucher key (Money out). */
    { to: "/scm/payment-requests", label: "Payment Requests" },
    /* Product request (owner 2026-10-06): a salesperson asks for a new product
       or a repack; the Purchaser approves. Gated by its NAV_TABS entries — the
       rep leaf, or the office leaf's keys (Consignment). */
    { to: "/scm/product-requests", label: "Product Requests" },
  ]},
  { group: "Projects · PMS", items: [
    { to: "/projects", label: "Projects" },
    { to: "/projects?view=defects", label: "Defect List" },
  ]},
  { group: "After-sales", items: [
    { to: "/assr", label: "Service Case" },
  ]},
  { group: "Procurement & MRP", items: [
    { to: "/scm/procurement-overview", label: "Procurement Overview" },
    { to: "/scm/mrp", label: "MRP · Stock Status" },
    { to: "/scm/purchase-orders", label: "Purchase Orders" },
    { to: "/scm/po-amendments", label: "PO Amendments" },
    { to: "/scm/grns", label: "Goods Receipt" },
    { to: "/scm/purchase-invoices", label: "Purchase Invoices" },
    { to: "/scm/purchase-returns", label: "Purchase Returns" },
    { to: "/scm/products", label: "Products & Maintenance" },
    { to: "/scm/suppliers", label: "Suppliers" },
  ]},
  { group: "Consignment", items: [
    { to: "/scm/consignment-orders", label: "Consignment Orders" },
    { to: "/scm/consignment-notes", label: "Consignment Notes" },
    { to: "/scm/consignment-returns", label: "Consignment Returns" },
    { to: "/scm/purchase-consignment-orders", label: "Purchase Consignment Orders" },
    { to: "/scm/purchase-consignment-receives", label: "Purchase Consignment Receives" },
    { to: "/scm/purchase-consignment-returns", label: "Purchase Consignment Returns" },
  ]},
  { group: "Logistics", items: [
    { to: "/scm/logistic-overview", label: "Logistic Overview" },
    { to: "/scm/delivery-planning", label: "Last Mile Delivery" },
    /* Gates on its OWN nav entry (scm.transportation.last_mile), like the desktop
       row. Borrowing /scm/delivery-planning hid it from the Driver role, which has
       last_mile but not planning (owner 2026-10-26). */
    { to: "/scm/delivery-planning-driver", label: "Last Mile Delivery (Driver)" },
    { to: "/scm/fleet", label: "Fleet", gateVia: "/scm/delivery-maintenance" },
    /* KEPT, unlike the retired DESKTOP /scm/drivers page — mobile is NOT the
       same shape and the owner's "fleet 里面也是有 driver" is not true here.
       Mobile's "fleet" module is LORRIES ONLY (MODULE_CONFIGS.fleet — title
       "Lorries", endpoint /lorries); it does not merge drivers/helpers the way
       the desktop Fleet page does. So this row is the only driver surface on a
       phone, not a duplicate, and retiring it would delete the capability
       instead of consolidating it. See the report to the owner: the mobile
       "Fleet" LABEL is the thing that is wrong here, and renaming it is a
       prototype/design call, not this PR's.

       `gateVia` because the desktop /scm/drivers NAV_TABS entry — which used to
       supply this row's permission — is gone with that page, and `allowed()`
       now fails CLOSED for a path with no nav match ("matches.length === 0 ?
       false"). Without this the row would silently VANISH for the drivers cohort
       too. /scm/delivery-maintenance carries the byte-identical gate the
       /scm/drivers entry had (anyPerm ["*","scm.access"] + anyAccess
       ["scm.transportation.drivers"] + hideForSalesRep), so this preserves
       today's behaviour exactly. It replaced /scm/fleet here on 2026-08-01 when
       the six Transportation reference rows collapsed into that one nav entry —
       the gate is the same pair, only the surviving path changed. */
    { to: "/scm/drivers", label: "Drivers", gateVia: "/scm/delivery-maintenance" },
    { to: "/scm/helpers", label: "Helpers", gateVia: "/scm/delivery-maintenance" },
    { to: "/scm/delivery-planning-regions", label: "Regions", gateVia: "/scm/delivery-maintenance" },
    { to: "/fleet-health", label: "Fleet Mileage" },
  ]},
  { group: "Warehouse", items: [
    { to: "/scm/warehouses", label: "Warehouse" },
    { to: "/scm/warehouses/racks", label: "Racks" },
    { to: "/scm/inventory", label: "Inventory" },
    { to: "/scm/stock-transfers", label: "Stock Transfers" },
    { to: "/scm/stock-takes", label: "Stock Take" },
  ]},
  { group: "System", items: [
    { to: "/autocount-sync", label: "AutoCount Sync" },
    { to: "/venture-portal-feed", label: "Venture Portal Feed" },
    { to: "/change-log", label: "Change Log" },
  ]},
];

/** Organisation destinations — owner 2026-07: these do NOT live in the module
 *  menu ("这全部在 profile 里面") — they are rows inside the Profile screen.
 *  Same routes and the SAME per-item permission gate (`allowed`) the menu
 *  applied when they lived there; an item hidden from the old menu stays
 *  hidden in Profile. */
export const PROFILE_ORG_ITEMS: MobileMenuItem[] = [
  { to: "/activity-inbox", label: "Inbox", alwaysShow: true },
  { to: "/mail-center", label: "Mail Center" },
  { to: "/announcements", label: "Announcements", alwaysShow: true },
  { to: "/it-support", label: "IT Support" },
  { to: "/meetings", label: "Meetings" },
  { to: "/team?tab=directory", label: "Directory" },
  { to: "/team?tab=departments2", label: "Departments" },
  { to: "/roles", label: "Roles", gateVia: "/team?tab=hub" },
  { to: "/titles", label: "Titles", gateVia: "/team?tab=hub" },
];

function MobileDialogBridge() {
  const notify = useNotify();
  const confirm = useConfirm();
  useEffect(() => {
    registerDialogService({ confirm, notify });
  }, [confirm, notify]);
  return null;
}

function MobileScreenFallback() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--app-bg)",
      }}
    >
      <div
        className="animate-pulse"
        style={{ width: 120, height: 12, borderRadius: 6, background: "var(--border, #d8d5c8)" }}
      />
    </div>
  );
}

export function MobileApp() {
  useApplyHtmlLang();
  return (
    <NotifyProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ChoiceProvider>
            <MobileDialogBridge />
            <VpBrandPromptBridge />
            <IosInstallGuide />
            <AndroidInstallGuide />
            <MobileAppInner />
          </ChoiceProvider>
        </PromptProvider>
      </ConfirmProvider>
    </NotifyProvider>
  );
}

function MobileAppInner() {
  const navigate = useNavigate();
  const { user, can, pageAccess, logout } = useAuth();
  const notify = useNotify();
  const qc = useQueryClient();
  useEffect(() => { void import("../vendor/scm/lib/product-categories-store").then((m) => m.ensureProductCategories()).catch((e: unknown) => console.warn("product categories not loaded; labels read the code", e)); }, []);
  const annUnread = useAnnouncementUnread();
  const itConnected = useItSupportConnected();
  const profileUnread = annUnread + useItSupportUnread();

  const navVisible = makeNavVisible({ user, can, pageAccess });
  const flatNav: NavTab[] = [];
  const walkNav = (t: NavTab) => { flatNav.push(t); (t.children ?? []).forEach(walkNav); };
  NAV_TABS.forEach(walkNav);
  const allowed = (to: string): boolean => {
    const matches = flatNav.filter((t) => t.to != null && mobileDestinationMatches(to, t.to));
    return matches.length === 0 ? false : matches.some(navVisible);
  };

  const canOrders = allowed("/scm/sales-orders");
  const canService = allowed("/assr");
  const canCalendar = pageAccess("projects.calendar") !== "none";
  const firstTab: Tab = canOrders ? "orders" : canService ? "service" : canCalendar ? "calendar" : "profile";

  const menuGroups = MOBILE_MENU_GROUPS
    .map((g) => ({ group: g.group, items: g.items.filter((it) => (it.capability ? capability(user, it.capability) : (it.alwaysShow || allowed(it.gateVia ?? it.to)))) }))
    .filter((g) => g.items.length > 0);

  const profileOrgItems = PROFILE_ORG_ITEMS.filter((it) =>
    it.capability ? capability(user, it.capability) : (it.alwaysShow || allowed(it.gateVia ?? it.to)),
  );

  const visibleDestinations = [...menuGroups.flatMap((g) => g.items), ...profileOrgItems];
  const allKnownDestinations = [...MOBILE_MENU_GROUPS.flatMap((g) => g.items), ...PROFILE_ORG_ITEMS];

  const initialRoute = resolveMobileRoute(
    typeof window === "undefined"
      ? "/"
      : `${window.location.pathname}${window.location.search}${window.location.hash}`,
    visibleDestinations,
    allKnownDestinations,
  );

  const [tab, setTab] = useState<Tab>(initialRoute.t === "tab" ? initialRoute.tab : firstTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>(() => initialScreenFor(initialRoute));
  const screenKey = JSON.stringify(screen);
  const back = () => setScreen({ t: "tab" });
  const leaveUrlDeadEnd = () => {
    navigate("/", { replace: true });
    setScreen({ t: "tab" });
  };

  const flowNav: FlowNav = {
    can: (nav: FlowDocNav) => {
      if (nav.kind === "so") return canOrders;
      const path = CONFIG_TO_ROUTE[nav.moduleKey];
      return !!path && !!MODULE_CONFIGS[nav.moduleKey] && allowed(path);
    },
    open: (nav: FlowDocNav) => {
      if (nav.kind === "so") { setScreen({ t: "so-detail", docNo: nav.docNo }); return; }
      const cfg = MODULE_CONFIGS[nav.moduleKey];
      if (!cfg) return;
      setScreen({ t: "module-detail", key: nav.moduleKey, row: { id: nav.id }, title: cfg.title ?? nav.moduleKey });
    },
  };

  const [calJump, setCalJump] = useState<{ year: number; month: number; projectId: number; nonce: number } | null>(null);

  const onSearchNavigate = (nav: SearchNav) => {
    switch (nav.kind) {
      case "sales_order":
        return setScreen({ t: "so-detail", docNo: nav.docNo });
      case "project": {
        const iso = (nav.date ?? "").slice(0, 10);
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
        if (m) {
          setCalJump({ year: Number(m[1]), month: Number(m[2]) - 1, projectId: nav.projectId, nonce: Date.now() });
          setTab("calendar");
          return setScreen({ t: "tab" });
        }
        return setScreen({ t: "pms", projectId: nav.projectId });
      }
      case "assr_case":
        return setScreen({ t: "service" });
      case "product":
        return MODULE_CONFIGS["products"]
          ? setScreen({ t: "module", key: "products", title: "Products & Maintenance" })
          : setScreen({ t: "tab" });
      case "user":
        return MODULE_CONFIGS["members"]
          ? setScreen({ t: "module", key: "members", title: "Members" })
          : setScreen({ t: "tab" });
    }
  };

  /* Scan → background DRAFT: MobileScan has FIRED the enqueue(s)/create(s).
     The operator now STAYS on the Scan screen (owner 2026-07-04) watching the
     Recent-scans pills progress — navigation was split OUT of this handler; he
     leaves via Cancel/back whenever. This handler only nudges the Orders-list
     query (so the drafts surface when he does go back) and toasts. */
  const onScanDrafted = (count: number) => {
    const bumpSoLists = () => {
      void qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
      invalidateSoShared(qc);
    };
    bumpSoLists();
    window.setTimeout(bumpSoLists, 2500);
    window.setTimeout(bumpSoLists, 45_000);
    window.setTimeout(bumpSoLists, 120_000);
    void notify({
      title: count > 1 ? `${count} orders uploaded` : "Order uploaded",
      body: count > 1
        ? "They're being read in the background — watch their progress under Recent scans, or close the app. Each one appears in Orders as a draft when it finishes."
        : "It's being read in the background — watch its progress under Recent scans, or close the app. It appears in Orders as a draft when it finishes.",
    });
  };

  const openRoute = (to: string, label: string) => {
    setMenuOpen(false);
    const target = destinationScreen(to, label);
    if (target.t === "orders-tab") { setTab("orders"); setScreen({ t: "tab" }); return; }
    setScreen(target);
  };

  const annPopup = screen.t === "announcements" || annUnread === 0 ? null : (
    <MobileCrashBoundary resetKey={`ann:${screenKey}`} fallback={null}>
      <MobileAnnouncementPopup onOpenList={() => setScreen({ t: "announcements" })} />
    </MobileCrashBoundary>
  );

  const raiseExchangePo = mayCreatePurchaseDoc("po", can, pageAccess)
    ? () => setScreen({ t: "purchase-doc-new", key: "mfg-purchase-orders", title: "Purchase Orders", kind: "po" })
    : undefined;

  let overlay: ReactNode = null;
  if (screen.t === "search") overlay = <MobileSearch onBack={back} onNavigate={onSearchNavigate} />;
  else if (screen.t === "so-detail") overlay = <MobileSODetail docNo={screen.docNo} onBack={back} onEdit={(d) => setScreen({ t: "new-so", mode: "edit", docNo: d })} onAddLine={(d) => setScreen({ t: "new-so", mode: "edit", docNo: d, addLine: true })} flowNav={flowNav} onConvert={(convertFrom) => setScreen({ t: "new-so", mode: "new", convertFrom })} />;
  else if (screen.t === "amendments") overlay = <MobileAmendments onBack={back} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} />;
  else if (screen.t === "po-amendments") overlay = <MobilePoAmendments onBack={back} onOpen={(id) => setScreen({ t: "po-amendment-detail", id })} onOpenSo={(doc) => setScreen({ t: "so-detail", docNo: doc })} />;
  else if (screen.t === "po-amendment-detail") overlay = <MobilePoAmendmentDetail amendmentId={screen.id} onBack={() => setScreen({ t: "po-amendments" })} />;
  else if (screen.t === "so-maintenance") {
    overlay = !capability(user, "scm.maintenance.open") ? (
      <TabLocked title="SO Maintenance" />
    ) : (
      <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
        <header style={{ background: "var(--hz-c-surface)", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
          <button onClick={back} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--teal)", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>‹ Back</button>
          <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>SO Maintenance</div>
        </header>
        <div style={{ flex: 1, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
          <Scm2990Shell><ScmSalesOrderMaintenance /></Scm2990Shell>
        </div>
      </div>
    );
  }
  else if (screen.t === "fair-report") {
    overlay = !canViewFairReport(user) ? <TabLocked title="Sales Report" /> : <MobileFairReport onBack={back} />;
  }
  else if (screen.t === "change-log") {
    const maySee = can("*") || can("scm.changelog.read") || can("settings.manage");
    overlay = !maySee ? <TabLocked title="Change Log" /> : <MobileChangeLog onBack={back} />;
  }
  else if (screen.t === "autocount-sync") {
    const mayRead = can("*") || can("scm.autocount.read") || can("settings.manage");
    overlay = !mayRead ? <TabLocked title="AutoCount Sync" /> : <MobileAutoCountSync onBack={back} />;
  }
  else if (screen.t === "venture-portal-feed") {
    const mayRead = can("*") || can("scm.venture_portal.read") || can("settings.manage");
    overlay = !mayRead ? <TabLocked title="Venture Portal Feed" /> : <MobileVenturePortalFeed onBack={back} />;
  }
  else if (screen.t === "new-so") overlay = <MobileNewSO mode={screen.mode} docNo={screen.docNo} scanPrefill={screen.scanPrefill} convertFrom={screen.convertFrom} openAddLine={screen.addLine === true} onBack={back} onSaved={(d) => setScreen({ t: "so-detail", docNo: d })} />;
  else if (screen.t === "scan") overlay = <MobileScan onBack={back} onDrafted={onScanDrafted} onOpenSo={(docNo) => setScreen({ t: "so-detail", docNo })} />;
  else if (screen.t === "scan-pi") overlay = <MobileScanInvoice onBack={back} onOpenPi={() => setScreen({ t: "module", key: "purchase-invoices", title: "Purchase Invoices" })} />;
  else if (screen.t === "grn-scan") overlay = <MobileGrnScan onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })} onOpenGrn={(id) => setScreen({ t: "module-detail", key: screen.key, row: { id }, title: screen.title })} />;
  else if (screen.t === "module") {
    const k = screen.key;
    const convertTarget = MODULE_TO_CONVERT[k];
    /* Owner 2026-07-17: Office operates DO and SI, Sales only looks — and
       2026-07-18 on parity, "電話電腦的權限應該一樣的". Mobile used to hand every
       user who could SEE the Delivery Orders / Sales Invoices list a "+" that
       opened the convert wizard, because MobileModuleList renders the button on
       `onNew` alone and MobileConvertWizard imports no auth at all. Withholding
       `onNew` is what makes the control ABSENT (off, not hide), and it resolves
       through the SAME helper the desktop uses — one decision, both platforms. */
    const mayConvert =
      convertTarget === "do"
        ? canOperateDeliveryOrders(user, can, pageAccess)
        : convertTarget === "si"
          ? canOperateSalesInvoices(user, can, pageAccess)
          : convertTarget === "grn"
            ? canOperateGoodsReceipts(can, pageAccess)
            : convertTarget === "po"
              ? canOperatePurchaseOrders(can, pageAccess)
              : true;
    const purchaseKind = MODULE_TO_PURCHASE_DOC[k] as PurchaseDocKind | undefined;
    const onNew = purchaseKind
      ? mayCreatePurchaseDoc(purchaseKind, can, pageAccess)
        ? () => setScreen({ t: "purchase-doc-new", key: k, title: screen.title, kind: purchaseKind })
        : undefined
      : convertTarget
      ? mayConvert
        ? () => setScreen({ t: "convert", key: k, title: screen.title, target: convertTarget })
        : undefined
      : MODULE_CONFIGS[k]?.form
        ? () => setScreen({ t: "module-form", key: k, mode: "new" })
        : undefined;
    const grnScanEntry = k === "grns" && canOperateGoodsReceipts(can, pageAccess) ? (
      <button
        onClick={() => setScreen({ t: "grn-scan", key: k, title: screen.title })}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", justifyContent: "center", height: 44, borderRadius: 12, border: "1px solid var(--hz-c-primary)", background: "var(--hz-c-surface)", color: "var(--hz-c-primary)", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer", marginBottom: 12 }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16695f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18" /></svg>
        Scan delivery order
      </button>
    ) : undefined;
    const canScanPi = purchaseKind === "pi" && mayCreatePurchaseDoc("pi", can, pageAccess);
    const aboveList = k === "members"
      ? <MobileInvitations />
      : k === "delivery-orders-mfg"
        ? <MobilePackingLists />
      : canScanPi
        ? <ScanInvoiceLauncher onClick={() => setScreen({ t: "scan-pi" })} />
        : grnScanEntry;
    overlay = <MobileModuleList config={MODULE_CONFIGS[k]} onBack={back}
      onOpen={(row) => setScreen({ t: "module-detail", key: k, row, title: screen.title })}
      onNew={onNew}
      aboveList={aboveList} />;
  }
  else if (screen.t === "purchase-doc-new") {
    const backToList = () => setScreen({ t: "module", key: screen.key, title: screen.title });
    const alt = convertInsteadFor(screen.kind);
    const { key, title } = screen;
    overlay = <MobilePurchaseDocNew
      kind={screen.kind}
      onBack={backToList}
      onCreated={(created) => (screen.kind === "grn" && created.id
        ? setScreen({ t: "module-detail", key, row: { id: created.id }, title })
        : backToList())}
      onConvertInstead={alt ? { label: alt.label, open: () => setScreen({ t: "convert", key, title, target: alt.target }) } : null} />;
  }
  else if (screen.t === "convert") {
    const fromSo = screen.target === "do" && !!screen.initialSourceId;
    const backToConvertHome = fromSo
      ? () => setScreen({ t: "so-detail", docNo: screen.initialSourceId! })
      : () => setScreen({ t: "module", key: screen.key, title: screen.title });
    const { key: convertKey, title: convertTitle } = screen;
    const onConverted = (_docNo: string, docId?: string) => (screen.target === "grn" && docId
      ? setScreen({ t: "module-detail", key: convertKey, row: { id: docId }, title: convertTitle })
      : backToConvertHome());
    overlay = <MobileConvertWizard target={screen.target} initialSourceId={screen.initialSourceId} onBack={backToConvertHome} onCreated={onConverted} />;
  }
  else if (screen.t === "module-detail" && screen.key === "inventory") {
    overlay = <MobileStockCard
      itemCode={screen.row?.item_code ?? ""}
      productName={screen.row?.product_name ?? null}
      canTransfer={allowed("/scm/stock-transfers")}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onNewTransfer={() => setScreen({ t: "stock-transfer-new", key: screen.key, row: screen.row, title: screen.title })} />;
  }
  else if (screen.t === "racks") overlay = <MobileRacks onBack={back} />;
  else if (screen.t === "payment-requests") overlay = <MobilePaymentRequests onBack={back} />;
  else if (screen.t === "product-requests") overlay = <MobileProductRequests onBack={back} />;
  else if (screen.t === "stock-transfer-new") {
    const backToCard = () => setScreen({ t: "module-detail", key: screen.key, row: screen.row, title: screen.title });
    overlay = <MobileStockTransferNew onBack={backToCard} onCreated={backToCard} />;
  }
  else if (screen.t === "module-detail") {
    const doNo = screen.key === "delivery-orders-mfg" ? (screen.row?.do_number ?? screen.row?.doNumber) : null;
    const canPod =
      !!doNo &&
      (canOperateDeliveryOrders(user, can, pageAccess) || canDriverCompleteDelivery(user));
    overlay = <MobileModuleDetail moduleKey={screen.key} row={screen.row} title={screen.title}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onEdit={screen.key !== "delivery-orders-mfg"
        ? (fresh?: Record<string, unknown>) => setScreen({ t: "module-form", key: screen.key, mode: "edit", row: fresh ?? screen.row })
        : canOperateDeliveryOrders(user, can, pageAccess) && screen.row?.id
          ? () => setScreen({ t: "do-edit", key: screen.key, row: screen.row, title: screen.title })
          : undefined}
      onPOD={canPod ? () => setScreen({ t: "pod", docNo: String(doNo) }) : undefined}
      flowNav={flowNav} />;
  }
  else if (screen.t === "module-form") {
    const cfg = MODULE_CONFIGS[screen.key];
    /* A scoped Sales Director's member saves ignore fields: the invite stores the
       baseline role (docs/bugs/0887), the edit strips role, department, position
       and email (docs/bugs/0924-a-sales-director-s-phone-edit-of-a-member-s-role-department.md).
       Each form shows only what its save applies. */
    const baseForm = cfg?.form;
    const scopedSalesDirector = isSalesDirectorUser(user) && !can("users.manage");
    const schema = screen.mode === "edit" && screen.key === "members"
      ? memberEditFormFor(FORM_MEMBERS_EDIT, scopedSalesDirector)
      : screen.key === "members" && baseForm
        ? memberInviteFormFor(baseForm, scopedSalesDirector)
        : screen.key === "suppliers" && baseForm
          /* Owner 2026-09-30: the Finance part and (on edit) the code are Finance's. */
          ? supplierFormFor(baseForm, capability(user, "scm.money.move"), screen.mode)
          : baseForm;
    const title = cfg?.title ?? screen.key;
    overlay = !schema ? <Stub title={title} onBack={back} /> : (
      <MobileModuleForm schema={schema} mode={screen.mode} initial={screen.mode === "edit" ? screen.row : undefined}
        onBack={() => setScreen(screen.mode === "edit" && screen.row ? { t: "module-detail", key: screen.key, row: screen.row, title } : { t: "module", key: screen.key, title })}
        onSaved={() => setScreen({ t: "module", key: screen.key, title })} />
    );
  }
  else if (screen.t === "do-edit") {
    const backToDoc = () => setScreen({ t: "module-detail", key: screen.key, row: screen.row, title: screen.title });
    overlay = <MobileDoHeaderEdit id={String(screen.row.id)} onBack={backToDoc} onSaved={backToDoc} />;
  }
  else if (screen.t === "pod") {
    const fromDriver = screen.from === "delivery-planning-driver";
    const fromSheet = fromDriver || screen.from === "delivery-planning";
    const toSheet = (completedDoNumber: string | null) =>
      setScreen(fromDriver
        ? { t: "delivery-planning-driver", completedDoNumber }
        : { t: "delivery-planning", completedDoNumber });
    const leavePod = fromSheet ? () => toSheet(null) : back;
    const donePod = fromSheet ? () => toSheet(screen.docNo) : back;
    overlay = <MobilePOD docNo={screen.docNo} companyCode={screen.companyCode ?? null} onBack={leavePod} onDone={donePod} />;
  }
  else if (screen.t === "mileage-capture") overlay = <MobileMileageCapture onBack={back} />;
  else if (screen.t === "punch") overlay = <MobilePunch onBack={back} />;
  else if (screen.t === "overview") overlay = <MobileOverview kind={screen.kind} onBack={back} />;
  else if (screen.t === "service") overlay = <MobileServiceCase onBack={back} startNew={screen.startNew} onRaiseExchangePo={raiseExchangePo} />;
  else if (screen.t === "delivery-planning") overlay = <MobileDeliveryPlanning onBack={back} completedDoNumber={screen.completedDoNumber ?? null} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} onPod={(doNumber, companyCode) => setScreen({ t: "pod", docNo: doNumber, companyCode, from: "delivery-planning" })} />;
  else if (screen.t === "delivery-planning-driver") overlay = <MobileDeliveryPlanning onBack={back} completedDoNumber={screen.completedDoNumber} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} onPod={(doNumber, companyCode) => setScreen({ t: "pod", docNo: doNumber, companyCode, from: "delivery-planning-driver" })} />;
  else if (screen.t === "pms") overlay = (
    <MobilePMS
      onBack={back}
      initialProjectId={screen.projectId}
      // Owner 2026-11-09 "letak balik button tu": the project-detail + FAB
      // routes through MobileApp's setScreen the same way the Orders tab + FAB
      // does, so one create path serves both surfaces.
      onCreateSO={() => setScreen({ t: "new-so", mode: "new" })}
      onCreateCase={() => setScreen({ t: "service", startNew: true })}
    />
  );
  else if (screen.t === "pms-defects") overlay = (
    <MobilePmsDefectList
      onBack={back}
      onOpenProject={(id) => setScreen({ t: "pms", projectId: id })}
    />
  );
  else if (screen.t === "mail") overlay = <MobileMailCenter onBack={back} />;
  else if (screen.t === "roles") overlay = can("roles.read") ? <MobileRoles onBack={back} /> : <TabLocked title="Roles" />;
  else if (screen.t === "titles") overlay = can("users.read") ? <MobileTitles onBack={back} /> : <TabLocked title="Titles" />;
  else if (screen.t === "announcements") overlay = <MobileAnnouncements onBack={back} />;
  else if (screen.t === "it-support") overlay = <MobileItSupport onBack={back} />;
  else if (screen.t === "meetings") overlay = <MobileMeetings onBack={back} />;
  else if (screen.t === "inbox") overlay = <MobileInbox onBack={back} onOpen={(n) => { const doc = (n as { doc_no?: string }).doc_no; if (doc) setScreen({ t: "so-detail", docNo: doc }); }} />;
  else if (screen.t === "locked") overlay = <UrlLocked label={screen.label} onHome={leaveUrlDeadEnd} />;
  else if (screen.t === "desktop-only") overlay = <DesktopOnly path={screen.path} onHome={leaveUrlDeadEnd} />;
  else if (screen.t === "not-found") overlay = <MobileNotFound path={screen.path} onHome={leaveUrlDeadEnd} />;
  else if (screen.t === "stub") overlay = <Stub title={screen.title} onBack={back} />;
  if (overlay !== null) return (
    <>
      <MobileCrashBoundary resetKey={`overlay:${screenKey}`} fallback={<MobileScreenFallback />}>
        {overlay}
      </MobileCrashBoundary>
      {annPopup}
      <LazySlot resetKey="pending-reminder" fallback={null}><PendingTasksReminder /></LazySlot>
    </>
  );

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <MobileCrashBoundary resetKey={`tab:${tab}`} fallback={<MobileScreenFallback />}>
          {tab === "orders" && (canOrders ? (
            <MobileSalesOrders
              onScan={() => setScreen({ t: "scan" })}
              onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })}
              onNew={() => setScreen({ t: "new-so", mode: "new" })}
              onNewCase={() => setScreen({ t: "service", startNew: true })}
            />
          ) : <TabLocked title="Sales Orders" />)}
          {tab === "service" && (canService
            ? <MobileServiceCase onBack={() => setTab(firstTab)} onRaiseExchangePo={raiseExchangePo} />
            : <TabLocked title="Service Cases" />)}
          {tab === "calendar" && (canCalendar ? (
            <MobileCalendar
              onOpenProject={(id) => setScreen({ t: "pms", projectId: id })}
              onOpenSearch={() => setScreen({ t: "search" })}
              key={calJump ? `caljump-${calJump.nonce}` : "cal"}
              initialYear={calJump?.year}
              initialMonth={calJump?.month}
              focusProjectId={calJump?.projectId}
            />
          ) : <TabLocked title="Calendar" />)}
          {tab === "profile" && <MobileProfile onLogout={logout} orgItems={withoutUnconnectedItSupport(profileOrgItems, itConnected)} onOpenOrg={openRoute} />}
        </MobileCrashBoundary>
      </div>

      <div className="navwrap">
        <nav className="tabbar">
          <button className={`tab${tab === "orders" ? " on" : ""}`} onClick={() => setTab("orders")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v14H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v4h4" /><path d="M9.5 12.5h5M9.5 16h3" /></svg>
            <span className="tl">Orders</span>
          </button>
          <button className={`tab${tab === "service" ? " on" : ""}`} onClick={() => setTab("service")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15.3 7.3a3.8 3.8 0 0 1-4.9 4.9l-5.1 5.1a1.8 1.8 0 0 1-2.6-2.6l5.1-5.1a3.8 3.8 0 0 1 4.9-4.9l-2.3 2.3a1 1 0 0 0 0 1.4l1.2 1.2a1 1 0 0 0 1.4 0Z" /></svg>
            <span className="tl">Service</span>
          </button>
          <div className="tab-center">
            <button className="disc" onClick={() => setMenuOpen((s) => !s)} aria-label="Menu">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></svg>
            </button>
          </div>
          <button className={`tab${tab === "calendar" ? " on" : ""}`} onClick={() => setTab("calendar")}>
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>
            <span className="tl">Calendar</span>
          </button>
          <button
            className={`tab${tab === "profile" ? " on" : ""}`}
            onClick={() => setTab("profile")}
            aria-label={profileUnread > 0 ? `Profile, ${profileUnread} unread` : "Profile"}
          >
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.7" /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" /></svg>
            {profileUnread > 0 && (
              <span aria-hidden style={{ position: "absolute", top: 4, left: "calc(50% + 5px)", minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#c0392b", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, boxSizing: "border-box" }}>
                {profileUnread > 9 ? "9+" : profileUnread}
              </span>
            )}
            <span className="tl">Profile</span>
          </button>
        </nav>
      </div>

      {menuOpen && (
        <div className="sheet-bd" onClick={(e) => { if (e.target === e.currentTarget) setMenuOpen(false); }}>
          <div className="sheet">
            <div className="grab" />
            <div className="sheet-head">
              <div>
                <div className="ey" style={{ color: "var(--hz-c-accent)" }}>Menu</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "var(--hz-c-ink)", marginTop: 2 }}>Where to next?</div>
              </div>
              <button className="sheet-x" onClick={() => setMenuOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="sheet-scroll">
              {menuGroups.map(({ group, items }) => (
                <div className="mgroup" key={group}>
                  <div className="mgh"><span className="gl">{group}</span></div>
                  <div className="mgrid">
                    {items.map((it) => (
                      <button className="mcard" key={it.to} onClick={() => openRoute(it.to, it.label)}>
                        <span className="ml">{it.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {menuGroups.length === 0 && <div style={{ textAlign: "center", color: "var(--hz-c-ink-soft)", fontSize: 12, padding: "24px 0" }}>No modules available for your position.</div>}
            </div>
          </div>
        </div>
      )}

      {annPopup}
      <LazySlot resetKey="pending-reminder" fallback={null}><PendingTasksReminder /></LazySlot>
      {/* MobileAssistant intentionally NOT rendered — owner 2026-09-11:
          "那个 assistant 的功能是直接不要的". The whole surface is off on
          mobile: no launcher, no sheet, no /api/assistant calls fire. The
          backend service stays for the desktop `/assistant` page. */}
    </div>
  );
}

function TabLocked({ title }: { title: string }) {
  return (
    <div className="hz-m" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "var(--hz-c-surface)", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--hz-c-ink-soft)", fontSize: 12.5, padding: 24, textAlign: "center" }}>
        Your position doesn't have access to this section.
      </div>
    </div>
  );
}

function UrlDeadEnd({ title, body, onHome }: { title: string; body: string; onHome: () => void }) {
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "var(--hz-c-surface)", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
        <div style={{ color: "var(--hz-c-ink-soft)", fontSize: 12.5, lineHeight: 1.6, maxWidth: 300 }}>{body}</div>
        <button
          onClick={onHome}
          style={{ background: "var(--teal)", color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontFamily: "inherit", fontSize: 13, fontWeight: 700 }}
        >
          Go to the app
        </button>
      </div>
    </div>
  );
}

function UrlLocked({ label, onHome }: { label: string; onHome: () => void }) {
  return (
    <UrlDeadEnd
      title={label}
      body="Your position doesn't have access to this section."
      onHome={onHome}
    />
  );
}

function DesktopOnly({ path, onHome }: { path: string; onHome: () => void }) {
  return (
    <UrlDeadEnd
      title="Not available on mobile"
      body={`${path} hasn't been built for phones yet. Open it on a computer to use this page.`}
      onHome={onHome}
    />
  );
}

function MobileNotFound({ path, onHome }: { path: string; onHome: () => void }) {
  return (
    <UrlDeadEnd
      title="Page not found"
      body={`${path} isn't a page in Houzs ERP. Check the link or return to the app.`}
      onHome={onHome}
    />
  );
}

function Stub({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "var(--hz-c-surface)", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--teal)", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>‹ Back</button>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--hz-c-ink-soft)", fontSize: 12.5, padding: 24, textAlign: "center" }}>
        Building this screen next — it will match your design and connect to the live data.
      </div>
    </div>
  );
}

