import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./auth/AuthContext";
import { canUseAssistant } from "./auth/assistantAccess";
import { isSalesStaff, isDirectorUser, isSalesDirectorUser, isSalesNonDirector, canViewFairReport, hasAnyScmPageAccess } from "./auth/salesAccess";
import { capability, capabilitiesUnresolved } from "./auth/capabilities";
import { PageGuard } from "./auth/PageGuard";
import { ROUTE_ALIASES } from "./lib/routeAliases";
import { AliasRedirect } from "./routing/AliasRedirect";
import { Forbidden } from "./pages/Forbidden";
import { GlobalSearchProvider } from "./components/GlobalSearch";
import { NotificationsProvider } from "./hooks/useNotifications";
import { BrowserPushSink } from "./components/BrowserPushSink";
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import { QuickActionsFAB } from "./components/QuickActionsFAB";
import { BackToTopFAB } from "./components/BackToTopFAB";
import { AssistantLauncher } from "./components/AssistantLauncher";
import { AssistantPanel } from "./components/AssistantPanel";
import { AssistantPanelProvider } from "./components/AssistantPanelContext";
import { BreadcrumbsProvider } from "./hooks/useBreadcrumbs";
import { PageSkeleton, RouteCrashBoundary } from "./components/RouteFallback";
// NewVersionBanner is deliberately NOT mounted here — see main.tsx's RootApp.
// App() is the DESKTOP shell; AuthGate renders MobileApp instead of it, so a
// mount in this file reaches no mobile screen at all.
import { IosInstallGuide } from "./components/IosInstallGuide";
import { AndroidInstallGuide } from "./components/AndroidInstallGuide";

// Route-level code splitting: every page becomes its own chunk, fetched on
// first visit, so the initial bundle carries only the shell. The .then()
// indirection adapts our named exports to React.lazy's default-export shape
// without touching the page files. Multi-page modules (ServiceCases, Projects)
// share one chunk.
const ServiceCases = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCases })));
const ServiceCaseDetail = lazy(() => import("./pages/ServiceCases").then((m) => ({ default: m.ServiceCaseDetail })));
const MyCases = lazy(() => import("./pages/MyCases").then((m) => ({ default: m.MyCases })));
const MyCaseDetail = lazy(() => import("./pages/MyCases").then((m) => ({ default: m.MyCaseDetail })));
const Projects = lazy(() => import("./pages/Projects").then((m) => ({ default: m.Projects })));
const ProjectDetail = lazy(() => import("./pages/Projects").then((m) => ({ default: m.ProjectDetail })));
const FairReportFill = lazy(() => import("./pages/FairReportFill").then((m) => ({ default: m.FairReportFill })));
const ScheduleReconcile = lazy(() => import("./pages/ScheduleReconcile").then((m) => ({ default: m.ScheduleReconcile })));
const SetupInvoiceFill = lazy(() => import("./pages/SetupInvoiceFill").then((m) => ({ default: m.SetupInvoiceFill })));
// Sales Entries — rep-entered sales log + Director approval queue.
// Restored to the menu 2026-07-06 (stripped in the core-slim pass).
const Sales = lazy(() => import("./pages/Sales").then((m) => ({ default: m.Sales })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Notifications = lazy(() => import("./pages/Notifications").then((m) => ({ default: m.Notifications })));
const Announcements = lazy(() => import("./pages/Announcements").then((m) => ({ default: m.Announcements })));
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Team = lazy(() => import("./pages/Team").then((m) => ({ default: m.Team })));
const SystemHealth = lazy(() => import("./pages/SystemHealth").then((m) => ({ default: m.SystemHealth })));
const AutoCountSync = lazy(() => import("./pages/AutoCountSync").then((m) => ({ default: m.AutoCountSync })));
const FleetHealth = lazy(() => import("./pages/FleetHealth").then((m) => ({ default: m.FleetHealth })));
const LorryRecord = lazy(() => import("./pages/LorryRecord").then((m) => ({ default: m.LorryRecord })));
const Agents = lazy(() => import("./pages/Agents").then((m) => ({ default: m.Agents })));
const Assistant = lazy(() => import("./pages/Assistant").then((m) => ({ default: m.Assistant })));
// Mail Center — in-ERP shared inbox (ported from Hookka). Inbox + thread detail;
// Compose is a modal opened from the inbox (no standalone route).
const MailInbox = lazy(() => import("./pages/MailCenter/Inbox").then((m) => ({ default: m.MailInbox })));
const MailThread = lazy(() => import("./pages/MailCenter/Thread").then((m) => ({ default: m.MailThread })));
// Ported 2990's SCM (furniture supply chain) — owner-gated under /scm/*.
// These are the VENDORED (wholesale-copied) 2990 pages, now the canonical /scm/*
// surface. The native pages/scm/* set was retired in the cutover.
const ScmSuppliersV2 = lazy(() => import("./pages/scm-v2/SuppliersV2Route"));
// Each list/detail page is a NAMED export wrapped at the route in <Scm2990Shell>
// (the Notify/Confirm/dialog-service providers).
const Scm2990Shell = lazy(() => import("./pages/scm-v2/Scm2990Shell"));
const ScmPurchaseOrdersV2 = lazy(() => import("./pages/scm-v2/PurchaseOrdersListV2").then((m) => ({ default: m.PurchaseOrdersListV2 })));
const ScmPurchaseOrderNewV2 = lazy(() => import("./pages/scm-v2/PurchaseOrderNew").then((m) => ({ default: m.PurchaseOrderNew })));
const ScmPurchaseOrderFromSoV2 = lazy(() => import("./pages/scm-v2/PurchaseOrderFromSo").then((m) => ({ default: m.PurchaseOrderFromSo })));
const ScmPurchaseOrderDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseOrderDetailV2").then((m) => ({ default: m.PurchaseOrderDetailV2 })));
// TEMP — vendored 2990's MRP + read/list pages (wave 2), parallel to native.
const ScmMrpV2 = lazy(() => import("./pages/scm-v2/Mrp").then((m) => ({ default: m.Mrp })));
const ScmAccountingV2 = lazy(() => import("./pages/scm-v2/Accounting").then((m) => ({ default: m.Accounting })));
const ScmDailyBank = lazy(() => import("./pages/scm-v2/DailyBank").then((m) => ({ default: m.DailyBank })));
const ScmMerchantRecon = lazy(() => import("./pages/scm-v2/MerchantRecon").then((m) => ({ default: m.MerchantRecon })));
const ScmBankRecon = lazy(() => import("./pages/scm-v2/BankRecon").then((m) => ({ default: m.BankRecon })));
const ScmSettlementSetup = lazy(() => import("./pages/scm-v2/SettlementSetup").then((m) => ({ default: m.SettlementSetup })));
const ScmOutstandingV2 = lazy(() => import("./pages/scm-v2/Outstanding").then((m) => ({ default: m.Outstanding })));
const ScmUnbilledDeliveriesV2 = lazy(() => import("./pages/scm-v2/UnbilledDeliveriesV2").then((m) => ({ default: m.UnbilledDeliveriesV2 })));
const ScmFabricTrackingV2 = lazy(() => import("./pages/scm-v2/FabricTracking").then((m) => ({ default: m.FabricTracking })));
const ScmWarehousesV2 = lazy(() => import("./pages/scm-v2/Warehouses").then((m) => ({ default: m.Warehouses })));
const ScmWarehouseRacksV2 = lazy(() => import("./pages/scm-v2/WarehouseRacks").then((m) => ({ default: m.WarehouseRacks })));
const ScmCurrenciesV2 = lazy(() => import("./pages/scm-v2/Currencies").then((m) => ({ default: m.Currencies })));
const ScmProductsV2 = lazy(() => import("./pages/scm-v2/Products").then((m) => ({ default: m.Products })));
const ScmProductModelsV2 = lazy(() => import("./pages/scm-v2/ProductModels").then((m) => ({ default: m.ProductModels })));
const ScmProductModelDetailV2 = lazy(() => import("./pages/scm-v2/ProductModelDetail").then((m) => ({ default: m.ProductModelDetail })));
const ScmGoodsReceivedV2 = lazy(() => import("./pages/scm-v2/GoodsReceivedListV2").then((m) => ({ default: m.GoodsReceivedListV2 })));
const ScmGrnNewV2 = lazy(() => import("./pages/scm-v2/GrnNew").then((m) => ({ default: m.GrnNew })));
const ScmGrnFromPoV2 = lazy(() => import("./pages/scm-v2/GrnFromPo").then((m) => ({ default: m.GrnFromPo })));
const ScmGoodsReceivedDetailV2 = lazy(() => import("./pages/scm-v2/GoodsReceivedDetailV2").then((m) => ({ default: m.GoodsReceivedDetailV2 })));
const ScmPurchaseInvoicesV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoicesListV2").then((m) => ({ default: m.PurchaseInvoicesListV2 })));
const ScmPurchaseInvoiceNewV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoiceNew").then((m) => ({ default: m.PurchaseInvoiceNew })));
const ScmPurchaseInvoiceFromGrnV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoiceFromGrn").then((m) => ({ default: m.PurchaseInvoiceFromGrn })));
const ScmPurchaseInvoiceDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseInvoiceDetailV2").then((m) => ({ default: m.PurchaseInvoiceDetailV2 })));
const ScmPaymentVouchersV2 = lazy(() => import("./pages/scm-v2/PaymentVouchers").then((m) => ({ default: m.PaymentVouchers })));
const ScmPaymentVoucherNewV2 = lazy(() => import("./pages/scm-v2/PaymentVoucherNew").then((m) => ({ default: m.PaymentVoucherNew })));
const ScmPaymentVoucherScanV2 = lazy(() => import("./pages/scm-v2/PaymentVoucherScan").then((m) => ({ default: m.PaymentVoucherScan })));
const ScmPaymentVoucherDetailV2 = lazy(() => import("./pages/scm-v2/PaymentVoucherDetail").then((m) => ({ default: m.PaymentVoucherDetail })));
const ScmStockAdjustmentsV2 = lazy(() => import("./pages/scm-v2/StockAdjustments").then((m) => ({ default: m.StockAdjustments })));
const ScmStockAdjustmentNewV2 = lazy(() => import("./pages/scm-v2/StockAdjustmentNew").then((m) => ({ default: m.StockAdjustmentNew })));
const ScmStockTransfersV2 = lazy(() => import("./pages/scm-v2/StockTransfersListV2").then((m) => ({ default: m.StockTransfersListV2 })));
const ScmStockTransferNewV2 = lazy(() => import("./pages/scm-v2/StockTransferNew").then((m) => ({ default: m.StockTransferNew })));
const ScmStockTransferDetailV2 = lazy(() => import("./pages/scm-v2/StockTransferDetail").then((m) => ({ default: m.StockTransferDetail })));
const ScmStockTakesV2 = lazy(() => import("./pages/scm-v2/StockTakesListV2").then((m) => ({ default: m.StockTakesListV2 })));
const ScmStockTakeNewV2 = lazy(() => import("./pages/scm-v2/StockTakeNew").then((m) => ({ default: m.StockTakeNew })));
const ScmStockTakeDetailV2 = lazy(() => import("./pages/scm-v2/StockTakeDetail").then((m) => ({ default: m.StockTakeDetail })));
// HR / Commission — the payroll surface over /api/scm/hr.
const ScmHrCommission = lazy(() => import("./pages/scm-v2/HrCommission").then((m) => ({ default: m.HrCommission })));
const ScmHrSettings = lazy(() => import("./pages/scm-v2/HrSettings").then((m) => ({ default: m.HrSettings })));
// TEMP — vendored 2990's PR / Inventory / Stock Card / Supplier Detail / Drivers
// pages (this wave), parallel to the native /scm/* routes below.
const ScmPurchaseReturnsV2 = lazy(() => import("./pages/scm-v2/PurchaseReturnsListV2").then((m) => ({ default: m.PurchaseReturnsListV2 })));
const ScmPurchaseReturnNewV2 = lazy(() => import("./pages/scm-v2/PurchaseReturnNew").then((m) => ({ default: m.PurchaseReturnNew })));
const ScmPurchaseReturnDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseReturnDetailV2").then((m) => ({ default: m.PurchaseReturnDetailV2 })));
const ScmInventoryV2 = lazy(() => import("./pages/scm-v2/Inventory").then((m) => ({ default: m.Inventory })));
const ScmStockCardV2 = lazy(() => import("./pages/scm-v2/StockCard").then((m) => ({ default: m.StockCard })));
const ScmSupplierDetailV2 = lazy(() => import("./pages/scm-v2/SupplierDetail").then((m) => ({ default: m.SupplierDetail })));
// Delivery Planning + TMS (Stage 3 — ported 2026-06-28 from 2990).
const ScmDeliveryPlanningV2 = lazy(() => import("./pages/scm-v2/DeliveryPlanning").then((m) => ({ default: m.DeliveryPlanning })));
const ScmDpOrdersV2 = lazy(() => import("./pages/scm-v2/DpOrders").then((m) => ({ default: m.DpOrders })));
const ScmTrips = lazy(() => import("./pages/scm-v2/Trips").then((m) => ({ default: m.Trips })));
const ScmDeliveryPlanningRegionsV2 = lazy(() => import("./pages/scm-v2/DeliveryPlanningRegions").then((m) => ({ default: m.DeliveryPlanningRegions })));
const ScmDeliveryResidenceRulesV2 = lazy(() => import("./pages/scm-v2/DeliveryResidenceRules").then((m) => ({ default: m.DeliveryResidenceRules })));
// Fleet Module A1 — postcode->zone map admin + auto-propose delivery-date + lock.
const ScmDeliveryZonesV2 = lazy(() => import("./pages/scm-v2/DeliveryZones").then((m) => ({ default: m.DeliveryZones })));
// Fleet Module C — delivery rate-card config + cost calculator + 3PL reconciliation.
const ScmDeliveryRateCardsV2 = lazy(() => import("./pages/scm-v2/DeliveryRateCards").then((m) => ({ default: m.DeliveryRateCards })));
const ScmAutoScheduleV2 = lazy(() => import("./pages/scm-v2/AutoSchedule").then((m) => ({ default: m.AutoSchedule })));
const ScmDriverLeaveV2 = lazy(() => import("./pages/scm-v2/DriverLeave").then((m) => ({ default: m.DriverLeave })));
const ScmThreePLCompaniesV2 = lazy(() => import("./pages/scm-v2/ThreePLCompanies").then((m) => ({ default: m.ThreePLCompanies })));
const ScmFleetV2 = lazy(() => import("./pages/scm-v2/Fleet").then((m) => ({ default: m.Fleet })));
const ScmDeliveryMaintenanceV2 = lazy(() => import("./pages/scm-v2/DeliveryMaintenance").then((m) => ({ default: m.DeliveryMaintenance })));
const ScmLorryCapacityV2 = lazy(() => import("./pages/scm-v2/LorryCapacity").then((m) => ({ default: m.LorryCapacity })));
// Fleet Module A4 — day-view map + printable driver run-sheet (read/render over trips).
const ScmFleetDayV2 = lazy(() => import("./pages/scm-v2/FleetDay").then((m) => ({ default: m.FleetDay })));
const ScmFleetRunSheetV2 = lazy(() => import("./pages/scm-v2/FleetRunSheet").then((m) => ({ default: m.FleetRunSheet })));
// Sales Order READ side (vendored 2990 list + detail + maintenance). New-SO
// configurator + SoFromProducts come in a later wave. NOTE: 2990 uses :docNo
// (not :id) for SO detail, and the literal /maintenance route MUST precede
// /:docNo so 'maintenance' isn't read as a doc number.
// Overview — Workspace home (P1 task-first dashboard).
const Overview = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
// Supply Chain Hub — section landing page (flattens the 3-level SCM nesting).
const ScmHub = lazy(() => import("./pages/ScmHub").then((m) => ({ default: m.ScmHub })));
const ScmSubgroupHub = lazy(() => import("./pages/ScmSubgroupHub").then((m) => ({ default: m.ScmSubgroupHub })));
const ScmSalesOrdersV2 = lazy(() => import("./pages/scm-v2/MfgSalesOrdersListV2").then((m) => ({ default: m.MfgSalesOrdersListV2 })));
const ScmSalesOrderMaintenanceV2 = lazy(() => import("./pages/scm-v2/SalesOrderMaintenance").then((m) => ({ default: m.SalesOrderMaintenance })));
const ScmSalesOrderNewV2 = lazy(() => import("./pages/scm-v2/SalesOrderNew").then((m) => ({ default: m.SalesOrderNew })));
const ScmSalesOrderNewGuidedV2 = lazy(() => import("./pages/scm-v2/SalesOrderNewGuided").then((m) => ({ default: m.SalesOrderNewGuided })));
const ScmSalesOrderNewFromProductsV2 = lazy(() => import("./pages/scm-v2/SalesOrderNewFromProducts").then((m) => ({ default: m.SalesOrderNewFromProducts })));
const ScmCategoriesV2 = lazy(() => import("./pages/scm-v2/Categories").then((m) => ({ default: m.Categories })));
const ScmSoFromProductsV2 = lazy(() => import("./pages/scm-v2/SoFromProducts").then((m) => ({ default: m.SoFromProducts })));
const ScmSalesOrderDetailV2 = lazy(() => import("./pages/scm-v2/SalesOrderDetailV2").then((m) => ({ default: m.SalesOrderDetailV2 })));
const ScmAmendmentsV2 = lazy(() => import("./pages/scm-v2/Amendments").then((m) => ({ default: m.Amendments })));
const ScmAmendmentDetailV2 = lazy(() => import("./pages/scm-v2/AmendmentDetailV2").then((m) => ({ default: m.AmendmentDetailV2 })));
const ScmPoAmendmentsV2 = lazy(() => import("./pages/scm-v2/PoAmendments").then((m) => ({ default: m.PoAmendments })));
const ScmPoAmendmentDetailV2 = lazy(() => import("./pages/scm-v2/PoAmendmentDetailV2").then((m) => ({ default: m.PoAmendmentDetailV2 })));
const ScmSoDetailListingV2 = lazy(() => import("./pages/scm-v2/SalesOrderDetailListing").then((m) => ({ default: m.SalesOrderDetailListing })));
const ScmDoDetailListingV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderDetailListing").then((m) => ({ default: m.DeliveryOrderDetailListing })));
const ScmSiDetailListingV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceDetailListing").then((m) => ({ default: m.SalesInvoiceDetailListing })));
const ScmDrDetailListingV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnDetailListing").then((m) => ({ default: m.DeliveryReturnDetailListing })));
const FairReportV2 = lazy(() => import("./pages/scm-v2/FairReport").then((m) => ({ default: m.FairReport })));
const ScmDeliveryOrdersV2 = lazy(() => import("./pages/scm-v2/MfgDeliveryOrdersListV2").then((m) => ({ default: m.MfgDeliveryOrdersListV2 })));
const ScmDeliveryOrderNewV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderNewV2").then((m) => ({ default: m.DeliveryOrderNewV2 })));
const ScmDeliveryOrderFromSoV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderFromSo").then((m) => ({ default: m.DeliveryOrderFromSo })));
const ScmDeliveryOrderDetailV2 = lazy(() => import("./pages/scm-v2/DeliveryOrderDetailV2").then((m) => ({ default: m.DeliveryOrderDetailV2 })));
const ScmDoLoadScan = lazy(() => import("./pages/scm-v2/DoLoadScan").then((m) => ({ default: m.DoLoadScan })));
const ScmLoadingList = lazy(() => import("./pages/scm-v2/LoadingList").then((m) => ({ default: m.LoadingList })));
const ScmSalesInvoicesV2 = lazy(() => import("./pages/scm-v2/SalesInvoicesListV2").then((m) => ({ default: m.SalesInvoicesListV2 })));
const ScmSalesInvoiceNewV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceNew").then((m) => ({ default: m.SalesInvoiceNew })));
const ScmSalesInvoiceFromDoV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceFromDo").then((m) => ({ default: m.SalesInvoiceFromDo })));
const ScmSalesInvoiceDetailV2 = lazy(() => import("./pages/scm-v2/SalesInvoiceDetailV2").then((m) => ({ default: m.SalesInvoiceDetailV2 })));
const ScmDeliveryReturnsV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnsListV2").then((m) => ({ default: m.DeliveryReturnsListV2 })));
const ScmDeliveryReturnNewV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnNew").then((m) => ({ default: m.DeliveryReturnNew })));
const ScmDeliveryReturnFromDoV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnFromDo").then((m) => ({ default: m.DeliveryReturnFromDo })));
const ScmDeliveryReturnDetailV2 = lazy(() => import("./pages/scm-v2/DeliveryReturnDetailV2").then((m) => ({ default: m.DeliveryReturnDetailV2 })));
const ScmConsignmentOrdersV2 = lazy(() => import("./pages/scm-v2/ConsignmentOrders").then((m) => ({ default: m.ConsignmentOrders })));
const ScmConsignmentOrderNewV2 = lazy(() => import("./pages/scm-v2/ConsignmentOrderNew").then((m) => ({ default: m.ConsignmentOrderNew })));
const ScmConsignmentOrderDetailV2 = lazy(() => import("./pages/scm-v2/ConsignmentOrderDetail").then((m) => ({ default: m.ConsignmentOrderDetail })));
const ScmConsignmentNotesV2 = lazy(() => import("./pages/scm-v2/ConsignmentNotes").then((m) => ({ default: m.ConsignmentNotes })));
const ScmConsignmentNoteNewV2 = lazy(() => import("./pages/scm-v2/ConsignmentNoteNew").then((m) => ({ default: m.ConsignmentNoteNew })));
const ScmConsignmentNoteFromOrderV2 = lazy(() => import("./pages/scm-v2/ConsignmentNoteFromOrder").then((m) => ({ default: m.ConsignmentNoteFromOrder })));
const ScmConsignmentNoteDetailV2 = lazy(() => import("./pages/scm-v2/ConsignmentNoteDetail").then((m) => ({ default: m.ConsignmentNoteDetail })));
const ScmConsignmentReturnsV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturns").then((m) => ({ default: m.ConsignmentReturns })));
const ScmConsignmentReturnNewV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturnNew").then((m) => ({ default: m.ConsignmentReturnNew })));
const ScmConsignmentReturnFromNoteV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturnFromNote").then((m) => ({ default: m.ConsignmentReturnFromNote })));
const ScmConsignmentReturnDetailV2 = lazy(() => import("./pages/scm-v2/ConsignmentReturnDetail").then((m) => ({ default: m.ConsignmentReturnDetail })));
const ScmPurchaseConsignmentOrdersV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentOrders").then((m) => ({ default: m.PurchaseConsignmentOrders })));
const ScmPurchaseConsignmentOrderNewV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentOrderNew").then((m) => ({ default: m.PurchaseConsignmentOrderNew })));
const ScmPurchaseConsignmentOrderDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentOrderDetail").then((m) => ({ default: m.PurchaseConsignmentOrderDetail })));
const ScmPurchaseConsignmentReceivesV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceives").then((m) => ({ default: m.PurchaseConsignmentReceives })));
const ScmPurchaseConsignmentReceiveNewV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceiveNew").then((m) => ({ default: m.PurchaseConsignmentReceiveNew })));
const ScmPurchaseConsignmentReceiveFromOrderV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceiveFromOrder").then((m) => ({ default: m.PurchaseConsignmentReceiveFromOrder })));
const ScmPurchaseConsignmentReceiveDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReceiveDetail").then((m) => ({ default: m.PurchaseConsignmentReceiveDetail })));
const ScmPurchaseConsignmentReturnsV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturns").then((m) => ({ default: m.PurchaseConsignmentReturns })));
const ScmPurchaseConsignmentReturnNewV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturnNew").then((m) => ({ default: m.PurchaseConsignmentReturnNew })));
const ScmPurchaseConsignmentReturnFromReceiveV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturnFromReceive").then((m) => ({ default: m.PurchaseConsignmentReturnFromReceive })));
const ScmPurchaseConsignmentReturnDetailV2 = lazy(() => import("./pages/scm-v2/PurchaseConsignmentReturnDetail").then((m) => ({ default: m.PurchaseConsignmentReturnDetail })));

/**
 * Wraps a route element in a permission check. Failures render the
 * <Forbidden> page inline (URL preserved) so the user understands why
 * they were blocked — see frontend/src/pages/Forbidden.tsx.
 */
/* Field crew get no Assistant at all (owner 2026-07-18: operation EXCEPT
   driver / helper / storekeeper). The route does not MOUNT for them — per the
   house rule that a gated feature is absent, not merely hidden. The backend 403s
   the endpoint independently; this is the UI half, not the control. */
function AssistantGuard({ children }: { children: React.ReactElement }) {
  const { user } = useAuth();
  if (!canUseAssistant(user)) return <Navigate to="/" replace />;
  return children;
}

/* /assr/:id — the EDITABLE board case detail (stage change, field edits, add
   item, archive, close). A non-director Sales rep is redirected to the
   read-only /my-cases/:id view instead: they may raise cases but not edit
   existing ones (owner 2026-07-23). The whole edit surface lives on this detail
   page, so redirecting it is the complete block — the board LIST stays reachable
   (that's their create path) but carries no inline edit. Ops + Sales Directors
   fall through to the editable detail unchanged. */
function SalesRepCaseDetailRoute() {
  const { user } = useAuth();
  const { id } = useParams();
  if (isSalesNonDirector(user) && id) {
    return <Navigate to={`/my-cases/${id}`} replace />;
  }
  return (
    <PageGuard page="service_cases" allowSales>
      <ServiceCaseDetail />
    </PageGuard>
  );
}

function Guard({
  perm,
  anyPerm,
  anyAccess,
  allowSalesDirector = false,
  children,
}: {
  perm?: string;
  anyPerm?: string[];
  /** ADDITIVE page-access OR-gate. When present, the route also passes if
   *  ANY listed page-access key resolves to !== 'none'. Combined with `perm`
   *  / `anyPerm` via OR — used by the SCM routes so a per-position SCM grant
   *  unlocks its area WITHOUT removing the existing `scm.access` / `*` path. */
  anyAccess?: string[];
  /** ADDITIVE code-keyed admittance: a Sales Director (auth/salesAccess.
   *  isSalesDirectorUser) passes even without the flat permission — their
   *  POSITION carries no permission-matrix backfill, so a code-keyed door is the
   *  only one they have. Mirrors PageGuard's allowSalesDirector, which is where
   *  the live users are (/team). /announcements was the last <Guard> caller and
   *  dropped its gate entirely on 2026-07-21 (readable by every active user), so
   *  this prop is currently unused HERE; kept because it is the established
   *  spelling of "admit the Sales Director too" and the next route that needs it
   *  must not invent a second one. */
  allowSalesDirector?: boolean;
  children: React.ReactNode;
}) {
  const { can, pageAccess, user } = useAuth();
  // OR across all provided gates — pass if ANY is satisfied. (Previously each
  // gate could only DENY; with anyAccess the gates are alternatives, so a
  // grant on any one is sufficient.)
  const permOk = perm ? can(perm) : false;
  const anyPermOk = anyPerm ? anyPerm.some((p) => can(p)) : false;
  const anyAccessOk = anyAccess
    ? anyAccess.some((k) => pageAccess(k) !== "none")
    : false;
  if (permOk || anyPermOk || anyAccessOk) return <>{children}</>;
  if (allowSalesDirector && isSalesDirectorUser(user)) return <>{children}</>;
  const label =
    perm ?? anyPerm?.join(" / ") ?? anyAccess?.join(" / ") ?? "access";
  return <Forbidden page={label} />;
}

/**
 * SCM route guard — `scm.access` / `*` keep full access (unchanged); a
 * position granted the mapped SCM page-access area ALSO passes (additive).
 * `area` is one of the scm.<area> page keys. Thin wrapper over <Guard> so the
 * ~75 /scm/* routes stay a one-line change each.
 *
 * `allowSales` (owner rule 2026-07) — mirrors PageGuard's allowSales: a
 * Sales-department user (auth/salesAccess.isSalesStaff) is let through even
 * without the matrix page-access. Set on the Sales-Orders-area routes
 * (list + create + SO detail) AND on the Delivery-Order / Sales-Invoice READ
 * routes (list + detail only, NOT their create routes): the backend row-scopes
 * every read to own + downline (#400/#410, lib/salesScope) and strips cost/margin
 * from non-finance callers, so a salesperson sees the DO/SI generated from their
 * OWN Sales Orders — and nothing else. Safe: opens NO office/finance data.
 */
function ScmGuard({
  area,
  allowSales = false,
  allowDirector = false,
  allowCapability,
  children,
}: {
  area: string;
  allowSales?: boolean;
  /* allowDirector (owner 2026-07-15) — a director (Sales Director / Super Admin /
   * Finance Manager) is let through even without the flat scm matrix row. Set on
   * the /scm HUB so the landing grid opens for directors, matching the sub-pages
   * that already carry allowSales; each card still enforces its own area key. */
  allowDirector?: boolean;
  /* allowCapability (2026-08-25) — admit a holder of this position capability
   * even without the area grant, mirroring the backend area guard's writeBypass.
   * Set on /scm/do-load so a storekeeper holding scm.do.load opens the scan-
   * confirm page though scm.sales.delivery is none; the page's one action still
   * hits the capability-gated status endpoint. */
  allowCapability?: string;
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  if (allowSales && isSalesStaff(user)) return <>{children}</>;
  if (allowDirector && isDirectorUser(user)) return <>{children}</>;
  if (allowCapability && (user?.position_capabilities ?? []).includes(allowCapability))
    return <>{children}</>;
  // SCM hub landing pages (area === "scm": /scm and the six sub-group hubs) are a
  // navigation INDEX, not a data surface — every tile is permission-filtered and
  // each real page still gates on its own area key. Admit any caller who holds ANY
  // scm.* page grant (mirrors the backend requireScmAccess umbrella), even without
  // the broad scm.access permission or a bare `scm` row: a Sales Director has
  // scm.sales=full but scm=none, so opens the hub and sees only their own modules
  // (owner 2026-07-20). Real pages stay individually gated, so this widens no data.
  if (area === "scm" && hasAnyScmPageAccess(user)) return <>{children}</>;
  return (
    <Guard perm="scm.access" anyAccess={[area]}>
      {children}
    </Guard>
  );
}

/**
 * Delivery Returns route guard — Sales-access model. Denies BEFORE mount for
 * ANY Sales-department user — INCLUDING the Sales Director (owner rule, 2026-07:
 * Delivery Returns is hidden from all Sales staff, director too; every OTHER
 * sales-restricted item stays director-visible) — so the page component never
 * mounts and none of its data hooks fire (OFF, not hidden). Everyone else falls
 * through to the normal scm.sales.returns area guard. Also wraps the
 * delivery-return report route (the off-not-hide fix). Backend remains the
 * source of truth; this is nav-consistent defence-in-depth for a typed URL.
 */
function DeliveryReturnsGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (isSalesStaff(user)) return <Forbidden page="scm.sales.returns" />;
  return <ScmGuard area="scm.sales.returns">{children}</ScmGuard>;
}

/**
 * SO Maintenance route guard — gated on the BACKEND's answer,
 * `scm.maintenance.open` (backend services/capabilities.ts, resolved once on
 * /auth/me). A refused caller is Forbidden BEFORE the page mounts, so none of
 * the maintenance data hooks fire (OFF, not hidden).
 *
 * WAS `isDirectorUser(user)`, a FRONTEND re-derivation, and it was the wrong
 * cohort. That predicate resolves {`*`, Super Admin, Sales Director, Finance
 * Manager}. Every write on the page passes houzs-perms.canWriteScmConfig, which
 * admits {`*`, flat-key holders, Procurement/Purchasing, Operation Manager,
 * Operation Executive, Logistic Admin, Super Admin}. The two agree on Super
 * Admin and `*` and disagree about everyone else — so the four positions the
 * owner ruled on 2026-07-18 must be able to DO master-data writes were bounced
 * to <Forbidden> at a door the API would have opened. Fixing the page's
 * read-only banner does not reach this: the banner lives inside a route those
 * positions never mounted.
 *
 * The capability is the union of the write tier and the director read-only tier,
 * so it is ADDITIVE — no one who could open this page before loses it, and the
 * owner's 2026-07-15 exclusion of non-director Sales still holds (the sales
 * cohort satisfies neither term). Pinned in backend/tests/capabilities.test.ts.
 *
 * Same capability drives the SO-list toolbar button (MfgSalesOrdersListV2
 * `canMaintain`) and both mobile sites (MobileApp's menu row + overlay), which
 * is the point: ONE logic layer, computed once, consumed by desktop and phone.
 */
function SoMaintenanceGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  // A signed-in user whose capability set never arrived is a BROKEN DEPLOY, not
  // an unprivileged user. Both deny — failing closed is mandatory — but they
  // must not say the same thing: "you don't have permission" sends the operator
  // to an administrator, who will find nothing wrong with their role.
  if (capabilitiesUnresolved(user)) {
    return (
      <Forbidden
        page="scm.sales.orders"
        reason="We couldn't load your permissions, so this page stayed shut. This is a system problem, not a change to your access — reload the page, and tell IT if it keeps happening."
      />
    );
  }
  if (!capability(user, "scm.maintenance.open")) return <Forbidden page="scm.sales.orders" />;
  return <>{children}</>;
}

/**
 * Fair Report route guard — management + the Sales Director only, mirroring the
 * backend fairReportAccess cohort (auth/salesAccess.canViewFairReport =
 * management OR Sales Director). Ordinary sales / office are Forbidden BEFORE the
 * page mounts, so none of the report's data hooks fire (off, not hidden). The
 * PER-STAGE split (a Sales Director sees the SO tab only) is enforced inside the
 * page via fairAllowedStages, and the backend still 403s every refused stage.
 */
function FairReportGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!canViewFairReport(user)) return <Forbidden page="reports.fair" />;
  return <>{children}</>;
}

export default function App() {
  return (
    <GlobalSearchProvider>
      <NotificationsProvider>
      <BreadcrumbsProvider>
      <BrowserPushSink />
      <AnnouncementBanner />
      <QuickActionsFAB />
      <BackToTopFAB />
      <AssistantPanelProvider>
        <AssistantLauncher />
        <AssistantPanel />
      </AssistantPanelProvider>
      <IosInstallGuide />
      <AndroidInstallGuide />
      <Layout>
        <RouteCrashBoundary>
        <Suspense fallback={<PageSkeleton />}>
        <Routes>
        {/* Landing → Overview workspace home (P1). */}
        <Route path="/" element={<Overview />} />
        <Route
          path="/assr"
          element={
            <PageGuard page="service_cases" allowSales>
              <ServiceCases />
            </PageGuard>
          }
        />
        <Route
          path="/assr/:id"
          element={
            /* allowSales, to match its three siblings (/assr, /my-cases,
               /my-cases/:id) and — the part that actually decides it — to match
               the API. The case-detail read is
               `app.get("/:id{[0-9]+}", requireServiceCaseAccess())`
               (routes/assr.ts), and requireServiceCaseAccess admits Sales via
               canAccessServiceCases → isSalesUser, with the rows still scoped to
               self+downline by assrVisibleUserIds. Without this word a Sales rep
               could open the case LIST, click a row, and hit <Forbidden> on a
               case the backend would have served them.

               A NON-director Sales rep, though, gets bounced to the READ-ONLY
               My Cases detail (below) BEFORE this editable board detail renders
               — owner 2026-07-23: "sales agent 不应该有 edit case 功能". Reps can
               still raise cases (the create panel + FAB stay open to them), but
               every existing case opens read-only. Ops + Sales Directors keep the
               editable board. */
            <SalesRepCaseDetailRoute />
          }
        />
        <Route
          path="/sales"
          element={
            <PageGuard page="sales">
              <Sales />
            </PageGuard>
          }
        />
        <Route
          path="/my-cases"
          element={
            <PageGuard page="service_cases" allowSales>
              <MyCases />
            </PageGuard>
          }
        />
        <Route
          path="/my-cases/:id"
          element={
            <PageGuard page="service_cases" allowSales>
              <>
                <MyCases />
                <MyCaseDetail />
              </>
            </PageGuard>
          }
        />
        <Route
          path="/projects"
          element={
            <PageGuard page="projects">
              <Projects />
            </PageGuard>
          }
        />
        <Route
          path="/projects/:id"
          element={
            <PageGuard page="projects.list">
              <ProjectDetail />
            </PageGuard>
          }
        />
        <Route
          path="/fair-report-fill"
          element={
            <PageGuard page="projects">
              <FairReportFill />
            </PageGuard>
          }
        />
        <Route
          path="/setup-invoice"
          element={
            <PageGuard page="projects">
              <SetupInvoiceFill />
            </PageGuard>
          }
        />
        <Route
          path="/schedule-reconcile"
          element={
            <PageGuard page="projects">
              <ScheduleReconcile />
            </PageGuard>
          }
        />
        <Route
          path="/settings"
          element={
            <PageGuard page="settings" minLevel="full">
              <Settings />
            </PageGuard>
          }
        />
        {/* Agent console — owner/IT only (wildcard). Runtime governance for the
            agent fleet: pause/kill, autonomy gates, proposals + findings, the
            learned-tuning approvals, and the per-agent teaching notebook. */}
        <Route path="/agents" element={<Guard anyPerm={["*"]}><Agents /></Guard>} />
        {/* No permission gate: the Assistant is open to every authenticated staff
            member, and what each may SEE is scoped server-side per position
            (services/assistant-scope.ts). Gating the door again here would only
            hide the feature from the people the scoping already protects. */}
        <Route path="/assistant" element={<AssistantGuard><Assistant /></AssistantGuard>} />
        <Route
          path="/system-health"
          element={
            <PageGuard page="system_health">
              <SystemHealth />
            </PageGuard>
          }
        />
        {/* AutoCount Sync — the read of scm.autocount_outbox. Gated on the same
            two keys the endpoint accepts, so the nav row, this door and the
            server all agree; the server is still the boundary. */}
        <Route
          path="/autocount-sync"
          element={
            <Guard anyPerm={["*", "scm.autocount.read", "settings.manage"]}>
              <AutoCountSync />
            </Guard>
          }
        />
        <Route
          path="/team"
          element={
            <PageGuard page="team" allowSalesDirector>
              <Team />
            </PageGuard>
          }
        />
        {/* ── Announcements — office-wide notices + read receipts. NO permission
            gate (owner restated 2026-07-21: announcements are readable by EVERY
            active user), so this is a bare route like / and /profile — the whole
            tree already sits inside <AuthGate>, which is the authentication the
            page needs. It used to be `<Guard perm="announcements.read">`, but
            that verb is the ADMIN list/composer permission an ordinary
            salesperson never holds, so the notice pop-up's "Read SOP" /
            "View details" button landed them on Forbidden. The mobile shell
            already showed the same screen to everyone; this closes the desktop
            half. Nothing leaks: GET /api/announcements audience-filters a
            non-manager caller to the live notices addressed to them (the same
            filter /banner has always run), and every write action on the page
            keys off `canWrite` = announcements.write / Sales Director, which the
            backend re-checks. ── */}
        <Route path="/announcements" element={<Announcements />} />
        {/* Fleet Health — Fleet Maintenance & Compliance Phase 1 dashboard.
            Gated on the flat fleet.read permission; fleet.write covers the
            mutations (backend re-checks). Desktop ops screen. */}
        <Route path="/fleet-health" element={<Guard perm="fleet.read"><FleetHealth /></Guard>} />
        {/* One lorry's FULL record. The Fleet Health drawer is the quick look —
            "can I use this today" — and everything else lives here (owner
            2026-08-02: "要不然界面会显得非常乱"). Same fleet.read gate. */}
        <Route path="/fleet-health/:lorryId" element={<Guard perm="fleet.read"><LorryRecord /></Guard>} />
        {/* ── Mail Center — shared inbox. Permission-gated on mail_center.read
            (the per-user mailbox scope is enforced server-side; reads/replies
            aren't gated by a permission key, only by mailbox ownership). The
            literal /mail-center route precedes /mail-center/:id. Compose is a
            modal opened from the inbox, not its own route. ── */}
        <Route
          path="/mail-center"
          element={
            <Guard perm="mail_center.read">
              <MailInbox />
            </Guard>
          }
        />
        <Route
          path="/mail-center/:id"
          element={
            <Guard perm="mail_center.read">
              <MailThread />
            </Guard>
          }
        />
        {/* ── Supply Chain (vendored 2990's SCM) — scm.access-gated /scm/*;
            Owner / IT Admin pass via their "*" wildcard (can() short-circuits "*"). ── */}
        <Route
          path="/scm/suppliers"
          element={
            <ScmGuard area="scm.procurement.suppliers">
              <ScmSuppliersV2 />
            </ScmGuard>
          }
        />
        {/* Vendored 2990's Purchase Order pages. /new + /from-so precede /:id so
            the literal segments match before the param route. Each page is wrapped
            in <Scm2990Shell> for the Notify/Confirm/dialog-service providers. */}
        <Route path="/scm/purchase-orders" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-orders/new" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-orders/from-so" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrderFromSoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-orders/:id" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPurchaseOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* PO amendment / revision queue + job card (Houzs, mig 0192). Same
            Procurement-PO area guard as the Purchase Orders list; the finer
            scm.po_amendment.* gates layer on inside the pages + backend. The
            literal /po-amendments segments precede the PO /:id route above only
            in the sidebar sense — routes are matched exactly, so order is safe. */}
        <Route path="/scm/po-amendments" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPoAmendmentsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/po-amendments/:id" element={<ScmGuard area="scm.procurement.po"><Scm2990Shell><ScmPoAmendmentDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Vendored 2990's MRP + read/list pages. Each wrapped in <Scm2990Shell>.
            product-models list precedes /:id so the literal segment matches first. */}
        <Route path="/scm/mrp" element={<ScmGuard area="scm.procurement.mrp"><Scm2990Shell><ScmMrpV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/accounting" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmAccountingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/daily-bank" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmDailyBank /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/merchant-recon" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmMerchantRecon /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/bank-recon" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmBankRecon /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/settlement-setup" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmSettlementSetup /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/outstanding" element={<ScmGuard area="scm.finance.outstanding"><Scm2990Shell><ScmOutstandingV2 /></Scm2990Shell></ScmGuard>} />
        {/* Delivered-but-not-billed, aged. Same area key as Outstanding — it is the
            money answer to the question that page's DO tab asks with a status flag. */}
        <Route path="/scm/unbilled-deliveries" element={<ScmGuard area="scm.finance.outstanding"><Scm2990Shell><ScmUnbilledDeliveriesV2 /></Scm2990Shell></ScmGuard>} />
        {/* Currencies master (Phase 1-A FX) — owner-maintained currency + rate
            table feeding the GRN / PI / PV foreign-currency posting. Gated on the
            flat scm.currency.manage permission (Owner / IT Admin cover it via *). */}
        <Route path="/scm/currencies" element={<Guard anyPerm={["*", "scm.currency.manage"]}><Scm2990Shell><ScmCurrenciesV2 /></Scm2990Shell></Guard>} />
        <Route path="/scm/fabric-tracking" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmFabricTrackingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/loading-list" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmLoadingList /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/warehouses" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmWarehousesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/warehouses/racks" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmWarehouseRacksV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/products" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/categories" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmCategoriesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/product-models" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductModelsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/product-models/:id" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductModelDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* TEMP — vendored 2990's GRN + Purchase Invoice pages (wave 3), parallel
            to the native /scm/* below. Each wrapped in <Scm2990Shell>. Literal
            segments (/new, /from-po, /from-grn) precede /:id so they match first. */}
        <Route path="/scm/grns" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGoodsReceivedV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/grns/new" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGrnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/grns/from-po" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGrnFromPoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/grns/:id" element={<ScmGuard area="scm.procurement.grn"><Scm2990Shell><ScmGoodsReceivedDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoicesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices/new" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoiceNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices/from-grn" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoiceFromGrnV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-invoices/:id" element={<ScmGuard area="scm.procurement.pi"><Scm2990Shell><ScmPurchaseInvoiceDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Payment Vouchers — standalone AP cash-out doc (port of 2990 0189/0202,
            Phase 1-B MYR). Gated on the finance area; /new precedes /:id. */}
        <Route path="/scm/payment-vouchers" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmPaymentVouchersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/payment-vouchers/new" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmPaymentVoucherNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/payment-vouchers/scan" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmPaymentVoucherScanV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/payment-vouchers/:id" element={<ScmGuard area="scm.finance.accounting"><Scm2990Shell><ScmPaymentVoucherDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* TEMP — vendored 2990's stock-movement pages (wave 4: Adjustments /
            Transfers / Takes), parallel to the native /scm/* below. Each wrapped
            in <Scm2990Shell>. Literal /new precedes /:id so it matches first. */}
        {/* Adjustment writes hit POST /inventory/adjustments, now gated on
            scm.warehouse.adjustments server-side by its own area-guard sub-mount
            (scm/index.ts) — split off inventory-view because adjusting changes
            valuation. Guard the route on that same key so a position with
            inventory-view but no adjustments grant reaches Inventory, not this. */}
        <Route path="/scm/stock-adjustments" element={<ScmGuard area="scm.warehouse.adjustments"><Scm2990Shell><ScmStockAdjustmentsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-adjustments/new" element={<ScmGuard area="scm.warehouse.adjustments"><Scm2990Shell><ScmStockAdjustmentNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-transfers" element={<ScmGuard area="scm.warehouse.transfers"><Scm2990Shell><ScmStockTransfersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-transfers/new" element={<ScmGuard area="scm.warehouse.transfers"><Scm2990Shell><ScmStockTransferNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-transfers/:id" element={<ScmGuard area="scm.warehouse.transfers"><Scm2990Shell><ScmStockTransferDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-takes" element={<ScmGuard area="scm.warehouse.stock_take"><Scm2990Shell><ScmStockTakesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-takes/new" element={<ScmGuard area="scm.warehouse.stock_take"><Scm2990Shell><ScmStockTakeNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/stock-takes/:id" element={<ScmGuard area="scm.warehouse.stock_take"><Scm2990Shell><ScmStockTakeDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* HR / Commission. Flat <Guard>, NOT <ScmGuard>: HR has no L2 page-access
            area, and the report returns every colleague's pay — it must not ride
            the broad scm.access umbrella. Same two keys the backend checks.
            Settings takes scm.hr.manage alone: without it every control on the
            page 403s, so a read-only holder gets the report instead.

            scm.hr.close / scm.hr.reopen are NOT route keys. They gate the two
            payout-approval buttons inside the Commission page and are checked
            there; a holder of either still needs scm.hr.read to get in, because
            the API will not show them the period to approve. */}
        <Route path="/scm/hr/commission" element={<Guard anyPerm={["*", "scm.hr.read", "scm.hr.manage"]}><Scm2990Shell><ScmHrCommission /></Scm2990Shell></Guard>} />
        <Route path="/scm/hr/settings" element={<Guard anyPerm={["*", "scm.hr.manage"]}><Scm2990Shell><ScmHrSettings /></Scm2990Shell></Guard>} />
        {/* TEMP — vendored 2990's PR / Inventory / Stock Card / Supplier Detail /
            Drivers pages (this wave), parallel to the native /scm/* below. Each
            wrapped in <Scm2990Shell>. Literal segments (/new, /stock-card)
            precede the /:id routes so they match first. */}
        <Route path="/scm/purchase-returns" element={<ScmGuard area="scm.procurement.pr"><Scm2990Shell><ScmPurchaseReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-returns/new" element={<ScmGuard area="scm.procurement.pr"><Scm2990Shell><ScmPurchaseReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-returns/:id" element={<ScmGuard area="scm.procurement.pr"><Scm2990Shell><ScmPurchaseReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/inventory" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmInventoryV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/inventory/stock-card/:itemCode" element={<ScmGuard area="scm.warehouse.inventory"><Scm2990Shell><ScmStockCardV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/suppliers/:id" element={<ScmGuard area="scm.procurement.suppliers"><Scm2990Shell><ScmSupplierDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* /scm/drivers is RETIRED (owner 2026-07-17: "fleet 里面也是有 driver，
            所以我都不需要多一个 driver"). Its page is now the Drivers section of
            /scm/fleet, which carries the same scm.transportation.drivers gate.
            Route deliberately NOT mounted — "off, not hide": no nav entry, no
            route, no prefetch, so nothing mounts and no query fires. The file
            pages/scm-v2/Drivers.tsx is KEPT on disk (vendored 2990 tree shape)
            but has no importer. Do not re-add this route. */}
        {/* Delivery Planning + TMS Stage 3 — all under the existing scm.transportation.drivers area. */}
        <Route path="/scm/delivery-planning"         element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryPlanningV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/dp-orders"                 element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDpOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/trips"                     element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmTrips /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-planning-regions" element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryPlanningRegionsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-residence-rules"  element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryResidenceRulesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-zones"            element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryZonesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-rate-cards"       element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryRateCardsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/auto-schedule"             element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmAutoScheduleV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/driver-leave"              element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDriverLeaveV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/threepl-companies"         element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmThreePLCompaniesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/fleet"                     element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmFleetV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-maintenance"      element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmDeliveryMaintenanceV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/lorry-capacity"            element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmLorryCapacityV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/fleet-day"                 element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmFleetDayV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/fleet-run-sheet"           element={<ScmGuard area="scm.transportation.drivers"><Scm2990Shell><ScmFleetRunSheetV2 /></Scm2990Shell></ScmGuard>} />
        {/* Supply Chain Hub — section landing page (main app layout, NOT the 2990 shell). */}
        <Route path="/scm" element={<ScmGuard area="scm" allowDirector><ScmHub /></ScmGuard>} />
        {/* Nick 2026-07-09 — Level 2 sub-group hubs (mirror /projects?view=hub).
            Each renders NAV_TABS children of the corresponding scm sub-group as
            a card grid. Same ScmGuard as ScmHub — a role with any SCM access
            passes; per-card visibility inside the hub is filtered against
            NAV_TABS' own permission fields. */}
        <Route path="/scm/sales-order"    element={<ScmGuard area="scm"><ScmSubgroupHub groupId="scm-sales"          description="Pick a section — sales orders, delivery orders, invoices or returns." /></ScmGuard>} />
        <Route path="/scm/consignment"    element={<ScmGuard area="scm"><ScmSubgroupHub groupId="scm-consignment"    description="Consignment flow — orders, notes, returns and their purchase-side counterparts." /></ScmGuard>} />
        <Route path="/scm/procurement"    element={<ScmGuard area="scm"><ScmSubgroupHub groupId="scm-procurement"    description="Procurement flow — products, suppliers, MRP, POs, receipts, invoices and returns." /></ScmGuard>} />
        <Route path="/scm/transportation" element={<ScmGuard area="scm"><ScmSubgroupHub groupId="scm-transportation" description="Delivery planning, fleet, lorry capacity, drivers and regions." /></ScmGuard>} />
        <Route path="/scm/warehouse"      element={<ScmGuard area="scm"><ScmSubgroupHub groupId="scm-warehouse"      description="Warehouses, inventory, adjustments, transfers and stock take." /></ScmGuard>} />
        <Route path="/scm/finance"        element={<ScmGuard area="scm"><ScmSubgroupHub groupId="scm-finance"        description="Accounting and outstanding receivables." /></ScmGuard>} />
        {/* Sales Orders READ side (vendored). The literal /maintenance route
            MUST precede /:docNo so 'maintenance' isn't caught as a doc number.
            2990 uses :docNo (not :id) for the SO detail. */}
        <Route path="/scm/sales-orders" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmSalesOrdersV2 /></Scm2990Shell></ScmGuard>} />
        {/* SO amendment / revision queue (Phase 1-C). Sales-Orders-area surface —
            same ScmGuard + allowSales as the Sales Orders list, so a salesperson
            reaches their own amendments (Owner 2026-07-16); the backend scopes the
            list/detail to their own+downline SOs. Directors / office / `*` and any
            amendment-perm holder pass via the area key. */}
        <Route path="/scm/amendments" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmAmendmentsV2 /></Scm2990Shell></ScmGuard>} />
        {/* Amendment job card — before/after diff detail for one revision. Same
            guard as the queue; reached by double-clicking a queue row. */}
        <Route path="/scm/amendments/:id" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmAmendmentDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/maintenance" element={<SoMaintenanceGuard><Scm2990Shell><ScmSalesOrderMaintenanceV2 /></Scm2990Shell></SoMaintenanceGuard>} />
        {/* Literal /new + /generate MUST precede /:docNo so they match first.
            All Sales-Orders-area routes carry allowSales so a rep reaches their
            own SO list / create / detail without the matrix page-access. */}
        <Route path="/scm/sales-orders/new" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmSalesOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/new/guided" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmSalesOrderNewGuidedV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/new/from-products" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmSalesOrderNewFromProductsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/generate" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmSoFromProductsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-orders/:docNo" element={<ScmGuard area="scm.sales.orders" allowSales><Scm2990Shell><ScmSalesOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* SCM Reports v2 — AutoCount-style detail listings. Each wrapped in <Scm2990Shell>. */}
        <Route path="/scm/reports/sales-order-detail-listing" element={<ScmGuard area="scm.sales.orders"><Scm2990Shell><ScmSoDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/reports/delivery-order-detail-listing" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDoDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/reports/sales-invoice-detail-listing" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSiDetailListingV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/reports/delivery-return-detail-listing" element={<DeliveryReturnsGuard><Scm2990Shell><ScmDrDetailListingV2 /></Scm2990Shell></DeliveryReturnsGuard>} />
        {/* Fair Report — exhibition-performance report (SO / DO / Invoice stages).
            Top-level /reports/* (not nested under /scm) so it reads as a clean
            management report, not a deep SCM leaf. Management + Sales Director
            only (FairReportGuard mirrors the backend fairReportAccess cohort). */}
        <Route path="/reports/fair-report" element={<FairReportGuard><Scm2990Shell><FairReportV2 /></Scm2990Shell></FairReportGuard>} />
        {/* allowSales — a salesperson READS the DO list/detail generated from
            their own SOs (backend row-scopes own+downline, strips cost/margin).
            Create routes below deliberately OMIT allowSales (read-only). */}
        <Route path="/scm/delivery-orders" element={<ScmGuard area="scm.sales.delivery" allowSales><Scm2990Shell><ScmDeliveryOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders/new" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDeliveryOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders/from-so" element={<ScmGuard area="scm.sales.delivery"><Scm2990Shell><ScmDeliveryOrderFromSoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-orders/:id" element={<ScmGuard area="scm.sales.delivery" allowSales><Scm2990Shell><ScmDeliveryOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* The DO print's "SCAN · MARK LOADED" QR lands here (warehouse loading confirmation). */}
        <Route path="/scm/do-load" element={<ScmGuard area="scm.sales.delivery" allowSales allowCapability="scm.do.load"><Scm2990Shell><ScmDoLoadScan /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices" element={<ScmGuard area="scm.sales.invoices" allowSales><Scm2990Shell><ScmSalesInvoicesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices/new" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSalesInvoiceNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices/from-do" element={<ScmGuard area="scm.sales.invoices"><Scm2990Shell><ScmSalesInvoiceFromDoV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/sales-invoices/:id" element={<ScmGuard area="scm.sales.invoices" allowSales><Scm2990Shell><ScmSalesInvoiceDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/delivery-returns" element={<DeliveryReturnsGuard><Scm2990Shell><ScmDeliveryReturnsV2 /></Scm2990Shell></DeliveryReturnsGuard>} />
        <Route path="/scm/delivery-returns/new" element={<DeliveryReturnsGuard><Scm2990Shell><ScmDeliveryReturnNewV2 /></Scm2990Shell></DeliveryReturnsGuard>} />
        <Route path="/scm/delivery-returns/from-do" element={<DeliveryReturnsGuard><Scm2990Shell><ScmDeliveryReturnFromDoV2 /></Scm2990Shell></DeliveryReturnsGuard>} />
        <Route path="/scm/delivery-returns/:id" element={<DeliveryReturnsGuard><Scm2990Shell><ScmDeliveryReturnDetailV2 /></Scm2990Shell></DeliveryReturnsGuard>} />
        <Route path="/scm/consignment-orders" element={<ScmGuard area="scm.consignment.orders"><Scm2990Shell><ScmConsignmentOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-orders/new" element={<ScmGuard area="scm.consignment.orders"><Scm2990Shell><ScmConsignmentOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-orders/:docNo" element={<ScmGuard area="scm.consignment.orders"><Scm2990Shell><ScmConsignmentOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNotesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes/new" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNoteNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes/from-order" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNoteFromOrderV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-notes/:id" element={<ScmGuard area="scm.consignment.notes"><Scm2990Shell><ScmConsignmentNoteDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Consignment Returns (DR-clone) + Purchase Consignment Orders (PO-clone),
            vendored 2990 pages wrapped in <Scm2990Shell>. Literal segments
            (/new, /from-note) precede /:id so they match first. */}
        <Route path="/scm/consignment-returns" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-returns/new" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-returns/from-note" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnFromNoteV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/consignment-returns/:id" element={<ScmGuard area="scm.consignment.returns"><Scm2990Shell><ScmConsignmentReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-orders" element={<ScmGuard area="scm.consignment.po_orders"><Scm2990Shell><ScmPurchaseConsignmentOrdersV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-orders/new" element={<ScmGuard area="scm.consignment.po_orders"><Scm2990Shell><ScmPurchaseConsignmentOrderNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-orders/:id" element={<ScmGuard area="scm.consignment.po_orders"><Scm2990Shell><ScmPurchaseConsignmentOrderDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceivesV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives/new" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceiveNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives/from-pc-order" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceiveFromOrderV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-receives/:id" element={<ScmGuard area="scm.consignment.po_receives"><Scm2990Shell><ScmPurchaseConsignmentReceiveDetailV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnsV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns/new" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnNewV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns/from-receive" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnFromReceiveV2 /></Scm2990Shell></ScmGuard>} />
        <Route path="/scm/purchase-consignment-returns/:id" element={<ScmGuard area="scm.consignment.po_returns"><Scm2990Shell><ScmPurchaseConsignmentReturnDetailV2 /></Scm2990Shell></ScmGuard>} />
        {/* Maintenance — no standalone vendored page; the vendored Products page
            hosts the Maintenance tab. The "Maintenance" nav item resolves here. */}
        <Route path="/scm/maintenance" element={<ScmGuard area="scm.procurement.products"><Scm2990Shell><ScmProductsV2 /></Scm2990Shell></ScmGuard>} />
        {/* Inbox — the mobile bottom-nav Inbox tab + the desktop bell's
            "view all" land here. Reuses the shared NotificationsProvider
            feed. Gated on projects.read (same gate as the bell + the mobile
            menu's Inbox card). */}
        <Route
          path="/notifications"
          element={
            <Guard perm="projects.read">
              <Notifications />
            </Guard>
          }
        />
        {/* Legacy /roles → Team page's Roles tab */}
        <Route
          path="/roles"
          element={<Navigate to="/team?tab=roles" replace />}
        />
        <Route path="/profile" element={<Profile />} />
        {/* URL standardisation, step 1 (owner 2026-07 "整個讓系統更加
            standardise"): make reasonable-but-wrong path guesses resolve
            instead of 404-ing — chiefly a missing or spurious `/scm` prefix.
            Purely additive: nothing is renamed or removed, and each alias
            grants no access of its own since the destination route's guard
            still runs. See lib/routeAliases.ts for why no path is renamed. */}
        {ROUTE_ALIASES.map((a) => (
          <Route key={a.from} path={a.from} element={<AliasRedirect to={a.to} />} />
        ))}
        <Route path="*" element={<Forbidden kind="not-found" />} />
        </Routes>
        </Suspense>
        </RouteCrashBoundary>
      </Layout>
      </BreadcrumbsProvider>
      </NotificationsProvider>
    </GlobalSearchProvider>
  );
}
