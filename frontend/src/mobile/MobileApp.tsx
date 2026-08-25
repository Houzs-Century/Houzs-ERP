import { lazy, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { canOperateDeliveryOrders, canDriverCompleteDelivery, canOperateSalesInvoices, canOperateGoodsReceipts, canOperatePurchaseOrders, canViewFairReport } from "../auth/salesAccess";
import { capability, type CapabilityKey } from "../auth/capabilities";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { makeNavVisible } from "../components/navFilter";
import { NotifyProvider, useNotify } from "../vendor/scm/components/NotifyDialog";
import { ConfirmProvider, useConfirm } from "../vendor/scm/components/ConfirmDialog";
import { PromptProvider } from "../vendor/scm/components/PromptDialog";
import { ChoiceProvider } from "../vendor/scm/components/ChoiceDialog";
import { registerDialogService } from "../vendor/scm/lib/dialog-service";
import { invalidateSoShared } from "./sharedInvalidate";
import { useApplyHtmlLang } from "./mobileI18n";
import { useAnnouncementUnread } from "./useAnnouncementUnread";
import { MobileCrashBoundary } from "./MobileCrashBoundary";
import { IosInstallGuide } from "../components/IosInstallGuide";
import { AndroidInstallGuide } from "../components/AndroidInstallGuide";
// Heavy mobile screens are lazy-loaded so the initial mobile chunk stays small
// (desktop routes were already lazy — this closes the mobile gap that made the
// first mobile paint download/parse a ~10k-line monolith). Rendered under the
// MobileCrashBoundary slots in MobileAppInner. Types import separately so they don't
// pull a module into the eager bundle. MobileModuleList stays EAGER: its
// MODULE_CONFIGS / FORM_MEMBERS_EDIT are read synchronously by the routing +
// form logic below, so it can't be deferred without splitting those out first.
import { MobileModuleList, MODULE_CONFIGS, FORM_MEMBERS_EDIT } from "./MobileModuleList";
import { MobileInvitations } from "./MobileInvitations";
import { mobileDestinationMatches, resolveMobileRoute, type MobileRoute } from "./mobileRoute";
import type { FlowDocNav, FlowNav } from "./relationship-map-model";
import type { SearchNav } from "./MobileSearch";
import type { MobileScanPrefill } from "./MobileScan";
import type { ConvertTarget } from "./MobileConvertWizard";
const MobileSalesOrders = lazy(() => import("./MobileSalesOrders").then((m) => ({ default: m.MobileSalesOrders })));
const MobileAmendments = lazy(() => import("./MobileAmendments").then((m) => ({ default: m.MobileAmendments })));
const MobilePoAmendments = lazy(() => import("./MobilePoAmendments").then((m) => ({ default: m.MobilePoAmendments })));
const MobilePoAmendmentDetail = lazy(() => import("./MobilePoAmendmentDetail").then((m) => ({ default: m.MobilePoAmendmentDetail })));
const MobileSODetail = lazy(() => import("./MobileSODetail").then((m) => ({ default: m.MobileSODetail })));
const MobileNewSO = lazy(() => import("./MobileNewSO").then((m) => ({ default: m.MobileNewSO })));
const MobileCalendar = lazy(() => import("./MobileCalendar").then((m) => ({ default: m.MobileCalendar })));
const MobileSearch = lazy(() => import("./MobileSearch").then((m) => ({ default: m.MobileSearch })));
const MobileInbox = lazy(() => import("./MobileInbox").then((m) => ({ default: m.MobileInbox })));
const MobileServiceCase = lazy(() => import("./MobileServiceCase").then((m) => ({ default: m.MobileServiceCase })));
const MobilePMS = lazy(() => import("./MobilePMS").then((m) => ({ default: m.MobilePMS })));
const MobileMailCenter = lazy(() => import("./MobileMailCenter").then((m) => ({ default: m.MobileMailCenter })));
const MobileAnnouncements = lazy(() => import("./MobileAnnouncements").then((m) => ({ default: m.MobileAnnouncements })));
// The unacknowledged-notice pop-up. Lazy like every other mobile screen, and
// only mounted once the unread badge says something IS waiting — that hook
// (useAnnouncementUnread) polls the same feed, so on the ordinary
// nothing-new load the phone never downloads this chunk at all.
const MobileAnnouncementPopup = lazy(() => import("./MobileAnnouncementPopup").then((m) => ({ default: m.MobileAnnouncementPopup })));
const MobileModuleDetail = lazy(() => import("./MobileModuleDetail").then((m) => ({ default: m.MobileModuleDetail })));
const MobileModuleForm = lazy(() => import("./MobileModuleForm").then((m) => ({ default: m.MobileModuleForm })));
const MobileDeliveryPlanning = lazy(() => import("./MobileDeliveryPlanning").then((m) => ({ default: m.MobileDeliveryPlanning })));
const MobileScan = lazy(() => import("./MobileScan").then((m) => ({ default: m.MobileScan })));
const MobileConvertWizard = lazy(() => import("./MobileConvertWizard").then((m) => ({ default: m.MobileConvertWizard })));
const MobilePOD = lazy(() => import("./MobilePOD").then((m) => ({ default: m.MobilePOD })));
const MobileMileageCapture = lazy(() => import("./MobileMileageCapture").then((m) => ({ default: m.MobileMileageCapture })));
const MobileProfile = lazy(() => import("./MobileProfile").then((m) => ({ default: m.MobileProfile })));
const MobileStockCard = lazy(() => import("./MobileStockCard").then((m) => ({ default: m.MobileStockCard })));
const MobileStockTransferNew = lazy(() => import("./MobileStockTransferNew").then((m) => ({ default: m.MobileStockTransferNew })));
const MobileFairReport = lazy(() => import("./MobileFairReport").then((m) => ({ default: m.MobileFairReport })));
const MobileAutoCountSync = lazy(() => import("./MobileAutoCountSync").then((m) => ({ default: m.MobileAutoCountSync })));
// SO Maintenance is the SAME desktop page (/scm/sales-orders/maintenance) — the
// director-only State→Warehouse / Localities / SO-dropdown CRUD surface. Mobile
// has no route table, so the vendored desktop page is mounted directly inside
// its provider shell (Scm2990Shell) as a full-screen overlay. It's a desktop-
// oriented layout (owner accepted this — the ask was to give directors the
// entry on their phone, matching desktop; see BUG-HISTORY 2026-07-15).
const ScmSalesOrderMaintenance = lazy(() => import("../pages/scm-v2/SalesOrderMaintenance").then((m) => ({ default: m.SalesOrderMaintenance })));
const Scm2990Shell = lazy(() => import("../pages/scm-v2/Scm2990Shell"));
import "./mobile.css";
import { MobileAssistant } from "./MobileAssistant";

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
  | { t: "new-so"; mode: "new" | "edit" | "edit-draft"; docNo?: string; scanPrefill?: MobileScanPrefill }
  | { t: "scan" }
  | { t: "module"; key: string; title: string }
  | { t: "module-detail"; key: string; row: any; title: string }
  | { t: "stock-transfer-new"; key: string; row: any; title: string }
  | { t: "module-form"; key: string; mode: "new" | "edit"; row?: any }
  | { t: "convert"; key: string; title: string; target: ConvertTarget; initialSourceId?: string }
  /* `from` is the return address. Back/Done out of POD normally drops to the
     tab, which is right when POD was opened from a document card — but the
     delivery-planning board sends the driver here MID-RUN, and dumping them on
     the home tab loses the run sheet they were working through. */
  | { t: "pod"; docNo: string; from?: "delivery-planning" }
  /* Fleet Maintenance Phase 2 — the driver's day-complete odometer capture.
     Mobile mounts this for /fleet-health; desktop mounts the full Fleet Health
     admin dashboard at the same URL (one product, two presentations). */
  | { t: "mileage-capture" }
  | { t: "service"; startNew?: boolean }
  | { t: "delivery-planning" }
  | { t: "pms"; projectId?: number }
  | { t: "mail" }
  | { t: "announcements" }
  | { t: "inbox" }
  /* A real mobile destination this user's position may not open. Reached only
     by URL — the menu never renders a row the user can't use. */
  | { t: "locked"; label: string }
  /* A URL with no mobile screen at all. NOT a stub ("building this next") and
     NOT a silent redirect to Orders — see mobileRoute.ts for what used to
     happen here. */
  | { t: "desktop-only"; path: string }
  | { t: "not-found"; path: string }
  | { t: "stub"; title: string };

/** Where a menu destination goes, as a PURE mapping. Shared by the menu tap
 *  (`openRoute`) and by the URL resolution at mount, so a path can never open
 *  one screen when tapped and a different one when typed. `orders-tab` is the
 *  one destination that is a bottom tab rather than an overlay. */
type DestinationTarget = Screen | { t: "orders-tab" };

export function destinationScreen(to: string, label: string): DestinationTarget {
  const path = (to || "").split("?")[0];
  if (path === "/scm/sales-orders") return { t: "orders-tab" };
  if (path === "/scm/sales-orders/maintenance") return { t: "so-maintenance" };
  if (path === "/reports/fair-report") return { t: "fair-report" };
  if (path === "/autocount-sync") return { t: "autocount-sync" };
  if (path === "/scm/amendments") return { t: "amendments" };
  if (path === "/scm/po-amendments") return { t: "po-amendments" };
  if (path === "/assr") return { t: "service" };
  if (path === "/projects") return { t: "pms" };
  if (path === "/mail-center") return { t: "mail" };
  if (path === "/announcements") return { t: "announcements" };
  if (path === "/activity-inbox") return { t: "inbox" };
  if (path === "/scm/delivery-planning") return { t: "delivery-planning" };
  // Fleet Health on a phone IS the driver's mileage capture; the desktop Fleet
  // Health dashboard (plans admin + board) is the same URL's desktop surface.
  if (path === "/fleet-health") return { t: "mileage-capture" };
  if (path === "/team") {
    const tab = new URLSearchParams((to.split("?")[1] || "")).get("tab");
    // Positions is owner-managed through backend/tooling only. Keep it out of
    // every mobile route, not merely out of the visible Profile row.
    // The redesigned desktop tab values (directory / departments2) land on the
    // same classic mobile modules; the legacy values stay accepted for old
    // bookmarks until cutover.
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

/** The screen the app opens on, given what the URL resolved to. */
function initialScreenFor(route: MobileRoute): Screen {
  switch (route.t) {
    case "home":
    // A tab path opens the shell on that tab (selected via `initialRoute`
    // where the tab state is created), so the screen is the plain tab view.
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
      // The Orders destination lands on the default tab, which is already
      // "orders" for anyone the resolver would have shown this destination to.
      return target.t === "orders-tab" ? { t: "tab" } : target;
    }
  }
}

// Doc modules whose "+ New" opens a convert wizard (create by converting a
// source doc), matching desktop. Others with a `form` open MobileModuleForm.
const MODULE_TO_CONVERT: Record<string, ConvertTarget> = {
  "delivery-orders-mfg": "do",
  "sales-invoices": "si",
  "grns": "grn",
  "mfg-purchase-orders": "po",
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

/* moduleKey → its menu path, for gating Relationship-Map node taps with the
 *  SAME `allowed()` the menu rows use. Derived, so it cannot drift. */
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
  /** Gate this row on one backend-resolved capability. Fails closed: an
   *  unresolved capability set hides the row. */
  capability?: CapabilityKey;
  gateVia?: string;
};

export const MOBILE_MENU_GROUPS: { group: string; items: MobileMenuItem[] }[] = [
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
    /* MODULE_CONFIGS.accounting → GET /accounting/accounts. Labelled "Chart of
       Accounts", NOT "Accounting", because accounts is all it opens: the
       journal-entry half of the desktop page (/accounting/journal-entries) has
       no mobile screen. A row named "Accounting" would send someone looking for
       journal entries and let them conclude the app is broken when they don't
       find them — the label has to name what the screen actually is. Gated by
       its own live nav entry (anyAccess scm.finance.accounting), which is also
       the backend area guard on /api/scm/accounting/*. */
    { to: "/scm/accounting", label: "Chart of Accounts" },
    /* Sales Report — moved from the Projects PMS group into the Finance
       cluster (owner 2026-07-22, to match the desktop Sidebar move). Same
       gate as before: `allowed("/reports/fair-report")` resolves to the
       fair-report cohort (management + Sales Director), so an ordinary
       salesperson never gets this row. Routes to the MOBILE screen
       (MobileFairReport), NOT the desktop table. */
    { to: "/reports/fair-report", label: "Sales Report" },
  ]},
  { group: "Projects · PMS", items: [
    { to: "/projects", label: "Projects" },
  ]},
  { group: "After-sales", items: [
    { to: "/assr", label: "Service Case" },
  ]},
  { group: "Procurement & MRP", items: [
    { to: "/scm/mrp", label: "MRP · Stock Status" },
    { to: "/scm/purchase-orders", label: "Purchase Orders" },
    { to: "/scm/po-amendments", label: "PO Amendments" },
    { to: "/scm/grns", label: "Goods Receipt" },
    { to: "/scm/purchase-invoices", label: "Purchase Invoices" },
    { to: "/scm/purchase-returns", label: "Purchase Returns" },
    { to: "/scm/products", label: "Products & Maintenance" },
    { to: "/scm/suppliers", label: "Suppliers" },
  ]},
  /* Consignment — the six vendored consignment doc lists, all of which already
     had a MODULE_CONFIGS entry (eyebrow "Consignment") and a live backend list
     endpoint, but no way in. Group + order + per-row gate mirror the desktop
     Sidebar's own Consignment group: each row carries its OWN anyAccess key
     (scm.consignment.orders / .notes / .returns / .po_orders / .po_receives /
     .po_returns), which is also the backend area guard, so a position granted
     only part of the area sees only that part. */
  { group: "Consignment", items: [
    { to: "/scm/consignment-orders", label: "Consignment Orders" },
    { to: "/scm/consignment-notes", label: "Consignment Notes" },
    { to: "/scm/consignment-returns", label: "Consignment Returns" },
    { to: "/scm/purchase-consignment-orders", label: "Purchase Consignment Orders" },
    { to: "/scm/purchase-consignment-receives", label: "Purchase Consignment Receives" },
    { to: "/scm/purchase-consignment-returns", label: "Purchase Consignment Returns" },
  ]},
  { group: "Logistics", items: [
    { to: "/scm/delivery-planning", label: "Delivery Planning" },
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
    /* Helpers — the delivery-crew master (scm.helpers, mig 0053). Same shape as
       the Drivers row above and for the same reason: mobile's "Fleet" module is
       LORRIES ONLY, so this is the only helper surface on a phone, not a
       duplicate. `gateVia` because /scm/helpers is a mobile-only path with no
       NAV_TABS entry, and `allowed()` fails CLOSED for an unmatched path — without
       it the row would vanish for everyone. /scm/delivery-maintenance carries
       the gate the backend applies to /api/scm/helpers/* (scmAreaGuard
       "scm.transportation.drivers"), so the two agree. */
    { to: "/scm/helpers", label: "Helpers", gateVia: "/scm/delivery-maintenance" },
    { to: "/scm/delivery-planning-regions", label: "Regions", gateVia: "/scm/delivery-maintenance" },
    /* Fleet Mileage — the Phase-2 driver action (mark day complete + odometer +
       photo). Points at /fleet-health, which on a phone mounts the mileage
       capture screen (destinationScreen), and gates on that path's own NAV_TABS
       entry (perm fleet.read) — so the same positions that see the desktop Fleet
       Health page get the mobile capture, and no one else. */
    { to: "/fleet-health", label: "Fleet Mileage" },
  ]},
  { group: "Warehouse", items: [
    { to: "/scm/warehouses", label: "Warehouse" },
    { to: "/scm/inventory", label: "Inventory" },
    { to: "/scm/stock-transfers", label: "Stock Transfers" },
    { to: "/scm/stock-takes", label: "Stock Take" },
  ]},
  /* System — the phone half of the desktop Sidebar's `system` section. Only one
     row so far: the AutoCount write-back queue, which is the answer to "did my
     sales order reach AutoCount" and therefore the one system page an owner
     opens on a phone rather than at a desk. Gated by its own live NAV_TABS entry
     at /autocount-sync (mechanism 1 above), which carries the same two keys the
     endpoint accepts. */
  { group: "System", items: [
    { to: "/autocount-sync", label: "AutoCount Sync" },
  ]},
];

/** Organisation destinations — owner 2026-07: these do NOT live in the module
 *  menu ("这全部在 profile 里面") — they are rows inside the Profile screen.
 *  Same routes and the SAME per-item permission gate (`allowed`) the menu
 *  applied when they lived there; an item hidden from the old menu stays
 *  hidden in Profile. */
export const PROFILE_ORG_ITEMS: MobileMenuItem[] = [
  /* DELIBERATELY UNGATED — but it does NOT lean on the fail-open default (there is
     none any more; allowed() fails CLOSED). /activity-inbox is a MOBILE-ONLY path:
     not a route in App.tsx and no NAV_TABS entry, so there is no desktop gate to
     borrow. The screen is the project-activity feed (hooks/useNotifications) — the
     phone's equivalent of the desktop bell, which every signed-in user has — and it
     is audience-filtered SERVER-side, so there is no page permission to apply here.
     `alwaysShow` is what keeps it visible: it short-circuits allowed() at the filter
     call sites, so the flip to fail-closed does NOT remove this row. That intent is
     stated in the data rather than left to a permissive default, and
     mobileMenuGates.test.ts pins it: this path is in that test's UNGATED_BY_DESIGN
     list, and the test fails if the list ever names a path that has since acquired a
     real gate. */
  { to: "/activity-inbox", label: "Inbox", alwaysShow: true },
  { to: "/mail-center", label: "Mail Center" },
  /* Owner rule 2026-07: Announcements is readable by EVERY active user —
     the mobile screen reads /api/announcements/banner, which needs no
     permission and is audience-filtered server-side (only notices addressed
     to this user). So this row bypasses the desktop nav gate
     (announcements.read = the desktop ADMIN list/composer permission). */
  { to: "/announcements", label: "Announcements", alwaysShow: true },
  /* Team destinations follow the desktop redesign's NAV_TABS rows
     (?tab=directory / ?tab=departments2) so each mobile row keeps its exact
     query-bearing gate; the screens themselves stay the classic mobile
     members/departments modules until the handoff's mobile pass (S8). */
  { to: "/team?tab=directory", label: "Directory" },
  { to: "/team?tab=departments2", label: "Departments" },
];

/** Mobile app shell — bottom tab bar + slide-up module menu, permission-gated
 *  (same page_access the desktop uses). Every menu route maps to a real mobile
 *  screen; the menu is limited to MOBILE_MENU (the design's module set). */
/** Registers the live confirm + notify fns with the module-level dialog-service
 *  bridge so non-React callers (authedFetch's short-stock gate, query onError)
 *  raise the in-app dialogs on mobile too. Renders inside both providers. */
function MobileDialogBridge() {
  const notify = useNotify();
  const confirm = useConfirm();
  useEffect(() => {
    registerDialogService({ confirm, notify });
  }, [confirm, notify]);
  return null;
}

// Shown while a lazy screen's chunk is in flight. Absolutely positioned so it
// fills its boundary container (the overlay slot or the tab-content slot) without
// disturbing the persistent tab bar, which lives outside the boundary.
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
  // Stamp <html lang> from the reader's chosen mobile language. This is what
  // activates the `:root[lang="bn"]` Bengali font-stack + line-height rules in
  // mobile.css, and it gives screen readers the right voice. Mounted at the
  // shell root so it applies to every mobile screen, including pre-auth.
  useApplyHtmlLang();
  return (
    <NotifyProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ChoiceProvider>
            <MobileDialogBridge />
            {/* Manual install coaches. Previously mounted only in the desktop
                App shell, so phone users whose browser never fires
                beforeinstallprompt (iOS Safari, Samsung Internet, in-app
                webviews, Chrome post-decline) got NO install path at all —
                the guides self-guard on platform/standalone/cool-off, and
                the Android one defers to PwaBanners' one-tap Install. */}
            <IosInstallGuide />
            <AndroidInstallGuide />
            <MobileAppInner />
            <MobileAssistant />
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
  // App-wide unread badge — un-acked human announcements AND the actionable
  // system notices (scan / service case). Shown on the Profile tab (below) +
  // the Profile > Announcements row, so a phone user sees a new broadcast or
  // service case without opening the screen (B2).
  const annUnread = useAnnouncementUnread();

  // Single-source the mobile gating on the SHARED per-node predicate the desktop
  // Sidebar + MobileTabBar filter with (components/navFilter.makeNavVisible), so
  // the mobile shell can never drift back into a hand-copied subset that omitted
  // pageAccessFull / hidePerm / requireFinanceViewer. `allowed(to)` answers "is
  // the nav destination at this path visible for the user".
  //
  // FAILS CLOSED: a path with NO NAV_TABS entry resolves to FALSE (hidden), not
  // true. There is no desktop gate to borrow for such a path, and defaulting to
  // "shown" made every new ungated menu row a page visible to EVERY position —
  // the fail-open leak this shell shipped twice (retired /scm/drivers, mobile-only
  // /scm/helpers). A destination that legitimately has no nav gate states that in
  // the DATA instead: `capability` (server-decided) or `alwaysShow` (+ its
  // justification in mobileMenuGates.test.ts UNGATED_BY_DESIGN, e.g. /activity-inbox).
  // Both are checked BEFORE allowed() at the call sites below, so they still show;
  // everything else must earn its row through a real gate. mobileMenuGates.test.ts
  // pins both this default and that every row declares a gate.
  const navVisible = makeNavVisible({ user, can, pageAccess });
  const flatNav: NavTab[] = [];
  const walkNav = (t: NavTab) => { flatNav.push(t); (t.children ?? []).forEach(walkNav); };
  NAV_TABS.forEach(walkNav);
  const allowed = (to: string): boolean => {
    // Query-bearing destinations are separate pages with separate gates.
    // Members must not lend its permission to Departments (or the backend-only
    // Positions editor) merely because all three share the /team pathname.
    const matches = flatNav.filter((t) => t.to != null && mobileDestinationMatches(to, t.to));
    return matches.length === 0 ? false : matches.some(navVisible);
  };

  // Bottom-tab access — a tab whose destination the user can't reach must NOT
  // mount its screen (its screen fires ungated queries → 403). Mirror the exact
  // capability the desktop nav uses: Orders = the /scm/sales-orders shortcut,
  // Service = the /assr Service-Cases group (service_cases.read OR Sales staff
  // via showForSales), Calendar = projects.calendar page access. Profile always.
  const canOrders = allowed("/scm/sales-orders");
  const canService = allowed("/assr");
  const canCalendar = pageAccess("projects.calendar") !== "none";
  // Land on the first tab the user can actually open (falls back to Profile) so
  // no one starts on a locked screen.
  const firstTab: Tab = canOrders ? "orders" : canService ? "service" : canCalendar ? "calendar" : "profile";

  // Build the grouped mobile Menu from MOBILE_MENU_GROUPS (design mirror), keeping
  // only items this user may reach: a `capability` row asks the server answer, an
  // `alwaysShow` row bypasses the gate, and every other row must pass the shared
  // `allowed` above — which now fails CLOSED, so a row with no nav match and no
  // capability/alwaysShow is hidden, not shown. Computed HERE, above the state,
  // because the initial screen is resolved from the URL against exactly this
  // permission-filtered list.
  const menuGroups = MOBILE_MENU_GROUPS
    .map((g) => ({ group: g.group, items: g.items.filter((it) => (it.capability ? capability(user, it.capability) : (it.alwaysShow || allowed(it.gateVia ?? it.to)))) }))
    .filter((g) => g.items.length > 0);

  // Organisation rows shown inside the Profile screen — gated by the SAME
  // `allowed` check (+ Announcements' alwaysShow bypass) the menu used when
  // these items lived in its Organisation group.
  const profileOrgItems = PROFILE_ORG_ITEMS.filter((it) => it.alwaysShow || allowed(it.to));

  // What this user may open, and what the mobile app implements at all. The
  // difference between the two is the "your position can't open this" answer;
  // absence from both is the "no mobile screen exists" answer.
  const visibleDestinations = [...menuGroups.flatMap((g) => g.items), ...profileOrgItems];
  const allKnownDestinations = [...MOBILE_MENU_GROUPS.flatMap((g) => g.items), ...PROFILE_ORG_ITEMS];

  /* URL → screen, ONCE at mount. The mobile shell has no router and does not
     write to the URL as the user moves, so this is deliberately an initial
     resolution and not a two-way sync: adding history syncing would change what
     every already-working mobile screen does, which this fix must not. What it
     buys is that a typed, bookmarked, notification or shared link either lands
     on the RIGHT screen or says so plainly — instead of silently rendering the
     Sales Orders list under, say, /scm/purchase-orders. */
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
  /* The crash-reset key for the overlay boundaries. Mobile navigation lives in
     `screen`, never in the URL, so the desktop shell's pathname key is useless
     here — serialise the state itself, which is a small discriminated union. */
  const screenKey = JSON.stringify(screen);
  const back = () => setScreen({ t: "tab" });
  const leaveUrlDeadEnd = () => {
    navigate("/", { replace: true });
    setScreen({ t: "tab" });
  };

  /* Relationship-Map node navigation (MobileRelationshipMap, opened from the
     SO / module detail screens). `can` runs the SAME fail-closed `allowed()`
     gate the menu rows use, so a map node whose destination this position may
     not open renders INERT (off, not hide) instead of mounting a screen whose
     queries would 403. */
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
      // A synthetic { id } row is enough: DocumentDetail fetches the full
      // header + items by id and falls back to the row only while loading.
      setScreen({ t: "module-detail", key: nav.moduleKey, row: { id: nav.id }, title: cfg.title ?? nav.moduleKey });
    },
  };

  // Search → calendar jump target. When a project search hit is tapped we route
  // to the Calendar tab and snap it to the project's start-date month, with the
  // project's bar highlighted (see MobileCalendar focusProjectId). A monotonic
  // nonce lets a repeat jump to the SAME month re-fire the calendar's effects.
  const [calJump, setCalJump] = useState<{ year: number; month: number; projectId: number; nonce: number } | null>(null);

  // Route a typed search hit onto the right mobile screen.
  const onSearchNavigate = (nav: SearchNav) => {
    switch (nav.kind) {
      case "sales_order":
        return setScreen({ t: "so-detail", docNo: nav.docNo });
      case "project": {
        // A dated project jumps the calendar to its month + highlights it; an
        // undated one falls back to opening the project in PMS.
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
    /* The minted draft is an ordinary SO, so the desktop SO lists must refetch
       alongside the phone's own list — the job creates it server-side, where no
       mutation hook runs to invalidate anything. */
    const bumpSoLists = () => {
      void qc.invalidateQueries({ queryKey: ["mobile-so-list-paged"] });
      invalidateSoShared(qc);
    };
    bumpSoLists();
    // The scan runs as a BACKGROUND job now (upload returns before the OCR),
    // so refetch again on the OCR's typical timescale — a slow job still
    // surfaces its draft without the operator reloading.
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
    // The Orders destination is a bottom TAB, not an overlay screen.
    if (target.t === "orders-tab") { setTab("orders"); setScreen({ t: "tab" }); return; }
    setScreen(target);
  };

  /* The un-acked announcement pop-up. It rides above EVERYTHING — the tab
     shell and any overlay screen — because a notice has to reach the user
     wherever they happen to be, which is exactly what the desktop gets from
     mounting AnnouncementBanner at the app root (App.tsx). Suppressed on the
     Announcements screen itself (the reader is already there, and a sheet over
     the list is noise, not news) and while the badge count is 0 — a notice the
     pop-up would show is by definition un-acked, so it is always counted, and
     gating on the count keeps the chunk off the wire on a quiet day. */
  const annPopup = screen.t === "announcements" || annUnread === 0 ? null : (
    /* Boundaried like the screens: this is a NON-route lazy that renders over
       whatever the operator has open, so a stale chunk here used to take the
       whole app down through main.tsx's unkeyed top-level boundary. */
    <MobileCrashBoundary resetKey={`ann:${screenKey}`} fallback={null}>
      <MobileAnnouncementPopup onOpenList={() => setScreen({ t: "announcements" })} />
    </MobileCrashBoundary>
  );

  // Overlay screens (pushed above the tab bar). These resolve to lazy-loaded
  // components, so the chosen element is returned under a single crash+Suspense
  // boundary (full-screen fallback — an overlay owns the whole viewport anyway).
  let overlay: ReactNode = null;
  if (screen.t === "search") overlay = <MobileSearch onBack={back} onNavigate={onSearchNavigate} />;
  else if (screen.t === "so-detail") overlay = <MobileSODetail docNo={screen.docNo} onBack={back} onEdit={(d) => setScreen({ t: "new-so", mode: "edit", docNo: d })} flowNav={flowNav} />;
  else if (screen.t === "amendments") overlay = <MobileAmendments onBack={back} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} />;
  else if (screen.t === "po-amendments") overlay = <MobilePoAmendments onBack={back} onOpen={(id) => setScreen({ t: "po-amendment-detail", id })} />;
  else if (screen.t === "po-amendment-detail") overlay = <MobilePoAmendmentDetail amendmentId={screen.id} onBack={() => setScreen({ t: "po-amendments" })} />;
  else if (screen.t === "so-maintenance") {
    // Defence-in-depth on the SAME server-decided answer the menu row uses, so
    // the row and the mount cannot disagree: don't mount the maintenance page
    // (or its data hooks) for a caller the backend would refuse. Mirrors
    // App.tsx SoMaintenanceGuard, which now reads the same capability. OFF, not
    // hide — an unresolved capability set denies here too.
    overlay = !capability(user, "scm.maintenance.open") ? (
      <TabLocked title="SO Maintenance" />
    ) : (
      <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
        <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
          <button onClick={back} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--teal)", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>‹ Back</button>
          <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>SO Maintenance</div>
        </header>
        {/* The vendored desktop maintenance page mounted inside its provider shell.
            Desktop-oriented layout — scrolls within this container on a phone. */}
        <div style={{ flex: 1, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
          <Scm2990Shell><ScmSalesOrderMaintenance /></Scm2990Shell>
        </div>
      </div>
    );
  }
  else if (screen.t === "fair-report") {
    // Guard the screen too (not just the menu row) — a Fair-Report URL must not
    // mount the screen (or fire its queries) for a user outside the cohort.
    // Mirrors the desktop FairReport route guard; OFF, not hide.
    overlay = !canViewFairReport(user) ? <TabLocked title="Sales Report" /> : <MobileFairReport onBack={back} />;
  }
  else if (screen.t === "autocount-sync") {
    /* Guard the SCREEN, not only the menu row: an /autocount-sync URL must not
       mount the page or fire its query for someone the endpoint would 403.
       Same two keys the desktop route and the server accept. OFF, not hidden. */
    const mayRead = can("*") || can("scm.autocount.read") || can("settings.manage");
    overlay = !mayRead ? <TabLocked title="AutoCount Sync" /> : <MobileAutoCountSync onBack={back} />;
  }
  else if (screen.t === "new-so") overlay = <MobileNewSO mode={screen.mode} docNo={screen.docNo} scanPrefill={screen.scanPrefill} onBack={back} onSaved={(d) => setScreen({ t: "so-detail", docNo: d })} />;
  else if (screen.t === "scan") overlay = <MobileScan onBack={back} onDrafted={onScanDrafted} onOpenSo={(docNo) => setScreen({ t: "so-detail", docNo })} />;
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
    /* `: true` used to be the fourth arm, and it covered BOTH remaining targets
       — "grn" and "po". So the rule the two sentences above describe was applied
       to exactly half the wizard: a `view`-level holder of Purchase Orders or
       Goods Receipts was still handed the "+", and MobileConvertWizard imports
       no auth of its own, so nothing downstream stopped them either. There is no
       default arm now: every ConvertTarget names its gate, and a new target that
       forgets to will not typecheck. */
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
    const onNew = convertTarget
      ? mayConvert
        ? () => setScreen({ t: "convert", key: k, title: screen.title, target: convertTarget })
        : undefined
      : MODULE_CONFIGS[k]?.form
        ? () => setScreen({ t: "module-form", key: k, mode: "new" })
        : undefined;
    overlay = <MobileModuleList config={MODULE_CONFIGS[k]} onBack={back}
      onOpen={(row) => setScreen({ t: "module-detail", key: k, row, title: screen.title })}
      onNew={onNew}
      aboveList={k === "members" ? <MobileInvitations /> : undefined} />;
  }
  else if (screen.t === "convert") {
    // Convert is entered from a module list ("+ New") → return to that list
    // afterwards. If ever re-seeded with an initialSourceId (source doc), return
    // to that SO detail instead so the operator sees the updated state.
    const fromSo = screen.target === "do" && !!screen.initialSourceId;
    const backToConvertHome = fromSo
      ? () => setScreen({ t: "so-detail", docNo: screen.initialSourceId! })
      : () => setScreen({ t: "module", key: screen.key, title: screen.title });
    overlay = <MobileConvertWizard target={screen.target} initialSourceId={screen.initialSourceId} onBack={backToConvertHome} onCreated={backToConvertHome} />;
  }
  else if (screen.t === "module-detail" && screen.key === "inventory") {
    // Inventory row → the richer per-SKU stock card (replaces the generic detail).
    overlay = <MobileStockCard
      itemCode={screen.row?.item_code ?? ""}
      productName={screen.row?.product_name ?? null}
      canTransfer={allowed("/scm/stock-transfers")}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onNewTransfer={() => setScreen({ t: "stock-transfer-new", key: screen.key, row: screen.row, title: screen.title })} />;
  }
  else if (screen.t === "stock-transfer-new") {
    const backToCard = () => setScreen({ t: "module-detail", key: screen.key, row: screen.row, title: screen.title });
    overlay = <MobileStockTransferNew onBack={backToCard} onCreated={backToCard} />;
  }
  else if (screen.t === "module-detail") {
    const doNo = screen.key === "delivery-orders-mfg" ? (screen.row?.do_number ?? screen.row?.doNumber) : null;
    /* POD records a delivery's arrival (signature + photo; it does NOT move
       stock — the OUT fired at LOADED). Office operators reach it via the same
       canOperateDeliveryOrders helper as the other DO controls; a DRIVER reaches
       it via canDriverCompleteDelivery (scm.do.dispatch), whose scm.sales.delivery
       is `none`. A view-only user (the Sales cohort) gets NO POD entry; the
       SERVER enforces a driver may complete only their OWN dispatched job, so
       this only decides whether the entry SHOWS. */
    const canPod =
      !!doNo &&
      (canOperateDeliveryOrders(user, can, pageAccess) || canDriverCompleteDelivery(user));
    overlay = <MobileModuleDetail moduleKey={screen.key} row={screen.row} title={screen.title}
      onBack={() => setScreen({ t: "module", key: screen.key, title: screen.title })}
      onEdit={() => setScreen({ t: "module-form", key: screen.key, mode: "edit", row: screen.row })}
      onPOD={canPod ? () => setScreen({ t: "pod", docNo: String(doNo) }) : undefined}
      flowNav={flowNav} />;
  }
  else if (screen.t === "module-form") {
    const cfg = MODULE_CONFIGS[screen.key];
    const schema = screen.mode === "edit" && screen.key === "members" ? FORM_MEMBERS_EDIT : cfg?.form;
    const title = cfg?.title ?? screen.key;
    overlay = !schema ? <Stub title={title} onBack={back} /> : (
      <MobileModuleForm schema={schema} mode={screen.mode} initial={screen.mode === "edit" ? screen.row : undefined}
        onBack={() => setScreen(screen.mode === "edit" && screen.row ? { t: "module-detail", key: screen.key, row: screen.row, title } : { t: "module", key: screen.key, title })}
        onSaved={() => setScreen({ t: "module", key: screen.key, title })} />
    );
  }
  else if (screen.t === "pod") {
    const leavePod = screen.from === "delivery-planning"
      ? () => setScreen({ t: "delivery-planning" })
      : back;
    overlay = <MobilePOD docNo={screen.docNo} onBack={leavePod} onDone={leavePod} />;
  }
  else if (screen.t === "mileage-capture") overlay = <MobileMileageCapture onBack={back} />;
  else if (screen.t === "service") overlay = <MobileServiceCase onBack={back} startNew={screen.startNew} />;
  else if (screen.t === "delivery-planning") overlay = <MobileDeliveryPlanning onBack={back} onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })} onPod={(doNumber) => setScreen({ t: "pod", docNo: doNumber, from: "delivery-planning" })} />;
  else if (screen.t === "pms") overlay = <MobilePMS onBack={back} initialProjectId={screen.projectId} />;
  else if (screen.t === "mail") overlay = <MobileMailCenter onBack={back} />;
  else if (screen.t === "announcements") overlay = <MobileAnnouncements onBack={back} />;
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
    </>
  );

  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, background: "var(--app-bg)", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* The boundary wraps only the tab CONTENT — the tab bar below stays mounted,
            so switching to a not-yet-loaded tab shows a content skeleton without
            the nav flashing. */}
        <MobileCrashBoundary resetKey={`tab:${tab}`} fallback={<MobileScreenFallback />}>
          {/* Each content tab mounts its screen ONLY when the user can reach the
              destination (same makeNavVisible gate as the nav). A tab the user
              can't access renders a locked placeholder instead of the real screen
              — so its ungated queries (/api/scm/mfg-sales-orders, /api/assr,
              /api/projects/calendar…) never fire a 403 (OFF, not hide). */}
          {tab === "orders" && (canOrders ? (
            <MobileSalesOrders
              onScan={() => setScreen({ t: "scan" })}
              onOpen={(doc) => setScreen({ t: "so-detail", docNo: doc })}
              onNew={() => setScreen({ t: "new-so", mode: "new" })}
              // FAB "+" second action — open the service-case create sheet on the
              // Service screen (parity with the desktop QuickActionsFAB two-choice).
              onNewCase={() => setScreen({ t: "service", startNew: true })}
            />
          ) : <TabLocked title="Sales Orders" />)}
          {tab === "service" && (canService
            ? <MobileServiceCase onBack={() => setTab(firstTab)} />
            : <TabLocked title="Service Cases" />)}
          {tab === "calendar" && (canCalendar ? (
            <MobileCalendar
              onOpenProject={(id) => setScreen({ t: "pms", projectId: id })}
              onOpenSearch={() => setScreen({ t: "search" })}
              // Search → calendar jump: keyed by the jump nonce so re-jumping to the
              // same month re-triggers the snap + highlight.
              key={calJump ? `caljump-${calJump.nonce}` : "cal"}
              initialYear={calJump?.year}
              initialMonth={calJump?.month}
              focusProjectId={calJump?.projectId}
            />
          ) : <TabLocked title="Calendar" />)}
          {tab === "profile" && <MobileProfile onLogout={logout} orgItems={profileOrgItems} onOpenOrg={openRoute} />}
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
            {/* center Menu disc — icon ported VERBATIM from the owner's design
                prototype (houzs-mobile.html `var DISC`): a 4-square grid / apps
                icon (four rounded rects), NOT the hamburger. Toggles the
                permission-gated module sheet, matching the design's toggle. */}
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
            aria-label={annUnread > 0 ? `Profile, ${annUnread} unread notification${annUnread > 1 ? "s" : ""}` : "Profile"}
          >
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="3.7" /><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" /></svg>
            {/* App-wide unread badge — same red count pill as the Profile >
                Announcements row (owner B2); the un-acked system-notice count. */}
            {annUnread > 0 && (
              <span aria-hidden style={{ position: "absolute", top: 4, left: "calc(50% + 5px)", minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#c0392b", color: "#fff", fontSize: 10, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1, boxSizing: "border-box" }}>
                {annUnread > 9 ? "9+" : annUnread}
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
                <div className="ey" style={{ color: "#a16a2e" }}>Menu</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#11140f", marginTop: 2 }}>Where to next?</div>
              </div>
              <button className="sheet-x" onClick={() => setMenuOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="sheet-scroll">
              {/* Grouped module menu — mirrors the owner's design MobileShell.tsx
                  sheet: each group is a card with an uppercase group title and a
                  2-column grid of plain label buttons (no per-item / per-group
                  icons, no footer). Routing stays real via openRoute(it.to). */}
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
              {menuGroups.length === 0 && <div style={{ textAlign: "center", color: "#9aa093", fontSize: 12, padding: "24px 0" }}>No modules available for your position.</div>}
            </div>
          </div>
        </div>
      )}

      {annPopup}
    </div>
  );
}

/** Locked placeholder for a bottom tab the user can't access — the tab button
 *  stays in the fixed bar (design), but its screen (and every query it fires)
 *  never mounts. OFF, not hide: no fetch, no 403. */
function TabLocked({ title }: { title: string }) {
  return (
    <div className="hz-m" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9aa093", fontSize: 12.5, padding: 24, textAlign: "center" }}>
        Your position doesn't have access to this section.
      </div>
    </div>
  );
}

/** Shared frame for the two honest URL dead ends below. Deliberately has no
 *  "Back" — the user arrived by URL, so there is usually nothing behind them;
 *  the way out is into the app. */
function UrlDeadEnd({ title, body, onHome }: { title: string; body: string; onHome: () => void }) {
  return (
    <div className="hz-m" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--app-bg)" }}>
      <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
        <div style={{ color: "#9aa093", fontSize: 12.5, lineHeight: 1.6, maxWidth: 300 }}>{body}</div>
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

/** A URL naming a real mobile screen this position may not open. Says so —
 *  rather than dropping the user on whatever screen happens to be first. */
function UrlLocked({ label, onHome }: { label: string; onHome: () => void }) {
  return (
    <UrlDeadEnd
      title={label}
      body="Your position doesn't have access to this section."
      onHome={onHome}
    />
  );
}

/** A URL with no mobile screen at all. The page EXISTS on desktop, so the
 *  honest answer is "open it on a computer" — not a 404, and above all not
 *  another document type rendered under this URL. */
function DesktopOnly({ path, onHome }: { path: string; onHome: () => void }) {
  return (
    <UrlDeadEnd
      title="Not available on mobile"
      body={`${path} hasn't been built for phones yet. Open it on a computer to use this page.`}
      onHome={onHome}
    />
  );
}

/** A genuine typo/retired URL, distinct from a real desktop-only page. */
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
      <header style={{ background: "#fff", borderBottom: "1px solid var(--line)", padding: "calc(env(safe-area-inset-top) + 16px) 16px 14px" }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", color: "var(--teal)", fontFamily: "inherit", fontSize: 13, fontWeight: 600 }}>‹ Back</button>
        <div style={{ fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>{title}</div>
      </header>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9aa093", fontSize: 12.5, padding: 24, textAlign: "center" }}>
        Building this screen next — it will match your design and connect to the live data.
      </div>
    </div>
  );
}

