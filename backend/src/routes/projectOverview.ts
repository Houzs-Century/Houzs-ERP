/* GET /api/projects/overview — every project of the active company with what
   Project Overview needs (owner, 2026-10-17: "project 的数据都没有接起来"):
   the finance lines keyed on it (sales, COGS, rental and every other cost) and
   the Sales Orders opened at it (amount, cost, count). The page chooses, per
   project, keyed figures when they exist and the Sales Orders otherwise, and
   says which (lib/projectOverviewModel.ts in the frontend).

   Its own router, mounted at the exact path before the projects router, because
   routes/projects.ts is at its size ceiling. Gated like Project Overview:
   projects.finances page access in index.ts, then the finance-viewer rule here,
   BEFORE supabaseAuth replaces `user`. Company scope: the projects read carries
   the active-company predicate, the Sales Orders read scopeToCompany. */
import { Hono } from "hono";
import type { Env, Variables } from "../scm/env";
import type { AuthUser } from "../services/auth";
import { supabaseAuth } from "../scm/middleware/auth";
import { scopeToCompany, activeCompanySql } from "../scm/lib/companyScope";
import { chunkIn, paginateAll } from "../scm/lib/paginate-all";
import { indexOrdersByToken, matchBill, type OrderRow } from "./lib/sales-report-bills";
import { financeHiddenForUser } from "../services/pmsAccess";

export const projectOverview = new Hono<{ Bindings: Env; Variables: Variables }>();

projectOverview.use("*", async (c, next) => {
  if (financeHiddenForUser(c.get("user") as unknown as AuthUser)) {
    return c.json({ error: "You don't have permission to view financial information." }, 403);
  }
  await next();
});
projectOverview.use("*", supabaseAuth);

type ProjectRow = {
  id: number; code: string; name: string; brand: string | null; organizer: string | null; venue: string | null;
  state: string | null; stage: string | null; start_date: string | null; end_date: string | null; event_type: string | null;
  income: number; cogs: number; rental: number; commission: number; setup: number; transport: number; merchandise: number; other_cost: number;
  cogs_matt_sofa: number; cogs_bedframe: number; cogs_accessories: number; transport_fee: number; transport_setup: number;
};

projectOverview.get("/", async (c) => {
  const COGS = "('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')";
  const sum = (where: string) =>
    `COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND ${where}), 0)`;
  // company-scope: finance lines are read per project of the active company (activeCompanySql on p.company_id at the end of this statement).
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.organizer, p.venue, p.state, p.stage, p.start_date, p.end_date,
            et.name AS event_type,
            ${sum("l.kind = 'income'")} AS income,
            ${sum(`l.kind = 'cost' AND l.category IN ${COGS}`)} AS cogs,
            ${sum("l.kind = 'cost' AND l.category IN ('cogs_matt_sofa','cogs')")} AS cogs_matt_sofa,
            ${sum("l.kind = 'cost' AND l.category = 'cogs_bedframe'")} AS cogs_bedframe,
            ${sum("l.kind = 'cost' AND l.category = 'cogs_accessories'")} AS cogs_accessories,
            ${sum("l.kind = 'cost' AND l.category IN ('transport_fee','transport')")} AS transport_fee,
            ${sum("l.kind = 'cost' AND l.category = 'transport_setup_dismantle'")} AS transport_setup,
            ${sum("l.kind = 'cost' AND l.category = 'rental'")} AS rental,
            ${sum("l.kind = 'cost' AND l.category = 'commission'")} AS commission,
            ${sum("l.kind = 'cost' AND l.category = 'setup'")} AS setup,
            ${sum("l.kind = 'cost' AND l.category IN ('transport','transport_fee','transport_setup_dismantle')")} AS transport,
            ${sum("l.kind = 'cost' AND l.category = 'merchandise'")} AS merchandise,
            ${sum(`l.kind = 'cost' AND l.category NOT IN ${COGS} AND l.category NOT IN ('rental','commission','setup','transport','transport_fee','transport_setup_dismantle','merchandise')`)} AS other_cost
       FROM projects p
       LEFT JOIN project_event_types et ON et.id = p.event_type_id
      WHERE p.archived_at IS NULL${activeCompanySql(c, "p.company_id")}`,
  ).all<ProjectRow>();
  const projects = rows.results;

  const sos = await chunkIn<{ doc_no: string; project_id: number; local_total_sen: number | null; total_cost_sen: number | null }>(projects.map((p) => String(p.id)), (b, f, t) =>
    scopeToCompany(c.get("supabase").from("mfg_sales_orders")
      .select("doc_no, project_id, local_total_sen, total_cost_sen").in("project_id", b)
      .not("status", "in", '("DRAFT","CANCELLED")'), c).order("doc_no").range(f, t));
  if (sos.error) return c.json({ error: "load_failed", reason: `sales orders: ${sos.error.message}` }, 500);
  type SoCost = { sen: number; costSen: number; count: number; costSplit: { mattSofa: number; bedframe: number; accessories: number } };
  const so = new Map<number, SoCost>();
  for (const s of sos.data) {
    const k = Number(s.project_id);
    const g = so.get(k) ?? { sen: 0, costSen: 0, count: 0, costSplit: { mattSofa: 0, bedframe: 0, accessories: 0 } };
    g.sen += Number(s.local_total_sen ?? 0); g.costSen += Number(s.total_cost_sen ?? 0); g.count += 1;
    so.set(k, g);
  }
  /* An event with no COGS keyed takes its COGS from its Sales Orders; split that
     cost by the line's product group into the Financial Snapshot's three COGS
     lines (owner 2026-10-19: "确保这些是 breakdown"). Only those events' lines
     are read, not every order ever opened at an event. */
  const noCogs = new Set(projects.filter((p) => !(Number(p.cogs) > 0)).map((p) => p.id));
  const projectOfDoc = new Map(sos.data.filter((s) => noCogs.has(Number(s.project_id))).map((s) => [s.doc_no, Number(s.project_id)]));
  if (projectOfDoc.size > 0) {
    const items = await chunkIn<{ doc_no: string; item_group: string | null; line_cost_sen: number | null }>([...projectOfDoc.keys()], (b, f, t) =>
      scopeToCompany(c.get("supabase").from("mfg_sales_order_items")
        .select("doc_no, item_group, line_cost_sen").in("doc_no", b).eq("cancelled", false), c).order("id").range(f, t));
    if (items.error) return c.json({ error: "load_failed", reason: `sales order lines: ${items.error.message}` }, 500);
    for (const it of items.data) {
      const g = so.get(projectOfDoc.get(it.doc_no) ?? -1);
      if (!g) continue;
      const grp = (it.item_group ?? "").toLowerCase();
      const key = grp === "mattress" || grp === "sofa" ? "mattSofa" : grp === "bedframe" ? "bedframe" : "accessories";
      g.costSplit[key] += Number(it.line_cost_sen ?? 0);
    }
  }

  /* Is the event's Sales Orders daily? (owner 2026-10-19) Its chat sales report
     against the orders, by the event page's own rule (lib/sales-report-bills.ts):
     every bill opened as an order under this event = daily. */
  // company-scope: the saved report bills carry activeCompanySql on b.company_id.
  const billRows = await c.env.DB.prepare(
    `SELECT b.project_id, b.ref_token, b.amount_sen FROM project_sales_bills b WHERE 1 = 1${activeCompanySql(c, "b.company_id")}`,
  ).all<{ project_id: number; ref_token: string; amount_sen: number }>();
  const billsOf = new Map<number, Array<{ ref_token: string; amount_sen: number }>>();
  for (const b of billRows.results) billsOf.set(Number(b.project_id), [...(billsOf.get(Number(b.project_id)) ?? []), b]);
  const withBills = projects.filter((p) => billsOf.has(p.id));
  const report = new Map<number, { bills: number; billsSen: number; opened: number; openedSen: number; otherEvent: number }>();
  if (withBills.length > 0) {
    const starts = withBills.map((p) => String(p.start_date ?? "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const from = new Date(Date.parse(`${starts[0] ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
    const orders = await paginateAll<OrderRow>((f, t) => scopeToCompany(c.get("supabase").from("mfg_sales_orders")
      .select("doc_no, project_id, status, customer_so_no, ref, salesperson_id, local_total_sen, total_revenue_sen")
      .neq("status", "CANCELLED").gte("so_date", from), c).order("doc_no").range(f, t));
    if (orders.error) return c.json({ error: "load_failed", reason: `orders for the sales report: ${orders.error.message}` }, 500);
    const index = indexOrdersByToken(orders.data ?? []);
    for (const p of withBills) {
      const r = { bills: 0, billsSen: 0, opened: 0, openedSen: 0, otherEvent: 0 };
      for (const b of billsOf.get(p.id) ?? []) {
        const m = matchBill(b.ref_token, p.id, index);
        r.bills += 1; r.billsSen += Number(b.amount_sen);
        if (m.status === "opened" && !m.other_event) { r.opened += 1; r.openedSen += Number(b.amount_sen); }
        if (m.other_event) r.otherEvent += 1;
      }
      report.set(p.id, r);
    }
  }

  return c.json({
    projects: projects.map((p) => ({
      id: p.id, code: p.code, name: p.name, brand: p.brand, organizer: p.organizer, venue: p.venue, state: p.state, stage: p.stage,
      startDate: p.start_date ? String(p.start_date).slice(0, 10) : null, endDate: p.end_date ? String(p.end_date).slice(0, 10) : null,
      eventType: p.event_type,
      keyed: {
        income: Number(p.income), cogs: Number(p.cogs), rental: Number(p.rental), commission: Number(p.commission),
        setup: Number(p.setup), transport: Number(p.transport), merchandise: Number(p.merchandise), other: Number(p.other_cost),
        cogsMattSofa: Number(p.cogs_matt_sofa), cogsBedframe: Number(p.cogs_bedframe), cogsAccessories: Number(p.cogs_accessories),
        transportFee: Number(p.transport_fee), transportSetup: Number(p.transport_setup),
      },
      salesOrders: so.get(p.id) ?? { sen: 0, costSen: 0, count: 0, costSplit: { mattSofa: 0, bedframe: 0, accessories: 0 } },
      chatReport: report.get(p.id) ?? null,
    })),
  });
});

/* GET /api/projects/overview/tasks — every live event with what the project
   stage tracker needs (owner, 2026-10-17: "group the events by the project
   stage, like the overdue production orders"): its checklist items and
   whether setup is arranged; the page applies the tracker's own rule
   (frontend projects/projectStage.ts) so the list and the project page agree.
   Also each task past its due date (the SLA: event start + the task's
   due-offset days in the checklist template). Live = not cancelled and not
   ended more than 30 days ago, whatever stage it was left at. */
projectOverview.get("/tasks", async (c) => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  const rows = await c.env.DB.prepare(
    `SELECT c.title, c.role_label, c.status, c.review_status, c.due_date,
            p.id AS project_id, p.name, p.brand, p.start_date, p.end_date, p.setup_crew, p.setup_start_at
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
      WHERE p.archived_at IS NULL AND p.status <> 'cancelled'
        AND substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?${activeCompanySql(c, "p.company_id")}`,
  ).bind(since).all<{ title: string; role_label: string | null; status: string; review_status: string | null; due_date: string | null; project_id: number; name: string; brand: string | null; start_date: string | null; end_date: string | null; setup_crew: string | null; setup_start_at: string | null }>();
  const day = (v: string | null) => (v ? String(v).slice(0, 10) : null);
  const diff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  /* The checklist's own "complete": done, n/a, or approved (frontend checklistDone.ts). */
  const complete = (r: { status: string; review_status: string | null }) => r.status === "done" || r.status === "na" || r.review_status === "approved";
  const byProject = new Map<number, typeof rows.results>();
  for (const r of rows.results) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
  const events = [...byProject.values()].map((rs) => {
    const p = rs[0]!;
    const late = rs.filter((r) => !complete(r) && day(r.due_date) && (day(r.due_date) as string) < today)
      .map((r) => ({ title: r.title, role: r.role_label, due: day(r.due_date) as string, daysOver: diff(day(r.due_date) as string, today) }))
      .sort((a, b) => b.daysOver - a.daysOver);
    return {
      projectId: p.project_id, project: p.name, brand: p.brand, start: day(p.start_date), end: day(p.end_date),
      setupCrew: p.setup_crew, setupStartAt: p.setup_start_at,
      items: rs.map((r) => ({ title: r.title, status: r.status, review_status: r.review_status, due: day(r.due_date) })),
      pending: rs.filter((r) => !complete(r)).length, late,
    };
  });
  return c.json({ today, events });
});
