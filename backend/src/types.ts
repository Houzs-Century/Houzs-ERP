export type Env = {
  // During the D1 -> Supabase cutover, `DB` is injected per request/cron with
  // a D1-compatible shim over Postgres (see middleware/db.ts). The legacy D1
  // binding may stay in wrangler.toml until the cutover is verified.
  DB: D1Database;
  // Cloudflare Hyperdrive over the Supabase pooler (prod). Local dev / scripts
  // read DATABASE_URL from .dev.vars instead.
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  // Supabase REST (PostgREST) access — for the SCM modules ported from 2990's,
  // which talk to the SAME Supabase via supabase-js (alongside the Drizzle /
  // Hyperdrive path the rest of Houzs uses). All point at one DB. Set the keys
  // via `wrangler secret put`. SUPABASE_URL is `https://<project-ref>.supabase.co`.
  // Required by the ported 2990's SCM routes (they createClient(...) directly).
  // Set in .dev.vars locally; must be set as Worker vars/secrets for prod.
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Anthropic vision/OCR key for the ported SCM /scan-so route (handwritten
  // sale-order slip → structured JSON). OPTIONAL: when unset, /scan-so/extract
  // returns 503 anthropic_key_missing — the worker still boots and tsc passes.
  // Set via `wrangler secret put ANTHROPIC_API_KEY` (and in .dev.vars locally).
  ANTHROPIC_API_KEY?: string;
  // Shared secret for the Google Form → ERP intake webhook
  // (/api/assr-form-intake). GitHub secret, injected at deploy; the
  // endpoint 401s on every request while unset.
  FORM_INTAKE_KEY?: string;
  /** Shared secret for the sheet status-export pull (Nick 2026-07-14) —
   *  a separate key from FORM_INTAKE_KEY because the form-intake script
   *  lives in a different Google account than the HC Delivery sheet's. */
  SHEET_SYNC_KEY?: string;
  /** Shared secret for the sheet's 2990 ready-to-ship pull (Nico 2026-08-26).
   *  A THIRD key, not a reuse: the two above both speak for HOUZS, and by the
   *  2026-08-18 rule a secret may only open its own company's data. This one
   *  speaks for 2990 and opens nothing else. Unset => /so-export 401s. */
  SHEET_SYNC_KEY_2990?: string;
  /** ISO-8601 instant. While set AND in the future, a Sales Order mutation that
   *  omits the concurrency `version` is accepted with the pre-CAS
   *  last-writer-wins semantics instead of 428. This is the ROLLOUT grace for
   *  browser tabs that were already open when mandatory CAS deployed; a STALE
   *  version is still 409 either way. Unset = strict (the steady state). Set it
   *  to deploy time + 30 minutes at cutover, then delete the variable.
   *  See docs/IDEMPOTENCY-PHASE2-RUNBOOK.md. */
  SO_CAS_GRACE_UNTIL?: string;
  /** Seampify WhatsApp gateway (Delivery Planning "Send Message", owner
   *  2026-07-22). BOTH are wrangler secrets; while either is unset the send
   *  endpoint answers 503 not_configured — the UI ships before the creds. */
  SEAMPIFY_SEND_URL?: string;
  SEAMPIFY_API_KEY?: string;
  POD_BUCKET: R2Bucket;
  // R2 buckets used by the ported SCM routes (SO item photos, public assets).
  // Typed required so the ported code compiles; bind in wrangler.toml before the
  // photo/asset endpoints are exercised (they fail at runtime until then).
  SO_ITEM_PHOTOS: R2Bucket;
  PUBLIC_ASSETS: R2Bucket;
  // Payment-slip bucket (bound in wrangler.toml since 2026-07-04). The slip
  // flow is a Worker-proxy upload through this binding — it needs NO R2 S3
  // creds (see scm/routes/slips.ts). Optional so tests without the binding
  // still compile; scm/lib/slip.ts slipBindings() guards at runtime.
  SLIPS?: R2Bucket;
  // Cloudflare Queue for the background scan-so OCR pipeline (queue
  // `houzs-scan-ocr`, DLQ `houzs-scan-ocr-dlq`). The /scan-so/enqueue producer
  // sends ONLY the job id; the consumer (index.ts `queue()` handler) rebuilds
  // everything from the scan_jobs row + R2 photos. Optional so tests / older
  // deploys without the binding compile and fall back to the waitUntil path.
  SCAN_QUEUE?: Queue<{ jobId: string }>;
  // R2 S3-API credentials for presigned SO-item-photo GET URLs ONLY (the slip
  // flow no longer uses them). Optional — those endpoints fail at runtime
  // until set.
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  SO_ITEM_PHOTOS_BUCKET_NAME?: string;
  // Optional KV cache for the hydrated session user (see services/sessionCache.ts).
  // Absent in tests/local — auth falls back to the DB path unchanged.
  SESSION_CACHE?: KVNamespace;
  // Bounded DB-outage session-liveness fallback. "true" = during a DB read
  // failure getUserBySession may re-serve a session the DB most recently
  // confirmed active, for up to SESSION_FALLBACK_TTL_MS, instead of logging
  // everyone out on a cold-start 503 / pooler blip. ABSENT OR ANYTHING ELSE =
  // OFF (fail-closed default): the fallback code path is not entered at all and
  // a DB read failure rejects the request. Parsed by
  // services/sessionCache.isSessionFallbackEnabled.
  SESSION_FALLBACK_ENABLED?: string;
  // Milliseconds a DB-confirmed session may be re-served while the DB is down.
  // Only read when SESSION_FALLBACK_ENABLED is "true". Default 60000, clamped
  // to 1000..300000; anything non-numeric or out of range uses the default.
  // Parsed by services/sessionCache.sessionFallbackTtlMs.
  SESSION_FALLBACK_TTL_MS?: string;
  AUTOCOUNT_API_URL: string;
  AUTOCOUNT_API_KEY: string;
  // Inbound-sync kill switch. "true" = skip every AutoCount pull (cron + manual).
  AUTOCOUNT_SYNC_DISABLED?: string;
  // ── ERP -> AutoCount WRITE-BACK (outbound; separate from the two above,
  // which are the legacy inbound pull) ───────────────────────────────────────
  // Base URL of AcSyncService, the write-back service that runs ON the AutoCount
  // host and drives the licensed 2.2 SDK (backend/scripts/autocount-service).
  // CONFIG, not a secret — a hostname and a port. ABSENT = the write-back drain
  // is a no-op and says so, which is the state this ships in.
  AC_SYNC_URL?: string;
  // Shared key for that service's X-API-KEY header. A CREDENTIAL: set it as a
  // wrangler secret (`wrangler secret put AC_SYNC_KEY`), never in wrangler.toml.
  AC_SYNC_KEY?: string;
  DASHBOARD_API_KEY: string;
  // Dedicated service token for Houzs Connect's org sync — accepted as the
  // same service-tier caller as DASHBOARD_API_KEY (see middleware/auth.ts),
  // so Connect authenticates with its own credential.
  CONNECT_SERVICE_TOKEN: string;
  GOOGLE_MAPS_API_KEY?: string;
  // Email (Resend). Leave RESEND_API_KEY unset to run in no-op mode —
  // send() will log + skip, never throw.
  RESEND_API_KEY?: string;
  // APNs push (services/apns.ts). All unset = no-op mode, same as Resend.
  // Values come from an App Store Connect auth KEY (.p8) once the Apple
  // Developer enrolment completes — see docs/ios-app-store.md.
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_SANDBOX?: string;
  EMAIL_FROM?: string;        // e.g. "Houzs ERP <no-reply@houzs.com>"
  EMAIL_REPLY_TO?: string;
  // Public origin for building email links (portal survey URLs etc.).
  // Falls back to the worker URL if unset.
  PUBLIC_APP_URL?: string;
  // Commit this Worker build was deployed from. Stamped ONLY by deploy.yml
  // (`wrangler deploy --var GIT_SHA:<sha>`); absent on any bare local deploy.
  // Read by GET /health and compared against main by the deploy-watchdog
  // workflow, which auto-redeploys main when the live Worker goes stale.
  GIT_SHA?: string;
  // "true" opens admin login-as-member to EVERY users.manage admin
  // (routes/users.ts impersonation). Set ONLY in [env.staging.vars] — never
  // on prod: there the wildcard owner (`*`) can always impersonate anyway,
  // via short-lived 1-hour audited sessions, without this flag.
  IMPERSONATION_ENABLED?: string;
  // Cost/margin DISPLAY switch — the ONE backend-authoritative toggle for
  // whether SCM sales-document cost/margin may reach the wire at all. "false"
  // withholds cost/margin from EVERY response (canViewScmFinance returns false
  // for everyone) and drops the scm.finance.view capability, so the FE hides the
  // columns too. Absent / anything but "false" = ON (current prod behaviour, no
  // regression). Parsed once via scm/lib/costing-enabled.isCostingDisplayEnabled.
  // Mirrors the FE build-time COSTING_DISPLAY_ENABLED, but THIS is authoritative.
  COSTING_DISPLAY_ENABLED?: string;
  // Stock-take posting thresholds (phase 1, 2026-08-08). A variance whose
  // |qty delta| exceeds the qty limit, or whose |delta| x unit cost exceeds the
  // value limit (integer SEN), needs scm.stock_take.supervise to post. Absent /
  // unparseable = the shipped defaults (5 units / RM500) — same absent-safe
  // posture as COSTING_DISPLAY_ENABLED. Parsed once by
  // scm/shared/stock-take-threshold.parseVarianceThresholds; set in
  // wrangler.toml [vars] only when the owner wants different limits.
  STOCK_TAKE_VARIANCE_QTY_LIMIT?: string;
  STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN?: string;
  /** Error tracking (services/errorTracking.ts). The ONE switch: while unset —
   *  the default on every environment — the reporter makes no network call, no
   *  log line and no allocation, so the ERP behaves exactly as it did before it
   *  existed. Set once with `wrangler secret put SENTRY_DSN` to turn on BOTH
   *  backend throws and relayed browser crashes. A Sentry DSN or a self-hosted
   *  GlitchTip DSN both work — same wire protocol. See
   *  docs/error-tracking-options.md. */
  SENTRY_DSN?: string;
  /** Environment label on every reported event. Defaults to "production";
   *  [env.staging.vars] sets "staging" so one project can hold both without the
   *  two polluting each other's alert rules. Plain var, not a secret. */
  SENTRY_ENVIRONMENT?: string;
  /** Fraction of errors to report, "0".."1". Absent / unparseable = 1 (report
   *  everything), which is the right default at this volume — the per-isolate
   *  storm brake, not sampling, is what protects the free quota. Dial down only
   *  if the monthly quota is genuinely being spent on steady-state noise. */
  SENTRY_SAMPLE_RATE?: string;
  // CUTOVER FLIP SWITCH (task #15). "true" = Houzs owns the 2990- doc namespace
  // (post-flip) so the mirror guards stop blocking; unset/"false" = pre-flip
  // read-only mirror. Parsed via scm/lib/companyScope.houzsOwns2990. Flip in the
  // same deploy as the POS VITE_BACKEND_TARGET=houzs (see wrangler.toml).
  HOUZS_OWNS_2990?: string;
  // Mail Center inbound ingest secret (shared with the standalone
  // houzs-mail-inbound CF Email Worker / IMAP bridge). The pre-auth
  // POST /api/mail-center/inbound route 503s until this is set and >= 16 chars.
  // Set via `wrangler secret put MAIL_INBOUND_SECRET` (owner-gated, MX cutover).
  MAIL_INBOUND_SECRET?: string;
  // Shared secret guarding POST /api/sync/so-mirror (the 2990 live SO mirror
  // receiver). The 2990 DB (pg_net) sends it as `x-sync-secret`. Set via
  // `wrangler secret put SYNC_SECRET`. Unset => the receiver 401s (fail-closed).
  SYNC_SECRET?: string;
  // Houzs → 2990 Product Maintenance push (scm/routes/maintenance-push.ts).
  // The push writes 2990's public.maintenance_config_history DIRECTLY with
  // 2990's service-role key — an owner-granted, table-scoped exception to D2
  // (that endpoint is an RBAC check plus a plain INSERT, with no business logic
  // to reuse). The full cost is documented in scm/lib/bridge-2990.ts's header,
  // and the headline is: THIS KEY BYPASSES ALL RLS ON 2990'S ENTIRE DATABASE.
  // It is unrestricted read/write over the live retail DB — every order, every
  // customer, every price. Supabase cannot scope it to one table, so the only
  // constraint is the code in bridge-2990.ts (client never exported, no generic
  // helper, one hardcoded table). Treat any new use of this secret as a
  // blast-radius decision, not a convenience.
  // Set via `wrangler secret put BRIDGE_2990_SUPABASE_URL` / `..._SERVICE_ROLE_KEY`.
  // With either unset the push cannot reach 2990 and the route 503s — this is
  // how the feature ships dark. The DB kill switch (scm.sync_config) is the
  // separate, no-deploy emergency stop.
  BRIDGE_2990_SUPABASE_URL?: string;
  BRIDGE_2990_SERVICE_ROLE_KEY?: string;
  // SO-amendment write-back (scm/lib/bridge-2990-command.ts, design §3.2/D2).
  // A DIFFERENT credential class from the service-role key above: this path calls
  // 2990's OWN API (PATCH /so-amendments/:id/{approve-so,...}), which gates on a
  // real user (isApproveSoCaller reads public.staff WHERE id = user.id). The
  // service-role key carries NO user identity, so it CANNOT be used here — this
  // needs a real 2990 Supabase auth user whose public.staff row has an
  // approve-capable role. Do not collapse the two paths.
  //   BRIDGE_2990_ANON_KEY  — 2990's project anon key, for the GoTrue password
  //                           sign-in (grants no identity of its own).
  //   BRIDGE_2990_API_URL   — 2990's API base that reaches the soAmendments
  //                           router (origin + any /api prefix); the dispatcher
  //                           appends /so-amendments/:id/:action.
  //   BRIDGE_2990_EMAIL / _PASSWORD — the bridge user's credentials.
  // With ANY unset the write-back cannot reach 2990 and ships dark; the DB kill
  // switch scm.sync_config.mirror_commands_enabled is the separate no-deploy stop.
  // Set via `wrangler secret put BRIDGE_2990_ANON_KEY` / `..._EMAIL` / `..._PASSWORD`
  // and BRIDGE_2990_API_URL (a var, not secret — it is not sensitive).
  BRIDGE_2990_ANON_KEY?: string;
  BRIDGE_2990_API_URL?: string;
  BRIDGE_2990_EMAIL?: string;
  BRIDGE_2990_PASSWORD?: string;
  // System Health observability (phase 2, ported from Hookka). Writes via the
  // binding; reads via the AE SQL API using the two secrets. All optional —
  // absent => health endpoints serve deterministic mock data.
  ERP_METRICS?: AnalyticsEngineDataset;
  CF_ACCOUNT_ID?: string;
  AE_QUERY_TOKEN?: string;
  // GitHub Actions health panel (optional). Unset => panel shows a connect hint.
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
};

export type Region = "WEST" | "EAST" | "SG";
export type SyncStatus = "SYNCED" | "ERROR";

// Raw API shape from AutoCount middleware
export interface ACSalesOrder {
  DocNo: string;
  TransferTo?: string | null;
  DocDate?: string | null;
  Ref?: string | null;
  SOUDF_BRANDING?: string | null;
  DebtorName?: string | null;
  Phone1?: string | null;
  SalesLocation?: string | null;
  SalesAgent?: string | null;
  Total?: number | null;
  SOUDF_BALANCE?: number | null;
  Remark2?: string | null;
  Remark3?: string | null;
  Remark4?: string | null;
  SOUDF_PDate?: string | null;
  SalesExemptionExpiryDate?: string | null;
  SOUDF_Note?: string | null;
  SOUDF_ToPONo?: string | null;
  InvAddr1?: string | null;
  InvAddr2?: string | null;
  InvAddr3?: string | null;
  InvAddr4?: string | null;
  SOUDF_VENUE?: string | null;
  Attention?: string | null;
  LastModified?: string | null;
}

// Slim Delivery Order header from the middleware's
// /DeliveryOrder/getSince/{checkpoint} (nine-column projection; the
// full-dump getAll ships the whole 181-column vDeliveryOrder row and is
// parsed structurally instead of through a type).
export interface ACDeliveryOrder {
  DocNo: string;
  DocDate?: string | null;
  Ref?: string | null;
  DebtorName?: string | null;
  SalesAgent?: string | null;
  SalesLocation?: string | null;
  Total?: number | null;
  Cancelled?: string | null;
  LastModified?: string | null;
}

// Line-item detail for a single Sales Order from AutoCount's
// /SalesOrder/getDetail/{docNo} endpoint. Field names mirror the
// middleware response; shape is flexible since installs vary.
export interface ACSalesOrderDetail {
  DocNo?: string;
  ItemCode?: string | null;
  Description?: string | null;
  ItemDescription?: string | null;
  Qty?: number | null;
  UOM?: string | null;
  UnitPrice?: number | null;
  Amount?: number | null;
  [key: string]: any;
}

export interface ACPurchaseOrder {
  DocNo: string;
  SODocNo?: string | null;
  CreditorCode?: string | null;
  CreditorName?: string | null;
  ItemCode: string;
  ItemDescription?: string | null;
  Location?: string | null;
  DocDate?: string | null;
  RemainingQty?: number | null;
  DeliveryDate?: string | null;
  SupplierDeliveryDate1?: string | null;
  SupplierDeliveryDate2?: string | null;
  SupplierDeliveryDate3?: string | null;
  // (Legacy) Money fields from the line payload. AutoCount's
  // getOutstanding doesn't expose these for our middleware version, so
  // they're optional and the sync falls back to manual entry. Kept on
  // the line type so existing /getOutstanding consumers stay clean.
  //   • UnitPrice               — raw per-unit price (foreign currency)
  //   • UnitPriceAfterDiscount  — per-unit after the line discount
  //   • SubTotal                — line total (Qty × UnitPriceAfterDiscount), foreign
  //   • LocalSubTotal           — line total in local currency (preferred)
  //   • LocalSubTotalExTax      — local line total before tax
  // The sync prefers LocalSubTotal so the P&L is in RM. When that's
  // missing it computes UnitPriceAfterDiscount × RemainingQty so the
  // *outstanding commitment* still surfaces.
  UnitPrice?: number | null;
  UnitPriceAfterDiscount?: number | null;
  SubTotal?: number | null;
  LocalSubTotal?: number | null;
  LocalSubTotalExTax?: number | null;
  [key: string]: any;
}

/**
 * Doc-level Purchase Order from /PurchaseOrder/getAll. One row per PO
 * document — no line items. Used for cost roll-ups (P&L) and for the
 * "Documents" view on the PO page.
 *
 * `LocalExTax` is the line-item subtotal in local currency, ex-tax —
 * what we want for cost analysis. `LocalNetTotal` is the same with
 * tax. `Cancelled` is "T"/"F" string from AutoCount.
 */
export interface ACPurchaseOrderDoc {
  DocNo: string;
  DocDate?: string | null;
  Ref?: string | null;
  POUDF_SONo?: string | null;
  CreditorCode?: string | null;
  CreditorName?: string | null;
  PurchaseLocation?: string | null;
  DocStatus?: string | null;
  Cancelled?: string | boolean | number | null;
  ExTax?: number | null;
  LocalExTax?: number | null;
  Tax?: number | null;
  LocalTax?: number | null;
  NetTotal?: number | null;
  LocalNetTotal?: number | null;
  Total?: number | null;
  TotalWithTax?: number | null;
  FinalTotal?: number | null;
  CurrencyCode?: string | null;
  CurrencyRate?: number | null;
  Remark1?: string | null;
  Remark2?: string | null;
  Remark3?: string | null;
  Remark4?: string | null;
  Note?: string | null;
  LastModified?: string | null;
  [key: string]: any;
}

export interface SalesOrderRow {
  id: number;
  doc_no: string;
  region: Region;
  transfer_to: string | null;
  doc_date: string | null;
  ref: string | null;
  branding: string | null;
  debtor_name: string | null;
  phone: string | null;
  sales_location: string | null;
  sales_agent: string | null;
  local_total: number;
  balance: number;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  /* AutoCount's SO.UDF_PDate, mirrored verbatim (mig 0285 renamed this from
     `processing_date`). NOT the ERP's Processing Date — that is
     scm.mfg_sales_orders.internal_expected_dd, one column, different table,
     different document. */
  ac_udf_pdate: string | null;
  expiry_date: string | null;
  note: string | null;
  po_doc_no: string | null;
  inv_addr1: string | null;
  inv_addr2: string | null;
  inv_addr3: string | null;
  inv_addr4: string | null;
  venue: string | null;
  sync_status: SyncStatus;
  sync_error: string | null;
  last_modified: string | null;
  created_at: string;
  updated_at: string;
}
