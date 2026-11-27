import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { pollEtag, POLLED_LIST_PATHS } from "./middleware/pollEtag";
import type { Env, ScanQueueMessage } from "./types";
import { GIT_SHA, resolveBuildSha } from "./build-info";
import { restKeyClaims, restUrlRef } from "./db/rest-key-claims";
import { auth, requirePermission, requireAnyPermission, requireHrRead, requireScmAccess, requirePageAccessOrSalesView, requirePageAccess } from "./middleware/auth";
import { TRANSIENT_CONN_RE } from "./db/d1-compat";
import scmApp from "./scm";
import { publicScmImages } from "./scm/routes/public-images";
import { idempotency } from "./middleware/idempotency";
import { requestLog } from "./middleware/requestLog";
import { captureError, describeErrorForLog } from "./services/errorTracking";
import assr from "./routes/assr";
import logs from "./routes/logs";
import auditRoutes from "./routes/audit";
import systemHealthRoutes from "./routes/systemHealth";
import aiUsageRoutes from "./routes/aiUsage";
import ocrDashboardRoutes from "./routes/ocrDashboard";
import clientErrors from "./routes/clientErrors";
import udf from "./routes/udf";
import authRoutes from "./routes/auth";
import totpRoutes from "./routes/totp";
import users from "./routes/users";
import fieldPinAdmin from "./routes/fieldPinAdmin";
import roles from "./routes/roles";
import positions from "./routes/positions";
import positionCapabilities from "./routes/position-capabilities";
import positionPolicy from "./routes/position-policy";
import departments from "./routes/departments";
import documentRefs from "./routes/documentRefs";
import companies from "./routes/companies";
import tableLayouts from "./routes/tableLayouts";
import notifications from "./routes/notifications";
import badgeCounts, { setBadgeDispatch } from "./routes/badgeCounts";
import pushDevices from "./routes/push";
import itSupport from "./routes/itSupport";
import mcpRoutes, { mcpWellKnown, setMcpApp } from "./routes/mcp";
import mcpAdminRoutes from "./routes/mcpAdmin";
import { mcpBriefPublic } from "./routes/mcpBrief";
import { runAlerts, runBriefs } from "./services/mcp-proactive-run";
import meetings, { publicMeetings } from "./routes/meetings";
import { MEETINGS_DIRECTORY_JOB, pushMeetingsDirectory } from "./services/meetingsDirectory";
import { sendAiUsageToHub } from "./services/aiUsageHub";
import { HEALTH_HUB_JOB, sendHealthReportToHub } from "./services/healthHub";
import { runPushFleetReminders } from "./services/pushFleetReminders";
import presence from "./routes/presence";
import projects from "./routes/projects";
import { projectSalesOrders } from "./routes/project-sales-orders";
import { projectSalesBills } from "./routes/project-sales-bills";
import { projectPosSales } from "./routes/project-pos-sales";
import { posAdmin } from "./routes/pos-admin";
import { hr as hrEmployees } from "./routes/hr";
import { hrAttendance } from "./routes/hr-attendance";
import { hrLabor } from "./routes/hr-labor";
import { hrPayroll } from "./routes/hr-payroll";
import { hrTripPay } from "./routes/hr-trip-pay";
import { hrKpi } from "./routes/hr-kpi";
import { hrShifts } from "./routes/hr-shifts";
import { runNightlyTripSync } from "./routes/lib/hr-trip-sync";
import { attendance } from "./routes/attendance";
import { runAutoClockOut } from "./routes/lib/hr-labor-store";
import { posDevice } from "./routes/pos-device";
import projectsOutstanding from "./routes/projectsOutstanding";
import projectsDefectList from "./routes/projectsDefectList";
import projectsCalendarSearch from "./routes/projectsCalendarSearch";
import { projectDataGaps } from "./routes/projectDataGaps";
import { projectOverview } from "./routes/projectOverview";
import assrQuality from "./routes/assrQuality";
import { isFinanceViewer } from "./services/pmsAccess";
import type { AuthUser } from "./services/auth";
import sales from "./routes/sales";
import finance from "./routes/finance";
import stockItems from "./routes/stockItems";
import fleet from "./routes/fleet";
import fleetMaintenance from "./scm/routes/fleet-maintenance";
import { fleetWorkOrderPhotos } from "./scm/routes/fleet-work-order-photos";
import { fleetPlanService } from "./scm/routes/fleet-plan-service";
import { fleetOffRoad } from "./scm/routes/fleet-off-road";
import fleetWorkOrderFiles from "./scm/routes/fleet-work-order-files";
import fleetBreakdownFiles from "./scm/routes/fleet-breakdown-files";
import settings from "./routes/settings";
import branding from "./routes/branding";
import inbox, { bustInboxForUser } from "./routes/inbox";
import projectsPrint from "./routes/projects_print";
import search from "./routes/search";
import assrPrint from "./routes/assr_print";
import assrPortal from "./routes/assrPortal";
import assrFormIntake from "./routes/assrFormIntake";
import deliverySheetSync from "./routes/deliverySheetSync";
import chatCallback from "./routes/chatCallback";
import connectPayments from "./routes/connect-payments";
import survey from "./routes/survey";
import track from "./routes/track";
import portal from "./routes/portal";
import supplierPortal from "./routes/supplierPortal";
import mailCenter from "./routes/mail-center";
import mailInbound from "./routes/mail-inbound";
import mailAcks from "./routes/mail-acks";
import mailAccessLog from "./routes/mail-access-log";
import mailReplyGuard from "./routes/mail-reply-guard";
import mailPersonal from "./routes/mail-personal";
import mailSenders from "./routes/mail-senders";
import mailClaim from "./routes/mail-claim";
import { soMirror } from "./scm/routes/so-mirror";
import { drainCommands } from "./scm/lib/amendment-command";
import { drainStockAllocationRecompute } from "./scm/lib/stock-allocation-job";
import { drainAutoCountOutbox } from "./scm/lib/autocount-outbox";
import {
  drainVenturePortalOutbox,
  reconcileVenturePortalOutbox,
} from "./scm/lib/venture-portal-outbox";
import { runScheduledConnectSync } from "./scm/lib/connect-contact-sync";
import { pushVenturePortalCatalogue } from "./scm/lib/venture-portal-catalogue";
import { pushVenturePortalAttendance } from "./scm/lib/venture-portal-attendance";
import { venturePortalKick } from "./scm/lib/venture-portal-kick";
import { reconcilePendingFairs } from "./scm/lib/fair-reconcile";
import { claimReportedOrders } from "./scm/lib/fair-claim";
import { autoReadBills } from "./scm/lib/threepl-bill-import";
import { relinkHeldBackSweep } from "./scm/lib/autocount-relink-sweep";
import { deliveryDateSweep } from "./scm/lib/autocount-delivery-date-sweep";
import { refreshAllMrpSnapshots } from "./scm/lib/mrp-snapshot";
import { deliverDueShippedOrders } from "./scm/lib/deliver-due-shipped";
import { refreshProcurementOverviewSnapshots } from "./scm/routes/procurement-overview";
import { amendmentMirror } from "./scm/routes/amendment-mirror";
import { customerMirror } from "./scm/routes/customer-mirror";
import { staffMirror } from "./scm/routes/staff-mirror";
import { warehouseMirror } from "./scm/routes/warehouse-mirror";
import pos from "./routes/pos";
import announcements from "./routes/announcements";
import announcementReceipts from "./routes/announcementReceipts";
import announcementApproval from "./routes/announcementApproval";
import memos from "./routes/memos";
import agentConsole from "./routes/agent-console";
import assistant from "./routes/assistant";
import { caseTrack } from "./middleware/caseTrack";
import { supplierTrack } from "./middleware/supplierTrack";
import { dbInject, withPgDb } from "./middleware/db";
import { companyContext } from "./middleware/companyContext";
import { publicDoScan } from "./routes/publicDoScan";
import { publicContractorCalendar } from "./routes/publicContractorCalendar";
import { publicBrandCalendar } from "./routes/publicBrandCalendar";
import { brandShare } from "./routes/brandShare";
import { projectForecast } from "./routes/projectForecast";
import { drainEmailOutbox } from "./services/email";
import { sendAllMeetingMail } from "./services/meetingMail";
import { backfillOutboundMessageIds } from "./lib/mail-threading";
import { DELIVERY_REFRESH_LIMIT, refreshOutboundDelivery } from "./lib/mail-delivery";
import { pollVelocity } from "./scm/lib/velocity-poll";
import { pollItrack } from "./scm/lib/itrack-poll";
import { runMailAckEscalation } from "./lib/mail-acks";
import { runClientErrorDigest } from "./services/clientErrors";
import { runSlaEscalation } from "./services/assrEscalation";
import { runAssrAlerts, runAssrDailyDigest } from "./services/assrAlerts";
import { runWeeklyServiceCaseStatus } from "./services/assrWeeklyStatus";
import { runOverdueEscalation } from "./services/announcementEscalation";
import { runScheduledLeadTimeActivations } from "./services/assrLeadTime";
import { runProjectDueReminders } from "./services/projectReminders";
import { runPosAlerts } from "./services/posAlerts";
import { distillAllSalespersonRules, warmCatalogCacheForCron, processScanQueueMessage, processDistillQueueMessage } from "./scm/routes/scan-so";
import { processAiReadQueueMessage } from "./scm/lib/ai-read-runners";
import { CLAUDE_MODEL } from "./scm/lib/scan-ocr";
import { runAgentHeartbeat } from "./services/agent-scheduler";
import { getSupabaseService } from "./db/supabase";
import { sweepStockClose } from "./acc/stock-close";
import { sweepCommissionRelease } from "./acc/commission-release";
import { retryOpenDoStamps } from "./scm/lib/do-shipped-from-retry";
import { INTEGRITY_JOB, runNightlyIntegrity } from "./services/nightlyIntegrityRun";
import { JOB_ALERTS_JOB, runJobFailureAlerts } from "./services/jobFailureAlerts";
import { withAfterResponse } from "./lib/after-response";
import { computeDayRoutes } from "./scm/lib/lorry-day-runs";
import { sweepSelfCheck } from "./scm/routes/accounting-self-check";
import { applyDueSupplierPrices } from "./scm/lib/supplier-price-apply";
import { todayMyt } from "./scm/lib/my-time";
import { reapOnce } from "./scm/lib/reaper";
import { getBranding } from "./services/branding";
import { runPull } from "./services/pull";
import { runDoMirrorSync } from "./services/doMirror";
import { runPOPull, runPODocsPull } from "./services/po";
import { runSOSnapshot, runPOSnapshot } from "./services/acSnapshot";
import { isAutoCountSyncDisabled } from "./services/autocount";
import { jobTracker, purgeOldJobRuns } from "./services/jobRuns";
import { pruneFailedLogins } from "./services/failedLogins";
import { bustProjectOverviewOnWrite } from "./routes/lib/project-overview-bust";

const app = new Hono<{ Bindings: Env }>();

const inboxBustAfterWrite: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.req.method === "GET") return;
  if (c.res.status >= 200 && c.res.status < 300) {
    const uid = c.get("user")?.id;
    if (uid != null) await bustInboxForUser(c.env, uid);
  }
};

app.use("*", requestLog);
app.use("*", async (c, next) => {
  let waitUntil: ((p: Promise<unknown>) => void) | null = null;
  try { waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx); } catch { }
  return waitUntil ? withAfterResponse(waitUntil, () => next()) : next();
});

function corsOriginAllowed(origin: string | undefined | null): string | undefined {
  if (!origin) return undefined;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const ok =
    host === "houzscentury.com" ||
    host.endsWith(".houzscentury.com") ||
    host === "2990shome.com" ||
    host.endsWith(".2990shome.com") ||
    /^([a-z0-9-]+\.)?houzs-erp(-staging)?\.pages\.dev$/.test(host) ||
    /^([a-z0-9-]+\.)?2990s-pos\.pages\.dev$/.test(host) ||
    host === "localhost" ||
    host === "127.0.0.1";
  return ok ? origin : undefined;
}
/* X-Session-Pass is EXPOSED because the middleware re-issues a pass on the
   authoritative path and the SPA has to be able to read it back — a header the
   browser hides is a renewal that silently never happens. It carries no secret:
   the pass is signed, token-bound and revocable, and the client already holds it.
   docs/bugs/0593-*. */
app.use("*", cors({ origin: corsOriginAllowed, exposeHeaders: ["X-Request-Id", "X-Company-Code", "X-Session-Pass", "Server-Timing"] }));

app.use(
  "*",
  secureHeaders({
    strictTransportSecurity: "max-age=15552000",
    xFrameOptions: "SAMEORIGIN",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    xPermittedCrossDomainPolicies: false,
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
  }),
);

app.use("*", dbInject);

app.get("/", (c) => c.json({ ok: true, service: "autocount-sync-api" }));
// `sha` is the commit this Worker was built from — the deploy-watchdog compares
// it to main to catch a rogue/stale overwrite of prod. It now comes from the
// bundled build stamp (build-info.ts, baked at deploy time), which — unlike the
// old `--var GIT_SHA` env var — cannot be dropped by the post-deploy secret step
// (see build-info.ts for the 2026-09-01 null-stamp incident). The env var is
// kept as a fallback for any Worker still on the old mechanism; "dev" is the
// un-stamped local placeholder and reports as no stamp (null).
// `rest_role` / `rest_ref` say what the configured PostgREST key IS — the role
// claim and project ref read off the key itself (db/rest-key-claims.ts). On
// staging the service-role secret held an anon-role key for three weeks and
// every table read worked while every VIEW read said "permission denied";
// nothing on any surface named the role (docs/bugs/0824). A rehearsal now
// refuses a key whose role is not service_role. Neither field is the key.
app.get("/health", (c) => {
  const claims = restKeyClaims(c.env.SUPABASE_SERVICE_ROLE_KEY);
  return c.json({
    ok: true,
    sha: resolveBuildSha(GIT_SHA, c.env.GIT_SHA),
    rest_role: claims.role,
    rest_ref: restUrlRef(c.env.SUPABASE_URL),
    rest_key_ref: claims.ref,
  });
});

app.route("/api/auth", authRoutes);
app.route("/api/mcp/brief", mcpBriefPublic);
app.route("/api/mcp", mcpRoutes);
app.route("/.well-known", mcpWellKnown);

app.route("/api/survey", survey);

app.route("/api/track", track);
app.use("/api/portal/*", caseTrack);
app.route("/api/portal", portal);

app.use("/api/supplier-portal/*", supplierTrack);
app.route("/api/supplier-portal", supplierPortal);

app.route("/api/mail-center/inbound", mailInbound);
app.route("/api/sync/so-mirror", soMirror);
app.route("/api/sync/amendment-mirror", amendmentMirror);
app.route("/api/sync/customer-mirror", customerMirror);
app.route("/api/sync/staff-mirror", staffMirror);
app.route("/api/sync/warehouse-mirror", warehouseMirror);
app.route("/api/pos", pos);
app.route("/api/pos-device", posDevice);

app.route("/api/assr-form-intake", assrFormIntake);

// HC Delivery sheet ERP sync — PRE-AUTH for the same reason as the form intake:
// the sheet-bound Apps Script calls it with no staff session, self-guarded by
// SHEET_SYNC_KEY (X-Intake-Key), HOUZS only. Replaces the sheet's AutoCount pull
// and push (owner 2026-09-15). See routes/deliverySheetSync.ts.
app.route("/api/delivery-sheet", deliverySheetSync);

app.route("/api/chat-callback", chatCallback);

// global `auth` + `requireScmAccess` gates so a plain <img src> (no Bearer, no
app.route("/api/scm", publicScmImages);

// PUBLIC no-login delivery-order SCAN — MUST be mounted BEFORE the `auth` gate,
// because the driver opens the printed QR with a phone camera and has no
// session. The gate is the unguessable 64-hex token printed on the paper
// (mig 0328), which the owner chose in those terms (「就跟hookka一样」), plus the
// kill switch he asked for on top of it. The surface is deliberately two
// endpoints: a minimal summary with no money, no address and no contact, and a
// forward-only one-rung advance that runs the OFFICE's own status writer. The
// company is taken from the row the token resolves to, never from the request.
// See routes/publicDoScan.ts and backend/tests/publicDoScan*.test.ts.
app.route("/api/public/do-scan", publicDoScan);

app.route("/api/public/contractor-calendar", publicContractorCalendar);
app.route("/api/public/brand-calendar", publicBrandCalendar);
app.route("/api/public/meetings", publicMeetings);

app.use("/api/*", auth);

app.use("/api/*", companyContext);

app.use("/api/*", idempotency);

for (const path of POLLED_LIST_PATHS) app.use(path, pollEtag);

app.route("/api/connect/payments", connectPayments);

app.use("/api/assr/*", inboxBustAfterWrite);
app.use("/api/projects/*", inboxBustAfterWrite);
app.use("/api/projects/*", venturePortalKick());

app.route("/api/assr/portal", assrPortal);
app.route("/api/assr/quality-overview", assrQuality);
app.route("/api/assr", assr);
app.route("/api/logs", logs);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/health", systemHealthRoutes);
app.route("/api/admin/ai-usage", aiUsageRoutes);
app.route("/api/admin/ocr", ocrDashboardRoutes);
app.route("/api/client-errors", clientErrors);
app.route("/api/udf", udf);
app.route("/api/totp", totpRoutes);
app.route("/api/users", users);
app.route("/api/field-pin", fieldPinAdmin);
app.route("/api/roles", roles);
app.route("/api/positions", positions);
app.route("/api/position-capabilities", positionCapabilities);
app.route("/api/position-policy", positionPolicy);
app.route("/api/departments", departments);
app.route("/api", documentRefs);
app.route("/api/companies", companies);
app.route("/api/table-layouts", tableLayouts);
app.route("/api/notifications", notifications);
setBadgeDispatch((c, req) => {
  let ctx: Parameters<typeof app.fetch>[2];
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  return Promise.resolve(app.fetch(req, c.env, ctx));
});
app.route("/api/badge-counts", badgeCounts);

app.route("/api/push", pushDevices);
app.route("/api/it-support", itSupport);
app.route("/api/mcp-admin", mcpAdminRoutes);
app.route("/api/meetings", meetings);
app.route("/api/presence", presence);
app.route("/api/projects/outstanding-tasks", projectsOutstanding);
app.route("/api/projects/calendar/search", projectsCalendarSearch);
app.route("/api/projects/defect-list", projectsDefectList);
app.use("/api/projects/data-gaps/*", requirePageAccess("projects.finances"));
app.route("/api/projects/data-gaps", projectDataGaps);
/* Project Overview: the projects.finances page, or any finance viewer (the
   directors, owner 2026-10-20) - the router itself still refuses everyone else. */
const requirePageAccessOrDirector: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (isFinanceViewer(c.get("user") as unknown as AuthUser)) return next();
  return requirePageAccess("projects.finances")(c, next);
};
app.use("/api/projects/*", bustProjectOverviewOnWrite);
app.use("/api/project-forecast/*", bustProjectOverviewOnWrite);
app.use("/api/projects/overview/*", requirePageAccessOrDirector);
app.route("/api/projects/overview", projectOverview);
app.route("/api/projects", projects);
app.route("/api/brand-share", brandShare);
app.route("/api/project-forecast", projectForecast);
app.use("/api/project-sales-orders/*", requirePageAccessOrSalesView("sales"));
app.route("/api/project-sales-orders", projectSalesOrders);
app.use("/api/project-sales-bills/*", requirePageAccessOrSalesView("sales"));
app.route("/api/project-sales-bills", projectSalesBills);
app.use("/api/project-pos-sales/*", requirePageAccessOrSalesView("sales"));
app.route("/api/project-pos-sales", projectPosSales);
app.use("/api/pos-admin/*", requirePermission("pos.manage"));
app.route("/api/pos-admin", posAdmin);
// HR Employees & Attendance (HC-0125): broad read on either employees key sees
// everything; a narrow hr.attendance.read reaches only the Attendance reads
// (default-deny, see requireHrRead). Every write checks hr.employees.manage
// inside. Salaries, so not under the SCM umbrella.
app.use("/api/hr/*", requireHrRead);
app.route("/api/hr", hrEmployees);
app.route("/api/hr", hrAttendance);
app.route("/api/hr", hrLabor);
app.route("/api/hr", hrPayroll);
app.route("/api/hr", hrTripPay);
app.route("/api/hr", hrKpi);
app.route("/api/hr", hrShifts);
// The phone punch clock (HC-0125): any signed-in account, answered only for
// the employee linked to it, so NOT behind the hr.employees.* gate above.
app.route("/api/attendance", attendance);
app.route("/api/sales", sales);
app.route("/api/finance", finance);
app.route("/api/stockitems", stockItems);
app.route("/api/fleet", fleet);
app.route("/api/fleet-maintenance", fleetWorkOrderPhotos);
app.route("/api/fleet-maintenance", fleetPlanService);
app.route("/api/fleet-maintenance", fleetOffRoad);
app.route("/api/fleet-maintenance", fleetMaintenance);
app.route("/api/fleet-work-order-files", fleetWorkOrderFiles);
app.route("/api/fleet-breakdown-files", fleetBreakdownFiles);
app.route("/api/settings", settings);
app.route("/api/branding", branding);
app.route("/api/inbox", inbox);
app.route("/api/mail-center", mailAcks);
app.route("/api/mail-center", mailAccessLog);
app.route("/api/mail-center", mailReplyGuard);
app.route("/api/mail-center", mailPersonal);
app.route("/api/mail-center", mailClaim);
app.route("/api/mail-center", mailSenders);
app.route("/api/mail-center", mailCenter);
app.route("/api/announcements", announcements);
app.route("/api/announcements", announcementReceipts);
app.route("/api/announcements", announcementApproval);
app.route("/api/memos", memos);
app.route("/api/agents", agentConsole);
app.route("/api/assistant", assistant);
app.route("/api/projects-print", projectsPrint);
app.route("/api/search", search);
app.route("/api/assr-print", assrPrint);

app.use("/api/scm/*", requireScmAccess);
app.route("/api/scm", scmApp);

function humanizeError(err: Error): { status: 500 | 503; message: string } {
  const m = String(err?.message ?? err);
  if (TRANSIENT_CONN_RE.test(m))
    return { status: 503, message: "The database is briefly unavailable. Please try again in a moment." };
  if (/operator does not exist|column .* does not exist|relation .* does not exist|syntax error|invalid input syntax|violates .* constraint|duplicate key/i.test(m))
    return { status: 500, message: "Something went wrong processing that request. Please try again." };
  return { status: 500, message: "Something went wrong. Please try again." };
}

app.onError((err, c) => {
  console.error("[onError]", describeErrorForLog(err), err);
  const anyErr = err as Error & { getResponse?: () => Response; status?: number };
  const base =
    typeof anyErr.getResponse === "function"
      ? anyErr.getResponse()
      : (() => {
          const { status, message } = humanizeError(err);
          return c.json({ error: message }, status);
        })();
  const res = new Response(base.body, base);
  const allowedOrigin = corsOriginAllowed(c.req.header("Origin"));
  if (allowedOrigin) res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  res.headers.set("Access-Control-Expose-Headers", "X-Request-Id, X-Session-Pass");

  if (res.status >= 500) {
    let waitUntil: ((p: Promise<unknown>) => void) | undefined;
    try {
      waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
    } catch {
      waitUntil = undefined;
    }
    captureError(
      c.env,
      err,
      {
        source: "worker",
        route: c.req.routePath || new URL(c.req.url).pathname,
        method: c.req.method,
        status: res.status,
        requestId: c.get("requestId"),
        userId: c.get("user")?.id ?? null,
        companyId: c.get("companyId") ?? null,
      },
      waitUntil,
    );
  }
  return res;
});

setMcpApp(app as unknown as Parameters<typeof setMcpApp>[0]);

export { app };

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    env = withPgDb(env);
    const track = jobTracker(env);
    if (event.cron === "*/5 * * * *") {
      ctx.waitUntil(
        track("keepwarm", () => env.DB.prepare("SELECT 1 AS ok").first()).catch((e) => console.error("[cron keepwarm]", e))
      );
      // Durable email: retry outbox rows whose immediate send failed. No-op
      // without RESEND_API_KEY; bounded to 25 rows / 3 attempts so a bad batch
      // can't stall the slot.
      // Then give Mail Center sends Resend's Message-ID, which a customer's
      // reply quotes to land back on its thread, and ask whether each recent
      // send was delivered or bounced (HC-0247).
      // Meeting emails the IT Hub wrote for meetings made here, reminders included (services/meetingMail.ts).
      ctx.waitUntil(
        track("meeting-mail", () => sendAllMeetingMail(env))
          .then((r) => {
            if (r.sent || r.failed) console.log(`[cron meeting-mail] sent=${r.sent} failed=${r.failed}`);
          })
          .catch((e) => console.error("[cron meeting-mail]", e))
      );
      ctx.waitUntil(
        track("email-outbox", () => drainEmailOutbox(env))
          .then((r) => {
            if (r.processed) console.log(`[cron email-outbox] processed=${r.processed} sent=${r.sent} failed=${r.failed}`);
          })
          .catch((e) => console.error("[cron email-outbox]", e))
          .then(() => backfillOutboundMessageIds(env.DB, env, null, 10))
          .catch((e) => console.error("[cron mail-message-ids]", e))
          .then(() => refreshOutboundDelivery(env.DB, env, DELIVERY_REFRESH_LIMIT, Date.now()))
          .then((r) => {
            if (r.changed) console.log(`[cron mail-delivery] checked=${r.checked} changed=${r.changed} bounced=${r.bounced} unreachable=${r.unreachable}`);
          })
          .catch((e) => console.error("[cron mail-delivery]", e))
      );
      if (new Date(event.scheduledTime).getUTCMinutes() < 5) {
        ctx.waitUntil(
          track("meetings-directory", () => pushMeetingsDirectory(env))
            .catch((e) => console.error(`[cron ${MEETINGS_DIRECTORY_JOB}]`, e))
        );
      }
      ctx.waitUntil(
        track("health-hub", () => sendHealthReportToHub(env, event.scheduledTime))
          .then((r) => { if (r.sent && !r.ok) console.log(`[cron ${HEALTH_HUB_JOB}] sent, health is not ok`); })
          .catch((e) => console.error(`[cron ${HEALTH_HUB_JOB}]`, e))
      );
      ctx.waitUntil(
        pollVelocity(env)
          .then((r) => {
            if (!r.skipped) console.log(`[cron velocity] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron velocity]", e instanceof Error ? e.message : e))
      );
      // HC-0050: same, from iTrack (no-op until ITRACK_ACCOUNT + ITRACK_PASSWORD are set).
      ctx.waitUntil(
        pollItrack(env)
          .then((r) => {
            if (!r.skipped) console.log(`[cron itrack] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron itrack]", e instanceof Error ? e.message : e))
      );
      if (!isAutoCountSyncDisabled(env)) {
        ctx.waitUntil(
          track("so-pull", () => runPull(env, "SCHEDULED"))
            .then((r) => console.log(`[cron so-pull] ${r.message}`))
            .catch((e) => console.error("[cron so-pull]", e))
        );
      }
      ctx.waitUntil(
        track("amendment-cmd", () => drainCommands(env))
          .then((r) => {
            if (r.processed) console.log(`[cron amendment-cmd] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron amendment-cmd]", e))
      );
      ctx.waitUntil(
        track("ac-writeback", () => drainAutoCountOutbox(env))
          .then((r) => {
            if (r.failed) console.error(`[cron ac-writeback] FAILED ${JSON.stringify(r)}`);
            else if (r.processed) console.log(`[cron ac-writeback] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron ac-writeback]", e))
      );
      const vpOrderDrain = track("vp-feed", () => drainVenturePortalOutbox(env))
        .then((r) => {
          if (r.failed) console.error(`[cron vp-feed] FAILED ${JSON.stringify(r)}`);
          else if (r.processed) console.log(`[cron vp-feed] ${JSON.stringify(r)}`);
        })
        .catch((e) => console.error("[cron vp-feed]", e));
      ctx.waitUntil(vpOrderDrain);
      const vpCatalogue = vpOrderDrain
        .then(() => track("vp-catalogue", () => pushVenturePortalCatalogue(env, { force: false })))
        .then((r) => {
          if (
            r.skipped === "catalogue_url_unknown"
            || r.companies.some((x) => x.action === "failed" || x.action === "build_failed")
          ) {
            console.error(`[cron vp-catalogue] FAILED ${JSON.stringify(r)}`);
          } else if (r.companies.some((x) => x.action === "sent" || x.action === "retry")) {
            console.log(`[cron vp-catalogue] ${JSON.stringify(r)}`);
          }
        })
        .catch((e) => console.error("[cron vp-catalogue]", e));
      ctx.waitUntil(vpCatalogue);
      ctx.waitUntil(
        vpCatalogue
          .then(() => pushVenturePortalAttendance(env, { force: false }))
          .then((r) => {
            if (
              r.skipped === "attendance_url_unknown"
              || r.companies.some((x) => x.action === "failed" || x.action === "build_failed")
            ) {
              console.error(`[cron vp-attendance] FAILED ${JSON.stringify(r)}`);
            } else if (r.companies.some((x) => x.action === "sent" || x.action === "retry")) {
              console.log(`[cron vp-attendance] ${JSON.stringify(r)}`);
            }
          })
          .catch((e) => console.error("[cron vp-attendance]", e))
      );
      ctx.waitUntil(
        track("ac-relink-sweep", () => relinkHeldBackSweep(env))
          .then((r) => {
            if (r.mode !== "off" && (r.scanned || r.linesStamped || r.docsEnqueued)) {
              console.log(`[cron ac-relink-sweep] ${JSON.stringify(r)}`);
            }
          })
          .catch((e) => console.error("[cron ac-relink-sweep]", e))
      );
      /* Delivery-date sweep. Ships DARK twice over: no-op unless
         scm.app_config 'scm.autocount_delivery_date_sweep' is 'plan' or
         'apply', AND the host route /delivery-dates only exists once
         AcSyncService is rebuilt on the office machine. It closes the
         one-directional half of the sync: AutoCount keeps the delivery date on
         the LINE, the inbound pull carries headers only, so a date changed in
         the book after import never reached us (docs/bugs/0810). Best-effort —
         a sweep failure can never break the slot. */
      ctx.waitUntil(
        track("ac-delivery-dates", () => deliveryDateSweep(env))
          .then((r) => {
            if (r.mode !== "off" && (r.linesWritten || r.headersWritten || r.remaining || r.hostError)) {
              console.log(`[cron ac-delivery-dates] ${JSON.stringify(r)}`);
            }
          })
          .catch((e) => console.error("[cron ac-delivery-dates]", e))
      );
      /* SO allocation projection sweep.

         This comment used to read "every source-data mutation first queues the
         singleton invalidation in its own DB transaction", which is FALSE and
         reads as a durability guarantee the system does not give. Counted
         2026-08-19: `scheduleStockAllocationAfterCommand` (the durable path,
         enqueues inside the caller's transaction) has FOUR call sites, while
         `recomputeSoStockAllocation` has 42. The other ~34 triggers — GRN
         post/cancel, DO ship/cancel, returns, stock takes, transfers,
         adjustments, consignment — are best-effort: they call the recompute and
         hope. See the SCOPE header of scm/lib/stock-allocation-job.ts, which
         says so plainly, and docs/modules/sales-order.md.

         So this sweep is NOT merely a backstop for a rare crash. Since
         2026-08-17 the recompute enqueues its own retry row when a sweep it
         entered did not finish, which makes this a real repair loop for all ~38
         triggers. What is still uncovered: a Worker that dies BEFORE reaching
         the recompute leaves no row and no retry, and that gap closes only by
         moving each route onto `runScmPgCommand`. */
      ctx.waitUntil(
        track("so-allocation", () => drainStockAllocationRecompute(env))
          .then((r) => {
            if (r.deadLettered) console.error(`[cron so-allocation] DEAD LETTER ${JSON.stringify(r)}`);
            else if (r.processed || r.reason) console.log(`[cron so-allocation] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron so-allocation]", e))
      );
    } else if (event.cron === "*/15 * * * *") {
      ctx.waitUntil(
        track("mrp-snapshot", () => refreshAllMrpSnapshots(env, new Date().toISOString()))
          .catch((e) => console.error("[cron mrp-snapshot]", e))
      );
      // HC-0145: the Procurement Overview's default views, served from KV between runs.
      ctx.waitUntil(
        track("procurement-overview", () => refreshProcurementOverviewSnapshots(env, todayMyt()))
          .catch((e) => console.error("[cron procurement-overview]", e))
      );
      ctx.waitUntil(
        track("mcp-brief", () => runBriefs(env, ctx, event.scheduledTime))
          .then((r) => { if (r.due) console.log(`[cron mcp-brief] ${JSON.stringify(r)}`); })
          .catch((e) => console.error("[cron mcp-brief]", e))
      );
    } else if (event.cron === "*/30 * * * *") {
      ctx.waitUntil(
        track("mcp-alerts", () => runAlerts(env, ctx, event.scheduledTime))
          .then((r) => { if (r.sent || r.failed) console.log(`[cron mcp-alerts] ${JSON.stringify(r)}`); })
          .catch((e) => console.error("[cron mcp-alerts]", e))
      );
      ctx.waitUntil(
        track("hr-auto-clockout", () => runAutoClockOut(env))
          .then((r) => {
            if (r.closed) console.log(`[cron hr-auto-clockout] closed=${r.closed}`);
          })
          .catch((e) => console.error("[cron hr-auto-clockout]", e))
      );
      ctx.waitUntil(
        track("vp-reconcile", () => reconcileVenturePortalOutbox(env, { includeFailed: false }))
          .then((r) => {
            if (r.requeued) console.warn(`[cron vp-reconcile] requeued=${r.requeued}`);
          })
          .catch((e) => console.error("[cron vp-reconcile]", e))
      );
      /* Houzs Connect contact sync (owner 2026-11-02): fill every customer's
         Connect contact panel from their order, no message sent. Walks the
         in-window orders a batch at a time by a cursor in app_config — the first
         cycle backfills the ~1,099 existing contacts, then it wraps and keeps them
         current (a new conversation contact is picked up on the next pass; an
         explicit send fills instantly). Ships dark until CONNECT_WEBHOOK_* are set
         (skipped:'not_configured'). Best-effort — a failed group is logged and
         counted, never thrown. */
      ctx.waitUntil(
        track("connect-sync", () => runScheduledConnectSync(env))
          .then((r) => {
            if (r.synced || r.failed) console.log(`[cron connect-sync] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron connect-sync]", e))
      );
      ctx.waitUntil(
        runPosAlerts(env)
          .then((r) => {
            if (r.opened || r.resolved || r.emailed || r.summaries || r.errors)
              console.log(`[cron pos-alerts] opened=${r.opened} resolved=${r.resolved} emailed=${r.emailed} summaries=${r.summaries} errors=${r.errors}`);
          })
          .catch((e) => console.error("[cron pos-alerts]", e))
      );
      ctx.waitUntil(
        track("assr-alerts", () => runAssrAlerts(env))
          .then((r) =>
            console.log(
              `[cron assr-alerts] scanned=${r.cases_scanned} half=${r.half} appr=${r.approaching} breach=${r.breach}`
            )
          )
          .catch((e) => console.error("[cron assr-alerts]", e))
      );
      ctx.waitUntil(
        track("ann-escalation", () => runOverdueEscalation(env))
          .then((r) => {
            if (r.escalated > 0 || r.scanned > 0)
              console.log(`[cron ann-escalation] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron ann-escalation]", e))
      );
      ctx.waitUntil(
        runMailAckEscalation(env)
          .then((r) => {
            if (r.chased > 0) console.log(`[cron mail-ack-escalation] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron mail-ack-escalation]", e))
      );
      ctx.waitUntil(
        track("lead-time-schedule", () => runScheduledLeadTimeActivations(env))
          .then((r) => {
            if (r.fired > 0) console.log(`[cron lead-time-schedule] fired=${r.fired}`);
          })
          .catch((e) => console.error("[cron lead-time-schedule]", e))
      );
      ctx.waitUntil(
        track("agent-heartbeat", () => runAgentHeartbeat(env))
          .then((r) => {
            if (r.ran.length)
              console.log(
                `[cron agent-heartbeat] ran=${r.ran.map((x) => x.task).join(",")} skipped=${r.skipped.length}`
              );
          })
          .catch((e) => console.error("[cron agent-heartbeat]", e))
      );
      {
        const h = new Date(event.scheduledTime).getUTCHours();
        if (h >= 0 && h < 14 && env.ANTHROPIC_API_KEY) {
          ctx.waitUntil(
            track("scan-so-warm", () => warmCatalogCacheForCron(env))
              .then((r) => console.log(`[cron scan-so warm] ${JSON.stringify(r)}`))
              .catch((e) => console.error("[cron scan-so warm]", e)),
          );
        }
      }
      {
        const h = new Date(event.scheduledTime).getUTCHours();
        if (h === 0) {
          ctx.waitUntil(
            track("push-reminders", () => runPushFleetReminders(env))
              .then((r) => {
                if (r.attempted || r.reason !== "apns_not_configured")
                  console.log(`[cron push-reminders] ${JSON.stringify(r)}`);
              })
              .catch((e) => console.error("[cron push-reminders]", e))
          );
        }
      }
      // Fair reconcile (owner 2026-09-13). 23% of exhibitions reach PMS within a
      // week of opening and 13 of 114 only after they had started, so an order
      // written on the floor often has no fair to point at yet. It records the
      // place and waits; this pass links it once the fair exists. Gated to the
      // 08:00 MYT hour (UTC 0) — a day's latency is the whole point, and the
      // slot fires twice in that hour, which is harmless because the job only
      // reads rows still marked PENDING. Best-effort: a failure here can never
      // break the other crons. scm/lib/fair-reconcile.ts.
      {
        const h = new Date(event.scheduledTime).getUTCHours();
        if (h === 0) {
          ctx.waitUntil(
            track("fair-reconcile", () => reconcilePendingFairs(env))
              .then((r) => {
                if (r.scanned > 0) console.log(`[cron fair-reconcile] ${JSON.stringify(r)}`);
              })
              .catch((e) => console.error("[cron fair-reconcile]", e))
          );
          ctx.waitUntil(track("fair-claim", () => claimReportedOrders(env, new Date(event.scheduledTime + 8 * 3600_000).toISOString().slice(0, 10)))
            .then((r) => { if (r.claimed > 0 || r.failed > 0) console.log(`[cron fair-claim] ${JSON.stringify(r)}`); })
            .catch((e) => console.error("[cron fair-claim]", e)));
        }
      }
      // 3PL bills (owner 2026-10-24): an AP invoice from a transport supplier
      // with its bill attached is read by itself and kept — matched lines on
      // their DOs, the rest waiting for Finance under "To check" — and read again
      // when a file is added. Four bills a run; nothing posts to the ledger.
      // scm/lib/threepl-bill-import.ts.
      ctx.waitUntil(
        track("threepl-bills", () => autoReadBills(env))
          .then((r) => {
            if (r.due > 0 || r.released > 0 || r.errors.length) console.log(`[cron threepl-bills] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron threepl-bills]", e))
      );
      ctx.waitUntil(
        track("slip-reaper", () => reapOnce(getSupabaseService(env), env, `cron-${event.scheduledTime}`))
          .then((r) => {
            if (r.claimed > 0 || r.errors > 0)
              console.log(
                `[cron slip-reaper] claimed=${r.claimed} deleted=${r.deleted} errors=${r.errors} remaining=${r.remaining}`
              );
          })
          .catch((e) => console.error("[cron slip-reaper]", e))
      );
      // Background-job failure alerts (owner-approved 2026-11-10): hourly, on the
      // :00 pass of this slot. Classifies every job as System Health does and
      // tells the IT-page holders once per incident (services/jobFailureAlerts.ts).
      if (new Date(event.scheduledTime).getUTCMinutes() < 30) {
        ctx.waitUntil(
          track("job-alerts", () => runJobFailureAlerts(env, event.scheduledTime))
            .then((r) => { if (r.critical || r.alerted.length) console.log(`[cron ${JOB_ALERTS_JOB}] critical=${r.critical} alerted=${r.alerted.join(",") || "none"}`); })
            .catch((e) => console.error(`[cron ${JOB_ALERTS_JOB}]`, e)),
        );
      }
    } else if (event.cron === "0 2 * * *") {
      ctx.waitUntil(
        track("sla", () => runSlaEscalation(env))
          .then((r) => console.log(`[cron sla] escalated ${r.escalated} case(s)`))
          .catch((e) => console.error("[cron sla]", e))
      );
      ctx.waitUntil(
        track("ai-usage-hub", () => sendAiUsageToHub(env, new Date()))
          .then((r) => console.log(r ? `[cron ai-usage-hub] sent ${r.days} day(s), ${r.rows} row(s)` : "[cron ai-usage-hub] not set up"))
          .catch((e) => console.error("[cron ai-usage-hub]", e))
      );
      // Local "actually delivered" sweep (owner 2026-10-27): so-delivery-sync
      // only SHIPS now; a SHIPPED local order whose DO date has passed and that
      // has a driver is delivered here. East Malaysia / Singapore are left out —
      // their delivered signal is the HC Delivery sheet, synced separately.
      ctx.waitUntil(
        track("deliver-due", () => deliverDueShippedOrders(getSupabaseService(env), todayMyt(), null))
          .then((r) => console.log(`[cron deliver-due] scanned=${r.scanned} delivered=${r.delivered} skipped=${r.skipped}`))
          .catch((e) => console.error("[cron deliver-due]", e))
      );
      if (!isAutoCountSyncDisabled(env)) {
        ctx.waitUntil(
          track("do-mirror", () => runDoMirrorSync(env, "SCHEDULED"))
            .then((r) => console.log(`[cron do-mirror] ${r.message}`))
            .catch((e) => console.error("[cron do-mirror]", e))
        );
        ctx.waitUntil(
          track("po-docs-pull", () => runPODocsPull(env, "SCHEDULED"))
            .then((r) => console.log(`[cron po-docs-pull] ${r.message}`))
            .then(() => track("po-pull", () => runPOPull(env, "SCHEDULED")))
            .then((r) => console.log(`[cron po-pull] ${r.message}`))
            .catch((e) => console.error("[cron po-pull]", e))
        );
        ctx.waitUntil(
          track("ac-snapshot-so", () => runSOSnapshot(env, "SCHEDULED"))
            .then((r) => console.log(`[cron ac-snapshot-so] ${r.message}`))
            .then(() => track("ac-snapshot-po", () => runPOSnapshot(env, "SCHEDULED")))
            .then((r) => console.log(`[cron ac-snapshot-po] ${r.message}`))
            .catch((e) => console.error("[cron ac-snapshot]", e))
        );
      }
      ctx.waitUntil(
        track("assr-digest", () => runAssrDailyDigest(env))
          .then((r) => console.log(`[cron assr-digest] sent=${r.recipients} cases=${r.cases}`))
          .catch((e) => console.error("[cron assr-digest]", e))
      );
      // Weekly Service Case status update to customers (owner 2026-11-02; moved
      // Friday -> Monday 2026-11-03). This 02:00 UTC slot is 10:00 MYT; gate to
      // Monday (getUTCDay 1) so it runs once a week at that hour without a
      // dedicated cron trigger. Ships DARK — no-op unless scm.app_config
      // 'scm.assr_weekly_status' is pilot/on. Best-effort.
      if (new Date(event.scheduledTime).getUTCDay() === 1) {
        ctx.waitUntil(
          track("assr-weekly-status", () => runWeeklyServiceCaseStatus(env))
            .then((r) => {
              if (r.mode !== "off") console.log(`[cron assr-weekly-status] ${JSON.stringify(r)}`);
            })
            .catch((e) => console.error("[cron assr-weekly-status]", e))
        );
      }
      ctx.waitUntil(
        track("proj-reminders", () => runProjectDueReminders(env))
          .then((r) =>
            console.log(
              `[cron proj-reminders] ${r.items} item(s) across ${r.recipients} recipient(s), ${r.sent} email(s) sent`
            )
          )
          .catch((e) => console.error("[cron proj-reminders]", e))
      );
      ctx.waitUntil(
        track("client-errors", () => runClientErrorDigest(env))
          .then((r) => {
            if (r.errors || r.purged)
              console.log(
                `[cron client-errors] sent=${r.sent} errors=${r.errors} occurrences=${r.occurrences} purged=${r.purged}`
              );
          })
          .catch((e) => console.error("[cron client-errors]", e))
      );
      ctx.waitUntil(
        track("idempotency-sweep", () => env.DB.prepare(
          `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`,
        )
          .run())
          .then((r) => {
            const n = r?.meta?.changes ?? 0;
            if (n) console.log(`[cron idempotency-sweep] purged ${n} expired key(s)`);
          })
          .catch((e) => console.error("[cron idempotency-sweep]", e)),
      );
      ctx.waitUntil(
        track("ar-aging-refresh", async () => {
          await env.DB.prepare(
            "REFRESH MATERIALIZED VIEW CONCURRENTLY scm.mv_ar_aging",
          ).run();
          await env.DB.prepare(
            "UPDATE scm.mv_ar_aging_meta SET refreshed_at = now()",
          ).run();
          console.log("[cron ar-aging-refresh] refreshed scm.mv_ar_aging");
        }).catch((e) => console.error("[cron ar-aging-refresh]", e)),
      );
      ctx.waitUntil(
        track("job-runs-retention", () => purgeOldJobRuns(env))
          .then((n) => {
            if (n) console.log(`[cron job-runs-retention] purged ${n} run(s)`);
          })
          .catch((e) => console.error("[cron job-runs-retention]", e)),
      );
      ctx.waitUntil(
        track("failed-logins-retention", () => pruneFailedLogins(env))
          .then((n) => {
            if (n) console.log(`[cron failed-logins-retention] purged ${n} row(s)`);
          })
          .catch((e) => console.error("[cron failed-logins-retention]", e)),
      );
      if (new Date(event.scheduledTime).getUTCDay() === 0) {
        ctx.waitUntil(
          track("scan-so-distill", async () => {
            const branding = await getBranding(env);
            const summary = await distillAllSalespersonRules(
              getSupabaseService(env),
              env.ANTHROPIC_API_KEY,
              branding.companyName,
              { env, feature: "scan_so_distill", model: CLAUDE_MODEL, companyId: null, userId: null, waitUntil: null },
            );
            console.log("[scan-so weekly distill]", JSON.stringify(summary));
          }).catch((e) => console.error("[scan-so weekly distill]", e)),
        );
      }
    } else if (event.cron === "5 16 * * *") {
      // 16:05 UTC = 00:05 MYT — the month-end stock close (GL redesign item 4).
      // On the 1st this POSTS last month's closing-stock pair the night the
      // month ends (the owner's 抓实时的); every other night it is the cheap
      // re-check that heals a late-keyed GRN by reversing and re-posting.
      // Sweeps the two most recent closed months for every company; every
      // outcome (including the quiet 'unchanged') lands in
      // scm.acc_stock_close_runs — the visible trail the owner asked for.
      ctx.waitUntil(
        track("stock-close", async () => {
          const sb = getSupabaseService(env);
          const { data, error } = await sb.schema("public").from("companies").select("id");
          if (error) throw new Error(`companies: ${error.message}`);
          const ids = ((data ?? []) as Array<{ id: number }>).map((r) => Number(r.id));
          const outcomes = await sweepStockClose(sb, ids, "cron");
          const changed = outcomes.filter((o) => o.action !== "unchanged");
          console.log(
            `[cron stock-close] ${outcomes.length} check(s), ${changed.length} change(s)` +
            (changed.length ? ` — ${changed.map((o) => `${o.companyId}/${o.month}:${o.action}`).join(", ")}` : ""),
          );
        }).catch((e) => console.error("[cron stock-close]", e)),
      );
      // The monthly commission release (owner 2026-11-25: 系统自动转): every month
      // from the books' start to last month worked out again for each company that
      // switched it on — a month whose lines moved (a bill booked late, an invoice
      // keyed back) is reversed on its own date and posted again. Counts only.
      ctx.waitUntil(
        track("commission-release", async () => {
          const sb = getSupabaseService(env);
          const { data, error } = await sb.schema("public").from("companies").select("id");
          if (error) throw new Error(`companies: ${error.message}`);
          const ids = ((data ?? []) as Array<{ id: number }>).map((r) => Number(r.id));
          const outcomes = await sweepCommissionRelease(sb, ids, "cron");
          const changed = outcomes.filter((o) => o.action !== "unchanged");
          console.log(
            `[cron commission-release] ${outcomes.length} month check(s), ${changed.length} change(s)` +
            (changed.length ? ` — ${changed.map((o) => `${o.companyId}/${"month" in o ? o.month : "-"}:${o.action}`).join(", ")}` : ""),
          );
          if (outcomes.some((o) => o.action === "failed")) throw new Error("a commission release month failed — see acc_commission_release_runs");
        }).catch((e) => console.error("[cron commission-release]", e)),
      );
      // Each lorry's day by road (owner 2026-11-08): the two days just gone are worked
      // out on the server, so Fleet Health and Lorry Capacity have every day whether or
      // not anyone opened Last Mile. Two days, so a late edit to yesterday is caught.
      ctx.waitUntil(
        track("lorry-day-routes", async () => {
          const sb = getSupabaseService(env);
          const today = new Date(Date.now() + 8 * 3600_000);
          for (const offset of [-2, -1, 0, 1]) {
            const date = new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
            const outcomes = await computeDayRoutes(sb, env, date);
            const skipped = outcomes.filter((o) => o.result === "skipped");
            console.log(
              `[cron lorry-day-routes] ${date}: ${outcomes.length} lorr${outcomes.length === 1 ? "y" : "ies"}, ` +
              `${outcomes.filter((o) => o.result === "worked-out").length} worked out` +
              (skipped.length ? `, skipped ${skipped.map((o) => `${o.plate} (${o.reason})`).join("; ")}` : ""),
            );
          }
        }).catch((e) => console.error("[cron lorry-day-routes]", e)),
      );
      // DO lines left open by the lock gate (owner 2026-11-10: a line whose rack or
      // PO is not known for its full qty is not locked; it is retried at the ship
      // and every night until its GRN gets a rack). Per company, bounded, write-once.
      ctx.waitUntil(
        track("do-stamp-retry", async () => {
          const sb = getSupabaseService(env);
          const { data, error } = await sb.schema("public").from("companies").select("id");
          if (error) throw new Error(`companies: ${error.message}`);
          const ids = ((data as Array<{ id: number }> | null) ?? []).map((r) => Number(r.id));
          const runs = await retryOpenDoStamps(sb, ids, new Date(event.scheduledTime));
          console.log(`[cron do-stamp-retry] ${runs.map((r) => `${r.companyId}: ${r.error ?? `${r.written} written, ${r.tried} of ${r.open_dos} DO(s) tried`}`).join("; ")}`);
          const failed = runs.filter((r) => r.error);
          if (failed.length) throw new Error(failed.map((r) => `${r.companyId}: ${r.error}`).join("; "));
        }).catch((e) => console.error("[cron do-stamp-retry]", e)),
      );
      // Nightly integrity check (owner-approved 2026-11-10): documents from the
      // last two days whose stock, PO or bank did not follow, per company. Reads
      // only; new findings become one notice per company to the IT-page holders
      // (services/nightlyIntegrityRun.ts). Logs counts only, never money.
      ctx.waitUntil(
        track("integrity-nightly", () => runNightlyIntegrity(env, event.scheduledTime))
          .then((r) => console.log(`[cron ${INTEGRITY_JOB}] ${r.companies} compan${r.companies === 1 ? "y" : "ies"}, ${r.findings} new finding(s)`))
          .catch((e) => console.error(`[cron ${INTEGRITY_JOB}]`, e)),
      );
      ctx.waitUntil(
        track("self-check", async () => {
          const sb = getSupabaseService(env);
          const { data, error } = await sb.schema("public").from("companies").select("id");
          if (error) throw new Error(`companies: ${error.message}`);
          const ids = ((data ?? []) as Array<{ id: number }>).map((r) => Number(r.id));
          const runs = await sweepSelfCheck(sb, ids);
          const failed = runs.filter((r) => !r.ok);
          console.log(
            `[cron self-check] ${runs.length} compan${runs.length === 1 ? "y" : "ies"}` +
            (failed.length ? ` — failed: ${failed.map((r) => `${r.companyId}: ${r.reason}`).join("; ")}` : ""),
          );
        }).catch((e) => console.error("[cron self-check]", e)),
      );
      // Trip Pay fills itself (owner 2026-11-17): yesterday's lorry runs and project
      // Setup / Dismantle become rows; older open days are re-read only where their
      // source changed. HR's edits and approved months are never touched (lib/hr-trip-sync.ts).
      ctx.waitUntil(
        track("hr-trip-sync", () => runNightlyTripSync(env, event.scheduledTime))
          .then((r) => console.log(`[cron hr-trip-sync] ${r.companies} compan${r.companies === 1 ? "y" : "ies"}: ${r.results.join(" | ")}`))
          .catch((e) => console.error("[cron hr-trip-sync]", e)),
      );
      ctx.waitUntil(
        track("supplier-price-apply", () => applyDueSupplierPrices(getSupabaseService(env), { today: todayMyt() }))
          .then((r) => console.log(`[cron supplier-price-apply] ${r.bindings} binding(s), ${r.applied} applied, ${r.failed} failed`))
          .catch((e) => console.error("[cron supplier-price-apply]", e)),
      );
    }
  },
  async queue(batch: MessageBatch<ScanQueueMessage>, env: Env, _ctx: ExecutionContext) {
    env = withPgDb(env);
    for (const msg of batch.messages) {
      const body = msg.body;
      if (body && "distill" in body) {
        try {
          await processDistillQueueMessage(env, body.distill);
        } catch (e) {
          console.error("[scan-queue distill]", e);
        }
        msg.ack();
        continue;
      }
      if ("aiRead" in body) {
        try {
          await processAiReadQueueMessage(env, body.aiRead);
          msg.ack();
        } catch (e) {
          console.error("[scan-queue ai-read]", body.aiRead, e);
          msg.retry();
        }
        continue;
      }
      try {
        await processScanQueueMessage(env, body.jobId);
        msg.ack();
      } catch (e) {
        console.error("[scan-queue]", body?.jobId, e);
        msg.retry();
      }
    }
  },
};
