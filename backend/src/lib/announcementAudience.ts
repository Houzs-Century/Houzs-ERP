// ---------------------------------------------------------------------------
// Announcement AUDIENCE helpers — who a notice reaches, and the roster it is
// measured against. Split out of routes/announcements.ts on 2026-09-06 (the
// route had crossed the 2000-line file-size cap with the division-targeting
// work); nothing here is route-specific. The route keeps the gate itself
// (userCanSee) because it reads the row shape; these are its ingredients:
//
//   · division targets (mig 20260906T0639): the {deptId, division} pairs a
//     notice may name, parsed + de-duplicated, and the case-insensitive
//     equality the gate uses;
//   · the caller's own division (AuthUser carries none);
//   · the active roster with org fields (receipts / ack-summary / team-pending),
//     the company-grant narrowing, and the per-person pending state.
// ---------------------------------------------------------------------------
import type { Env } from "../types";

/** One targeted division: the department it sits in + the division text. */
export type DivisionTarget = { deptId: number; division: string };

/** Case-insensitive, whitespace-trimmed division equality. */
export function divisionEq(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  return x.length > 0 && x === y;
}

/** Parse a stored / requested division list. Invalid entries are dropped,
 *  duplicates (same dept, same division ignoring case) collapse to one. */
export function readDivisionTargets(v: unknown): DivisionTarget[] {
  let arr: unknown = v;
  if (typeof v === "string") {
    if (!v.trim()) return [];
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: DivisionTarget[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as { deptId?: unknown; dept_id?: unknown; division?: unknown };
    const deptId = Number(o.deptId ?? o.dept_id);
    const division = typeof o.division === "string" ? o.division.trim() : "";
    if (!Number.isInteger(deptId) || deptId <= 0 || !division || division.length > 120) continue;
    if (out.some((d) => d.deptId === deptId && divisionEq(d.division, division))) continue;
    out.push({ deptId, division });
  }
  return out;
}

/**
 * Company filter for a notice's read-receipt / reminder roster. A notice's
 * audience spans the companies it TARGETS (target_company_ids); a user belongs
 * to that audience when they have a `user_companies` (mig 0085) grant for any
 * targeted company — with the same FAIL-OPEN rule as companyContext: a user
 * with NO grant rows belongs to every company. When the notice targets ALL
 * companies (empty list) OR no valid ids are given, returns "" (no filter) so
 * the whole active roster counts. Ids come from OUR companies master and are
 * re-validated as positive integers, so inlining them (no binds) is safe.
 */
export function rosterCompaniesSql(companyIds: number[], alias = "users"): string {
  const ids = companyIds
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return "";
  const inList = ids.join(",");
  return ` AND (NOT EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = ${alias}.id)
             OR EXISTS (SELECT 1 FROM user_companies uc WHERE uc.user_id = ${alias}.id AND uc.company_id IN (${inList})))`;
}

// The caller's division for the reader-side audience gates. AuthUser carries
// department_id / position_id but not users.division (mig 0021), so the
// list / banner / attachment gates look it up once per request. Missing table
// or column (older D1 mirrors) = no division, which only ever HIDES a
// division-targeted notice, never shows one.
export async function callerDivision(env: Env, userId: number): Promise<string | null> {
  try {
    // company-scope: the caller's OWN row by primary key; no company dimension.
    const row = await env.DB.prepare("SELECT division FROM users WHERE id = ?")
      .bind(userId)
      .first<{ division?: string | null }>();
    const v = (row?.division ?? "").trim();
    return v || null;
  } catch {
    return null;
  }
}

export type RosterUser = {
  id: number;
  email: string;
  name: string;
  departmentId: number | null;
  departmentName: string | null;
  positionId: number | null;
  positionName: string | null;
  managerId: number | null;
  division: string | null;
};

// Every ACTIVE user with their org-chart fields. `companyIds` narrows to the
// notice's targeted companies via the same fail-open grant rule as before
// (rosterCompaniesSql); [] = the whole roster. Reads dual-keyed because the pg
// driver folds snake_case → camelCase on read.
export async function loadRoster(env: Env, companyIds: number[]): Promise<RosterUser[]> {
  const res = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.department_id, u.position_id, u.manager_id,
            u.division, d.name AS department_name, p.name AS position_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN positions p ON p.id = u.position_id
      WHERE u.status = 'active'${rosterCompaniesSql(companyIds, "u")}
      ORDER BY u.name ASC`,
  ).all<{
    id: number;
    email?: string | null;
    name?: string | null;
    department_id?: number | null;
    departmentId?: number | null;
    position_id?: number | null;
    positionId?: number | null;
    manager_id?: number | null;
    managerId?: number | null;
    division?: string | null;
    department_name?: string | null;
    departmentName?: string | null;
    position_name?: string | null;
    positionName?: string | null;
  }>();
  return (res.results).map((u) => ({
    id: u.id,
    email: u.email ?? "",
    name: u.name ?? "",
    departmentId: u.departmentId ?? u.department_id ?? null,
    departmentName: u.departmentName ?? u.department_name ?? null,
    positionId: u.positionId ?? u.position_id ?? null,
    positionName: u.positionName ?? u.position_name ?? null,
    managerId: u.managerId ?? u.manager_id ?? null,
    division: (u.division ?? "").trim() || null,
  }));
}

// The user_companies grants, for narrowing a roster to a notice's targeted
// companies in JS (the summary walks every notice against one roster, so the
// per-notice SQL filter does not fit). Same fail-open rule as
// rosterCompaniesSql: a user with NO grant row belongs to every company. A
// missing table (D1 test mirror, pre-0085) means no grants → everyone belongs.
export async function loadCompanyGrants(env: Env): Promise<Map<number, Set<number>>> {
  const out = new Map<number, Set<number>>();
  try {
    const res = await env.DB.prepare(
      "SELECT user_id, company_id FROM user_companies",
    ).all<{ user_id?: number; userId?: number; company_id?: number; companyId?: number }>();
    for (const g of res.results) {
      const uid = g.userId ?? g.user_id;
      const cid = g.companyId ?? g.company_id;
      if (uid == null || cid == null) continue;
      let set = out.get(uid);
      if (!set) {
        set = new Set<number>();
        out.set(uid, set);
      }
      set.add(cid);
    }
  } catch {
    /* no grants table → fail-open, everyone belongs to every company */
  }
  return out;
}

export function inTargetCompanies(
  grants: Map<number, Set<number>>,
  userId: number,
  targets: number[],
): boolean {
  if (targets.length === 0) return true;
  const mine = grants.get(userId);
  if (!mine || mine.size === 0) return true;
  return targets.some((id) => mine.has(id));
}

// A pending person's state (design handoff 2026-09-04, drawer + dashboard):
// reminded = the office has reminded since the post; overdue = still unacked
// past the window; otherwise plainly pending. Confirmed is the acked side.
export const ACK_OVERDUE_HOURS = 48;
export type PendingState = "pending" | "reminded" | "overdue";
/** The two timestamps pendingState reads, dual-keyed like every row. */
export type PendingStateRow = {
  remindedAt?: string | null;
  reminded_at?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};
export function pendingState(ann: PendingStateRow, now = Date.now()): PendingState {
  const remindedAt = ann.remindedAt ?? ann.reminded_at ?? null;
  if (remindedAt && !Number.isNaN(Date.parse(remindedAt))) return "reminded";
  const createdAt = ann.createdAt ?? ann.created_at ?? null;
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isNaN(t) && now - t > ACK_OVERDUE_HOURS * 3_600_000) return "overdue";
  return "pending";
}
