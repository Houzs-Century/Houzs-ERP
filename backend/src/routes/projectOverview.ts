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

/* GET /api/projects/overview/tasks — where each live event is stuck (owner,
   2026-10-17: "like the overdue production orders — which step is holding it,
   overdue against our SLA"). The SLA is each checklist task's due date: the
   event start plus the task's due-offset days set in the checklist template.
   Steps are the checklist sections (Contract, Operation, Payment, Booth layout
   & setup, Setup & dismantle documents, Expo map). Per event: the steps done
   (every task done or n/a), the first step not done ("waiting at"), and its
   tasks past their due date. Live = not cancelled and not ended more than 30
   days ago (whatever stage it was left at). A task done but still waiting for review is not done. */
/* Every live event is listed (owner: "all of them, so I can see what is overdue"). */
projectOverview.get("/tasks", async (c) => {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  const rows = await c.env.DB.prepare(
    `SELECT c.title, c.role_label, c.status, c.review_status, c.due_date,
            s.name AS section, s.sort_order,
            p.id AS project_id, p.name, p.brand, p.start_date, p.end_date
       FROM project_checklist c
       JOIN projects p ON p.id = c.project_id
       LEFT JOIN project_checklist_sections s ON s.id = c.section_id
      WHERE p.archived_at IS NULL AND p.status <> 'cancelled'
        AND substr(COALESCE(p.end_date, p.start_date), 1, 10) >= ?${activeCompanySql(c, "p.company_id")}`,
  ).bind(since).all<{ title: string; role_label: string | null; status: string; review_status: string | null; due_date: string | null; section: string | null; sort_order: number | null; project_id: number; name: string; brand: string | null; start_date: string | null; end_date: string | null }>();
  const day = (v: string | null) => (v ? String(v).slice(0, 10) : null);
  const diff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const isDone = (r: { status: string; review_status: string | null }) => r.status === "na" || (r.status === "done" && r.review_status !== "pending_review");
  const byProject = new Map<number, typeof rows.results>();
  for (const r of rows.results) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r]);
  const steps = new Map<string, number>();
  const events = [...byProject.values()].map((rs) => {
    const p = rs[0]!;
    const secs = new Map<string, { order: number; done: boolean }>();
    for (const r of rs) {
      const k = r.section ?? "Other";
      const g = secs.get(k) ?? { order: r.sort_order ?? 999, done: true };
      if (!isDone(r)) g.done = false;
      secs.set(k, g);
      if (!steps.has(k) || (r.sort_order ?? 999) < (steps.get(k) as number)) steps.set(k, r.sort_order ?? 999);
    }
    const ordered = [...secs.entries()].sort((a, b) => a[1].order - b[1].order);
    const waitingAt = ordered.find(([, g]) => !g.done)?.[0] ?? null;
    const late = rs.filter((r) => !isDone(r) && day(r.due_date) && (day(r.due_date) as string) < today)
      .map((r) => ({ title: r.title, step: r.section ?? "Other", role: r.role_label, due: day(r.due_date) as string, daysOver: diff(day(r.due_date) as string, today), waitingReview: r.status === "done" }))
      .sort((a, b) => b.daysOver - a.daysOver);
    return {
      projectId: p.project_id, project: p.name, brand: p.brand, start: day(p.start_date), end: day(p.end_date),
      stepsDone: ordered.filter(([, g]) => g.done).length, steps: ordered.length, waitingAt,
      pending: rs.filter((r) => !isDone(r)).length, late, daysOver: late[0]?.daysOver ?? 0,
    };
  }).sort((a, b) => b.daysOver - a.daysOver || String(a.start).localeCompare(String(b.start)));
  return c.json({ today, steps: [...steps.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k), events });
});
