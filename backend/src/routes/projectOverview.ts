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
