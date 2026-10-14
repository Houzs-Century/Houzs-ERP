// ----------------------------------------------------------------------------
// project-sales-bills — the evening sales report a project's chat carries,
// counted bill by bill, and what it says is still not opened.
//
// WHY (owner 2026-10-14). Every evening the floor posts, per booth, one line
// per bill: booklet number, amount, who sold it. Until each bill is keyed into
// the Sales Order module that message is the only record of what the fair sold
// and whose it is. Pasted into the project's chat by the Owner, Ummu or Wei
// Siang, it counts at once — and so does every report pasted before this
// existed — and the project says, by booklet number (the order's Ref No.),
// which bills are still not opened, and how much of that sits with each
// salesperson, shown in red beside their name under Sales Attending.
//
//   GET  /api/project-sales-bills/:projectId                 the bills the chat
//        carries, each matched to its order, per-person and per-event totals,
//        and the latest summary's Total for Total Sales
//   POST /api/project-sales-bills/:projectId/notify          ask the rep of any
//        order found under another event to amend its fair
//   POST /api/project-sales-bills/:projectId/void/:activityId  void a wrongly
//        pasted chat message: it leaves the chat and stops counting
//
// DERIVED, NOT COPIED. The bills are read out of the chat (project_activity
// notes) on every request — lib/sales-report-bills.ts collectReport — so a
// message counts the moment it is posted, from either surface, and a voided
// message stops counting with nothing else to clean up. The order match is
// likewise computed on every read: the orders change daily as reps key them in.
//
// GATES. index.ts puts the Sales section's own read gate in front of the prefix
// (requirePageAccessOrSalesView("sales")) — every attending rep may see their
// number. Notify and void are for the three people the owner named
// (canSaveSalesReport), checked here on the REAL caller. Company scope: the
// project is read inside the active company before anything under it, and the
// order read is scopeToCompany.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env, Variables } from "../scm/env";
import { supabaseAuth } from "../scm/middleware/auth";
import { getDb } from "../db/client";
import { projects, project_activity, project_finance, project_sales_attendees, positions, sales_reps, users } from "../db/schema";
import { activeCompanyId, requireActiveCompanyId, scopeToCompany } from "../scm/lib/companyScope";
import { paginateAll, chunkIn, type PageResult } from "../scm/lib/paginate-all";
import { postPersonalNotice } from "../services/personalNotice";
import {
  canSaveSalesReport,
  collectReport,
  matchBills,
  summarizeBills,
  type AttendeeRow,
  type MatchedBill,
  type NoteRow,
  type OrderRow,
} from "./lib/sales-report-bills";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Db = ReturnType<typeof getDb>;
type ProjectRow = { id: number; name: string; start_date: string | null; end_date: string | null };

const MISMATCH_SOURCE = "sales_report_fair_mismatch";
const ONLY_THREE = "Only the owner, Ummu or Wei Siang can do this.";

/** The real caller — supabaseAuth has replaced `user` with the pinned scm
 *  staff row by the time a handler runs; the person is in houzsUser. */
function realUser(c: Ctx): { email?: string | null; position_name?: string | null; id: number } | null {
  const hu = c.get("houzsUser");
  return hu ? { id: hu.id, email: hu.email ?? null, position_name: hu.position_name ?? null } : null;
}

function parseProjectId(c: Ctx): number | null {
  const n = Number(c.req.param("projectId"));
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function loadProject(db: Db, projectId: number, companyId: number | undefined): Promise<ProjectRow | null> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, start_date: projects.start_date, end_date: projects.end_date })
    .from(projects)
    .where(and(eq(projects.id, projectId), companyId != null ? eq(projects.company_id, companyId) : undefined))
    .limit(1);
  return rows[0] ?? null;
}

async function loadAttendees(db: Db, projectId: number): Promise<AttendeeRow[]> {
  const rows = await db
    .select({
      sales_rep_id: project_sales_attendees.sales_rep_id,
      rep_name: sales_reps.name,
      user_name: users.name,
      rep_user_id: sales_reps.user_id,
    })
    .from(project_sales_attendees)
    .leftJoin(sales_reps, eq(sales_reps.id, project_sales_attendees.sales_rep_id))
    .leftJoin(users, eq(users.id, sales_reps.user_id))
    .where(eq(project_sales_attendees.project_id, projectId));
  return rows.map((r) => ({
    sales_rep_id: Number(r.sales_rep_id),
    rep_name: r.rep_name,
    user_name: r.user_name,
    rep_user_id: r.rep_user_id != null ? Number(r.rep_user_id) : null,
  }));
}

/** The project's live chat messages and who wrote each — the report's source.
 *  The project itself was read inside the company first; its notes are its own. */
async function loadNotes(db: Db, projectId: number): Promise<NoteRow[]> {
  const rows = await db
    .select({
      id: project_activity.id,
      note: project_activity.note,
      created_at: project_activity.created_at,
      author_email: users.email,
      author_position: positions.name,
    })
    .from(project_activity)
    .leftJoin(users, eq(users.id, project_activity.user_id))
    .leftJoin(positions, eq(positions.id, users.position_id))
    .where(and(eq(project_activity.project_id, projectId), eq(project_activity.action, "note"), isNull(project_activity.archived_at)))
    .orderBy(asc(project_activity.created_at), asc(project_activity.id));
  return rows.map((r) => ({
    id: Number(r.id),
    note: r.note,
    created_at: r.created_at,
    author_email: r.author_email,
    author_position: r.author_position,
  }));
}

/* The orders a bill could be: this company's live orders dated from a month
   before the fair. A fair's bill is never an order dated earlier than that, and
   the window keeps the read to a few hundred rows; the matching itself is the
   pure index in lib/sales-report-bills.ts. */
const ORDER_COLS = "doc_no, project_id, status, customer_so_no, ref, salesperson_id, local_total_sen, total_revenue_sen";

function orderWindowStart(startDate: string | null): string {
  const base = /^\d{4}-\d{2}-\d{2}/.test(startDate ?? "") ? new Date(`${startDate!.slice(0, 10)}T00:00:00Z`) : new Date();
  const days = /^\d{4}-\d{2}-\d{2}/.test(startDate ?? "") ? 30 : 180;
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString().slice(0, 10);
}

async function loadOrders(c: Ctx, project: ProjectRow): Promise<OrderRow[]> {
  const sb = c.get("supabase");
  const from = orderWindowStart(project.start_date);
  const { data, error } = await paginateAll<OrderRow>((a, b) => {
    let q = sb
      .from("mfg_sales_orders")
      .select(ORDER_COLS)
      .neq("status", "CANCELLED")
      .gte("so_date", from)
      .order("doc_no", { ascending: true });
    q = scopeToCompany(q, c);
    return q.range(a, b) as unknown as PromiseLike<PageResult<OrderRow>>;
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The names of the events a wrongly linked order sits under, so the page can
 *  say where it went. Same company as the project being read. */
async function loadEventNames(db: Db, ids: number[], companyId: number | undefined): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(inArray(projects.id, ids), companyId != null ? eq(projects.company_id, companyId) : undefined));
  return new Map(rows.map((r) => [Number(r.id), r.name] as const));
}

/** Total Sales (whole RM), for the three who report only: the chat needs it to
 *  put Total Sales back when the summary it came from is voided. Everyone else
 *  gets null — Total Sales is finance data the project detail strips for them. */
async function loadTotalSalesFor(c: Ctx, db: Db, projectId: number): Promise<number | null> {
  if (!canSaveSalesReport(realUser(c))) return null;
  const rows = await db.select({ total_sales: project_finance.total_sales }).from(project_finance).where(eq(project_finance.project_id, projectId)).limit(1);
  return rows.length > 0 ? rows[0].total_sales : null;
}

async function readPayload(c: Ctx, db: Db, project: ProjectRow) {
  const [notes, attendees, totalSalesRm] = await Promise.all([
    loadNotes(db, project.id),
    loadAttendees(db, project.id),
    loadTotalSalesFor(c, db, project.id),
  ]);
  const report = collectReport(notes, project.start_date);
  /* No bills, no matching: most events have no report, and the order read is
     the heavy one. */
  const orders = report.bills.length > 0 ? await loadOrders(c, project) : [];
  const matched = matchBills(report.bills, project.id, orders, attendees);
  const { persons, totals } = summarizeBills(matched, attendees);
  const otherIds = Array.from(new Set(matched.filter((b) => b.match.other_event).map((b) => b.match.so_project_id!)));
  const otherNames = await loadEventNames(db, otherIds, activeCompanyId(c));
  return {
    bills: matched.map((b) => ({
      ...b,
      other_event_name: b.match.other_event ? otherNames.get(b.match.so_project_id!) ?? null : null,
    })),
    persons,
    totals,
    report_activity_ids: report.report_activity_ids,
    summary: report.summary,
    total_sales_rm: totalSalesRm,
    can_save: canSaveSalesReport(realUser(c)),
  };
}

/* ── the wrong-fair notice ──────────────────────────────────────────────────
   One personal notice per salesperson naming each of their orders that the
   report puts at this event while the order says another. postPersonalNotice
   de-duplicates an identical unread notice, so a re-paste does not nag. */
async function notifyWrongFair(c: Ctx, db: Db, project: ProjectRow, matched: readonly MatchedBill[]): Promise<number> {
  const wrong = matched.filter((b) => b.match.other_event && b.match.so_doc_no && b.match.so_salesperson_id);
  if (wrong.length === 0) return 0;
  const sb = c.get("supabase");

  const staffIds = Array.from(new Set(wrong.map((b) => b.match.so_salesperson_id!)));
  const { data: staff, error: staffErr } = await chunkIn<{ id: string; user_id: number | null }>(
    staffIds,
    (batch, a, b) => sb.from("staff").select("id, user_id").in("id", batch).range(a, b),
  );
  /* A failed staff read means nobody can be addressed: say so in the log and
     send nothing rather than treating the failure as "no such people". */
  if (staffErr) {
    console.log(`[project-sales-bills] staff lookup failed, no wrong-fair notice sent: ${staffErr.message}`);
    return 0;
  }
  const userByStaff = new Map(staff.map((s) => [s.id, s.user_id != null ? Number(s.user_id) : null] as const));

  const otherIds = Array.from(new Set(wrong.map((b) => b.match.so_project_id!)));
  const others = otherIds.length
    ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, otherIds))
    : [];
  const otherName = new Map(others.map((p) => [Number(p.id), p.name] as const));

  const byUser = new Map<number, string[]>();
  for (const b of wrong) {
    const userId = userByStaff.get(b.match.so_salesperson_id!) ?? null;
    if (userId == null) continue;
    const line = `${b.match.so_doc_no} (${b.ref_raw}) is linked to ${otherName.get(b.match.so_project_id!) ?? `event #${b.match.so_project_id}`}`;
    byUser.set(userId, [...(byUser.get(userId) ?? []), line]);
  }
  let notified = 0;
  for (const [userId, lines] of byUser) {
    await postPersonalNotice(c.env, {
      userIds: [userId],
      category: "WARNING",
      title: `Sales order on the wrong event — ${project.name}`,
      body: `The sales report for ${project.name} lists these orders, but each is linked to a different event:\n${lines.map((l) => `· ${l}`).join("\n")}\nPlease amend the fair on the order so the event's sales read right.`,
      source: MISMATCH_SOURCE,
    });
    notified += 1;
  }
  return notified;
}

export const projectSalesBills = new Hono<{ Bindings: Env; Variables: Variables }>();
projectSalesBills.use("*", supabaseAuth);

projectSalesBills.get("/:projectId", async (c) => {
  const projectId = parseProjectId(c);
  if (projectId == null) return c.json({ error: "invalid_project_id" }, 400);
  const db = getDb(c.env);
  const project = await loadProject(db, projectId, activeCompanyId(c));
  if (!project) return c.json({ error: "Not found" }, 404);
  try {
    return c.json(await readPayload(c, db, project));
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

projectSalesBills.post("/:projectId/notify", async (c) => {
  if (!canSaveSalesReport(realUser(c))) return c.json({ error: ONLY_THREE }, 403);
  const projectId = parseProjectId(c);
  if (projectId == null) return c.json({ error: "invalid_project_id" }, 400);
  const db = getDb(c.env);
  const project = await loadProject(db, projectId, activeCompanyId(c));
  if (!project) return c.json({ error: "Not found" }, 404);
  try {
    const payload = await readPayload(c, db, project);
    return c.json({ notified: await notifyWrongFair(c, db, project, payload.bills) });
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* Void a wrongly pasted message (owner 2026-10-14: "kalau wrong … void"). The
   message is archived — the chat and the detail page already leave archived
   rows out — so it stops counting at once, and a trail row records who voided
   what. Only a chat message (action 'note') can be voided, never a system row. */
projectSalesBills.post("/:projectId/void/:activityId", async (c) => {
  const me = realUser(c);
  if (!me || !canSaveSalesReport(me)) return c.json({ error: ONLY_THREE }, 403);
  const projectId = parseProjectId(c);
  const activityId = Number(c.req.param("activityId"));
  if (projectId == null || !Number.isInteger(activityId) || activityId <= 0) return c.json({ error: "invalid_id" }, 400);
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  const db = getDb(c.env);
  const project = await loadProject(db, projectId, company.companyId);
  if (!project) return c.json({ error: "Not found" }, 404);
  const voided = await db
    .update(project_activity)
    .set({ archived_at: sql`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')` })
    .where(and(
      eq(project_activity.id, activityId),
      eq(project_activity.project_id, project.id),
      eq(project_activity.action, "note"),
      isNull(project_activity.archived_at),
    ))
    .returning({ id: project_activity.id, note: project_activity.note });
  if (voided.length === 0) return c.json({ error: "Not found" }, 404);
  const row = voided[0];
  const firstLine = (row.note ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  await db.insert(project_activity).values({
    project_id: project.id,
    user_id: me.id,
    action: "sales_report_voided",
    note: firstLine.slice(0, 120) || null,
  });
  return c.json({ ok: true });
});
