// ---------------------------------------------------------------------------
// Announcement escalation — "notify the supervisors of whoever has not
// acknowledged". ONE implementation behind two triggers:
//
//   · the drawer's "Notify their supervisors" (POST /:id/escalate, optional
//     department filter) — the poster's click;
//   · the overdue cron (owner 2026-09-06, "做逾期自动通知主管的 cron"): every
//     30 minutes, a notice that REQUIRES acknowledgement, is deliverable, and
//     is older than the ACK_OVERDUE_HOURS window (the same 48h that paints a
//     person "overdue" in the drawer) is escalated ONCE, automatically.
//
// One system notice per supervisor (source 'ack_escalation', via
// postPersonalNotice — idempotent on its own target set), listing their
// pending people. `announcements.escalated_at` (mig 20260906T0833) records
// that the escalation ran, so the cron never re-notifies and the drawer can
// say so; a manual click sets it too. It is set even when nobody could be
// notified (nothing pending, or pending people with no manager), so an old
// notice is not re-scanned every half hour forever.
// ---------------------------------------------------------------------------
import type { Env } from "../types";
import {
  ACK_OVERDUE_HOURS,
  announcementRequiresAck,
  audienceOf,
  deliverableNow,
  isOverdue,
  loadAckMap,
  loadRoster,
  readTargetCompanyIds,
  type AnnouncementRow,
  type RosterUser,
} from "../lib/announcementAudience";
import { bumpConfigVersion } from "./configCache";
import { postPersonalNotice } from "./personalNotice";

export type EscalationResult = {
  supervisors: number;
  people: number;
  unsupervised: number;
};

/**
 * Escalate ONE notice: a system notice to each supervisor of the people still
 * pending (optionally only those in `departmentId`), then stamp escalated_at.
 */
export async function escalatePending(
  env: Env,
  ann: AnnouncementRow,
  departmentId: number | null = null,
  now = Date.now(),
): Promise<EscalationResult> {
  const roster = audienceOf(ann, await loadRoster(env, readTargetCompanyIds(ann)));
  const ackedAtByUser = await loadAckMap(env, ann.id);
  const pending = roster.filter(
    (u) =>
      !ackedAtByUser.has(u.id) &&
      (departmentId == null || !Number.isFinite(departmentId) || u.departmentId === departmentId),
  );
  const byManager = new Map<number, RosterUser[]>();
  for (const u of pending) {
    if (u.managerId == null) continue;
    const list = byManager.get(u.managerId);
    if (list) list.push(u);
    else byManager.set(u.managerId, [u]);
  }
  for (const [managerId, people] of byManager) {
    const names = people.map((p) => p.name || p.email);
    await postPersonalNotice(env, {
      userIds: [managerId],
      category: "GENERAL",
      title: `${names.length} of your team ${names.length === 1 ? "has" : "have"} not acknowledged "${ann.title}"`,
      body: `Still pending: ${names.join(", ")}. Please follow up — the notice requires acknowledgement.`,
      source: "ack_escalation",
    });
  }
  // The managers' bell slices just changed.
  if (byManager.size > 0) await bumpConfigVersion(env, "banner");
  try {
    // company-scope: ONE notice by primary key, already scoped by the caller (route: getScopedAnnouncement; cron: the whole table is its scope).
    await env.DB.prepare("UPDATE announcements SET escalated_at = ? WHERE id = ?")
      .bind(new Date(now).toISOString(), ann.id)
      .run();
  } catch (e) {
    // A mirror without the column (pre-migration window) still delivers the
    // notices; only the "already escalated" memory is lost for that run.
    console.error("[announcements] escalated_at not recorded:", (e as Error).message);
  }
  return {
    supervisors: byManager.size,
    people: pending.filter((u) => u.managerId != null).length,
    unsupervised: pending.filter((u) => u.managerId == null).length,
  };
}

export type OverdueEscalationRun = {
  /** Candidate rows read (old enough, active, human, not yet escalated). */
  scanned: number;
  /** Notices escalated this run (stamped), whether or not anyone was notified. */
  escalated: number;
  /** Supervisor notices posted in total. */
  supervisors: number;
  /** Pending people who have no manager and so reached nobody. */
  unsupervised: number;
};

/**
 * The cron: escalate every acknowledgement-required notice that has been
 * live for longer than ACK_OVERDUE_HOURS and has not been escalated yet.
 */
export async function runOverdueEscalation(
  env: Env,
  now = Date.now(),
): Promise<OverdueEscalationRun> {
  const cutoff = new Date(now - ACK_OVERDUE_HOURS * 3_600_000).toISOString();
  // company-scope: the cron has no caller; it walks every company's notices on purpose (each supervisor notice is addressed to that supervisor alone).
  const res = await env.DB.prepare(
    `SELECT * FROM announcements
      WHERE source IS NULL AND is_active = 1 AND escalated_at IS NULL AND created_at < ?
      ORDER BY created_at ASC`,
  )
    .bind(cutoff)
    .all<AnnouncementRow>();
  const out: OverdueEscalationRun = { scanned: res.results.length, escalated: 0, supervisors: 0, unsupervised: 0 };
  for (const ann of res.results) {
    // created_at passed the SQL cutoff; a scheduled notice went live later,
    // so the window is re-checked against the instant it became readable.
    if (!deliverableNow(ann, now) || !announcementRequiresAck(ann) || !isOverdue(ann, now)) continue;
    const r = await escalatePending(env, ann, null, now);
    out.escalated += 1;
    out.supervisors += r.supervisors;
    out.unsupervised += r.unsupervised;
  }
  return out;
}
