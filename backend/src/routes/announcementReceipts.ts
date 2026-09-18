// ---------------------------------------------------------------------------
// Announcements — read receipts and acknowledgement analytics. Split out of
// routes/announcements.ts on 2026-09-09 (that file sat at its 2000-line
// ceiling); the handlers are moved verbatim, the gates and the arithmetic are
// unchanged. Mounted on the SAME prefix (/api/announcements) in
// src/index.ts, after routes/announcements.ts — no path here overlaps a path
// there (announcements.ts has no bare GET /:id), so mount order is moot.
//
//   GET  /:id/acks       — the receipts drawer: who acked, who is pending
//                          (state per person), the department buckets
//   GET  /ack-summary    — { id → { total, acked } } for the Manage table
//   GET  /ack-trend      — the dashboard's "Ack rate · last 30 days"
//   GET  /team-pending   — a supervisor's direct reports' unacked notices
//   POST /:id/escalate   — "Notify their supervisors"
//
// Contract and rules: docs/modules/announcements.md §2, §3 "Read receipts".
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermissionOrSalesDirector } from "../middleware/auth";
import { allowedCompanyIds } from "../scm/lib/companyScope";
import { escalatePending } from "../services/announcementEscalation";
import {
  ACK_OVERDUE_HOURS,
  announcementRequiresAck,
  audienceOf,
  deliverableNow,
  inTargetCompanies,
  isVoided,
  loadAckMap,
  loadAllAcks,
  loadAllReminders,
  loadCompanyGrants,
  loadReminderMap,
  loadRoster,
  pendingState,
  readCategory,
  readTargetCompanyIds,
  userCanSee,
  type AnnouncementCategory,
  type AnnouncementRow,
  type PendingState,
  type RosterUser,
} from "../lib/announcementAudience";
import { companyCanSee, getScopedAnnouncement, salesDirectorScope, sdBlockedFromRow } from "./announcements";

const app = new Hono<{ Bindings: Env }>();

app.get("/:id/acks", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  // A Sales Director may only see read-receipts for notices they authored.
  if (sdBlockedFromRow(salesDirectorScope(c), ann, c.get("user")?.id ?? null)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }

  // Only the active users this notice actually targets (userCanSee respects
  // ALL_USERS / DEPARTMENT_IDS / POSITION_IDS / USER_IDS / MIXED), narrowed to
  // the notice's TARGETED companies (user_companies grants, fail-open — see
  // helper). A notice targeting all companies counts the whole roster.
  const roster = audienceOf(ann, await loadRoster(c.env, readTargetCompanyIds(ann)));
  const ackedAtByUser = await loadAckMap(c.env, id);
  const reminders = await loadReminderMap(c.env, id);
  const now = Date.now();

  type Person = {
    id: number;
    name: string;
    email: string;
    departmentId: number | null;
    departmentName: string | null;
    positionName: string | null;
    managerId: number | null;
  };
  const person = (u: RosterUser): Person => ({
    id: u.id,
    name: u.name,
    email: u.email,
    departmentId: u.departmentId,
    departmentName: u.departmentName,
    positionName: u.positionName,
    managerId: u.managerId,
  });
  const acked: Array<Person & { ackedAt: string | null }> = [];
  const pending: Array<Person & { state: PendingState; remindedAt: string | null }> = [];
  // Two-level drill-down (notice → department → person): one bucket per
  // department in the audience, in roster (name) order of first appearance.
  const byDepartment = new Map<
    string,
    { id: number | null; name: string; total: number; acked: number; pending: number }
  >();
  for (const u of roster) {
    const key = u.departmentId == null ? "none" : String(u.departmentId);
    let d = byDepartment.get(key);
    if (!d) {
      d = {
        id: u.departmentId,
        name: u.departmentName ?? (u.departmentId == null ? "No department" : `Dept #${u.departmentId}`),
        total: 0,
        acked: 0,
        pending: 0,
      };
      byDepartment.set(key, d);
    }
    d.total += 1;
    if (ackedAtByUser.has(u.id)) {
      d.acked += 1;
      acked.push({ ...person(u), ackedAt: ackedAtByUser.get(u.id) ?? null });
    } else {
      d.pending += 1;
      const remindedAt = reminders.get(u.id) ?? null;
      pending.push({ ...person(u), state: pendingState(ann, now, remindedAt), remindedAt });
    }
  }
  acked.sort((x, y) => {
    const tx = x.ackedAt ? Date.parse(x.ackedAt) : 0;
    const ty = y.ackedAt ? Date.parse(y.ackedAt) : 0;
    return (Number.isNaN(ty) ? 0 : ty) - (Number.isNaN(tx) ? 0 : tx);
  });

  return c.json({
    success: true,
    data: {
      total: roster.length,
      ackedCount: acked.length,
      acked,
      pending,
      byDepartment: Array.from(byDepartment.values()).sort((a, b) => a.name.localeCompare(b.name)),
      remindedAt: ann.remindedAt ?? ann.reminded_at ?? null,
      overdueAfterHours: ACK_OVERDUE_HOURS,
    },
  });
});

// ============================================================
// GET /ack-summary — { [id]: { total, acked } } for every human post the
// caller may manage, in ONE round trip. Feeds the Manage table's ack-rate
// column and stat strip (design handoff 2026-09-04); walking /:id/acks per row
// would be N requests. Same gate + Sales-Director ownership rule as the
// receipts. Company narrowing is done in JS against the grants map because
// each notice has its own target set.
// ============================================================
app.get("/ack-summary", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const sd = salesDirectorScope(c);
  const allowed = allowedCompanyIds(c);
  // company-scope: announcements carry their audience as target_company_ids
  // (NULL = every company), not a per-row company predicate — the same
  // in-JS companyCanSee(allowed) gate GET / applies runs on the very next
  // line, so a notice targeting only companies the caller lacks is dropped
  // before its counts are computed.
  const res = await c.env.DB
    .prepare(`SELECT * FROM announcements WHERE source IS NULL ORDER BY created_at DESC`)
    .all<AnnouncementRow>();
  const rows = (res.results).filter(
    (r) => companyCanSee(r, allowed) && !sdBlockedFromRow(sd, r, user.id),
  );
  const totals = await noticeAckTotals(c.env, rows);
  const data: Record<string, { total: number; acked: number }> = {};
  for (const [id, t] of totals) data[id] = t;
  return c.json({ success: true, data });
});

// The ONE per-notice arithmetic behind /ack-summary and /ack-trend: the
// audience (roster through the gate, narrowed by company grants) and how many
// of it acknowledged. Kept together so the Manage table and the dashboard
// chart can never disagree on a rate.
async function noticeAckTotals(
  env: Env,
  rows: AnnouncementRow[],
): Promise<Map<string, { total: number; acked: number }>> {
  const [roster, acks, grants] = await Promise.all([
    loadRoster(env, []),
    loadAllAcks(env),
    loadCompanyGrants(env),
  ]);
  const out = new Map<string, { total: number; acked: number }>();
  for (const r of rows) {
    const targets = readTargetCompanyIds(r);
    const audience = audienceOf(r, roster).filter((u) => inTargetCompanies(grants, u.id, targets));
    const ackedSet = acks.get(r.id);
    let acked = 0;
    for (const u of audience) if (ackedSet?.has(u.id)) acked += 1;
    out.set(r.id, { total: audience.length, acked });
  }
  return out;
}

// ============================================================
// GET /ack-trend — the dashboard's "Ack rate · last 30 days" (design handoff
// 2026-09-04, screen 5; endpoint 2026-09-06): six 5-day buckets ending now,
// each the summed audience and acknowledgements of the human notices POSTED
// in it, plus the 30-day summary. Same gate, ownership rule and per-notice
// arithmetic as /ack-summary, so the card and the Manage table agree. A
// bucket with no notice has pct null (drawn empty, never as 0%). Buckets
// carry ISO instants only; the client renders them with the house fmtDate.
// ============================================================
const ACK_TREND_DAYS = 30;
const ACK_TREND_BUCKETS = 6;
app.get("/ack-trend", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const sd = salesDirectorScope(c);
  const allowed = allowedCompanyIds(c);
  const now = Date.now();
  const dayMs = 86_400_000;
  const bucketMs = (ACK_TREND_DAYS / ACK_TREND_BUCKETS) * dayMs;
  const windowStart = now - ACK_TREND_DAYS * dayMs;
  // company-scope: announcements carry their audience as target_company_ids
  // (NULL = every company), not a per-row company predicate — the same in-JS
  // companyCanSee(allowed) gate the list applies runs on the very next line.
  const res = await c.env.DB
    .prepare(`SELECT * FROM announcements WHERE source IS NULL AND created_at >= ? ORDER BY created_at ASC`)
    .bind(new Date(windowStart).toISOString())
    .all<AnnouncementRow>();
  const rows = (res.results).filter(
    (r) => companyCanSee(r, allowed) && !sdBlockedFromRow(sd, r, user.id),
  );
  const totals = await noticeAckTotals(c.env, rows);
  const buckets = Array.from({ length: ACK_TREND_BUCKETS }, (_, i) => {
    const start = new Date(windowStart + i * bucketMs);
    const end = new Date(windowStart + (i + 1) * bucketMs);
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      notices: 0,
      total: 0,
      acked: 0,
      pct: null as number | null,
    };
  });
  const summary = { days: ACK_TREND_DAYS, notices: 0, total: 0, acked: 0, pct: null as number | null };
  for (const r of rows) {
    const t = Date.parse(r.createdAt ?? r.created_at ?? "");
    if (Number.isNaN(t) || t < windowStart) continue;
    const idx = Math.min(ACK_TREND_BUCKETS - 1, Math.floor((t - windowStart) / bucketMs));
    const tot = totals.get(r.id) ?? { total: 0, acked: 0 };
    const b = buckets[idx];
    b.notices += 1;
    b.total += tot.total;
    b.acked += tot.acked;
    summary.notices += 1;
    summary.total += tot.total;
    summary.acked += tot.acked;
  }
  const pctOf = (acked: number, total: number) => (total > 0 ? Math.round((acked / total) * 100) : null);
  for (const b of buckets) b.pct = pctOf(b.acked, b.total);
  summary.pct = pctOf(summary.acked, summary.total);
  return c.json({ success: true, data: { days: ACK_TREND_DAYS, buckets, summary } });
});

// ============================================================
// GET /team-pending — the supervisor's gap (design handoff 2026-09-04, the
// dashboard "My team's pending" card). Every authed user may call it; the
// answer is scoped to THEIR direct reports (users.manager_id = caller) and
// lists each mandatory human notice a report has not acknowledged, with the
// same pending state the drawer shows. No reports → an empty answer, and the
// card does not render. Reminders stay manual; the automatic escalation job
// is a separate follow-up.
// ============================================================
app.get("/team-pending", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ success: false, error: "Your session has expired. Please sign in again." }, 401);
  }
  const roster = await loadRoster(c.env, []);
  const reports = roster.filter((u) => u.managerId === user.id);
  if (reports.length === 0) {
    return c.json({ success: true, data: { reports: 0, pending: [] } });
  }
  // company-scope: the audience is the REPORT's, not the caller's — each
  // report is matched against a notice's target_company_ids through their own
  // user_companies grants (inTargetCompanies, fail-open like rosterCompaniesSql)
  // in the loop below, so a report never appears against a notice their
  // companies cannot see; the notice rows themselves have no company column.
  const [res, acks, grants, reminders] = await Promise.all([
    c.env.DB
      // company-scope: audience is per REPORT via target_company_ids + inTargetCompanies below; rows carry no company column.
      .prepare(`SELECT * FROM announcements WHERE is_active = 1 AND source IS NULL ORDER BY created_at DESC`)
      .all<AnnouncementRow>(),
    loadAllAcks(c.env),
    loadCompanyGrants(c.env),
    loadAllReminders(c.env),
  ]);
  const now = Date.now();
  const notices = (res.results).filter(
    (r) => deliverableNow(r, now) && announcementRequiresAck(r),
  );
  const pending: Array<{
    userId: number;
    name: string;
    positionName: string | null;
    announcementId: string;
    title: string;
    category: AnnouncementCategory;
    createdAt: string | null;
    state: PendingState;
  }> = [];
  for (const r of notices) {
    const targets = readTargetCompanyIds(r);
    const ackedSet = acks.get(r.id);
    for (const u of reports) {
      if (!userCanSee(r, u.id, u.departmentId, u.positionId, u.division)) continue;
      if (!inTargetCompanies(grants, u.id, targets)) continue;
      if (ackedSet?.has(u.id)) continue;
      const state = pendingState(r, now, reminders.get(r.id)?.get(u.id) ?? null);
      pending.push({
        userId: u.id,
        name: u.name || u.email,
        positionName: u.positionName,
        announcementId: r.id,
        title: r.title,
        category: readCategory(r.category),
        createdAt: r.createdAt ?? r.created_at ?? null,
        state,
      });
    }
  }
  return c.json({
    success: true,
    data: { reports: reports.length, pending, overdueAfterHours: ACK_OVERDUE_HOURS },
  });
});

// ============================================================
// POST /:id/escalate — "Notify their supervisors" (design handoff 2026-09-04,
// the drawer's second action). For every person still pending on the notice
// (optionally one department: body.departmentId) with a manager on the org
// chart, the manager gets ONE system notice naming their pending reports. It
// rides the bell (source NOT NULL never pops a modal), and postPersonalNotice's
// dedupe swallows a repeat while the first is still unread. Manual, on the
// poster's click — the automatic overdue job is a separate follow-up.
// ============================================================
app.post("/:id/escalate", requirePermissionOrSalesDirector("announcements.write"), async (c) => {
  const id = c.req.param("id");
  const ann = await getScopedAnnouncement(c, id);
  if (!ann) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (sdBlockedFromRow(salesDirectorScope(c), ann, c.get("user").id)) {
    return c.json({ success: false, error: "Announcement not found" }, 404);
  }
  if (isVoided(ann)) {
    return c.json({ success: false, error: "A voided announcement cannot be escalated." }, 409);
  }
  const body = (await c.req.json().catch(() => ({}))) as { departmentId?: unknown };
  const deptFilter =
    body.departmentId == null ? null : parseInt(String(body.departmentId), 10);
  // The same implementation the overdue cron runs (services/announcementEscalation.ts).
  const r = await escalatePending(c.env, ann, deptFilter);
  return c.json({ success: true, ...r });
});

export default app;
