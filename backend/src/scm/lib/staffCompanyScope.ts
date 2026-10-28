import { activeCompanyId, houzsCompanyId, mirrorCompanyId } from "./companyScope";
import type { Env } from "../env";

/* The seeded super_admin system row (mig 0022 / 0066; the SCM auth bridge pins
   every caller to it). Same literal as middleware/auth.ts + staff-mirror.ts —
   it carries user_id NULL but is a HOUZS artifact, not a 2990 mirror row. Lives
   here rather than in a route file because the scoping rule below is the thing
   that needs it; it used to be a file-local const in scm/routes/staff.ts, which
   is part of why hr.ts could not reuse the pass. */
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
  /** The ACTIVE company for the request — a positive integer. The route
   *  resolves it before calling here; there is no "unresolved" branch to fall
   *  through, matching the REQUIRED-predicate rule for company scoping. */
  active: number;
  /** companies.code === 'HOUZS' — the base company an ungranted LINKED user and
   *  the system row default to. undefined only if the companies master lacks a
   *  HOUZS row (then those rows resolve to no company → hidden, i.e. fail
   *  closed). */
  houzs: number | undefined;
  /** companies.code === '2990' — the mirror-source company UNLINKED rows are
   *  attributed to. undefined only if the master lacks a 2990 row (then unlinked
   *  rows resolve to no company → hidden). */
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
  // The seeded system row is a Houzs artifact, not a 2990 mirror row — even
  // though it carries user_id NULL like the mirror rows do. Attribute to HOUZS.
  if (row.id === systemStaffId) return ids.houzs != null ? [ids.houzs] : [];

  if (row.user_id != null) {
    const grants = grantsByUserId.get(Number(row.user_id));
    if (grants && grants.length > 0) return grants.slice();
    // LINKED but ungranted → HOUZS base (Team backfill rule 1). NOT fail-open.
    return ids.houzs != null ? [ids.houzs] : [];
  }

  // UNLINKED (no Houzs user) → the 2990 mirror source.
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

/* ═══════════════════════════════════════════════════════════════════════════
   THE APPLIED PASS — moved here from scm/routes/staff.ts on 2026-08-18.

   The pure rule above had one caller and the rule's own header names the leak
   class it closes, so a SECOND staff picker that never called it was invisible:
   scm/routes/hr.ts GET /pickers returned every active staff row platform-wide
   while its four immediate siblings in the same Promise.all each carried
   `.eq('company_id', co.companyId)`. Chained with GET /staff/by-ids — which is
   deliberately unfiltered because the caller must already hold the ids, and
   which returns EMAIL and PHONE — the leak yielded the other company's staff
   directory from an endpoint whose own comment said the picker was "unscoped by
   design".

   That comment was reasoning from the wrong fact. scm.staff genuinely has no
   company_id (mig 0089 lists it under shared reference data), and it does not
   follow that the picker is unscopable — this file exists precisely because the
   attribution is DERIVED. A helper only one file can reach is a helper the next
   file re-derives or skips, so the applied pass lives with the rule now.
   ═══════════════════════════════════════════════════════════════════════════ */

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
    /* The `?? []` the rule calls redundant is the only guard left: the D1 shim
       TYPES `results` as non-nullable while the ops-script PostgREST shim can
       return it absent, and a picker that throws is worse than one that falls
       back to the base company. Same shape as the ?? guards in the money
       routes, which the backend lint ratchet documents in ci.yml. */
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
    // user_companies absent (pre-0f) or a transient DB error — keep the empty
    // map. Never throw: a picker that 500s is worse than one that falls back to
    // the HOUZS-base default for linked rows.
  }
  return map;
}

// The shared scoping pass: filter a raw staff-row set to the caller's ACTIVE
// company via Team grants. Every staff PICKER goes through this — staff.ts
// GET / and GET /pickable, and hr.ts GET /pickers — so the three cannot drift
// on the scope rule. See filterStaffToCompany above and the THREE-STATE
// contract on staff.ts GET /pickable for the full spec.
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
  // Pre-migration / cold-start: no companies master → single-company Houzs.
  // Degrade to the full roster (the pre-fix behaviour) — the caller then
  // renders the full list unchanged.
  if (companies.length === 0) return { scoped: rows, degrade: true, failClosed: false };
  const active = activeCompanyId(c);
  // Multi-company context but no resolvable active company → fail closed.
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
