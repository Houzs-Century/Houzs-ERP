// ----------------------------------------------------------------------------
// staff — SCM staff / salesperson directory (scm.staff).
// Ported READ from 2990's apps/backend/src/lib/admin-queries.ts (useStaff), which
// in 2990's reads the `staff` table DIRECTLY via the supabase client. Houzs has
// no client-side supabase, so the vendored useStaff routes through this GET.
//
// GET /staff — list scm.staff rows (the SO Salesperson dropdown + PaymentsTable
//              Collected-By picker source). Degrades to [] when the table is
//              missing. Response is camelCased to the StaffRow shape the frontend
//              expects (admin-queries.ts).
//
// HOUZS VENDOR: the whole /api/scm tree is owner-gated at the Houzs layer and the
// auth bridge maps every caller to ONE seeded super_admin system staff row
// (middleware/auth.ts), so this list is for picker population only — it is not a
// per-user identity surface.
// ----------------------------------------------------------------------------

import { Hono } from "hono";
import { supabaseAuth } from "../middleware/auth";
import { requireHouzsPerm, hasHouzsPerm } from "../lib/houzs-perms";
import { activeCompanyId, scopeToCompany } from "../lib/companyScope";
import { rowUserId, scopeStaffRowsToActiveCompany } from "../lib/staffCompanyScope";
import { derivePosRole } from "../lib/pos-staff-role";
import { isSalesUser } from "../../services/pmsAccess";
import type { Env, Variables } from "../env";

export const staff = new Hono<{ Bindings: Env; Variables: Variables }>();

staff.use("*", supabaseAuth);

// The columns every staff read selects. Shared by GET / (full roster, for
// id -> name DISPLAY) and GET /pickable (company-scoped, for the salesperson
// PICKERS) so the two can never drift on shape.
const STAFF_COLUMNS =
  "id, staff_code, name, role, showroom_id, venue_id, showroom_warehouse_id, user_id, initials, color, active, email, phone";

// Dual-read camelCase ?? snake_case — the PostgREST driver may camelCase result
// columns; cover both so we never read undefined.
function toStaffRow(r: Record<string, unknown>, positionSlug?: string | null) {
  return {
    id: r.id,
    staffCode: r.staffCode ?? r.staff_code ?? "",
    name: r.name,
    /* POS-role derivation (owner 2026-07-24, HANDOFF #104): the role the POS
       gates on FOLLOWS the member's User-Management position; the stored
       scm.staff.role (stamped 'sales' on every member by mig 0066) is only the
       fallback for unmapped/unlinked rows. See lib/pos-staff-role.ts. */
    role: derivePosRole(positionSlug, r.role),
    showroomId: r.showroomId ?? r.showroom_id ?? null,
    venueId: r.venueId ?? r.venue_id ?? null,
    /* SHOWROOM PARKING (migration 0148) — the warehouse this person is parked
       under. Distinct from the legacy `showroomId`, which points at the vendored
       2990 scm.showrooms table (empty in Houzs). userId is exposed so the
       Members page, which is keyed by Houzs user id, can join to this row
       without a second lookup. */
    showroomWarehouseId: r.showroomWarehouseId ?? r.showroom_warehouse_id ?? null,
    userId: r.userId ?? r.user_id ?? null,
    initials: r.initials ?? "",
    color: r.color ?? "#888888",
    active: r.active,
    email: r.email ?? null,
    phone: r.phone ?? null,
  };
}

/**
 * positions.slug per Houzs user id, for POS-role derivation (pos-staff-role.ts).
 * Same degrade contract as loadGrantsByUserId (now in lib/staffCompanyScope.ts):
 * an absent table
 * (pre-migration / D1 test mirror) or a read blip yields an EMPTY map — every
 * row then falls back to its stored scm.staff.role, which is exactly the
 * pre-derivation behaviour. Never throws the roster.
 */
async function loadPositionSlugsByUserId(
  env: Env,
  userIds: number[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (userIds.length === 0) return map;
  try {
    const placeholders = userIds.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT u.id AS user_id, p.slug AS position_slug
         FROM users u
         JOIN positions p ON p.id = u.position_id
        WHERE u.id IN (${placeholders})`,
    )
      .bind(...userIds)
      .all<{ user_id: number | string; position_slug: string | null }>();
    for (const row of res.results ?? []) {
      const uid = Number(row.user_id);
      if (!Number.isInteger(uid) || !row.position_slug) continue;
      map.set(uid, String(row.position_slug));
    }
  } catch {
    // users / positions absent or transient error — empty map = stored roles.
  }
  return map;
}

/** Serialise rows with the POS role derived from each member's position. The
 *  single serialisation path for every staff read (GET / , /by-ids, /pickable)
 *  so the POS can never see a position-blind role from one endpoint and a
 *  derived one from another. */
async function toStaffRowsWithDerivedRoles(
  env: Env,
  rows: Array<Record<string, unknown>>,
) {
  const linkedIds = Array.from(
    new Set(rows.map(rowUserId).filter((n): n is number => n != null)),
  );
  const slugByUserId = await loadPositionSlugsByUserId(env, linkedIds);
  return rows.map((r) => {
    const uid = rowUserId(r);
    return toStaffRow(r, uid == null ? null : slugByUserId.get(uid) ?? null);
  });
}

// GET / — list staff rows ordered by staff_code (mirrors 2990's useStaff
// .order('staff_code')). Includes active + inactive so historical-name
// DISPLAY still resolves the ids on old orders. Degrades to [] when the
// relation is missing.
//
// COMPANY SCOPE (owner audit 2026-07-22 — "从 backend 断绝掉"):
//   · Default: SCOPED to the caller's active company via Team grants (the same
//     rule as /pickable). Includes inactive rows so a departed salesperson who
//     was granted to THIS company still resolves for display. A caller who is
//     scoped out of a name — because the referenced staff is granted only to
//     the OTHER company — should look them up via GET /by-ids below, which is
//     bounded to specific known IDs.
//   · ?scope=all: opt-in cross-company full roster, gated on the same
//     `users.manage` permission as the Members page (the one page that
//     legitimately needs to see everyone regardless of company). Anyone else
//     asking for ?scope=all is refused 403 rather than fed the full list —
//     this is what stops a future picker misuse from re-opening the leak the
//     POS handover picker had (POS PR #744, hz-baseline BUG-HISTORY 2026-07-22).
staff.get("/", async (c) => {
  const supabase = c.get("supabase");
  const wantAll = c.req.query("scope") === "all";
  if (wantAll && !hasHouzsPerm(c, "users.manage")) {
    return c.json(
      {
        error: "forbidden",
        reason: "?scope=all is only for callers with users.manage permission — use /staff/by-ids for known-id name lookup.",
      },
      403,
    );
  }
  const { data, error } = await supabase
    .from("staff")
    .select(STAFF_COLUMNS)
    .order("staff_code", { ascending: true });
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ staff: [] });
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (wantAll) return c.json({ staff: await toStaffRowsWithDerivedRoles(c.env, rows) });
  const { scoped } = await scopeStaffRowsToActiveCompany(c, rows);
  return c.json({ staff: await toStaffRowsWithDerivedRoles(c.env, scoped) });
});

// GET /by-ids?ids=<uuid>,<uuid>,... — bulk name lookup for KNOWN IDs.
//
// The narrow companion to the scope tightening above. Any list/detail page
// that renders "Salesperson: <name>" from an id it already holds passes those
// ids here to resolve names; the server returns rows only for the specified
// ids. No scope filter: the caller already knows the ids, so the payload is
// exactly what they asked for — no enumeration of the roster, and no way to
// widen from one id to another. Capped at 200 ids per call to keep the URL
// bounded and prevent it from turning into an unbounded list endpoint.
staff.get("/by-ids", async (c) => {
  const raw = (c.req.query("ids") ?? "").trim();
  if (!raw) return c.json({ staff: [] });
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) return c.json({ staff: [] });
  if (ids.length > 200) {
    return c.json(
      { error: "too_many_ids", reason: "Cap is 200 ids per call — split the request." },
      400,
    );
  }
  const supabase = c.get("supabase");
  const { data, error } = await supabase
    .from("staff")
    .select(STAFF_COLUMNS)
    .in("id", ids);
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ staff: [] });
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  return c.json({
    staff: await toStaffRowsWithDerivedRoles(
      c.env,
      (data ?? []) as Array<Record<string, unknown>>,
    ),
  });
});

// GET /pickable — the salesperson SELECTION list, scoped to the ACTIVE company.
//
// This closes the last cross-company picker leak: GET / lists every company's
// salespeople, so a Houzs order could pick a 2990 salesperson and vice-versa.
// The salesperson dropdowns (SO / SI / DR / consignment new+edit, mobile New SO,
// PaymentsTable "Collected By") read THIS endpoint instead; DISPLAY keeps GET /.
//
// SCOPING RULE — see scm/lib/staffCompanyScope.ts (owner 2026-07-19: a
// salesperson's company is their Team assignment; "both" appears in both). Only
// ACTIVE rows are pickable (a departed salesperson is resolved for display via
// GET /, never offered for a NEW order).
//
// THREE-STATE COMPANY GATE — mirrors scm/lib/companyScope.ts, so this endpoint
// behaves like every other scoped read:
//   · companies master ABSENT (pre-migration / cold-start / D1 test mirror) —
//     single-company Houzs, nothing to leak to: DEGRADE to the full ACTIVE
//     roster, exactly as before this fix.
//   · master LOADED + active company RESOLVED — scope to it via the grant rule.
//   · master LOADED + active company UNRESOLVED (a caller restricted to no
//     active company) — FAIL CLOSED to []. In a live multi-company world an
//     unknown active company must NEVER dump every company's salespeople.
staff.get("/pickable", async (c) => {
  const supabase = c.get("supabase");
  const onlySales = c.req.query("onlySales") === "1";
  const { data, error } = await supabase
    .from("staff")
    .select(STAFF_COLUMNS)
    .eq("active", true)
    .order("staff_code", { ascending: true });
  if (error) {
    if (/relation .* does not exist/i.test(error.message)) return c.json({ staff: [] });
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const { scoped } = await scopeStaffRowsToActiveCompany(c, rows);

  /* Owner 2026-07-22: the SO / SI / DR / consignment SALESPERSON dropdowns
     were showing every ACTIVE staff row granted to the active company,
     including office / admin / owner / test accounts. Narrow to SALES only
     when the caller asks (onlySales=1) — mirrors pmsAccess.isSalesUser
     (position "Sales …" OR department containing "sales"). Left OFF by
     default so the PaymentsTable "Collected By" picker + any other
     legitimate all-staff caller still gets the full active roster. */
  if (!onlySales) {
    return c.json({ staff: await toStaffRowsWithDerivedRoles(c.env, scoped) });
  }

  const linkedIds = Array.from(
    new Set(scoped.map(rowUserId).filter((n): n is number => n != null)),
  );
  if (linkedIds.length === 0) return c.json({ staff: [] });
  let positionByUserId = new Map<number, { position_name: string | null; department_name: string | null }>();
  try {
    const placeholders = linkedIds.map(() => "?").join(",");
    const res = await c.env.DB.prepare(
      `SELECT u.id AS user_id,
              COALESCE(p.name, '')  AS position_name,
              COALESCE(d.name, pd.name, '') AS department_name
         FROM users u
         LEFT JOIN positions p    ON p.id = u.position_id
         LEFT JOIN departments pd ON pd.id = p.department_id
         LEFT JOIN departments d  ON d.id = u.department_id
        WHERE u.id IN (${placeholders})`,
    )
      .bind(...linkedIds)
      .all<{ user_id: number | string; position_name: string | null; department_name: string | null }>();
    for (const row of res.results ?? []) {
      const uid = Number(row.user_id);
      if (!Number.isInteger(uid)) continue;
      positionByUserId.set(uid, {
        position_name: row.position_name ?? null,
        department_name: row.department_name ?? null,
      });
    }
  } catch {
    // users / positions / departments absent (pre-migration / D1 test
    // mirror) — degrade to no-filter rather than blanking the picker.
    return c.json({ staff: await toStaffRowsWithDerivedRoles(c.env, scoped) });
  }

  const salesOnly = scoped.filter((r) => {
    const uid = rowUserId(r);
    if (uid == null) return false; // UNLINKED rows can't be resolved as sales
    const meta = positionByUserId.get(uid);
    if (!meta) return false;
    return isSalesUser({
      position_name: meta.position_name,
      department_name: meta.department_name,
      permissions_set: null,
    } as any);
  });
  return c.json({ staff: await toStaffRowsWithDerivedRoles(c.env, salesOnly) });
});

/* ── SHOWROOM PARKING (owner 2026-07-19, migration 0148) ────────────────────
   The PRIMARY venue binding. A salesperson is parked under a Showroom ONCE, by
   HR/admin, on the Members page — and from then on every order they raise
   attributes to that showroom's venue with no further data entry, no per-event
   work, and no dependence on anyone maintaining a project team. That is the
   whole reason it outranks the PMS binding in practice: an exhibition
   assignment still WINS when one exists (see lib/venue-binding.ts), but the
   system has to produce a correct venue when none ever does.

   A "Showroom" is a scm.warehouses row with is_showroom = true. It is NOT the
   vendored 2990 scm.showrooms table, which is empty in Houzs and POS-specific;
   one showroom vocabulary, anchored to the warehouse that physically exists. */

// GET /staff/showrooms — the parking picker's options: every warehouse flagged
// as a Showroom. venueName is surfaced (not hidden behind the id) so whoever
// parks a person can SEE which venue they are about to attribute that person's
// orders to, and can tell a showroom with no venue set yet from one that is
// ready — a flagged showroom with a blank venue resolves to nothing.
staff.get("/showrooms", async (c) => {
  const supabase = c.get("supabase");
  // Company-scoped: the parking picker must list ONLY the active company's
  // showrooms. Without this a 2990 member's picker showed HOUZS showrooms
  // (AKEMI SLEEP STUDIO / DUNLOPILLO SUITE), and mig 0186 (is_showroom synced
  // from type='showroom') widened the leak by flagging more rows. warehouses is
  // company-scoped since mig 0083.
  const cid = activeCompanyId(c);
  let q = supabase
    .from("warehouses")
    .select("id, code, name, venue_name, is_active")
    .eq("is_showroom", true);
  if (cid != null) q = q.eq("company_id", cid);
  const { data, error } = await q.order("name", { ascending: true });
  if (error) {
    if (/relation .* does not exist|column .* does not exist/i.test(error.message)) {
      return c.json({ showrooms: [] });
    }
    return c.json({ error: "load_failed", reason: error.message }, 500);
  }
  const showrooms = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    code: r.code ?? "",
    name: r.name ?? "",
    venueName: (r.venueName ?? r.venue_name ?? null) as string | null,
    active: (r.isActive ?? r.is_active ?? true) as boolean,
  }));
  return c.json({ showrooms });
});

// PATCH /staff/by-user/:userId/showroom — park (or unpark) one person.
//
// Keyed by HOUZS USER ID, not scm.staff.id: the Members page is a list of Houzs
// users, and migration 0066 syncs every non-disabled user into scm.staff with
// user_id as the deterministic link. Making the caller resolve the staff uuid
// first would put the SCM's internal identity into a Workspace page's contract.
//
// Gated on `users.manage` — parking someone under a showroom decides which venue
// their sales attribute to, and therefore which fair's P&L and whose commission
// they land in. That is the same class of authority as editing the person's
// record, so it uses the same key rather than inventing a new one.
staff.patch("/by-user/:userId/showroom", requireHouzsPerm("users.manage"), async (c) => {
  const supabase = c.get("supabase");
  const userId = Number(c.req.param("userId"));
  if (!Number.isFinite(userId)) return c.json({ error: "invalid_user_id" }, 400);

  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; }
  catch { return c.json({ error: "invalid_json" }, 400); }

  /* null / "" / absent all mean UNPARK. An explicit unpark is a real decision
     ("this person is not attached to a showroom"), and it resolves to an empty
     venue rather than to some fallback — so it must be expressible. */
  const raw = body.showroomWarehouseId;
  const showroomWarehouseId =
    typeof raw === "string" && raw.trim() ? raw.trim() : null;

  /* Verify the target is actually a flagged Showroom BEFORE parking anyone
     under it. Without this check a plain stock warehouse could be parked
     against, and it would resolve to nothing forever with no visible reason —
     the person's orders would just silently carry no venue. Fail loudly here
     instead, where someone is looking at the screen. */
  /* ⚠️ THE TARGET PERSON, checked BEFORE the warehouse. Added 2026-08-18.
     `showroom_warehouse_id` is a single column on a SHARED scm.staff row, so
     "which company may write it" cannot come from a predicate on that table —
     it comes from whether the PERSON belongs to the caller's company, which is
     exactly what staffCompanyScope derives. Unchecked, a HOUZS admin holding
     users.manage could re-park a 2990-only salesperson (and an UNPARK needs no
     warehouse at all, so the warehouse check below could not stand in for it),
     silently moving whose venue, fair P&L and commission their orders land in.
     404 rather than 403: same reasoning as NOT_THIS_COMPANY. */
  {
    const { data: target, error: targetErr } = await supabase
      .from("staff")
      .select("id, user_id")
      .eq("user_id", userId);
    if (targetErr) return c.json({ error: "load_failed", reason: targetErr.message }, 500);
    const targetRows = ((target ?? []) as Array<Record<string, unknown>>);
    if (targetRows.length > 0) {
      const { scoped } = await scopeStaffRowsToActiveCompany(c, targetRows);
      if (scoped.length === 0) {
        return c.json({
          error: "not_found_in_company",
          message: "That member isn't in the company you're working in.",
        }, 404);
      }
    }
  }

  if (showroomWarehouseId) {
    /* COMPANY SCOPE (deliberately NOT written as the checker's opt-out
       annotation — that spelling on this handler is what hid the unscoped
       write below from check-company-scope.mjs for as long as it existed. The
       handler is now judged on its merits like any other.)

       The WAREHOUSE is per-company (mig 0086 added
       warehouses.company_id; 0087 made its code unique per company), so the
       showroom must be one of THIS company's — an id-only check let a
       salesperson be parked under the other company's showroom, and every
       order they then wrote would carry that venue.

       scm.staff itself is deliberately NOT company-stamped: mig 0089 lists it
       under "shared / per-staff reference data" alongside currencies and
       my_localities, and hr_salesperson_profiles is keyed
       UNIQUE(company_id, staff_id) precisely because ONE staff row holds one
       profile PER company. So the `.eq('user_id', userId)` update below takes
       no company_id predicate — there is no such column to predicate on. That
       was the true half of the note this comment used to carry; the false half
       was reading it as "therefore nothing needs checking", which is what left
       the write open until the target-person gate above was added. Two tables,
       two different answers, in one handler. */
    const { data: wh, error: whErr } = await scopeToCompany(supabase
      .from("warehouses")
      .select("id, is_showroom")
      .eq("id", showroomWarehouseId), c)
      .maybeSingle();
    if (whErr) return c.json({ error: "load_failed", reason: whErr.message }, 500);
    const row = wh as Record<string, unknown> | null;
    const isShowroom = (row?.isShowroom ?? row?.is_showroom) as boolean | undefined;
    if (!row || isShowroom !== true) {
      return c.json({
        error: "not_a_showroom",
        message:
          "That location is not marked as a Showroom. Mark it as a Showroom in Warehouses first, then park the salesperson under it.",
      }, 409);
    }
  }

  const { data, error } = await supabase
    .from("staff")
    .update({ showroom_warehouse_id: showroomWarehouseId })
    .eq("user_id", userId)
    .select("id, user_id, showroom_warehouse_id");
  if (error) return c.json({ error: "update_failed", reason: error.message }, 500);

  /* No staff row = this user was never synced into scm.staff (disabled, or
     created before migration 0066 ran). Say so plainly rather than reporting a
     success that stored nothing — a parking that silently did not happen is the
     exact failure this feature cannot afford. */
  if (!data || (data as unknown[]).length === 0) {
    return c.json({
      error: "staff_unlinked",
      message:
        "This member has no sales profile yet, so they cannot be parked under a showroom. Ask IT to link their account.",
    }, 409);
  }
  return c.json({ ok: true, showroomWarehouseId });
});

export default staff;
