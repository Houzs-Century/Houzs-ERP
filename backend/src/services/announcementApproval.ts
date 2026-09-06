// ---------------------------------------------------------------------------
// Announcement approval workflow (owner 2026-09-06, "通告审批流").
//
//   DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED (published)
//                          │                          (ref_no minted here)
//                          └───reject (reason)───▶ REJECTED ──submit──▶ PENDING_APPROVAL
//
// The three transitions live here so the route file stays a thin gate and
// the desktop, the phone and the tests all run the same rule:
//   · who may approve is a PERMISSION (announcements.approve) held by a role —
//     the owner re-points it whenever the approver changes; the wildcard
//     ("*") passes requirePermission like everywhere else, so the owner can
//     always act;
//   · the submitter's own approval right does NOT short-circuit the flow —
//     every notice, the MD's included, is approved by a click (owner's call);
//   · the reference number [DEPT]-ANN-[YYMM]-[NNNN] is minted ON APPROVAL,
//     from the SUBMITTER's department code (Team → Departments); a department
//     without a code blocks the approval with a message that says what to
//     set, rather than publishing an un-numbered notice;
//   · every transition writes audit_events (best-effort) and posts a system
//     notice (the bell) to the people whose desk it lands on — approvers on
//     submit, the submitter on approve / reject. No e-mail (owner's call).
//
// Visibility is enforced in ONE place: deliverableNow() in
// lib/announcementAudience.ts requires APPROVED, and the reader feed, both
// banner slices, the ack endpoint and the escalation cron all go through it.
//
// Prepared SQL only (d1-compat): no `--` comments inside a statement.
// ---------------------------------------------------------------------------
import type { Env } from "../types";
import {
  readApprovalStatus,
  type AnnouncementRow,
  type ApprovalStatus,
} from "../lib/announcementAudience";
import { writeAudit } from "./audit";
import { bumpConfigVersion } from "./configCache";
import { mintDocumentRef } from "./documentRefs";
import { usersHoldingPermission } from "./permissionHolders";
import { postPersonalNotice } from "./personalNotice";

export const APPROVE_PERMISSION = "announcements.approve";
/** document_refs.entity_type for a notice; the type code is the seeded ANN. */
export const ANNOUNCEMENT_ENTITY = "announcement";
export const ANNOUNCEMENT_TYPE_CODE = "ANN";
/** `source` on the system notices this flow posts (bell slice only). */
export const APPROVAL_NOTICE_SOURCE = "announcement_approval";

/** A refused transition: the HTTP status the route should answer with. */
export class ApprovalError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type Actor = { id: number | null; email?: string | null; name?: string | null };

function titleOf(row: AnnouncementRow): string {
  return String(row.title).trim() || "(untitled)";
}
function actorLabel(actor: Actor): string {
  return String(actor.name ?? "").trim() || String(actor.email ?? "").trim() || "A manager";
}
/** The person whose notice this is: whoever submitted it, else the author. */
export function submitterOf(row: AnnouncementRow): number | null {
  const v = row.submittedBy ?? row.submitted_by ?? row.createdBy ?? row.created_by ?? null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function setStatus(
  env: Env,
  id: string,
  next: ApprovalStatus,
  fields: Record<string, string | number | null>,
  nowIso: string,
): Promise<void> {
  const keys = Object.keys(fields);
  const sets = ["approval_status = ?", ...keys.map((k) => `${k} = ?`), "updated_at = ?"];
  const binds: Array<string | number | null> = [next, ...keys.map((k) => fields[k]), nowIso, id];
  // company-scope: keyed by the announcement's primary key; the caller already resolved the row within its company scope.
  await env.DB.prepare(`UPDATE announcements SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/**
 * Tell the approvers a notice is waiting. The audience is "whose desk is this
 * on" — roles that carry announcements.approve (the wildcard is deliberately
 * not on the list, see permissionHolders.ts) — minus the submitter. Returns
 * the user ids notified; a lookup failure notifies nobody rather than failing
 * the submission (the queue in Manage still shows the notice).
 */
export async function notifyApprovers(env: Env, row: AnnouncementRow, actor: Actor): Promise<number[]> {
  let ids: number[] = [];
  try {
    ids = await usersHoldingPermission(env, APPROVE_PERMISSION);
  } catch (e) {
    console.warn("[announcementApproval] approver lookup failed", e instanceof Error ? e.message : e);
    return [];
  }
  const targets = ids.filter((id) => id !== actor.id);
  if (targets.length === 0) return [];
  const title = titleOf(row);
  await postPersonalNotice(env, {
    userIds: targets,
    category: "GENERAL",
    title: `Approval needed: ${title}`,
    body: `${actorLabel(actor)} submitted "${title}" for approval. Open Announcements → Manage → Pending approval to approve or reject it.`,
    source: APPROVAL_NOTICE_SOURCE,
    expiresDays: 14,
  });
  return targets;
}

/** The audit line + approver notices for a notice that just entered the
 *  queue — shared by POST (created straight into the queue) and /submit. */
export async function recordSubmission(env: Env, row: AnnouncementRow, actor: Actor): Promise<number[]> {
  await writeAudit(env, {
    action: "announcement.submit",
    entityType: ANNOUNCEMENT_ENTITY,
    entityId: String(row.id),
    summary: `Submitted "${titleOf(row)}" for approval`,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
  });
  return notifyApprovers(env, row, actor);
}

/**
 * DRAFT / REJECTED → PENDING_APPROVAL. Already pending = no-op (a double
 * click must not re-notify every approver); APPROVED refuses — an approved
 * notice is live and is edited, hidden or deleted, not re-queued.
 */
export async function submitForApproval(
  env: Env,
  row: AnnouncementRow,
  actor: Actor,
  now = Date.now(),
): Promise<{ status: ApprovalStatus; notified: number[]; changed: boolean }> {
  const current = readApprovalStatus(row);
  if (current === "PENDING_APPROVAL") return { status: current, notified: [], changed: false };
  if (current === "APPROVED") {
    throw new ApprovalError("This announcement is already approved and live.", 409);
  }
  const nowIso = new Date(now).toISOString();
  await setStatus(
    env,
    String(row.id),
    "PENDING_APPROVAL",
    {
      submitted_by: actor.id,
      submitted_at: nowIso,
      reviewed_by: null,
      reviewed_at: null,
      reject_reason: null,
    },
    nowIso,
  );
  const notified = await recordSubmission(env, row, actor);
  return { status: "PENDING_APPROVAL", notified, changed: true };
}

type DeptRow = { department_id?: number | null; departmentId?: number | null; dept_name?: string | null; deptName?: string | null; code?: string | null };

/** The submitter's department code — the [DEPT] segment of the number. */
async function submitterDeptCode(env: Env, userId: number | null): Promise<{ code: string | null; deptName: string | null; hasDept: boolean }> {
  if (userId == null) return { code: null, deptName: null, hasDept: false };
  // company-scope: one user row by primary key (the submitter), joined to the global departments table.
  const row = await env.DB.prepare(
    `SELECT u.department_id AS department_id, d.name AS dept_name, d.code AS code
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<DeptRow>();
  const deptId = row?.departmentId ?? row?.department_id ?? null;
  const code = String(row?.code ?? "").trim().toUpperCase() || null;
  return { code, deptName: row?.deptName ?? row?.dept_name ?? null, hasDept: deptId != null };
}

/**
 * PENDING_APPROVAL → APPROVED. Mints the reference number from the
 * submitter's department, flips the status (the audience sees it from the
 * next banner build), audits, and tells the submitter.
 */
export async function approveAnnouncement(
  env: Env,
  row: AnnouncementRow,
  actor: Actor,
  now = Date.now(),
): Promise<{ refNo: string }> {
  const current = readApprovalStatus(row);
  if (current === "APPROVED") throw new ApprovalError("This announcement is already approved.", 409);
  if (current !== "PENDING_APPROVAL") {
    throw new ApprovalError("Only an announcement that is pending approval can be approved. Submit it first.", 409);
  }
  const submitter = submitterOf(row);
  const dept = await submitterDeptCode(env, submitter);
  if (!dept.hasDept) {
    throw new ApprovalError(
      "The submitter has no department, so this notice cannot be numbered. Assign them a department under Team → Members, then approve again.",
      409,
    );
  }
  if (!dept.code) {
    throw new ApprovalError(
      `Department "${dept.deptName ?? "?"}" has no code yet, so this notice cannot be numbered. Set one under Team → Departments, then approve again.`,
      409,
    );
  }
  const ref = await mintDocumentRef(env, {
    deptCode: dept.code,
    typeCode: ANNOUNCEMENT_TYPE_CODE,
    entityType: ANNOUNCEMENT_ENTITY,
    entityId: String(row.id),
    createdBy: actor.id,
    now,
  });
  const nowIso = new Date(now).toISOString();
  await setStatus(
    env,
    String(row.id),
    "APPROVED",
    { reviewed_by: actor.id, reviewed_at: nowIso, reject_reason: null, ref_no: ref.refNo },
    nowIso,
  );
  // The notice just became visible to its audience — orphan every cached
  // banner snapshot, exactly as a create does.
  await bumpConfigVersion(env, "banner");
  const title = titleOf(row);
  await writeAudit(env, {
    action: "announcement.approve",
    entityType: ANNOUNCEMENT_ENTITY,
    entityId: String(row.id),
    summary: `Approved "${title}" as ${ref.refNo}`,
    meta: { refNo: ref.refNo, submittedBy: submitter },
    actorId: actor.id,
    actorEmail: actor.email ?? null,
  });
  if (submitter != null && submitter !== actor.id) {
    await postPersonalNotice(env, {
      userIds: [submitter],
      category: "GENERAL",
      title: `Approved: ${title}`,
      body: `${actorLabel(actor)} approved "${title}" as ${ref.refNo}. It is now live for its audience.`,
      source: APPROVAL_NOTICE_SOURCE,
      expiresDays: 14,
    });
  }
  return { refNo: ref.refNo };
}

/**
 * PENDING_APPROVAL → REJECTED. The reason is mandatory — it is what the
 * submitter reads on the bell and in the Manage drawer before editing and
 * submitting again.
 */
export async function rejectAnnouncement(
  env: Env,
  row: AnnouncementRow,
  actor: Actor,
  reason: string,
  now = Date.now(),
): Promise<{ reason: string }> {
  const text = String(reason).trim();
  if (!text) throw new ApprovalError("A reason is required to reject an announcement.", 400);
  if (text.length > 1000) throw new ApprovalError("Reason too long (1000 max).", 400);
  const current = readApprovalStatus(row);
  if (current !== "PENDING_APPROVAL") {
    throw new ApprovalError("Only an announcement that is pending approval can be rejected.", 409);
  }
  const nowIso = new Date(now).toISOString();
  await setStatus(
    env,
    String(row.id),
    "REJECTED",
    { reviewed_by: actor.id, reviewed_at: nowIso, reject_reason: text },
    nowIso,
  );
  const title = titleOf(row);
  const submitter = submitterOf(row);
  await writeAudit(env, {
    action: "announcement.reject",
    entityType: ANNOUNCEMENT_ENTITY,
    entityId: String(row.id),
    summary: `Rejected "${title}": ${text}`,
    meta: { reason: text, submittedBy: submitter },
    actorId: actor.id,
    actorEmail: actor.email ?? null,
  });
  if (submitter != null && submitter !== actor.id) {
    await postPersonalNotice(env, {
      userIds: [submitter],
      category: "WARNING",
      title: `Rejected: ${title}`,
      body: `${actorLabel(actor)} rejected "${title}": ${text} Edit it and submit it again.`,
      source: APPROVAL_NOTICE_SOURCE,
      expiresDays: 14,
    });
  }
  return { reason: text };
}
