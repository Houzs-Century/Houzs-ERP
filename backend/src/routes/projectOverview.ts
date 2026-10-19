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
import { chunkIn } from "../scm/lib/paginate-all";
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
};

projectOverview.get("/", async (c) => {
  const COGS = "('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')";
  const sum = (where: string) =>
    `COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND ${where}), 0)`;
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.organizer, p.venue, p.state, p.stage, p.start_date, p.end_date,
            et.name AS event_type,
            ${sum("l.kind = 'income'")} AS income,
            ${sum(`l.kind = 'cost' AND l.category IN ${COGS}`)} AS cogs,
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

  const sos = await chunkIn<{ project_id: number; local_total_sen: number | null; total_cost_sen: number | null }>(projects.map((p) => String(p.id)), (b, f, t) =>
    scopeToCompany(c.get("supabase").from("mfg_sales_orders")
      .select("project_id, local_total_sen, total_cost_sen").in("project_id", b)
      .not("status", "in", '("DRAFT","CANCELLED")'), c).order("doc_no").range(f, t));
  if (sos.error) return c.json({ error: "load_failed", reason: `sales orders: ${sos.error.message}` }, 500);
  const so = new Map<number, { sen: number; costSen: number; count: number }>();
  for (const s of sos.data) {
    const k = Number(s.project_id);
    const g = so.get(k) ?? { sen: 0, costSen: 0, count: 0 };
    g.sen += Number(s.local_total_sen ?? 0); g.costSen += Number(s.total_cost_sen ?? 0); g.count += 1;
    so.set(k, g);
  }

  return c.json({
    projects: projects.map((p) => ({
      id: p.id, code: p.code, name: p.name, brand: p.brand, organizer: p.organizer, venue: p.venue, state: p.state, stage: p.stage,
      startDate: p.start_date ? String(p.start_date).slice(0, 10) : null, endDate: p.end_date ? String(p.end_date).slice(0, 10) : null,
      eventType: p.event_type,
      keyed: {
        income: Number(p.income), cogs: Number(p.cogs), rental: Number(p.rental), commission: Number(p.commission),
        setup: Number(p.setup), transport: Number(p.transport), merchandise: Number(p.merchandise), other: Number(p.other_cost),
      },
      salesOrders: so.get(p.id) ?? { sen: 0, costSen: 0, count: 0 },
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
