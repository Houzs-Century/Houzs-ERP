import { Hono, type Context } from "hono";
import type { Env } from "../types";
import { auth, requirePermission } from "../middleware/auth";
import { companyContext } from "../middleware/companyContext";
import { hasPermission } from "../services/permissions";
import { isDirectorUser } from "../services/pmsAccess";
import { hasPositionCapability, type PositionCapabilityCaller } from "../services/positionCapabilities";
import {
  createSession,
  verifyPassword,
  hashPassword,
  SESSION_ORIGIN_POS,
} from "../services/auth";
import { posPinWriteRefusal, readPosPinStatus, setPosPinForUser } from "../services/posPin";
import { getSupabaseService } from "../db/supabase";
import { loadKpiUnitsByDoc } from "../scm/lib/kpi-units";
import { kpiSenForDocs, splitScopeRevenue } from "../scm/lib/pos-kpi-split";
import { readSalesPlace, salesPlaceFacet, salesPlaceSql, type SalesPlaceEntry } from "../scm/lib/pos-sales-place";
import { loadFairsByIds, type FairDb } from "../scm/lib/fair-binding";
import type { FairProjectRow } from "../scm/lib/fair-options";
import { activeCompanySql } from "../scm/lib/companyScope";

type Vars = { user?: { id: number }; companyId?: number };
const pos = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 60;
const isPin = (v: unknown): v is string => typeof v === "string" && /^\d{6}$/.test(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

pos.post("/pin-login", async (c) => {
  let body: { staffId?: string; pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const staffId = String(body.staffId ?? "").trim();
  const pin = body.pin;
  if (!staffId) return c.json({ error: "staff_required" }, 400);
  if (!UUID_RE.test(staffId)) return c.json({ error: "bad_pin" }, 401);
  if (!isPin(pin)) return c.json({ error: "pin_invalid" }, 400);
  const DB = c.env.DB;

  try {
    const chk = await DB.prepare(`SELECT allowed, retry_after FROM scm.pin_attempt_check(?, ?)`)
      .bind(staffId, MAX_FAILURES).first<{ allowed: boolean; retry_after: number }>();
    if (chk && chk.allowed === false) {
      return c.json({ error: "too_many_attempts", retryAfter: Number(chk.retry_after) || 60 }, 429);
    }
  } catch { }

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

  if (!row!.position_slug || !row!.position_slug.startsWith("sales")) {
    return c.json({ error: "not_pos_role" }, 403);
  }

  try { await DB.prepare(`SELECT scm.pin_attempt_reset(?)`).bind(staffId).run(); } catch {}
  const token = await createSession(c.env, Number(row!.user_id), SESSION_ORIGIN_POS);
  return c.json({ token, userId: Number(row!.user_id), staffId });
});

pos.get("/sales-staff", async (c) => {
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

async function callerStaffId(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<string | null> {
  const uid = c.get("user")?.id;
  if (uid == null) return null;
  const s = await c.env.DB.prepare(`SELECT id FROM scm.staff WHERE user_id = ?`).bind(uid).first<{ id: string }>();
  return s?.id ?? null;
}

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
  const refusal = posPinWriteRefusal(await readPosPinStatus(c.env, userId));
  if (refusal) return c.json(refusal, 409);
  const written = await setPosPinForUser(c.env, userId, body.pin!);
  if (!written) return c.json({ error: "no_staff_row", message: "This member has no sales profile yet." }, 409);
  return c.json({ ok: true });
});

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

pos.post("/verify-pin", auth, async (c) => {
  let body: { pin?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!isPin(body.pin)) return c.json({ error: "pin_invalid" }, 400);
  const staffId = await callerStaffId(c);
  if (!staffId) return c.json({ error: "no_staff_row" }, 400);
  const row = await c.env.DB.prepare(`SELECT pin_hash FROM scm.pos_pins WHERE staff_id = ?`)
    .bind(staffId).first<{ pin_hash: string }>();
  const ok = row ? await verifyPassword(body.pin!, row.pin_hash) : false;
  return c.json({ valid: ok, ok });
});

// global /api/* companyContext, which must stay off pin-login), so without it
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

/** The caller's Team Directory team (`users.division`, free text) as the key
 *  the Team card matches on: trimmed + lowercased, the AudiencePicker rule.
 *  null = no team, so no Team card. Exported so the test runs it. */
/** The Roles & Permissions capability that turns the Team card on (ticket
 *  2990-0045, Lim 2026-11-10: sales may not see colleagues' figures without
 *  approval). Per Title; granted to Sales Director only, by SQL. */
export const TEAM_TOTAL_CAPABILITY = "pos.sales.teamTotal";

export function salesTeamKey(division: string | null | undefined): { name: string; key: string } | null {
  const name = (division ?? "").trim();
  return name ? { name, key: name.toLowerCase() } : null;
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

  const wantSalesperson = (c.req.query("salesperson") || "").trim();
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

  const fromYmd = c.req.query("from") || null;
  const toYmd = c.req.query("to") || null;
  const nowMy = new Date(Date.now() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthStart = fromYmd ?? `${nowMy.getUTCFullYear()}-${pad(nowMy.getUTCMonth() + 1)}-01`;
  const monthEnd = toYmd;
  const monthLabel = fromYmd
    ? `${fromYmd}${toYmd ? ` – ${toYmd}` : ""}`
    : `${KPI_MONTHS[nowMy.getUTCMonth()]} ${nowMy.getUTCFullYear()}`;
  const place = readSalesPlace(c.req.query("project"), c.req.query("venue"));

  const empty = {
    monthLabel, monthStart, monthEnd, staffName: me?.name ?? "",
    showroomScope: me?.showroom_id ? "showroom" : "company",
    showroomTotal: 0, showroomCount: 0, showroomProducts: 0, showroomService: 0, showroomKpi: 0,
    personalTotal: 0, personalCount: 0, personalProducts: 0, personalService: 0, personalKpi: 0,
    place, places: [] as SalesPlaceEntry[],
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

  let showroomWhere = "true";
  const showroomBinds: unknown[] = [];
  if (me.showroom_id) {
    // company-scope: scm.staff is a shared master with no company_id; the SO totals are scoped by conds
    const mates = await DB.prepare(`SELECT id FROM scm.staff WHERE showroom_id = ?`)
      .bind(me.showroom_id).all<{ id: string }>();
    const ids = (mates.results ?? []).map((r) => r.id);
    if (ids.length === 0) return c.json(empty);
    showroomWhere = `salesperson_id IN (${ids.map(() => "?").join(",")})`;
    showroomBinds.push(...ids);
  }

  const mayTeam = hasPositionCapability(
    c.get("user") as PositionCapabilityCaller | undefined,
    TEAM_TOTAL_CAPABILITY,
  );
  const meUser = mayTeam
    ? await DB.prepare(`SELECT department_id, division FROM public.users WHERE id = ?`)
        .bind(uid).first<{ department_id: number | null; division: string | null }>()
    : null;
  const team = mayTeam && meUser?.department_id != null ? salesTeamKey(meUser.division) : null;
  let teamIds: string[] = [];
  if (team) {
    const rows = await DB.prepare(
      `SELECT s.id FROM scm.staff s JOIN public.users u ON u.id = s.user_id
        WHERE u.department_id = ? AND lower(btrim(u.division)) = ?`,
    ).bind(meUser!.department_id, team.key).all<{ id: string }>();
    teamIds = (rows.results ?? []).map((r) => r.id);
  }
  const teamWhere = teamIds.length > 0 ? `salesperson_id IN (${teamIds.map(() => "?").join(",")})` : null;

  // company-scope: the same `conds` as aggSql below (company_id = ? at the top
  // of this handler) plus the Showroom card's own scope.
  const placeRows = await DB.prepare(
    `SELECT project_id AS projectid, min(btrim(coalesce(venue, ''))) AS venuename, count(*)::int AS cnt
       FROM scm.mfg_sales_orders
      WHERE ${[...conds, showroomWhere].join(" AND ")}
      GROUP BY project_id, CASE WHEN project_id IS NULL THEN lower(btrim(coalesce(venue, ''))) END`,
  ).bind(...binds, ...showroomBinds).all<Record<string, unknown>>();
  const placeRowList = placeRows.results;
  let events = new Map<number, FairProjectRow>();
  try {
    events = await loadFairsByIds(
      DB as unknown as FairDb,
      activeCompanySql(c, "p.company_id"),
      placeRowList.map((r) => Number(r.projectid)).filter(Number.isInteger),
    );
  } catch { }
  const places = salesPlaceFacet(placeRowList, events);
  const placeClause = salesPlaceSql(place);
  if (placeClause) { conds.push(placeClause.sql); binds.push(...placeClause.binds); }

  type Agg = { cnt: number; total_sen: number; goods_sen: number };
  // company-scope: `conds` carries `company_id = ?` (built at :366 from the
  // companyContext value read at :298) and aggSql joins it into every WHERE, so
  // the predicate is on both statements — assembled, which is why the scanner
  // cannot see it. Verified 2026-08-26.
  const showroomRow = await DB.prepare(aggSql(showroomWhere)).bind(...binds, ...showroomBinds).first<Agg>();
  const personalRow = await DB.prepare(aggSql("salesperson_id = ?"))
    .bind(...binds, target?.id ?? me.id).first<Agg>();
  // company-scope: same aggSql, so the same `conds` (company_id = ?).
  const teamRow = teamWhere
    ? await DB.prepare(aggSql(teamWhere)).bind(...binds, ...teamIds).first<Agg>()
    : null;

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
  // company-scope: same docSql, same `conds`.
  const teamDocNos = teamWhere
    ? (await DB.prepare(docSql(teamWhere)).bind(...binds, ...teamIds).all<{ doc_no: string }>())
        .results.map((r) => r.doc_no)
    : [];

  let kpiFlags: Awaited<ReturnType<typeof loadKpiUnitsByDoc>>["flags"] = [];
  let kpiUnitsByDoc: Awaited<ReturnType<typeof loadKpiUnitsByDoc>>["unitsByDoc"] = new Map();
  if (companyId != null && (showroomDocNos.length > 0 || personalDocNos.length > 0 || teamDocNos.length > 0)) {
    try {
      const kpi = await loadKpiUnitsByDoc(
        getSupabaseService(c.env),
        [...new Set([...showroomDocNos, ...personalDocNos, ...teamDocNos])],
        Number(companyId),
      );
      kpiFlags = kpi.flags;
      kpiUnitsByDoc = kpi.unitsByDoc;
    } catch (e) {
      return c.json(
        { error: "kpi_failed", reason: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  }
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
  const t = teamWhere ? card(teamRow, teamDocNos) : null;

  return c.json({
    monthLabel, monthStart, monthEnd,
    staffName: target?.name ?? me.name,
    showroomScope: me.showroom_id ? "showroom" : "company",
    showroomTotal: s.total, showroomCount: s.count,
    showroomProducts: s.products, showroomService: s.service, showroomKpi: s.kpi,
    personalTotal: p.total, personalCount: p.count,
    personalProducts: p.products, personalService: p.service, personalKpi: p.kpi,
    ...(team && t ? {
      teamName: team.name, teamTotal: t.total, teamCount: t.count,
      teamProducts: t.products, teamService: t.service, teamKpi: t.kpi,
    } : {}),
    place, places,
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
