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
import type { AnnouncementTranslations } from "./translate-announcement";

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
  scheduledAt?: string | null;
  scheduled_at?: string | null;
};
export function pendingState(
  ann: PendingStateRow,
  now = Date.now(),
  personRemindedAt: string | null = null,
): PendingState {
  // Reminded = the whole notice was reminded (announcements.reminded_at) OR
  // this person was (announcement_reminders, mig 20260906T0921).
  const remindedAt = laterOf(ann.remindedAt ?? ann.reminded_at ?? null, personRemindedAt);
  if (remindedAt && !Number.isNaN(Date.parse(remindedAt))) return "reminded";
  const t = liveSinceMs(ann);
  if (!Number.isNaN(t) && now - t > ACK_OVERDUE_HOURS * 3_600_000) return "overdue";
  return "pending";
}

/** When the notice went live: the later of created_at and a scheduled_at
 *  (a scheduled notice was not readable before its instant, so the overdue
 *  clock must not run against it). NaN when neither parses. */
export function liveSinceMs(ann: PendingStateRow): number {
  const created = ann.createdAt ?? ann.created_at ?? null;
  const scheduled = ann.scheduledAt ?? ann.scheduled_at ?? null;
  const c = created ? Date.parse(created) : NaN;
  const s = scheduled ? Date.parse(scheduled) : NaN;
  if (Number.isNaN(c)) return s;
  if (Number.isNaN(s)) return c;
  return Math.max(c, s);
}

/** The later of two ISO instants; null when neither parses. */
export function laterOf(a: string | null | undefined, b: string | null | undefined): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? null : (b ?? null);
  if (Number.isNaN(tb)) return a ?? null;
  return ta >= tb ? (a ?? null) : (b ?? null);
}

// ── Per-person reminders (mig 20260906T0921). Every reader tolerates the
// table being absent (pre-migration window, older D1 mirrors): no rows.

/** ONE notice → user id → reminded_at. */
export async function loadReminderMap(env: Env, id: string): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  try {
    // company-scope: reminders for ONE notice the caller already passed getScopedAnnouncement for; no company dimension of their own.
    const res = await env.DB.prepare(
      "SELECT user_id, reminded_at FROM announcement_reminders WHERE announcement_id = ?",
    )
      .bind(id)
      .all<{ user_id?: number; userId?: number; reminded_at?: string | null; remindedAt?: string | null }>();
    for (const r of res.results) {
      const uid = r.userId ?? r.user_id;
      const at = r.remindedAt ?? r.reminded_at ?? null;
      if (uid != null && at) out.set(uid, at);
    }
  } catch {
    /* no reminders table yet */
  }
  return out;
}

/** ONE reader → notice id → reminded_at (the banner's re-pop input). */
export async function loadUserReminders(env: Env, userId: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    // company-scope: keyed on the caller's own user_id; the notice side is gated by companyCanSee / userCanSee where it is read.
    const res = await env.DB.prepare(
      "SELECT announcement_id, reminded_at FROM announcement_reminders WHERE user_id = ?",
    )
      .bind(userId)
      .all<{ announcement_id?: string; announcementId?: string; reminded_at?: string | null; remindedAt?: string | null }>();
    for (const r of res.results) {
      const id = r.announcementId ?? r.announcement_id;
      const at = r.remindedAt ?? r.reminded_at ?? null;
      if (id && at) out.set(id, at);
    }
  } catch {
    /* no reminders table yet */
  }
  return out;
}

/** Every reminder → notice id → (user id → reminded_at), for the team card. */
export async function loadAllReminders(env: Env): Promise<Map<string, Map<number, string>>> {
  const out = new Map<string, Map<number, string>>();
  try {
    // company-scope: a lookup map consulted only for (notice, report) pairs the caller has already filtered through userCanSee / inTargetCompanies; never returned raw.
    const res = await env.DB.prepare(
      "SELECT announcement_id, user_id, reminded_at FROM announcement_reminders",
    ).all<{ announcement_id?: string; announcementId?: string; user_id?: number; userId?: number; reminded_at?: string | null; remindedAt?: string | null }>();
    for (const r of res.results) {
      const id = r.announcementId ?? r.announcement_id;
      const uid = r.userId ?? r.user_id;
      const at = r.remindedAt ?? r.reminded_at ?? null;
      if (!id || uid == null || !at) continue;
      let m = out.get(id);
      if (!m) {
        m = new Map<number, string>();
        out.set(id, m);
      }
      m.set(uid, at);
    }
  } catch {
    /* no reminders table yet */
  }
  return out;
}

/** Upsert one reminder row per person (latest instant wins). Returns how many
 *  rows were written; 0 with a warning when the table is not there yet. */
export async function recordReminders(
  env: Env,
  announcementId: string,
  userIds: number[],
  remindedBy: number | null,
  at = new Date().toISOString(),
): Promise<number> {
  let n = 0;
  for (const uid of userIds) {
    try {
      await env.DB.prepare(
        `INSERT INTO announcement_reminders (announcement_id, user_id, reminded_at, reminded_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (announcement_id, user_id) DO UPDATE SET reminded_at = excluded.reminded_at, reminded_by = excluded.reminded_by`,
      )
        .bind(announcementId, uid, at, remindedBy)
        .run();
      n += 1;
    } catch (e) {
      console.error("[announcements] reminder row not recorded:", (e as Error).message);
      break;
    }
  }
  return n;
}

/** Overdue = live for longer than the window and not yet acknowledged. */
export function isOverdue(ann: PendingStateRow, now = Date.now()): boolean {
  const t = liveSinceMs(ann);
  return !Number.isNaN(t) && now - t > ACK_OVERDUE_HOURS * 3_600_000;
}

// ── Row shape + readers + the gate (moved from routes/announcements.ts on
// 2026-09-06 so the overdue-escalation cron can share them; the route imports
// them back). `userCanSee` is THE audience rule: every reader-side gate, the
// roster, ack-summary, team-pending and escalation go through it.

export type AnnouncementCategory = "GENERAL" | "WARNING" | "SOP" | "LEARNING";

export type TargetType =
  | "ALL_USERS"
  | "DEPARTMENT_IDS"
  | "POSITION_IDS"
  | "USER_IDS"
  | "MIXED";

export type AnnouncementAttachment = {
  r2Key: string;
  name: string;
  mime: string;
  size?: number;
};

export type PhotoLayout = "1" | "2" | "3" | "4";

export type VideoLayout = "1x1" | "1x2";

export type MediaLayout = { photo?: PhotoLayout; video?: VideoLayout };

// Raw row shape from the DB (dual-keyed because the pg driver folds
// snake_case -> camelCase on read — the #1 Hookka read-gotcha).
export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  // Rich body (mig 20260904T1700). Canonical HTML fragment — see
  // lib/announcementRichText.ts — or NULL for a plain-text notice. `body` is
  // ALWAYS the plain-text shadow of it, so plain-only readers need no branch.
  body_html?: string | null;
  bodyHtml?: string | null;
  // Per-notice "must acknowledge" flag (mig 20260905T1125), integer 0/1. NULL
  // only on a pre-migration row / the D1 test mirror — toPublic then emits
  // null and the client falls back to the category rule (WARNING / SOP).
  require_ack?: number | boolean | null;
  requireAck?: number | boolean | null;
  // Scheduled posting instant (same migration). ISO text; NULL = posted at
  // once. A row is not delivered (list / banner / ack) before it.
  scheduled_at?: string | null;
  scheduledAt?: string | null;
  is_active?: number | boolean | null;
  isActive?: number | boolean | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  reminded_at?: string | null;
  remindedAt?: string | null;
  created_by?: number | null;
  createdBy?: number | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
  translations?: AnnouncementTranslations | string | null;
  attachments?: string | unknown[] | null;
  // Rich-media layout hint (mig 0140). JSON string, dual-keyed for the pg
  // snake->camel fold. NULL = derive a default from the attachment count.
  media_layout?: string | MediaLayout | null;
  mediaLayout?: string | MediaLayout | null;
  target_type?: string | null;
  targetType?: string | null;
  target_dept_ids?: string | number[] | null;
  targetDeptIds?: string | number[] | null;
  target_position_ids?: string | number[] | null;
  targetPositionIds?: string | number[] | null;
  target_user_ids?: string | number[] | null;
  targetUserIds?: string | number[] | null;
  // Company-targeting dimension (mig 0113). JSON array of company ids, e.g.
  // '[1]' or '[1,2]'. NULL / empty = ALL companies (visible to everyone). The
  // existing per-row company_id below is the AUTHORING company; this is the
  // independent audience filter combined (AND) with the dept/position/user
  // audience match. See userCompanyCanSee / the unified read paths below.
  target_company_ids?: string | number[] | null;
  targetCompanyIds?: string | number[] | null;
  // Division targeting (mig 20260906T0639). JSON array of {deptId, division}
  // — a division is the free-text users.division within ONE department, so
  // the pair is the key. Counts as the DEPARTMENT bucket of target_type (a
  // division is a slice of a department; the CHECK constraint is untouched).
  target_divisions?: string | DivisionTarget[] | null;
  targetDivisions?: string | DivisionTarget[] | null;
  // People carved OUT of the audience (mig 20260906T0639). JSON integer array;
  // an excluded id never sees the notice, whatever else targets them.
  excluded_user_ids?: string | number[] | null;
  excludedUserIds?: string | number[] | null;
  // When the overdue escalation ran for this notice (cron or the drawer's
  // click; mig 20260906T0833). NULL = never — the cron's "due" filter.
  escalated_at?: string | null;
  escalatedAt?: string | null;
  category?: string | null;
  source?: string | null;
  company_id?: number | null;
  companyId?: number | null;
};

export function readCategory(v: unknown): AnnouncementCategory {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "WARNING" || s === "SOP" || s === "LEARNING") return s;
  return "GENERAL";
}

export function isActiveFlag(v: number | boolean | null | undefined): boolean {
  return v === true || v === 1;
}

export function notExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return true;
  return t > Date.now();
}

export function categoryRequiresAck(category: AnnouncementCategory): boolean {
  return category === "WARNING" || category === "SOP";
}

export function readRequireAck(v: number | boolean | null | undefined): boolean | null {
  if (v == null) return null;
  return v === true || v === 1;
}

export function scheduledLater(scheduledAt: string | null | undefined, now = Date.now()): boolean {
  if (!scheduledAt) return false;
  const t = Date.parse(scheduledAt);
  return !Number.isNaN(t) && t > now;
}

// Is this row DELIVERABLE to a reader right now? Active, past its schedule,
// and not expired — where an SOP never expires (redesign 2026-09-04: the SOP
// Library is permanent, so a stale expires_at on an SOP is ignored rather than
// silently pulling a standing procedure off everyone's screen). The list's
// reader branch, /banner and the ack POST all use this one answer.
export function deliverableNow(r: AnnouncementRow, now = Date.now()): boolean {
  if (!isActiveFlag(r.isActive ?? r.is_active ?? null)) return false;
  if (scheduledLater(r.scheduledAt ?? r.scheduled_at ?? null, now)) return false;
  if (readCategory(r.category) === "SOP") return true;
  return notExpired(r.expiresAt ?? r.expires_at ?? null);
}

// Parse a stored JSON array of integers. Tolerates a JSON string OR a parsed
// array; drops non-numbers; deduplicates.
export function readIntArray(v: string | number[] | null | undefined): number[] {
  if (v == null) return [];
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
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of arr) {
    const n = typeof x === "number" ? x : parseInt(String(x), 10);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function rowDivisions(r: AnnouncementRow): DivisionTarget[] {
  return readDivisionTargets(r.targetDivisions ?? r.target_divisions ?? null);
}

export function rowExcluded(r: AnnouncementRow): number[] {
  return readIntArray(r.excludedUserIds ?? r.excluded_user_ids ?? null);
}

export function readTargetType(r: AnnouncementRow): TargetType {
  const t = String(r.targetType ?? r.target_type ?? "ALL_USERS").toUpperCase();
  if (
    t === "DEPARTMENT_IDS" ||
    t === "POSITION_IDS" ||
    t === "USER_IDS" ||
    t === "MIXED"
  )
    return t;
  return "ALL_USERS";
}

// The announcement's targeted company ids (JSON array), dual-keyed for the pg
// snake->camel fold. Empty = ALL companies.
export function readTargetCompanyIds(r: AnnouncementRow): number[] {
  return readIntArray(r.targetCompanyIds ?? r.target_company_ids ?? null);
}

// True when a user with (id, deptId, positionId) is in the announcement's
// audience. Used by the banner GET so we never surface a notice the user
// shouldn't see.
export function userCanSee(
  r: AnnouncementRow,
  userId: number,
  userDeptId: number | null,
  userPositionId: number | null,
  userDivision: string | null = null,
): boolean {
  // An unticked person is out, whatever else targets them (mig 20260906T0639).
  if (rowExcluded(r).includes(userId)) return false;
  const type = readTargetType(r);
  if (type === "ALL_USERS") return true;
  const deptIds = readIntArray(r.targetDeptIds ?? r.target_dept_ids ?? null);
  if (userDeptId != null && deptIds.includes(userDeptId)) return true;
  // A division target matches the user's PRIMARY department + their division
  // text (users.division, mig 0021), case-insensitively.
  if (userDeptId != null && userDivision) {
    const divisions = rowDivisions(r);
    if (divisions.some((d) => d.deptId === userDeptId && divisionEq(d.division, userDivision))) {
      return true;
    }
  }
  const positionIds = readIntArray(
    r.targetPositionIds ?? r.target_position_ids ?? null,
  );
  if (userPositionId != null && positionIds.includes(userPositionId)) return true;
  const userIds = readIntArray(r.targetUserIds ?? r.target_user_ids ?? null);
  if (userIds.includes(userId)) return true;
  return false;
}

export function audienceOf(ann: AnnouncementRow, roster: RosterUser[]): RosterUser[] {
  return roster.filter((u) => userCanSee(ann, u.id, u.departmentId, u.positionId, u.division));
}

// acked_at per user for ONE notice (or, with no id, every notice → keyed by
// notice id first).
export async function loadAckMap(env: Env, id: string): Promise<Map<number, string | null>> {
  // company-scope: receipts for ONE notice the caller already passed getScopedAnnouncement (companyCanSee) for; acks carry no company dimension of their own.
  const res = await env.DB.prepare(
    "SELECT user_id, acked_at FROM announcement_acks WHERE announcement_id = ?",
  )
    .bind(id)
    .all<{ user_id?: number; userId?: number; acked_at?: string | null; ackedAt?: string | null }>();
  const out = new Map<number, string | null>();
  for (const a of res.results) {
    const uid = a.userId ?? a.user_id;
    if (uid != null) out.set(uid, a.ackedAt ?? a.acked_at ?? null);
  }
  return out;
}

export async function loadAllAcks(env: Env): Promise<Map<string, Set<number>>> {
  // company-scope: a lookup map consulted only for notices the caller has already filtered through companyCanSee / inTargetCompanies; never returned raw.
  const res = await env.DB.prepare(
    "SELECT announcement_id, user_id FROM announcement_acks",
  ).all<{ announcement_id?: string; announcementId?: string; user_id?: number; userId?: number }>();
  const out = new Map<string, Set<number>>();
  for (const a of res.results) {
    const id = a.announcementId ?? a.announcement_id;
    const uid = a.userId ?? a.user_id;
    if (!id || uid == null) continue;
    let set = out.get(id);
    if (!set) {
      set = new Set<number>();
      out.set(id, set);
    }
    set.add(uid);
  }
  return out;
}

// Does the notice demand an acknowledgement? The stored flag, else the
// category rule — the same fallback the client applies.
export function announcementRequiresAck(r: AnnouncementRow): boolean {
  return readRequireAck(r.requireAck ?? r.require_ack ?? null) ?? categoryRequiresAck(readCategory(r.category));
}
