import { activeCompanyId, houzsCompanyId, mirrorCompanyId } from "./companyScope";
import type { Env } from "../env";

export const SCM_SYSTEM_STAFF_ID = "00000000-0000-4000-8000-000000000001";

// ─────────────────────────────────────────────────────────────────────────
// staffCompanyScope.ts — derive which company a salesperson (scm.staff row)
// belongs to, from the Team company grants, so the SO / SI / DR / consignment
// salesperson pickers show only the ACTIVE company's people.
//
// THE LEAK THIS CLOSES: GET /api/scm/staff has no company predicate, so the
// salesperson dropdown listed BOTH companies' salespeople — a Houzs order could
// pick a 2990 salesperson and vice-versa (BUG-HISTORY.md, the salesperson arm of
// the cross-company picker-leak class).
//
// THE RULE (owner 2026-07-19, verbatim: "你就看我们team那边sales under什么公司
// 除非公司是both") — a salesperson's company is whatever their Team assignment
// says, and someone granted BOTH companies belongs to both. scm.staff has NO
// company_id (it is a SHARED master — migration 0083, restated in staff-mirror.ts
// and migrate-2990-staff.mjs), so the attribution is DERIVED, never stored:
//
//   • LINKED row (staff.user_id set → a Houzs User-Management user via migration
//     0066): company set = that user's public.user_companies grants. A user
//     granted {HOUZS, 2990} appears in BOTH pickers; granted {2990} only appears
//     when 2990 is active. "both" falls straight out of set-membership — no
//     special case.
//
//   • LINKED row with ZERO grants: attribute to the HOUZS base company only.
//     The Team backfill's founding rule is "every existing user belongs to Houzs
//     (company 1)" (phase0e-backfill-user-companies.sql rule 1), so an ungranted
//     linked user is a Houzs user by default. We deliberately do NOT mirror
//     companyContext's caller-side FAIL-OPEN ("0 grants = ALL companies") for a
//     LISTED salesperson: applied here it would re-open the very leak we are
//     closing (any ungranted user would surface in BOTH pickers). Real 2990
//     people never depend on this branch — migrate-2990-staff.mjs gives them an
//     explicit 2990 grant, and un-migrated 2990 rows are UNLINKED (next branch).
//
//   • UNLINKED row (staff.user_id NULL): a frozen 2990 import row
//     (migrate-2990-into-houzs.mjs) / a live 2990 mirror row (staff-mirror.ts) —
//     no Houzs user writes it; `user_id IS NULL` is that receiver's own
//     handover flag. Attribute to the mirror-source company 2990. The single
//     exception is the seeded system row (SYSTEM_STAFF_ID), a Houzs artifact,
//     attributed to HOUZS.
//
// Company ids are RESOLVED FROM companies.code (HOUZS / 2990), never hardcoded —
// the ids differ across staging/prod. See scm/lib/companyScope.ts
// houzsCompanyId / mirrorCompanyId.
// ─────────────────────────────────────────────────────────────────────────

/** The company ids this request needs, all resolved from companies.code. */
export interface StaffScopeCompanyIds {
  active: number;
  houzs: number | undefined;
  mirror: number | undefined;
}

/** The minimum a staff row must expose to be scoped: its id and its user link. */
export interface StaffScopeRow {
  id: string;
  user_id: number | null;
}

/**
 * The companies (ids) a staff row belongs to, derived purely from grants — see
 * the four-branch rule in the file header. `grantsByUserId` maps a linked user's
 * public.users id to the company ids granted to them in public.user_companies;
 * an absent entry means that user has ZERO grant rows.
 *
 * Returns a fresh array so a caller can neither mutate the grant map through it
 * nor share it across rows.
 */
export function staffCompanyIds(
  row: StaffScopeRow,
  grantsByUserId: Map<number, number[]>,
  ids: Pick<StaffScopeCompanyIds, "houzs" | "mirror">,
  systemStaffId: string,
): number[] {
  if (row.id === systemStaffId) return ids.houzs != null ? [ids.houzs] : [];

  if (row.user_id != null) {
    const grants = grantsByUserId.get(Number(row.user_id));
    if (grants && grants.length > 0) return grants.slice();
    return ids.houzs != null ? [ids.houzs] : [];
  }

  return ids.mirror != null ? [ids.mirror] : [];
}

/** True when a staff row belongs to the ACTIVE company. */
export function staffRowInActiveCompany(
  row: StaffScopeRow,
  grantsByUserId: Map<number, number[]>,
  ids: StaffScopeCompanyIds,
  systemStaffId: string,
): boolean {
  return staffCompanyIds(row, grantsByUserId, ids, systemStaffId).includes(ids.active);
}

/**
 * Filter a staff list to the rows that belong to the ACTIVE company. Preserves
 * input order (the roster arrives ordered by staff_code) and never mutates the
 * input. This is the pure core the GET /staff/pickable endpoint applies after
 * resolving the active company and loading grants.
 */
export function filterStaffToCompany<T extends StaffScopeRow>(
  rows: T[],
  grantsByUserId: Map<number, number[]>,
  ids: StaffScopeCompanyIds,
  systemStaffId: string,
): T[] {
  return rows.filter((r) => staffRowInActiveCompany(r, grantsByUserId, ids, systemStaffId));
}


/** A staff row's linked Houzs user id, reading camelCase ?? snake_case (the
 *  PostgREST driver may camelCase result columns). Null when unlinked. */
export function rowUserId(r: Record<string, unknown>): number | null {
  const raw = r.user_id ?? r.userId;
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Company grants for a set of Houzs users, as user_id -> [company_id, …], read
 * from public.user_companies via the Postgres-backed env.DB shim (the SAME
 * source companyContext resolves the caller's own grants from). An absent map
 * entry means that user has ZERO grant rows. Degrades to an empty map — never
 * throws the picker — when the table is missing (pre-0f) or a read blips; every
 * LINKED row then falls to its 0-grant default (HOUZS base), matching
 * companyContext's own "absent table = no grants" behaviour.
 */
export async function loadGrantsByUserId(
  env: Env,
  userIds: number[],
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (userIds.length === 0) return map;
  try {
    const placeholders = userIds.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT user_id, company_id FROM user_companies WHERE user_id IN (${placeholders})`,
    )
      .bind(...userIds)
      .all<{ user_id: number | string; company_id: number | string }>();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    for (const row of res.results ?? []) {
      const uid = Number(row.user_id);
      const cid = Number(row.company_id);
      if (!Number.isInteger(uid) || !Number.isInteger(cid) || cid <= 0) continue;
      const arr = map.get(uid);
      if (arr) arr.push(cid);
      else map.set(uid, [cid]);
    }
  } catch {
  }
  return map;
}

export async function scopeStaffRowsToActiveCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Hono Context or the synthetic headless one; see CompanyScopeCtx
  c: any,
  rows: Array<Record<string, unknown>>,
): Promise<{
  scoped: Array<Record<string, unknown>>;
  degrade: boolean;
  failClosed: boolean;
}> {
  const companies = c.get("companies") ?? [];
  if (companies.length === 0) return { scoped: rows, degrade: true, failClosed: false };
  const active = activeCompanyId(c);
  if (active == null) return { scoped: [], degrade: false, failClosed: true };
  const linkedIds = Array.from(
    new Set(rows.map(rowUserId).filter((n): n is number => n != null)),
  );
  const grantsByUserId = await loadGrantsByUserId(c.env, linkedIds);
  const ids = { active, houzs: houzsCompanyId(c), mirror: mirrorCompanyId(c) };
  const filtered = filterStaffToCompany(
    rows.map((r) => ({ raw: r, id: String(r.id), user_id: rowUserId(r) })),
    grantsByUserId,
    ids,
    SCM_SYSTEM_STAFF_ID,
  ).map((s) => s.raw);
  return { scoped: filtered, degrade: false, failClosed: false };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ALWAYS-HOLDS RULE — added 2026-08-21.

   A picker narrows its roster for good reasons (owner 2026-07-22: keep office /
   admin / owner / test accounts out of the SALESPERSON dropdown). What it must
   never do is narrow away a PERSON the screen has to resolve, because every
   consumer resolves a person against the same narrowed list and every one of
   them fails the same way:

     · the caller themself → the New-SO page could not find its own creator and
       fell back to a UI-only "<name> (me)" option that is not a staff id, and
       the Payments "Collected By" default fell to blank ("—");
     · the id already ON the document (salesperson_id) → the SO / SI / DR /
       consignment pickers labelled it "(former staff)" for someone who had
       raised the order minutes earlier.

   So the narrowing stays exactly as it is, and the roster is UNIONED with the
   two id sets a screen cannot do without. Server-side, because the alternative
   — each screen patching its own copy back in — is the same rule written eight
   times, which is how the three symptoms above came to have one cause.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The staff ids a picker must hold no matter what narrowing it applies:
 * the CALLER's own row plus every id the screen explicitly asked to keep.
 *
 * `roster` is the un-narrowed candidate set the ids are resolved against — the
 * caller is found in it by `user_id`, which is the same link the backend itself
 * resolves the caller by (`resolveCallerStaffId`). A caller with no row in
 * `roster` (no scm.staff row at all, or a deactivated one) contributes nothing:
 * this function never invents an id.
 *
 * `callerHouzsUserId` is REQUIRED and explicitly nullable rather than optional —
 * its absence changes the answer, so the compiler has to see every call site
 * decide (CLAUDE.md, "a parameter that DECIDES something is required").
 */
export function alwaysPickableStaffIds(
  roster: Array<Record<string, unknown>>,
  callerHouzsUserId: number | null,
  includeIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const id of includeIds) {
    const trimmed = id.trim();
    if (trimmed) out.add(trimmed);
  }
  if (callerHouzsUserId != null && Number.isFinite(callerHouzsUserId)) {
    for (const r of roster) {
      if (rowUserId(r) === callerHouzsUserId) {
        out.add(String(r.id));
        break;
      }
    }
  }
  return out;
}

/**
 * `narrowed` UNION the rows of `roster` whose id is in `alwaysIds`, in ROSTER
 * order (staff_code) so the picker's ordering is unchanged and one id can never
 * appear twice.
 *
 * `narrowed` is expected to be a subset of `roster`; an id in `alwaysIds` that
 * names no roster row adds nothing — the screen then renders its own
 * "(former staff)" fallback, which is now only reachable for a row that really
 * is gone (deactivated / no longer in the table) rather than one a filter hid.
 */
export function unionAlwaysPickable(
  roster: Array<Record<string, unknown>>,
  narrowed: Array<Record<string, unknown>>,
  alwaysIds: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  const keep = new Set(narrowed.map((r) => String(r.id)));
  return roster.filter((r) => {
    const id = String(r.id);
    return keep.has(id) || alwaysIds.has(id);
  });
}

/** Cap on `?include=` — the screens pass the ONE id already on the document;
 *  anything past this is a caller doing something else. Deliberately far below
 *  GET /staff/by-ids' 200, because this list is bounded by what one document
 *  can reference, not by what a list page can display. */
export const MAX_INCLUDE_IDS = 50;

/**
 * Parse `?include=<uuid>,<uuid>,…` into a de-duplicated id list.
 * Returns `null` when the caller sent more than {@link MAX_INCLUDE_IDS} — the
 * route answers 400 rather than silently truncating, because a truncated
 * include is exactly the "(former staff)" bug wearing a smaller hat.
 *
 * These ids are only ever COMPARED against rows already fetched — never
 * interpolated into a query — so an unparseable value is inert, not dangerous.
 */
export function parseIncludeIds(raw: string | undefined | null): string[] | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  const ids = Array.from(
    new Set(
      trimmed
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
  return ids.length > MAX_INCLUDE_IDS ? null : ids;
}
