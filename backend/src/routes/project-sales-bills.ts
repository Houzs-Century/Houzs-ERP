// ----------------------------------------------------------------------------
// project-sales-bills — the evening sales report a project keeps, bill by
// bill, and what it says is still not opened.
//
// WHY (owner 2026-10-14). Every evening the floor posts, per booth, one line
// per bill: booklet number, amount, who sold it. Until each bill is keyed into
// the Sales Order module that message is the only record of what the fair sold
// and whose it is. Pasted into the project's chat and saved here, the project
// can say — by booklet number, which is the order's Ref No. — which bills are
// still not opened, and how much of that sits with each salesperson, shown in
// red beside their name under Sales Attending.
//
//   GET    /api/project-sales-bills/:projectId            the saved bills, each
//          matched to its order, per-person and per-event totals
//   POST   /api/project-sales-bills/:projectId/preview    { text } → what a
//          paste would save, before saving it
//   POST   /api/project-sales-bills/:projectId            { text, source_activity_id? }
//          save (a booklet number pasted again updates its row)
//   DELETE /api/project-sales-bills/:projectId/:billId
//
// GATES. index.ts puts the Sales section's own read gate in front of the prefix
// (requirePageAccessOrSalesView("sales")) — every attending rep may see their
// number. Saving and deleting are for the three people the owner named
// (lib/sales-report-bills.ts canSaveSalesReport), checked here on the REAL
// caller. Company scope: the project is read inside the active company, the
// bills carry company_id, and the order read is scopeToCompany.
//
// THE MATCH is computed on every read, never stored: the orders change daily
// as the reps key them in, and a stored verdict would be stale by the morning.
// An order found under ANOTHER event is still "opened" (the bill exists in the
// system) but flagged, and on save its salesperson gets a personal notice
// asking them to amend the fair on the order — the owner's rule for a
// mis-picked fair.
// ----------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env, Variables } from "../scm/env";
import { supabaseAuth } from "../scm/middleware/auth";
import { getDb } from "../db/client";
import { projects, project_sales_attendees, sales_reps, users, project_sales_bills } from "../db/schema";
import { activeCompanyId, requireActiveCompanyId, scopeToCompany } from "../scm/lib/companyScope";
import { paginateAll, chunkIn, type PageResult } from "../scm/lib/paginate-all";
import { postPersonalNotice } from "../services/personalNotice";
import { parseSalesReport, reportDateFor } from "../scm/shared/sales-report-parse";
import {
  canSaveSalesReport,
  indexOrdersByToken,
  matchBill,
  matchBills,
  summarizeBills,
  type AttendeeRow,
  type BillRow,
  type MatchedBill,
  type OrderRow,
} from "./lib/sales-report-bills";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
type Db = ReturnType<typeof getDb>;
type ProjectRow = { id: number; name: string; start_date: string | null; end_date: string | null };

const MISMATCH_SOURCE = "sales_report_fair_mismatch";

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

async function loadBills(db: Db, projectId: number, companyId: number | undefined): Promise<BillRow[]> {
  const rows = await db
    .select()
    .from(project_sales_bills)
    .where(and(eq(project_sales_bills.project_id, projectId), companyId != null ? eq(project_sales_bills.company_id, companyId) : undefined))
    .orderBy(desc(project_sales_bills.report_date), asc(project_sales_bills.ref_token));
  return rows.map((r) => ({
    id: Number(r.id),
    ref_raw: r.ref_raw,
    ref_token: r.ref_token,
    amount_sen: Number(r.amount_sen),
    salesperson_name: r.salesperson_name ?? null,
    report_date: r.report_date ?? null,
    source_activity_id: r.source_activity_id != null ? Number(r.source_activity_id) : null,
    created_at: r.created_at,
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

async function readPayload(c: Ctx, db: Db, companyId: number | undefined, project: ProjectRow) {
  const [bills, attendees, orders] = await Promise.all([
    loadBills(db, project.id, companyId),
    loadAttendees(db, project.id),
    loadOrders(c, project),
  ]);
  const matched = matchBills(bills, project.id, orders, attendees);
  const { persons, totals } = summarizeBills(matched, attendees);
  const savedActivityIds = Array.from(new Set(bills.map((b) => b.source_activity_id).filter((v): v is number => v != null)));
  return {
    bills: matched,
    persons,
    totals,
    saved_activity_ids: savedActivityIds,
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
  const { data: staff } = await chunkIn<{ id: string; user_id: number | null }>(
    staffIds,
    (batch, a, b) => sb.from("staff").select("id, user_id").in("id", batch).range(a, b),
  );
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
  const companyId = activeCompanyId(c);
  const project = await loadProject(db, projectId, companyId);
  if (!project) return c.json({ error: "Not found" }, 404);
  try {
    return c.json(await readPayload(c, db, companyId, project));
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

projectSalesBills.post("/:projectId/preview", async (c) => {
  if (!canSaveSalesReport(realUser(c))) return c.json({ error: "Only the owner, Ummu or Wei Siang can save a sales report." }, 403);
  const projectId = parseProjectId(c);
  if (projectId == null) return c.json({ error: "invalid_project_id" }, 400);
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const db = getDb(c.env);
  const companyId = activeCompanyId(c);
  const project = await loadProject(db, projectId, companyId);
  if (!project) return c.json({ error: "Not found" }, 404);
  const parsed = parseSalesReport(body.text ?? "");
  try {
    const [existing, attendees, orders] = await Promise.all([
      loadBills(db, project.id, companyId),
      loadAttendees(db, project.id),
      loadOrders(c, project),
    ]);
    const have = new Set(existing.map((b) => b.ref_token));
    const index = indexOrdersByToken(orders);
    const bills = parsed.bills.map((b) => ({
      ...b,
      existing: have.has(b.ref_token),
      match: matchBill(b.ref_token, project.id, index),
      sales_rep_id: matchBills([{ ...b, id: 0, report_date: null, source_activity_id: null, created_at: null }], project.id, [], attendees)[0]!.sales_rep_id,
    }));
    return c.json({
      date: parsed.date,
      report_date: reportDateFor(parsed.date, project.start_date),
      total_sen: parsed.total_sen,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
      bills,
    });
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

projectSalesBills.post("/:projectId", async (c) => {
  const me = realUser(c);
  if (!canSaveSalesReport(me)) return c.json({ error: "Only the owner, Ummu or Wei Siang can save a sales report." }, 403);
  const projectId = parseProjectId(c);
  if (projectId == null) return c.json({ error: "invalid_project_id" }, 400);
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  const body = await c.req.json<{ text?: string; source_activity_id?: number | null }>().catch(() => ({} as { text?: string; source_activity_id?: number | null }));
  const parsed = parseSalesReport(body.text ?? "");
  if (parsed.bills.length === 0) return c.json({ error: "No bill lines found. A bill line reads like: 1. HC8993 RM6500 Jason" }, 400);
  const db = getDb(c.env);
  const project = await loadProject(db, projectId, company.companyId);
  if (!project) return c.json({ error: "Not found" }, 404);
  const sourceId = Number.isInteger(Number(body.source_activity_id)) && Number(body.source_activity_id) > 0 ? Number(body.source_activity_id) : null;
  const reportDate = reportDateFor(parsed.date, project.start_date);

  /* One row per booklet number per event: a re-paste updates the row. Last
     paste wins on amount and name — the evening's corrected report is the
     truer one, and the preview showed what was already there. */
  for (const b of parsed.bills) {
    await db
      .insert(project_sales_bills)
      .values({
        company_id: company.companyId,
        project_id: project.id,
        ref_token: b.ref_token,
        ref_raw: b.ref_raw,
        amount_sen: b.amount_sen,
        salesperson_name: b.salesperson_name,
        report_date: reportDate,
        source_activity_id: sourceId,
        created_by: me?.id ?? null,
      })
      .onConflictDoUpdate({
        target: [project_sales_bills.company_id, project_sales_bills.project_id, project_sales_bills.ref_token],
        set: {
          ref_raw: b.ref_raw,
          amount_sen: b.amount_sen,
          salesperson_name: b.salesperson_name,
          report_date: reportDate,
          source_activity_id: sourceId,
          updated_at: sql`now()`,
        },
      });
  }

  try {
    const payload = await readPayload(c, db, company.companyId, project);
    const notified = await notifyWrongFair(c, db, project, payload.bills);
    return c.json({ saved: parsed.bills.length, skipped: parsed.skipped, warnings: parsed.warnings, notified, ...payload });
  } catch (e) {
    return c.json({ error: "load_failed", reason: e instanceof Error ? e.message : String(e) }, 500);
  }
});

projectSalesBills.delete("/:projectId/:billId", async (c) => {
  if (!canSaveSalesReport(realUser(c))) return c.json({ error: "Only the owner, Ummu or Wei Siang can change a sales report." }, 403);
  const projectId = parseProjectId(c);
  const billId = Number(c.req.param("billId"));
  if (projectId == null || !Number.isInteger(billId) || billId <= 0) return c.json({ error: "invalid_id" }, 400);
  const company = requireActiveCompanyId(c);
  if (!company.ok) return c.json(company.refusal, 409);
  const db = getDb(c.env);
  const gone = await db
    .delete(project_sales_bills)
    .where(and(eq(project_sales_bills.id, billId), eq(project_sales_bills.project_id, projectId), eq(project_sales_bills.company_id, company.companyId)))
    .returning({ id: project_sales_bills.id });
  if (gone.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});
