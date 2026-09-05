import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Env } from "./types";
import { GIT_SHA, resolveBuildSha } from "./build-info";
import { auth, requirePermission, requireAnyPermission, requireScmAccess } from "./middleware/auth";
import { TRANSIENT_CONN_RE } from "./db/d1-compat";
// Ported 2990's SCM modules (furniture supply chain). Talk to the `scm` Postgres
// schema via supabase-js; namespaced under /api/scm/*, owner-only during the port.
import scmApp from "./scm";
import { publicScmImages } from "./scm/routes/public-images";
import { idempotency } from "./middleware/idempotency";
import { requestLog } from "./middleware/requestLog";
// Error tracking (Sentry-protocol, no SDK). Completely inert until the owner
// sets the SENTRY_DSN Worker secret — see services/errorTracking.ts.
import { captureError } from "./services/errorTracking";
import assr from "./routes/assr";
import logs from "./routes/logs";
import auditRoutes from "./routes/audit";
import systemHealthRoutes from "./routes/systemHealth";
// Self-hosted client error reporting (no Sentry): the SPA's global reporter
// POSTs batched uncaught errors here; the daily 02:00 cron mails IT a digest.
import clientErrors from "./routes/clientErrors";
import udf from "./routes/udf";
import authRoutes from "./routes/auth";
import totpRoutes from "./routes/totp";
import users from "./routes/users";
import roles from "./routes/roles";
import positions from "./routes/positions";
import positionCapabilities from "./routes/position-capabilities";
import departments from "./routes/departments";
import companies from "./routes/companies";
import tableLayouts from "./routes/tableLayouts";
import notifications from "./routes/notifications";
import pushDevices from "./routes/push";
import { runPushFleetReminders } from "./services/pushFleetReminders";
import presence from "./routes/presence";
import projects from "./routes/projects";
// Sales entries (/api/sales) is retained as a DEPENDENCY of Projects — the
// Projects page embeds the sales-entry EntryPanel + submit/void/delete flow.
// It has no standalone nav/route after the cutover.
import sales from "./routes/sales";
// Endpoints retained ONLY because the kept Service/Projects pages still call
// them (no standalone nav/route): finance.ts backs the Finances P&L tab on both
// Service and Projects (PnlCalendar); stockItems backs the ASSR By-Creditor
// "Refresh from AutoCount" button; fleet/lorries back the Projects Setup /
// Dismantle / Logistics crew + lorry pickers.
import finance from "./routes/finance";
import stockItems from "./routes/stockItems";
import fleet from "./routes/fleet";
// Fleet Maintenance & Compliance (Phase 1) — the compliance vault + Fleet Health
// dashboard BUILT ON the existing scm.lorries master (+ scm.lorry_maintenance /
// scm.lorry_service_records). Mounted OUTSIDE /api/scm so the gate is the flat
// fleet.read/fleet.write permission alone; it uses the SCM supabase client via
// supabaseAuth. Distinct from routes/fleet.ts (the crew picker).
import fleetMaintenance from "./scm/routes/fleet-maintenance";
// `routes/lorries.ts` removed 2026-06-28 — old Houzs Fleet lorries CRUD retired
// in favour of scm.lorries (mounted at /api/scm/lorries). public.lorries data
// was migrated by mig 0055 then the dead table dropped. /api/fleet/staff stays
// — it reads public.users by role for the project Setup/Dismantle crew picker
// (distinct from the new SCM TMS crew records).
import settings from "./routes/settings";
import branding from "./routes/branding";
import inbox, { bustInboxForUser } from "./routes/inbox";
import projectsPrint from "./routes/projects_print";
import search from "./routes/search";
import assrPrint from "./routes/assr_print";
import assrPortal from "./routes/assrPortal";
import assrFormIntake from "./routes/assrFormIntake";
import survey from "./routes/survey";
import track from "./routes/track";
import portal from "./routes/portal";
import supplierPortal from "./routes/supplierPortal";
// Mail Center — in-ERP shared inbox. `mailInbound` is the PRE-AUTH ingest
// (secret-guarded, mounted before the auth gate); `mailCenter` is the authed
// read/reply/compose/label/address/access/scope router.
import mailCenter from "./routes/mail-center";
import mailInbound from "./routes/mail-inbound";
// 2990 → Houzs LIVE SO mirror receiver. PRE-AUTH (secret-guarded, called by the
// 2990 DB via pg_net, no user JWT) — mounted at the top level, outside /api/scm.
import { soMirror } from "./scm/routes/so-mirror";
import { drainCommands } from "./scm/lib/amendment-command";
import { drainStockAllocationRecompute } from "./scm/lib/stock-allocation-job";
import { drainAutoCountOutbox } from "./scm/lib/autocount-outbox";
import { refreshAllMrpSnapshots } from "./scm/lib/mrp-snapshot";
import { amendmentMirror } from "./scm/routes/amendment-mirror";
import { customerMirror } from "./scm/routes/customer-mirror";
import { staffMirror } from "./scm/routes/staff-mirror";
import { warehouseMirror } from "./scm/routes/warehouse-mirror";
// POS auth (Phase 1 of the 2990-backend replacement): PIN/session login for the
// 2990 POS. Mounted PRE-AUTH; its two write endpoints re-apply `auth` per-route.
import pos from "./routes/pos";
// Announcements — office posts every logged-in user sees as a top banner with
// a "Got it" ack. Ported from Hookka (single-tenant + office-only here).
import announcements from "./routes/announcements";
// Agent Console — owner-only fleet console for the HOOKKA-ported agents
// (Delivery/Document/CS). Skeleton: controls + runs + config proposals +
// feedback; the engines register themselves in services/agent-scheduler.ts.
import agentConsole from "./routes/agent-console";
import assistant from "./routes/assistant";
import { caseTrack } from "./middleware/caseTrack";
import { supplierTrack } from "./middleware/supplierTrack";
import { dbInject, withPgDb } from "./middleware/db";
import { companyContext } from "./middleware/companyContext";
import { publicDoScan } from "./routes/publicDoScan";
import { publicContractorCalendar } from "./routes/publicContractorCalendar";
import { drainEmailOutbox } from "./services/email";
import { runClientErrorDigest } from "./services/clientErrors";
import { runSlaEscalation } from "./services/assrEscalation";
import { runAssrAlerts, runAssrDailyDigest } from "./services/assrAlerts";
import { runScheduledLeadTimeActivations } from "./services/assrLeadTime";
import { runProjectDueReminders } from "./services/projectReminders";
// Weekly OCR rule-distill (scan-so self-evolution). Run via the daily 02:00
// slot gated to Sundays — no new cron trigger. getSupabaseService is the same
// service client scan-so.ts uses internally (serviceClient(env)).
import { distillAllSalespersonRules, warmCatalogCacheForCron, processScanQueueMessage } from "./scm/routes/scan-so";
import { runAgentHeartbeat } from "./services/agent-scheduler";
import { getSupabaseService } from "./db/supabase";
import { sweepStockClose } from "./acc/stock-close";
import { reapOnce } from "./scm/lib/reaper";
import { getBranding } from "./services/branding";
// AutoCount inbound SO pull — restored 2026-07-14. Reads SO from the AutoCount
// middleware and upserts the local `sales_orders` mirror (read-only against
// AutoCount; writes only ERP tables). Gated by isAutoCountSyncDisabled so the
// env kill switch still halts it. The mirror feeds Finance/P&L revenue and the
// ASSR SO lookup, which had been frozen since the 2026-06-13 pause.
import { runPull } from "./services/pull";
import { runDoMirrorSync } from "./services/doMirror";
// AutoCount PO pulls (restored — frozen since 2026-06-12) and the unfiltered
// ac_snapshot_* staging load that gives the migration reconciliation a
// denominator. Both daily; see the 02:00 slot.
import { runPOPull, runPODocsPull } from "./services/po";
import { runSOSnapshot, runPOSnapshot } from "./services/acSnapshot";
import { isAutoCountSyncDisabled } from "./services/autocount";

const app = new Hono<{ Bindings: Env }>();

// After a successful ASSR/Projects write, bust the acting user's inbox snapshot
// so their own inbox self-heals on the next load (see routes/inbox.ts). Runs the
// handler first, then busts on a 2xx non-GET; always best-effort.
const inboxBustAfterWrite: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.req.method === "GET") return;
  if (c.res.status >= 200 && c.res.status < 300) {
    const uid = c.get("user")?.id;
    if (uid != null) await bustInboxForUser(c.env, uid);
  }
};

// Outermost: one structured access-log line + X-Request-Id per request.
app.use("*", requestLog);

// Allow-listed CORS origins (audit M3). The SPA calls the API SAME-ORIGIN, so it
// needs no CORS at all; the only legitimate CROSS-origin BROWSER callers are the
// company domains and the Pages hosts (prod / staging / preview) plus localhost
// for dev. Everything else is refused instead of the previous wildcard `*`, so a
// random attacker page can no longer read responses from the public/unauth
// endpoints. Non-browser callers (native apps, pg_net, server-to-server) send no
// Origin header and are unaffected.
//
// VERIFY BEFORE MERGE: confirm the POS surface's BROWSER origin is covered below
// (expected to be erp.houzscentury.com or a *.houzs-erp*.pages.dev host). A
// native/mobile POS sends no Origin and needs nothing here.
function corsOriginAllowed(origin: string | undefined | null): string | undefined {
  if (!origin) return undefined; // same-origin / non-browser: no ACAO needed
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
    // 2990 POS is a BROWSER SPA on Cloudflare Pages at 2990s-pos.pages.dev
    // calling this backend cross-origin (post-cutover it targets the Houzs
    // Worker). The M3 allowlist that replaced `cors *` omitted it, which
    // CORS-blocked every POS request (pin-login, catalog, cart) — the POS could
    // not open. The `<hash>.` prefix covers Pages preview deploys.
    /^([a-z0-9-]+\.)?2990s-pos\.pages\.dev$/.test(host) ||
    host === "localhost" ||
    host === "127.0.0.1";
  return ok ? origin : undefined;
}
// X-Company-Code rides on the branding-logo response so the client can refuse
// an image that belongs to another company (see routes/branding.ts). A custom
// response header is INVISIBLE to a cross-origin reader unless it is exposed
// here — omitting it would make the guard silently no-op in prod, where the
// SPA and the worker are different origins.
/* X-Session-Pass is EXPOSED because the middleware re-issues a pass on the
   authoritative path and the SPA has to be able to read it back — a header the
   browser hides is a renewal that silently never happens. It carries no secret:
   the pass is signed, token-bound and revocable, and the client already holds it.
   docs/bugs/0593-*. */
app.use("*", cors({ origin: corsOriginAllowed, exposeHeaders: ["X-Request-Id", "X-Company-Code", "X-Session-Pass"] }));

// Baseline security headers on every Worker response. Deliberately conservative:
// the cross-origin isolation family (CORP/COOP/COEP) is DISABLED because the API
// serves images consumed cross-origin (public image proxies, the POS surface) and
// CORP:same-origin would break those loads. HSTS omits includeSubDomains/preload so
// it cannot affect sibling subdomains. No Content-Security-Policy here yet — CSP is
// breakage-prone and must ship report-only first (tracked separately). The load-
// bearing one is X-Content-Type-Options: nosniff, which blunts MIME-sniff XSS on the
// file-proxy routes.
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

// D1 -> Supabase cutover: swap env.DB for the Postgres-backed shim on every
// request, before auth + routes. Remove once all paths use Drizzle/postgres.js.
app.use("*", dbInject);

app.get("/", (c) => c.json({ ok: true, service: "autocount-sync-api" }));
// `sha` is the commit this Worker was built from — the deploy-watchdog compares
// it to main to catch a rogue/stale overwrite of prod. It now comes from the
// bundled build stamp (build-info.ts, baked at deploy time), which — unlike the
// old `--var GIT_SHA` env var — cannot be dropped by the post-deploy secret step
// (see build-info.ts for the 2026-09-01 null-stamp incident). The env var is
// kept as a fallback for any Worker still on the old mechanism; "dev" is the
// un-stamped local placeholder and reports as no stamp (null).
app.get("/health", (c) => c.json({ ok: true, sha: resolveBuildSha(GIT_SHA, c.env.GIT_SHA) }));

// /api/auth/* is unauthenticated (login, bootstrap, accept-invite, status,
// me, logout). It must be mounted BEFORE the auth middleware below.
app.route("/api/auth", authRoutes);

// Public customer survey — unauthenticated, token-based. Lives under
// /api/survey (not /survey) so it doesn't collide with the SPA route
// at /survey/:token. The SPA page fetches from /api/survey.
app.route("/api/survey", survey);

// Customer Portal — tokenised per-case tracking.
//   POST /api/track               public: verify ASSR no + phone
//   /api/portal/*   (caseTrack)   single-case scoped API
// Both live under /api so the existing /api/* rewrite in _redirects
// forwards them correctly, and they never collide with SPA paths
// like /track or /portal/case/:token.
app.route("/api/track", track);
app.use("/api/portal/*", caseTrack);
app.route("/api/portal", portal);

// Supplier portal — same shape as customer portal, different middleware.
app.use("/api/supplier-portal/*", supplierTrack);
app.route("/api/supplier-portal", supplierPortal);

// Mail Center inbound ingest — PRE-AUTH, secret-guarded machine-to-machine.
// MUST be mounted BEFORE the /api/* auth gate so the standalone inbound Worker
// (no staff session) can POST received mail. It authenticates the caller with
// the x-mail-secret header vs env.MAIL_INBOUND_SECRET and 503s until that secret
// is set. Mounted at the exact sub-path so the authed mail-center router below
// never shadows it.
app.route("/api/mail-center/inbound", mailInbound);
// 2990 live SO mirror — pre-auth, secret-guarded (x-sync-secret == SYNC_SECRET).
app.route("/api/sync/so-mirror", soMirror);
// 2990 live SO AMENDMENT mirror — same caller, same secret, SEPARATE route and
// SEPARATE 2990-side drain/cron, so an amendment failure can never stall the SO
// mirror the business already runs on.
app.route("/api/sync/amendment-mirror", amendmentMirror);
// 2990 live CUSTOMER mirror — same caller, same secret, SEPARATE route and
// SEPARATE 2990-side drain/cron. This is the masters prerequisite (design D6):
// customers is a live FK parent of mirrored SOs, and a frozen import means a new
// 2990 customer's first SO 500s here forever (SO-2607-013, 6582 attempts).
app.route("/api/sync/customer-mirror", customerMirror);
// 2990 live STAFF + WAREHOUSE mirrors — the rest of the SO trio's FK parents, and
// the last two that can wedge it (venues are NULLed by so-mirror; items carry no
// product FK). Same caller, same secret, SEPARATE routes and SEPARATE 2990-side
// drains/crons. staff has NO company_id (0083: shared masters get none), so it
// guards on `user_id IS NULL` — the Houzs-User-Management handover flag — instead.
app.route("/api/sync/staff-mirror", staffMirror);
app.route("/api/sync/warehouse-mirror", warehouseMirror);
// POS auth — pin-login + sales-staff are PRE-AUTH (before the /api/* gate);
// every OTHER route in the router re-applies `auth` on itself (set-pin,
// verify-pin, sales-stats and the three admin-*-pin doors).
app.route("/api/pos", pos);

// Google Form intake webhook — PRE-AUTH like mail-inbound: called by
// Google Apps Script (no staff session), self-guarded by the
// FORM_INTAKE_KEY shared secret (X-Intake-Key header). Was mounted
// below the gate at first, so every call 401'd at the gate before the
// route's own key check ever ran.
app.route("/api/assr-form-intake", assrFormIntake);

// Auth gate for everything else under /api/*. Mounted AFTER the
// public API routes above so they stay unauthenticated.
// PUBLIC image proxies for the cross-origin POS — MUST be mounted BEFORE the
// global `auth` + `requireScmAccess` gates so a plain <img src> (no Bearer, no
// same-origin cookie) reaches them. Only these two GET routes are exposed; every
// other /api/scm/* path is untouched and still hits the gates below. Mirrors how
// 2990's api serves Model photos auth-free. See scm/routes/public-images.ts.
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

// PUBLIC no-login CONTRACTOR CALENDAR — also mounted BEFORE the `auth` gate: a
// booth-setup contractor opens their link with no Houzs account. The gate is the
// unguessable token in the URL (services/contractorShare.ts) plus the revoke
// kill switch. The route returns ONLY the confirmed schedule (venue + booth +
// dates) for the ONE contractor the token resolves to — never finance or any
// other contractor's events. See routes/publicContractorCalendar.ts.
app.route("/api/public/contractor-calendar", publicContractorCalendar);

app.use("/api/*", auth);

// Multi-company (Phase 0b): resolve the ACTIVE company + allowed companies per
// request (X-Company-Id switcher header / hostname default) and stash them on
// the context, so BOTH the SCM query-scoping helpers (scm/lib/companyScope.ts)
// AND the native raw-SQL modules (sales / finance) can filter + stamp
// company_id. Mounted on the whole authenticated /api/* surface: after auth,
// before idempotency and every route. Reads only request headers + the companies
// master, so native routes without any company table simply ignore
// c.get('companyId'), and it DEGRADES SAFELY (leaves companyId undefined) when
// the companies master isn't resolvable yet — so single-company Houzs keeps
// serving unchanged and the pre-auth public routes above are untouched.
app.use("/api/*", companyContext);

// Principal + company scoped request idempotency (no-op unless the client sends
// an `Idempotency-Key` header). Mounted after auth AND companyContext so a key
// can never replay another user's or another company's response. Bookkeeping
// failures are fail-closed for callers that explicitly request idempotency.
app.use("/api/*", idempotency);

// Inbox snapshot self-heal — the /api/inbox GET caches a per-user aggregate of
// ASSR + Projects + Trips for ~60s. After the acting user makes a successful
// write to ASSR or Projects, bust THEIR snapshot so their own inbox reflects it
// on the next load instead of staying stale for up to a minute. Best-effort and
// post-response: never blocks or fails the write. Scoped to /api/assr + /api/
// projects only, where c.get("user") is the Houzs bigint user that keys the
// snapshot; the /api/scm/* trip routes carry the scm.staff UUID (see the
// staff-UUID bigint trap), so their inbox slice stays on the 60s TTL. Cross-
// user staleness (items assigned to others) is likewise intentionally on TTL.
app.use("/api/assr/*", inboxBustAfterWrite);
app.use("/api/projects/*", inboxBustAfterWrite);

// Mount the Lead Time Portal first so /api/assr/portal/* doesn't
// fall through into the catch-all /:id handler on the main module.
app.route("/api/assr/portal", assrPortal);
app.route("/api/assr", assr);
app.route("/api/logs", logs);
app.route("/api/audit", auditRoutes);
app.route("/api/admin/health", systemHealthRoutes);
// Behind the /api/* auth gate: intake needs a session (identity is stamped from
// it, never from the body); the /summary read is super-admin inside the router.
app.route("/api/client-errors", clientErrors);
app.route("/api/udf", udf);
app.route("/api/totp", totpRoutes);
app.route("/api/users", users);
app.route("/api/roles", roles);
app.route("/api/positions", positions);
app.route("/api/position-capabilities", positionCapabilities);
app.route("/api/departments", departments);
app.route("/api/companies", companies);
// Column layouts: this user's own (synced across their machines) + each
// company's admin-set default. Any signed-in user reads and writes their OWN
// row; the /default writes gate on settings.manage inside the router.
app.route("/api/table-layouts", tableLayouts);
app.route("/api/notifications", notifications);
// Native-app push device registry (any signed-in user, own device only).
app.route("/api/push", pushDevices);
app.route("/api/presence", presence);
app.route("/api/projects", projects);
app.route("/api/sales", sales);
app.route("/api/finance", finance);
app.route("/api/stockitems", stockItems);
app.route("/api/fleet", fleet);
app.route("/api/fleet-maintenance", fleetMaintenance);
app.route("/api/settings", settings);
app.route("/api/branding", branding);
app.route("/api/inbox", inbox);
// Mail Center (authed) — reads/reply/compose/label gate on mailbox SCOPE
// ownership; alias/access/scope-level admin gate on mail_center.manage inside
// the handlers (owner passes via "*"). The pre-auth /api/mail-center/inbound
// route is mounted above, before the auth gate, and is not shadowed by this.
app.route("/api/mail-center", mailCenter);
// Announcements — the banner GET, the LIST GET and the ack POST are open to
// every authed user (the route handles it internally: the list is audience- and
// company-filtered server-side, same as the banner). announcements.read is the
// ADMIN verb and no longer gates reading; CRUD/remind/acks-readout stay on
// announcements.write.
app.route("/api/announcements", announcements);
// Agent Console — owner-only (requirePermission("*") inside the router).
// Deliberately in the public /api tree, NOT /api/scm (the scm subtree swaps
// c.get('user') to scm.staff UUIDs — the known staff-UUID bigint trap).
app.route("/api/agents", agentConsole);
app.route("/api/assistant", assistant);
app.route("/api/projects-print", projectsPrint);
app.route("/api/search", search);
app.route("/api/assr-print", assrPrint);

// ── Ported 2990's SCM (furniture supply chain) — /api/scm/* ──────────
// Gated on scm.access (Owner / IT Admin pass via their "*" wildcard). The
// routes attach their own scm-scoped supabase client via scm/middleware/auth.
// requireScmAccess is ADDITIVE: it keeps the exact "*"/"scm.access" pass
// conditions AND also lets a position pass when it has ANY scm* page-access
// area granted at >= view — so per-position SCM grants work without removing
// any existing user's access. (Was requireAnyPermission(["*","scm.access"]).)
app.use("/api/scm/*", requireScmAccess);
app.route("/api/scm", scmApp);

// Map raw infrastructure errors to operator-friendly messages so staff never
// see a Postgres/driver string (e.g. the "operator does not exist: date < text"
// or "CONNECTION_CLOSED" leaks seen during the cutover). Full error still goes
// to wrangler tail for us. HTTPException (thrown with an intended status) passes
// through untouched.
function humanizeError(err: Error): { status: 500 | 503; message: string } {
  const m = String(err?.message ?? err);
  // Transient connection failures (cold-start hang, pooler connection cap,
  // dropped/reaped socket, cross-context I/O) -> 503 "try again". Shares ONE
  // matcher with the retry layer (d1-compat TRANSIENT_CONN_RE) so the two can
  // never drift apart, and the frontend retries idempotent GETs on 503 — so
  // these self-heal instead of surfacing as a dead-end "Something went wrong".
  if (TRANSIENT_CONN_RE.test(m))
    return { status: 503, message: "The database is briefly unavailable. Please try again in a moment." };
  if (/operator does not exist|column .* does not exist|relation .* does not exist|syntax error|invalid input syntax|violates .* constraint|duplicate key/i.test(m))
    return { status: 500, message: "Something went wrong processing that request. Please try again." };
  return { status: 500, message: "Something went wrong. Please try again." };
}

app.onError((err, c) => {
  console.error("[onError]", err);
  // Preserve Hono HTTPException status/body (intentional 4xx from handlers).
  const anyErr = err as Error & { getResponse?: () => Response; status?: number };
  const base =
    typeof anyErr.getResponse === "function"
      ? anyErr.getResponse()
      : (() => {
          const { status, message } = humanizeError(err);
          return c.json({ error: message }, status);
        })();
  // The cors() middleware sets Access-Control-Allow-Origin in its post-next()
  // pass, which is SKIPPED when a handler throws — so error responses would
  // otherwise reach the browser WITHOUT CORS headers and surface as an opaque
  // "Failed to fetch" instead of the real status/message. Re-add them here so
  // every error is readable by the SPA — but only for an allow-listed origin,
  // matching the restricted cors() above (audit M3), never a blanket "*".
  const res = new Response(base.body, base);
  const allowedOrigin = corsOriginAllowed(c.req.header("Origin"));
  if (allowedOrigin) res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  res.headers.set("Access-Control-Expose-Headers", "X-Request-Id, X-Session-Pass");

  // Error tracking. INERT until the owner sets the SENTRY_DSN secret — with no
  // DSN this call returns before doing anything (no fetch, no log, no latency),
  // which is the default state on every environment. See
  // services/errorTracking.ts and docs/error-tracking-options.md.
  //
  // Only 5xx is reported. A handler that deliberately threw an HTTPException
  // with a 4xx status is telling a caller it got the request wrong; sending
  // those would bury the real failures and burn the free monthly quota on
  // validation noise.
  //
  // The route PATTERN, not the URL, is what travels: c.req.routePath is
  // "/api/scm/sales-orders/:id" where the URL would carry ids and (on a search)
  // the customer's name in the query string.
  if (res.status >= 500) {
    // c.executionCtx throws when the runtime did not supply one (some test
    // harnesses). Falling back to a floating promise is correct here — the
    // reporter is fire-and-forget by design.
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

// Exported for portalSurfaces.test.ts, which walks `app.routes` in
// registration order to prove every PUBLIC_API_PREFIXES entry is backed
// by a router mounted above the auth gate. The invariant is about mount
// ORDER, so it can only be checked against the assembled app.
export { app };

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Cutover: cron services write via env.DB too — point it at Postgres.
    env = withPgDb(env);
    if (event.cron === "*/5 * * * *") {
      // Keep-warm: a trivial DB ping every 5 min keeps the Hyperdrive pool
      // alive through quiet periods so the first real request never hits a
      // reaped/cold connection. Cheap — SELECT 1.
      ctx.waitUntil(
        env.DB.prepare("SELECT 1 AS ok").first().catch((e) => console.error("[cron keepwarm]", e))
      );
      // Durable email: retry outbox rows whose immediate send failed. No-op
      // without RESEND_API_KEY; bounded to 25 rows / 3 attempts so a bad batch
      // can't stall the slot.
      ctx.waitUntil(
        drainEmailOutbox(env)
          .then((r) => {
            if (r.processed) console.log(`[cron email-outbox] processed=${r.processed} sent=${r.sent} failed=${r.failed}`);
          })
          .catch((e) => console.error("[cron email-outbox]", e))
      );
      // AutoCount inbound SO pull (incremental, checkpoint-driven). getSince()
      // fetches every SO modified since the stored pull_checkpoint and upserts
      // the local `sales_orders` mirror — so the first run after re-enabling
      // catches the mirror up from the 2026-06-13 freeze, and every 5-min run
      // keeps it fresh. Read-only against AutoCount (no writes back). Gated by
      // the env kill switch; best-effort so a pull failure never breaks the slot.
      if (!isAutoCountSyncDisabled(env)) {
        ctx.waitUntil(
          runPull(env, "SCHEDULED")
            .then((r) => console.log(`[cron so-pull] ${r.message}`))
            .catch((e) => console.error("[cron so-pull]", e))
        );
      }
      // Amendment write-back backstop (design §3.2): drain any sync_command left
      // PENDING (a lost inline attempt, a 2990 hiccup). No-op when the DB flag is
      // off or the 2990 bridge is unconfigured, so this is safe to run always and
      // ships dark. Best-effort — a drain failure can never break the slot.
      ctx.waitUntil(
        drainCommands(env)
          .then((r) => {
            if (r.processed) console.log(`[cron amendment-cmd] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron amendment-cmd]", e))
      );
      // ERP -> AutoCount write-back drain. Ships dark twice over: no-op without
      // AC_SYNC_URL, and no-op while scm.app_config 'scm.autocount_writeback'
      // is off (which 0277 seeds it to). Best-effort — a drain failure can
      // never break the slot.
      ctx.waitUntil(
        drainAutoCountOutbox(env)
          .then((r) => {
            /* A FAILED row means a document exists in the ERP and does not
               exist in AutoCount. That is the divergence this whole mechanism
               is built to prevent, so it can never read as routine. */
            if (r.failed) console.error(`[cron ac-writeback] FAILED ${JSON.stringify(r)}`);
            else if (r.processed) console.log(`[cron ac-writeback] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron ac-writeback]", e))
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
        drainStockAllocationRecompute(env)
          .then((r) => {
            /* A dead-lettered job is the one state that must NEVER read as
               routine: allocation has stopped and stays stopped until a human
               acts. Logged at error level on every sweep so it cannot hide in
               the noise. */
            if (r.deadLettered) console.error(`[cron so-allocation] DEAD LETTER ${JSON.stringify(r)}`);
            else if (r.processed || r.reason) console.log(`[cron so-allocation] ${JSON.stringify(r)}`);
          })
          .catch((e) => console.error("[cron so-allocation]", e))
      );
    } else if (event.cron === "*/15 * * * *") {
      // MRP stored-planning snapshot refresh (option B, 2026-08-19): recompute
      // each company's default-view MRP and save it, so the MRP page opens
      // instantly from a fresh plan. Best-effort + fire-and-forget — a slow or
      // failed run logs and never stalls the slot.
      ctx.waitUntil(
        refreshAllMrpSnapshots(env, new Date().toISOString())
          .catch((e) => console.error("[cron mrp-snapshot]", e))
      );
    } else if (event.cron === "*/30 * * * *") {
      // ASSR/QMS v3.1 — per-stage alert scanner (half / approaching / breach).
      // Cheap: one query over open stage_history rows, idempotent via the
      // alerts_fired bit-mask.
      ctx.waitUntil(
        runAssrAlerts(env)
          .then((r) =>
            console.log(
              `[cron assr-alerts] scanned=${r.cases_scanned} half=${r.half} appr=${r.approaching} breach=${r.breach}`
            )
          )
          .catch((e) => console.error("[cron assr-alerts]", e))
      );
      // Lead-time scheduled activations (mig 080). Cheap: one indexed SELECT
      // for pending rows whose scheduled_for is past.
      ctx.waitUntil(
        runScheduledLeadTimeActivations(env)
          .then((r) => {
            if (r.fired > 0) console.log(`[cron lead-time-schedule] fired=${r.fired}`);
          })
          .catch((e) => console.error("[cron lead-time-schedule]", e))
      );
      // Agent heartbeat — the agents decide their own cadence (scheduler's
      // >=1h min-gap makes this an effective hourly beat). No-op until an
      // engine registers; kill switch / pause honoured inside. Best-effort:
      // a heartbeat failure can never break the other crons.
      ctx.waitUntil(
        runAgentHeartbeat(env)
          .then((r) => {
            if (r.ran.length)
              console.log(
                `[cron agent-heartbeat] ran=${r.ran.map((x) => x.task).join(",")} skipped=${r.skipped.length}`
              );
          })
          .catch((e) => console.error("[cron agent-heartbeat]", e))
      );
      // Keep-warm the scan-SO catalog prompt-cache during Malaysia business
      // hours (UTC+8 ~08:00–22:00 → UTC hour 0–13) so the shared Anthropic
      // cache rarely goes cold between showroom scans. Fires the SAME minimal
      // warm call /scan-so/warm uses (byte-identical cachedPrefix). Skips
      // gracefully when ANTHROPIC_API_KEY is unset; try/catch so a warm failure
      // can never break the scheduled handler.
      {
        const h = new Date(event.scheduledTime).getUTCHours();
        if (h >= 0 && h < 14 && env.ANTHROPIC_API_KEY) {
          ctx.waitUntil(
            warmCatalogCacheForCron(env)
              .then((r) => console.log(`[cron scan-so warm] ${JSON.stringify(r)}`))
              .catch((e) => console.error("[cron scan-so warm]", e)),
          );
        }
      }
      // iOS fleet-reminder push (docs/ios-app-store.md, phase 3). Gated to the
      // 08:00 MYT hour (UTC 0); the slot fires twice in it and the per-device
      // date stamp makes the second pass a no-op. Ships dark until the APNS_*
      // secrets exist. Best-effort — a push failure can never break the slot.
      {
        const h = new Date(event.scheduledTime).getUTCHours();
        if (h === 0) {
          ctx.waitUntil(
            runPushFleetReminders(env)
              .then((r) => {
                if (r.attempted || r.reason !== "apns_not_configured")
                  console.log(`[cron push-reminders] ${JSON.stringify(r)}`);
              })
              .catch((e) => console.error("[cron push-reminders]", e))
          );
        }
      }
      // Slip reaper (mirrors 2990's */10 orphan-slip sweep, which retires with
      // 2990's apps/api). Leases up to 100 orphan pending_slip_uploads rows
      // (5-min lease, SKIP LOCKED via lease_orphan_slips), deletes each R2 blob,
      // marks the row failed — reclaims leaked payment-slip objects from
      // abandoned/failed uploads. Idempotent; best-effort (a failure can never
      // break the other crons).
      ctx.waitUntil(
        reapOnce(getSupabaseService(env), env, `cron-${event.scheduledTime}`)
          .then((r) => {
            if (r.claimed > 0 || r.errors > 0)
              console.log(
                `[cron slip-reaper] claimed=${r.claimed} deleted=${r.deleted} errors=${r.errors} remaining=${r.remaining}`
              );
          })
          .catch((e) => console.error("[cron slip-reaper]", e))
      );
    } else if (event.cron === "0 2 * * *") {
      // Daily 02:00 UTC slot: SLA escalation + ASSR digest + project reminders.
      ctx.waitUntil(
        runSlaEscalation(env)
          .then((r) => console.log(`[cron sla] escalated ${r.escalated} case(s)`))
          .catch((e) => console.error("[cron sla]", e))
      );
      // AutoCount DO-header mirror refresh (mig 0215) — feeds the ASSR list's
      // DO No column for Houzs cases. Incremental via DeliveryOrder/getSince
      // once the middleware upgrade (its PR #1) is deployed; until then each
      // run streams the ~70 MB full dump — hence the daily batch slot, not
      // the 5-min SO pull. Same kill-switch + best-effort rules as the SO pull.
      if (!isAutoCountSyncDisabled(env)) {
        ctx.waitUntil(
          runDoMirrorSync(env, "SCHEDULED")
            .then((r) => console.log(`[cron do-mirror] ${r.message}`))
            .catch((e) => console.error("[cron do-mirror]", e))
        );
        // AutoCount PO pulls — frozen since 2026-06-12 because the 2026-07-14
        // restore brought back the SO pull only. Both tables are read on main:
        // `purchase_orders` by the ASSR supplier-PO lookup, `purchase_order_docs`
        // by Finance/P&L. Daily, not 5-min: each is a full wipe-and-reload of a
        // few thousand rows. Sequential so the two reloads never interleave, and
        // best-effort like every other job in this slot.
        ctx.waitUntil(
          runPODocsPull(env, "SCHEDULED")
            .then((r) => console.log(`[cron po-docs-pull] ${r.message}`))
            .then(() => runPOPull(env, "SCHEDULED"))
            .then((r) => console.log(`[cron po-pull] ${r.message}`))
            .catch((e) => console.error("[cron po-pull]", e))
        );
        // Full AutoCount snapshots into the ac_snapshot_* staging tables
        // (mig 0282) — the unfiltered denominator the migration reconciliation
        // needs. Writes only its own tables, so a failure here cannot touch the
        // mirrors above.
        ctx.waitUntil(
          runSOSnapshot(env, "SCHEDULED")
            .then((r) => console.log(`[cron ac-snapshot-so] ${r.message}`))
            .then(() => runPOSnapshot(env, "SCHEDULED"))
            .then((r) => console.log(`[cron ac-snapshot-po] ${r.message}`))
            .catch((e) => console.error("[cron ac-snapshot]", e))
        );
      }
      ctx.waitUntil(
        runAssrDailyDigest(env)
          .then((r) => console.log(`[cron assr-digest] sent=${r.recipients} cases=${r.cases}`))
          .catch((e) => console.error("[cron assr-digest]", e))
      );
      ctx.waitUntil(
        runProjectDueReminders(env)
          .then((r) =>
            console.log(
              `[cron proj-reminders] ${r.items} item(s) across ${r.recipients} recipient(s), ${r.sent} email(s) sent`
            )
          )
          .catch((e) => console.error("[cron proj-reminders]", e))
      );
      // Client-error digest: one email to IT when anything crashed in the last
      // 24h (zero errors = no email), plus the 90-day retention sweep.
      // Best-effort — a digest failure can never break the other crons.
      ctx.waitUntil(
        runClientErrorDigest(env)
          .then((r) => {
            if (r.errors || r.purged)
              console.log(
                `[cron client-errors] sent=${r.sent} errors=${r.errors} occurrences=${r.occurrences} purged=${r.purged}`
              );
          })
          .catch((e) => console.error("[cron client-errors]", e))
      );
      // Idempotency-key TTL sweep. Keys only need to outlive a client's retry
      // window; 24h is generous. Cheap (indexed on created_at).
      //
      // The predicate is PG-native on purpose. idempotency_keys.created_at is
      // `timestamptz` (mig 0003), but the d1-compat shim rewrites
      // datetime('now','-24 hours') into a to_char(...) that returns TEXT — so
      // the old form was `timestamptz < text`, which Postgres rejects with
      // "operator does not exist". `.catch(console.error)` swallowed it, so this
      // sweep had never once deleted a row. mig 0008's rule ("created_at columns
      // are only ever populated by DEFAULT now(), so they stay timestamptz — no
      // bug there") reasons about WRITES only; it does not cover COMPARING a
      // created_at against a shim-rewritten datetime('now'), which is this. When
      // a timestamptz column meets datetime('now'), compare in PG terms.
      ctx.waitUntil(
        env.DB.prepare(
          `DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`,
        )
          .run()
          .then((r) => {
            const n = r?.meta?.changes ?? 0;
            if (n) console.log(`[cron idempotency-sweep] purged ${n} expired key(s)`);
          })
          .catch((e) => console.error("[cron idempotency-sweep]", e)),
      );
      // AR aging snapshot (WO-3): rebuild scm.mv_ar_aging — the pre-aggregated
      // rollup behind the Outstanding summary's ?snapshot=1 fast path (migration
      // 0151) — then stamp its freshness row. CONCURRENTLY so a nightly rebuild
      // never blocks a reader (the MV carries a UNIQUE index for exactly this).
      // The REFRESH and the meta UPDATE are TWO separate autocommit statements on
      // purpose: REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a
      // transaction, so they must never be batched (env.DB.batch wraps in one).
      // Guarded so a refresh failure can never break the other 02:00 jobs — the
      // endpoint keeps serving the previous snapshot (or the live path) until the
      // next successful run.
      ctx.waitUntil(
        (async () => {
          await env.DB.prepare(
            "REFRESH MATERIALIZED VIEW CONCURRENTLY scm.mv_ar_aging",
          ).run();
          await env.DB.prepare(
            "UPDATE scm.mv_ar_aging_meta SET refreshed_at = now()",
          ).run();
          console.log("[cron ar-aging-refresh] refreshed scm.mv_ar_aging");
        })().catch((e) => console.error("[cron ar-aging-refresh]", e)),
      );
      // Weekly: re-distill every salesperson's scan-so OCR rules + the
      // __GLOBAL__ alias dictionary. Reuses the daily 02:00 slot, gated to
      // Sundays so it runs once a week without a dedicated cron trigger.
      // distillAllSalespersonRules cheap-skips reps with <2 samples and returns
      // a graceful error result when ANTHROPIC_API_KEY is unset — log + swallow
      // so a distill failure can never break the scheduled handler.
      if (new Date(event.scheduledTime).getUTCDay() === 0) {
        ctx.waitUntil(
          (async () => {
            try {
              const branding = await getBranding(env);
              const summary = await distillAllSalespersonRules(
                getSupabaseService(env),
                env.ANTHROPIC_API_KEY,
                branding.companyName,
              );
              console.log("[scan-so weekly distill]", JSON.stringify(summary));
            } catch (e) {
              console.error("[scan-so weekly distill]", e);
            }
          })(),
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
        (async () => {
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
        })().catch((e) => console.error("[cron stock-close]", e)),
      );
    }
  },
  // Cloudflare Queue consumer for the background scan-so OCR pipeline (queue
  // `houzs-scan-ocr`, DLQ `houzs-scan-ocr-dlq`). max_batch_size = 1, so each
  // batch is one job. A queue-owned attempt survives isolate eviction — the
  // reliability fix for the old waitUntil pipeline. On success ack; on failure
  // retry (up to max_retries in wrangler.toml, then the message lands in the
  // DLQ and the read-time reaper marks it stale as a final backstop).
  async queue(batch: MessageBatch<{ jobId: string }>, env: Env, _ctx: ExecutionContext) {
    // Mirror the scheduled handler: the consumer writes via env.DB too, so
    // point it at Postgres.
    env = withPgDb(env);
    for (const msg of batch.messages) {
      try {
        await processScanQueueMessage(env, msg.body.jobId);
        msg.ack();
      } catch (e) {
        console.error("[scan-queue]", msg.body?.jobId, e);
        msg.retry();
      }
    }
  },
};
