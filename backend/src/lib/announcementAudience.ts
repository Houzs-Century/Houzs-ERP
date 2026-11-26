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

export type AnnouncementRow = {
  id: string;
  number_dept_id?: number | null;
  numberDeptId?: number | null;
  title: string;
  body: string;
  body_html?: string | null;
  bodyHtml?: string | null;
  require_ack?: number | boolean | null;
  requireAck?: number | boolean | null;
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
  target_company_ids?: string | number[] | null;
  targetCompanyIds?: string | number[] | null;
  target_divisions?: string | DivisionTarget[] | null;
  targetDivisions?: string | DivisionTarget[] | null;
  excluded_user_ids?: string | number[] | null;
  excludedUserIds?: string | number[] | null;
  escalated_at?: string | null;
  escalatedAt?: string | null;
  approval_status?: string | null;
  approvalStatus?: string | null;
  submitted_by?: number | null;
  submittedBy?: number | null;
  submitted_at?: string | null;
  submittedAt?: string | null;
  reviewed_by?: number | null;
  reviewedBy?: number | null;
  reviewed_at?: string | null;
  reviewedAt?: string | null;
  reject_reason?: string | null;
  rejectReason?: string | null;
  ref_no?: string | null;
  refNo?: string | null;
  voided_by?: number | null;
  voidedBy?: number | null;
  voided_at?: string | null;
  voidedAt?: string | null;
  void_reason?: string | null;
  voidReason?: string | null;
  doc_type?: string | null;
  docType?: string | null;
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

export type ApprovalStatus = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
const APPROVAL_STATUSES: ReadonlySet<string> = new Set(["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED"]);

/** The approval state of a row. Anything unrecognised (NULL, a row from a
 *  mirror without the column) reads as APPROVED — the column's DEFAULT, and
 *  what every pre-workflow notice is. */
export function readApprovalStatus(r: Pick<AnnouncementRow, "approval_status" | "approvalStatus">): ApprovalStatus {
  const v = String(r.approvalStatus ?? r.approval_status ?? "").trim().toUpperCase();
  return APPROVAL_STATUSES.has(v) ? (v as ApprovalStatus) : "APPROVED";
}

/** The notice's document type code (mig 20260908T0300). NULL / absent /
 *  malformed reads as ANN — the column's DEFAULT and every pre-migration row. */
export function readDocType(r: Pick<AnnouncementRow, "doc_type" | "docType">): string {
  const v = String(r.docType ?? r.doc_type ?? "").trim().toUpperCase();
  return /^[A-Z]{2,4}$/.test(v) ? v : "ANN";
}

/** The department the number is minted under (mig 20260909T0900), or null
 *  for the rule before it — the submitter's own department. */
export function readNumberDept(r: Pick<AnnouncementRow, "number_dept_id" | "numberDeptId">): number | null {
  const v = Number(r.numberDeptId ?? r.number_dept_id ?? NaN);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** True once the notice was voided (mig 20260907T1030). */
export function isVoided(r: Pick<AnnouncementRow, "voided_at" | "voidedAt">): boolean {
  return (r.voidedAt ?? r.voided_at ?? null) != null;
}

export function deliverableNow(r: AnnouncementRow, now = Date.now()): boolean {
  if (isVoided(r)) return false;
  if (readApprovalStatus(r) !== "APPROVED") return false;
  if (!isActiveFlag(r.isActive ?? r.is_active ?? null)) return false;
  if (scheduledLater(r.scheduledAt ?? r.scheduled_at ?? null, now)) return false;
  if (readCategory(r.category) === "SOP") return true;
  return notExpired(r.expiresAt ?? r.expires_at ?? null);
}

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

export function readTargetCompanyIds(r: AnnouncementRow): number[] {
  return readIntArray(r.targetCompanyIds ?? r.target_company_ids ?? null);
}

export function userCanSee(
  r: AnnouncementRow,
  userId: number,
  userDeptId: number | null,
  userPositionId: number | null,
  userDivision: string | null = null,
): boolean {
  if (rowExcluded(r).includes(userId)) return false;
  const type = readTargetType(r);
  if (type === "ALL_USERS") return true;
  const deptIds = readIntArray(r.targetDeptIds ?? r.target_dept_ids ?? null);
  if (userDeptId != null && deptIds.includes(userDeptId)) return true;
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

export function announcementRequiresAck(r: AnnouncementRow): boolean {
  return readRequireAck(r.requireAck ?? r.require_ack ?? null) ?? categoryRequiresAck(readCategory(r.category));
}
