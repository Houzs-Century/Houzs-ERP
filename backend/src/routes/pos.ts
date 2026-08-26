// ----------------------------------------------------------------------------
// /api/pos — POS auth on Houzs (Phase 1 of the 2990-backend replacement).
//
// Lets the 2990 POS log into HOUZS (session auth) so it can stop using Supabase
// Auth. Mounted BEFORE the global /api/* auth gate; every route below the two
// PRE-AUTH ones re-applies `auth` per-route.
//   POST /pin-login   {staffId, pin}  -> mints a Houzs session      (PRE-AUTH)
//   GET  /sales-staff                 -> PIN-login picker list        (PRE-AUTH)
//   POST /set-pin      {pin}          -> set the caller's own PIN      (authed)
//   POST /verify-pin   {pin}          -> re-verify for sensitive ops   (authed)
//   GET  /sales-stats                 -> caller's MTD KPI tiles        (authed)
//   POST /admin-set-pin/:userId       -> issue a member's PIN   (users.manage)
//   POST /admin-reset-pin/:userId     -> clear a member's PIN   (users.manage)
//   GET  /admin-pin-status/:userId    -> has-PIN + tablet readiness    (  ~   )
//
// staffId = an scm.staff uuid (from /sales-staff). scm.staff.user_id links to the
// public.users integer (migration 0066); we mint the session for THAT user.
// PIN store + brute-force RPCs live in migration 0099 (scm.pos_pins /
// scm.pos_pin_attempts / scm.pin_attempt_*).
// ----------------------------------------------------------------------------
import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { auth, requirePermission } from "../middleware/auth";
import { companyContext } from "../middleware/companyContext";
import { hasPermission } from "../services/permissions";
import { isDirectorUser } from "../services/pmsAccess";
import {
  createSession,
  verifyPassword,
  hashPassword,
  SESSION_ORIGIN_POS,
} from "../services/auth";
import { posPinWriteRefusal, readPosPinStatus, setPosPinForUser } from "../services/posPin";
/* item-KPI: the SAME source /hr/commission reads, so the dashboard's KPI row
   and the commission run can never disagree about what a flagged item earned.
   getSupabaseService rather than the `supabase` middleware: /api/pos is
   session-authed and mounted pre-auth, so it has no Supabase context to read. */
import { getSupabaseService } from "../db/supabase";
import { loadKpiUnitsByDoc } from "../scm/lib/kpi-units";
import { kpiSenForDocs, splitScopeRevenue } from "../scm/lib/pos-kpi-split";

/* No `sessionOrigin` here on purpose. This router does not READ the origin of
   the caller's session anywhere — /exchange-web-session used to, and the ruling
   at that handler is why it no longer does. */
type Vars = { user?: { id: number }; companyId?: number };
const pos = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 60;
const isPin = (v: unknown): v is string => typeof v === "string" && /^\d{6}$/.test(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── PRE-AUTH: PIN login → Houzs session ─────────────────────────────────────
pos.post("/pin-login", async (c) => {
  let body: { staffId?: string; pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const staffId = String(body.staffId ?? "").trim();
  const pin = body.pin;
  if (!staffId) return c.json({ error: "staff_required" }, 400);
  // staff_id is a uuid column — a malformed value would 500 on the DB (22P02).
  // Treat a non-uuid like a bad login (401), not a crash, and skip the DB hit.
  if (!UUID_RE.test(staffId)) return c.json({ error: "bad_pin" }, 401);
  if (!isPin(pin)) return c.json({ error: "pin_invalid" }, 400);
  const DB = c.env.DB;

  // 1) brute-force gate (durable, 60s rolling window; fails OPEN on DB blip)
  try {
    const chk = await DB.prepare(`SELECT allowed, retry_after FROM scm.pin_attempt_check(?, ?)`)
      .bind(staffId, MAX_FAILURES).first<{ allowed: boolean; retry_after: number }>();
    if (chk && chk.allowed === false) {
      return c.json({ error: "too_many_attempts", retryAfter: Number(chk.retry_after) || 60 }, 429);
    }
  } catch { /* fail open */ }

  // 2) look up the PIN hash + the linked Houzs user + the member's position slug
  //    (for the sales-login gate below). scm.staff.role can't gate — the
  //    sync_user_to_staff trigger stamps role='sales' on EVERY member (mig 0066),
  //    so a member's SALES-ness comes from their position (public.positions).
  const row = await DB.prepare(
    `SELECT p.pin_hash, s.user_id, pn.slug AS position_slug
       FROM scm.pos_pins p
       JOIN scm.staff s ON s.id = p.staff_id
       LEFT JOIN public.users u ON u.id = s.user_id
       LEFT JOIN public.positions pn ON pn.id = u.position_id
      WHERE p.staff_id = ?`,
  ).bind(staffId).first<{ pin_hash: string; user_id: number | null; position_slug: string | null }>();

  const ok = row && row.user_id != null && (await verifyPassword(pin, row.pin_hash));
  if (!ok) {
    try { await DB.prepare(`SELECT scm.pin_attempt_fail(?, ?)`).bind(staffId, WINDOW_SECONDS).run(); } catch {}
    return c.json({ error: "bad_pin" }, 401);
  }

  // 2.5) Sales-login gate (mirrors 2990's isPinLoginRole). Only a SALES-position
  //      member may mint a POS session — defense-in-depth over PIN seeding, so a
  //      non-sales member who somehow holds a PIN (or an admin's stray seed)
  //      cannot get a tablet session. The picker (/sales-staff) already hides
  //      non-sales, so a legitimate POS never sends such a staffId.
  if (!row!.position_slug || !row!.position_slug.startsWith("sales")) {
    return c.json({ error: "not_pos_role" }, 403);
  }

  // 3) success → clear the counter, mint a Houzs session for the linked user.
  //
  // SESSION_ORIGIN_POS is the anti-tamper hinge and this is its ONLY writer.
  // It marks the SESSION, not the user: the same person's desktop and mobile
  // sessions stay origin-less and keep pricing freely, while everything done
  // with THIS token is held to the server's price by the SO pricing envelope
  // (scm/routes/mfg-sales-orders.ts isPosTabletCaller). The tablet is not
  // asked to declare itself and cannot decline to — it is stamped here, on
  // the way through the PIN gate, by the server.
  try { await DB.prepare(`SELECT scm.pin_attempt_reset(?)`).bind(staffId).run(); } catch {}
  const token = await createSession(c.env, Number(row!.user_id), SESSION_ORIGIN_POS);
  return c.json({ token, userId: Number(row!.user_id), staffId });
});

// ── PRE-AUTH: salesperson picker for the PIN screen ─────────────────────────
pos.get("/sales-staff", async (c) => {
  // The POS sends X-Company-Id (queries.ts) — HONOUR it so a 2990 tablet's PIN
  // picker shows ONLY company-2 SALES staff, never HOUZS's roster or non-sales
  // members (the earlier unscoped query leaked both). scm.staff has no
  // company_id (0083 — shared masters), so company comes from the member's
  // public.user_companies; the sales filter from the position slug, because the
  // sync_user_to_staff trigger stamps role='sales' on EVERY member (mig 0066) so
  // scm.staff.role can't discriminate. A missing/invalid header → empty roster
  // (fail closed) rather than a cross-company dump.
  const companyId = Number(c.req.header("x-company-id"));
  if (!Number.isInteger(companyId) || companyId <= 0) return c.json({ staff: [] });
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.staff_code, s.name, (p.staff_id IS NOT NULL) AS has_pin
       FROM scm.staff s
       JOIN public.user_companies uc ON uc.user_id = s.user_id AND uc.company_id = ?
       LEFT JOIN public.users u ON u.id = s.user_id
       LEFT JOIN public.positions pn ON pn.id = u.position_id
       LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
      WHERE s.active = true AND s.user_id IS NOT NULL
        AND pn.slug LIKE 'sales%'
      ORDER BY s.name`,
  ).bind(companyId).all<{ id: string; staff_code: string; name: string; has_pin: boolean }>();
  return c.json({ staff: rows.results ?? [] });
});

// helper: resolve the logged-in Houzs user → their scm.staff uuid
async function callerStaffId(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<string | null> {
  const uid = c.get("user")?.id;
  if (uid == null) return null;
  const s = await c.env.DB.prepare(`SELECT id FROM scm.staff WHERE user_id = ?`).bind(uid).first<{ id: string }>();
  return s?.id ?? null;
}

// ── AUTHED: set / change own PIN ────────────────────────────────────────────
pos.post("/set-pin", auth, async (c) => {
  let body: { pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!isPin(body.pin)) return c.json({ error: "pin_invalid" }, 400);
  const staffId = await callerStaffId(c);
  if (!staffId) return c.json({ error: "no_staff_row" }, 400);
  const hash = await hashPassword(body.pin!);
  await c.env.DB.prepare(
    `INSERT INTO scm.pos_pins (staff_id, pin_hash, updated_at) VALUES (?, ?, now())
       ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now()`,
  ).bind(staffId, hash).run();
  return c.json({ ok: true });
});

// ── ADMIN: set / reset another staff member's PIN ───────────────────────────
// Keyed by HOUZS USER ID (like the showroom-parking endpoint), because the
// Members page lists Houzs users; resolve the scm.staff uuid server-side.
// Gated on users.manage — the same permission the Members page requires. A POS
// PIN is a login credential, so only a member-admin may set one for someone
// else. The plaintext PIN is hashed server-side (never stored raw); it travels
// over TLS exactly like the self-service /set-pin.
async function staffIdForUser(c: Context<{ Bindings: Env; Variables: Vars }>, userId: number): Promise<string | null> {
  const s = await c.env.DB.prepare(`SELECT id FROM scm.staff WHERE user_id = ?`).bind(userId).first<{ id: string }>();
  return s?.id ?? null;
}
pos.post("/admin-set-pin/:userId", auth, requirePermission("users.manage"), async (c) => {
  const userId = Number(c.req.param("userId"));
  if (!Number.isInteger(userId) || userId <= 0) return c.json({ error: "bad_user" }, 400);
  let body: { pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!isPin(body.pin)) return c.json({ error: "pin_invalid" }, 400);
  // The SALES-position rule, which this door was missing while /api/users/invite
  // had it. Without it an admin could store a PIN against a non-sales member and
  // hear nothing: /pin-login then refuses that session with `not_pos_role`, which
  // the tablet renders as a wrong PIN, so the member is read as forgetful when in
  // fact the credential can never work. Refuse the write and say which half is
  // wrong.
  const refusal = posPinWriteRefusal(await readPosPinStatus(c.env, userId));
  if (refusal) return c.json(refusal, 409);
  const written = await setPosPinForUser(c.env, userId, body.pin!);
  if (!written) return c.json({ error: "no_staff_row", message: "This member has no sales profile yet." }, 409);
  return c.json({ ok: true });
});

// ── ADMIN: is this member ready for the tablet, and do they already hold a PIN?
// The Team profile asks before it offers a PIN box, so an admin can see "PIN set"
// / "no PIN yet" instead of having to send someone to a tablet to find out.
// Read-only, users.manage-gated like its two siblings. Never returns the hash.
pos.get("/admin-pin-status/:userId", auth, requirePermission("users.manage"), async (c) => {
  const userId = Number(c.req.param("userId"));
  if (!Number.isInteger(userId) || userId <= 0) return c.json({ error: "bad_user" }, 400);
  return c.json(await readPosPinStatus(c.env, userId));
});
pos.post("/admin-reset-pin/:userId", auth, requirePermission("users.manage"), async (c) => {
  const userId = Number(c.req.param("userId"));
  if (!Number.isInteger(userId) || userId <= 0) return c.json({ error: "bad_user" }, 400);
  const staffId = await staffIdForUser(c, userId);
  if (!staffId) return c.json({ error: "no_staff_row", message: "This member has no sales profile yet." }, 409);
  await c.env.DB.prepare(`DELETE FROM scm.pos_pins WHERE staff_id = ?`).bind(staffId).run();
  return c.json({ ok: true, cleared: true });
});

// ── AUTHED: re-verify PIN for a sensitive action ────────────────────────────
pos.post("/verify-pin", auth, async (c) => {
  let body: { pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!isPin(body.pin)) return c.json({ error: "pin_invalid" }, 400);
  const staffId = await callerStaffId(c);
  if (!staffId) return c.json({ error: "no_staff_row" }, 400);
  const row = await c.env.DB.prepare(`SELECT pin_hash FROM scm.pos_pins WHERE staff_id = ?`)
    .bind(staffId).first<{ pin_hash: string }>();
  const ok = row ? await verifyPassword(body.pin!, row.pin_hash) : false;
  // Return `valid` for POS parity — 2990's verify-pin returns {valid,...} and the
  // POS reads body.valid; keep `ok` for any other caller.
  return c.json({ valid: ok, ok });
});

// ── AUTHED: caller's KPI tiles (personal + showroom) — the POS home dashboard ─
// Ported from 2990's /pos/sales-stats to the full SalesStatsRow shape. Personal
// = the caller; Showroom = the caller's showroom mates (or the whole company
// when the caller has no showroom — admin/owner/coordinator). Period defaults to
// the current MY calendar month; ?from=&to= (MY YYYY-MM-DD, `to` inclusive)
// override, sharing the My-orders board window.
//
// companyContext runs here explicitly: /api/pos is pre-auth (mounted before the
// global /api/* companyContext, which must stay off pin-login), so without it
// the scope below would pool BOTH companies' orders.
//
// Revenue split (Loo 2026-06-20): Products = goods (mattress/sofa + bedframe +
// accessories + others) MINUS the item-KPI portion, Service = total − goods
// (delivery + SERVICE lines), KPI = the item-KPI-flagged add-on amount.
//
// KPI was hardcoded 0 here until 2026-08-26, on a comment saying the HR
// commission machinery had "no Houzs home yet (#19)". That stopped being true
// when hr.ts and lib/kpi-units.ts were ported — the tables (scm.hr_item_kpi),
// the loader, the per-unit rule and the admin UI (HrSettings) have all been
// live for weeks. Only this read was never wired up, so the tile answered RM 0
// for every salesperson in both companies and no amount of tracing from the POS
// could find a source, because there wasn't one. It now reads the real flags.
//
// An empty scm.hr_item_kpi still yields 0 — correctly, and that is the same
// answer 2990's own API gives when no flag is active. Zero means "nothing is
// flagged", not "not implemented".
// status::text guards the enum (excludes CANCELLED/ON_HOLD safely).
// ?salesperson targets the Personal card at ANOTHER salesperson. Honoured since
// 2026-08-19, and gated on canViewAllSales HERE, not on the POS: the board was
// already filtering by it while this card silently kept answering for the
// caller, so a director reading "SCARLETT · RM 2,990 · 2 orders" was reading his
// OWN two orders under her name. A client-side gate is not a permission — the
// param arrives from a browser, so an ungated read would hand any salesperson a
// colleague's month. Unknown/unauthorised name => the caller's own figures, the
// behaviour every caller had before.
//
// `showroomScope` says WHICH scope the Showroom card used, because the two are
// not the same question: staff WITH a showroom get their showroom mates, staff
// WITHOUT one (director / owner / coordinator) get the whole company. Both used
// to render under the word "SHOWROOM", so a director saw company-wide figures
// under a showroom heading and no two people's tiles agreed.
/** May this caller point the Personal KPI tile at ANOTHER salesperson?
 *
 *  EXPORTED AND PURE so the test EXECUTES it. Its two predecessors both died
 *  in ways a source-text pin cannot see: canViewAllSales(c) was called with a
 *  context whose houzsUser is never set on this route (gate permanently
 *  closed), and then hasPermission was handed the USER where it takes the
 *  PERMISSIONS — `user.has is not a function`, a 500 on every sales-stats read,
 *  both tiles "Couldn't load" (2026-08-20, reported with a screenshot both
 *  times). An `as never` cast silenced the compiler on the second one. The
 *  test now calls this function with real shapes instead of matching its
 *  spelling. */
export function canTargetSalesperson(
  caller: { position_name?: string | null; permissions_set?: ReadonlySet<string>; permissions?: ReadonlyArray<string> } | null | undefined,
  wantSalesperson: string,
): boolean {
  if (wantSalesperson === "" || wantSalesperson === "all") return false;
  const perms = caller?.permissions_set ?? caller?.permissions ?? [];
  return hasPermission(perms, "scm.so.view_all")
    || isDirectorUser({ position_name: caller?.position_name ?? null, permissions_set: caller?.permissions_set } as never);
}

const KPI_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
pos.get("/sales-stats", auth, companyContext, async (c) => {
  // company-scope: scoped by string-built SQL the checker cannot see — :366 pushes `company_id = ?` into `conds` from the companyContext value read at :298, and every statement below joins `conds` into its own WHERE (aggSql :368, docSql :396), so all four reads carry the predicate. The KPI resolve at :411 takes companyId as an explicit argument and is guarded on it being present. NOT a cross-company surface: companyContext is on the registration line precisely because /api/pos is mounted pre-auth and would otherwise pool both companies. Verified 2026-08-26.
  const DB = c.env.DB;
  const uid = c.get("user")?.id;
  const me = uid == null ? null : await DB.prepare(
    `SELECT id, name, showroom_id FROM scm.staff WHERE user_id = ?`,
  ).bind(uid).first<{ id: string; name: string; showroom_id: string | null }>();
  const companyId = (c.get("companyId") as number | undefined) ?? null;

  /* Whose Personal card. Defaults to the caller; a view-all caller may name
     someone else. TWO corrections against the first version (2026-08-19, found
     by the reporter within hours):
     · the gate read canViewAllSales(c), whose director arm needs `houzsUser` —
       which only scm/middleware/auth.ts stashes. On /api/pos it is never set,
       so a Sales Director (the exact person the picker is FOR) always failed
       the gate. Here `user` IS the real Houzs caller, so the check runs
       directly off it: the flat key, or the director org position.
     · the lookup matched staff.name; the POS picker sends staff.id
       (`<option value={s.id}>`). Every lookup missed and fell back to the
       caller — the label changed, the numbers did not. Matched by id when the
       param is uuid-shaped (guarded: a malformed value on a uuid column 500s
       with 22P02 — see the pin-login note above), by name otherwise.
     A miss still falls back to the caller rather than erroring — the card is a
     dashboard tile, and a 500 here would blank the whole page. */
  const wantSalesperson = (c.req.query("salesperson") || "").trim();
  /* Vars types `user` as { id } only; the runtime object is the full session
     user (services/auth.ts getUserBySession — permissions_set: Set<string>,
     position_name). Widening cast, not `as never`: the parameter type still
     checks every property we read. */
  const mayTarget = canTargetSalesperson(
    c.get("user") as Parameters<typeof canTargetSalesperson>[0],
    wantSalesperson,
  );
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const target = mayTarget
    ? await DB.prepare(UUID_RX.test(wantSalesperson)
        ? `SELECT id, name FROM scm.staff WHERE id = ? LIMIT 1`
        : `SELECT id, name FROM scm.staff WHERE name = ? LIMIT 1`)
        .bind(wantSalesperson).first<{ id: string; name: string }>()
    : null;

  // Period (Asia/Kuala_Lumpur = UTC+8). so_date is a DATE → range compares are tz-free.
  const fromYmd = c.req.query("from") || null;
  const toYmd = c.req.query("to") || null;
  const nowMy = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthStart = fromYmd ?? `${nowMy.getUTCFullYear()}-${pad(nowMy.getUTCMonth() + 1)}-01`;
  const monthEnd = toYmd;
  const monthLabel = fromYmd
    ? `${fromYmd}${toYmd ? ` – ${toYmd}` : ""}`
    : `${KPI_MONTHS[nowMy.getUTCMonth()]} ${nowMy.getUTCFullYear()}`;

  const empty = {
    monthLabel, monthStart, monthEnd, staffName: me?.name ?? "",
    showroomScope: me?.showroom_id ? "showroom" : "company",
    showroomTotal: 0, showroomCount: 0, showroomProducts: 0, showroomService: 0, showroomKpi: 0,
    personalTotal: 0, personalCount: 0, personalProducts: 0, personalService: 0, personalKpi: 0,
  };
  if (!me) return c.json(empty);

  // Shared period + company + status predicate.
  // DRAFT is COUNTED here, deliberately. #2356 excluded it on the reasoning that
  // a draft is not a sale, which is true of commission and of the MTD reports —
  // but this card is not a commission figure. It is the salesperson's pipeline
  // for the month, and the owner wants a started order to appear in it.
  // The mismatch #2356 was chasing (card 28, board 1) is closed from the other
  // side instead: GET /mfg-sales-orders/mine now returns drafts too, so the
  // board lists the same 28 orders this card counts. Change the two together or
  // they drift apart again.
  /* `NOT on_hold` since mig 0324. The hold is a MARKER beside the status, so
     the status test alone stopped being able to see one. Raw SQL rather than a
     PostgREST predicate here because this whole card is one aggregate query. */
  const conds = ["NOT on_hold", "status::text NOT IN ('CANCELLED','ON_HOLD')", "so_date >= ?"];
  const binds: unknown[] = [monthStart];
  if (toYmd) { conds.push("so_date <= ?"); binds.push(toYmd); }
  if (companyId != null) { conds.push("company_id = ?"); binds.push(Number(companyId)); }

  const aggSql = (extraWhere: string) =>
    `SELECT count(*)::int AS cnt,
            COALESCE(sum(total_revenue_sen),0)::bigint AS total_sen,
            COALESCE(sum(COALESCE(mattress_sofa_sen,0)+COALESCE(bedframe_sen,0)+COALESCE(accessories_sen,0)+COALESCE(others_sen,0)),0)::bigint AS goods_sen
       FROM scm.mfg_sales_orders
      WHERE ${[...conds, extraWhere].join(" AND ")}`;

  // Showroom scope: the caller's showroom mates, else the whole company.
  let showroomWhere = "true";
  const showroomBinds: unknown[] = [];
  if (me.showroom_id) {
    const mates = await DB.prepare(`SELECT id FROM scm.staff WHERE showroom_id = ?`)
      .bind(me.showroom_id).all<{ id: string }>();
    const ids = (mates.results ?? []).map((r) => r.id);
    if (ids.length === 0) return c.json(empty);
    showroomWhere = `salesperson_id IN (${ids.map(() => "?").join(",")})`;
    showroomBinds.push(...ids);
  }

  type Agg = { cnt: number; total_sen: number; goods_sen: number };
  // company-scope: `conds` carries `company_id = ?` (built at :366 from the
  // companyContext value read at :298) and aggSql joins it into every WHERE, so
  // the predicate is on both statements — assembled, which is why the scanner
  // cannot see it. Verified 2026-08-26.
  const showroomRow = await DB.prepare(aggSql(showroomWhere)).bind(...binds, ...showroomBinds).first<Agg>();
  const personalRow = await DB.prepare(aggSql("salesperson_id = ?"))
    .bind(...binds, target?.id ?? me.id).first<Agg>();

  /* The item-KPI portion is per-LINE, so it cannot come out of the header
     aggregate above — these read the doc numbers the same predicate matched, and
     kpi-units resolves their lines. Same WHERE, same binds: the two queries
     cannot describe different order sets. */
  // company-scope: same `conds` as aggSql above — identical WHERE, identical
  // binds, so this cannot read an order the aggregate did not count. Verified
  // 2026-08-26.
  const docSql = (extraWhere: string) =>
    `SELECT doc_no FROM scm.mfg_sales_orders WHERE ${[...conds, extraWhere].join(" AND ")}`;
  // company-scope: both reads use docSql, whose WHERE is the same `conds` the
  // aggregate uses — the company predicate is in there, assembled at :366.
  // Verified 2026-08-26.
  const showroomDocs = await DB.prepare(docSql(showroomWhere))
    .bind(...binds, ...showroomBinds).all<{ doc_no: string }>();
  const personalDocs = await DB.prepare(docSql("salesperson_id = ?"))
    .bind(...binds, target?.id ?? me.id).all<{ doc_no: string }>();
  const showroomDocNos = showroomDocs.results.map((r) => r.doc_no);
  const personalDocNos = personalDocs.results.map((r) => r.doc_no);

  /* Resolved ONCE for both scopes — personal orders are a subset of showroom
     ones, so a second pass would re-read the same lines. */
  let kpiFlags: Awaited<ReturnType<typeof loadKpiUnitsByDoc>>["flags"] = [];
  let kpiUnitsByDoc: Awaited<ReturnType<typeof loadKpiUnitsByDoc>>["unitsByDoc"] = new Map();
  if (companyId != null && (showroomDocNos.length > 0 || personalDocNos.length > 0)) {
    try {
      const kpi = await loadKpiUnitsByDoc(
        getSupabaseService(c.env),
        [...new Set([...showroomDocNos, ...personalDocNos])],
        Number(companyId),
      );
      kpiFlags = kpi.flags;
      kpiUnitsByDoc = kpi.unitsByDoc;
    } catch (e) {
      /* Mirrors hr.ts: a KPI read failure must NOT fall through to "no flags".
         Silently answering 0 is indistinguishable from "nothing is flagged",
         which is the exact ambiguity this endpoint just spent weeks in. */
      return c.json(
        { error: "kpi_failed", reason: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  }
  /* The money split + every clamp lives in lib/pos-kpi-split, where it is
     tested; this route only supplies the three sums and the count. */
  const card = (r: Agg | null, docNos: string[]) => ({
    ...splitScopeRevenue({
      totalSen: Number(r?.total_sen ?? 0),
      goodsSen: Number(r?.goods_sen ?? 0),
      kpiSen: kpiSenForDocs(docNos, kpiUnitsByDoc, kpiFlags),
    }),
    count: Number(r?.cnt ?? 0),
  });
  const s = card(showroomRow, showroomDocNos);
  const p = card(personalRow, personalDocNos);

  return c.json({
    monthLabel, monthStart, monthEnd,
    /* WHOSE Personal card this is. The POS labels the tile from this, so the
       name and the number can no longer disagree. */
    staffName: target?.name ?? me.name,
    showroomScope: me.showroom_id ? "showroom" : "company",
    showroomTotal: s.total, showroomCount: s.count,
    showroomProducts: s.products, showroomService: s.service, showroomKpi: s.kpi,
    personalTotal: p.total, personalCount: p.count,
    personalProducts: p.products, personalService: p.service, personalKpi: p.kpi,
  });
});

// ── AUTHED: exchange a POS session for a desktop web session ────────────────
// The POS opens Houzs backend pages in a new browser tab (Manual SO create,
// Service Case, etc.) — SSO handoff so the salesperson doesn't have to remember
// a Houzs password. Flow: POS calls this endpoint, gets back a fresh full
// desktop session token for the SAME user, opens
//   https://erp.houzscentury.com/#sso=<token>&next=<path>
// in a new tab. The Houzs frontend bootstrap (src/main.tsx) reads the fragment,
// stores the token in sessionStorage, strips the fragment, navigates to `next`.
//
// THE MINT DROPS THE ORIGIN. It is an ERP session, and an ERP session follows
// the ERP's rules.
//
// OWNER RULING 2026-08-16, after a salesperson signed in at the PIN door, came
// through this door, opened a Sales Order in the ERP and could not change a
// delivery-fee line from 250 to 125 — 422 `so_total_below_original`,
// "Changes cannot reduce the bill below the original sales order total."
// 「为什么我们要跟着 POS 的规矩?进了这个 ERP 就跟这个 ERP 的规矩。在我们
// ERP 里编辑,金额就必须能改。」 The POS follows the ERP's rules here, not the
// other way round.
//
// This reverses the 2026-08-14 change that made the mint CARRY the origin. That
// change was right about the mechanism and wrong about the policy: it is true
// that a tablet could shed `origin='pos'` by asking for a second token, and it
// is exactly that shedding the owner wants, because the token it gets back is
// only ever used to drive the ERP web app. What the gate defended — a tampered
// POS submitting a doctored low total — it no longer defends for anyone holding
// a PIN, and the owner has been told so and has ruled anyway. See BUG-HISTORY.md
// and the PR that carries this line for the full blast radius.
//
// WHAT IS UNCHANGED: the PIN door (/pin-login) still stamps SESSION_ORIGIN_POS,
// so the tablet's OWN token still carries it and the real POS surface is held to
// every restriction it is held to today. The only session that loses the mark is
// the one minted here — the one that exists solely to open ERP pages.
pos.post("/exchange-web-session", auth, async (c) => {
  const uid = c.get("user")?.id;
  if (uid == null) return c.json({ error: "not_authenticated" }, 401);
  const token = await createSession(c.env, Number(uid));
  return c.json({ token, userId: Number(uid) });
});

export default pos;
// touch: trigger backend redeploy for #979 SSO endpoint
