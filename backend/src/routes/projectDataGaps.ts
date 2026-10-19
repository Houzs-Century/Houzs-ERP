/* GET /api/projects/data-gaps — finished events whose books are incomplete
   (owner, 2026-10-17: the overviews should show management where the business,
   and its data, has a problem).

   An event that ended at least 3 days ago and is at most 120 days old is
   checked for the three lines every settled fair carries: sales, COGS and
   commission. An event with none of its sales keyed in reads as a pure loss on
   Project Overview, so the Sales Orders opened at it are returned alongside as
   the size of what is missing.

   Its own router, mounted at the exact path before the projects router (whose
   "/:id" would swallow "data-gaps"), because routes/projects.ts is at its size
   ceiling. Gated like Project Overview: projects.finances page access in
   index.ts, then the finance-viewer rule here, BEFORE supabaseAuth replaces
   `user` with the scm identity. Company scope: the projects read carries the
   active-company predicate, the Sales Orders read scopeToCompany. */
import { Hono } from "hono";
import type { Env, Variables } from "../scm/env";
import type { AuthUser } from "../services/auth";
import { supabaseAuth } from "../scm/middleware/auth";
import { scopeToCompany, activeCompanySql } from "../scm/lib/companyScope";
import { chunkIn } from "../scm/lib/paginate-all";
import { todayMyt } from "../scm/lib/my-time";
import { financeHiddenForUser } from "../services/pmsAccess";
import { classifyProjectGaps, type GapProject } from "../scm/lib/project-data-gaps";

export const projectDataGaps = new Hono<{ Bindings: Env; Variables: Variables }>();

projectDataGaps.use("*", async (c, next) => {
  if (financeHiddenForUser(c.get("user") as unknown as AuthUser)) {
    return c.json({ error: "You don't have permission to view financial information." }, 403);
  }
  await next();
});
projectDataGaps.use("*", supabaseAuth);

projectDataGaps.get("/", async (c) => {
  const from = todayMyt(-120);
  const to = todayMyt(-3);
  const COGS = "('cogs','cogs_matt_sofa','cogs_bedframe','cogs_accessories')";
  const sum = (where: string) =>
    `COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND ${where}), 0)`;
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.end_date,
            ${sum("l.kind = 'income'")} AS income,
            ${sum(`l.kind = 'cost' AND l.category IN ${COGS}`)} AS cogs,
            ${sum("l.kind = 'cost' AND l.category = 'commission'")} AS commission,
            ${sum("l.kind = 'cost'")} AS cost,
            ${sum("l.kind = 'cost' AND l.category = 'rental'")} AS rental,
            ${sum("l.kind = 'cost' AND l.category = 'setup'")} AS setup,
            ${sum("l.kind = 'cost' AND l.category IN ('transport_fee','transport')")} AS transport_fee,
            ${sum("l.kind = 'cost' AND l.category = 'transport_setup_dismantle'")} AS transport_setup,
            ${sum("l.kind = 'cost' AND l.category = 'merchandise'")} AS merchandise,
            ${sum("l.kind = 'cost' AND l.category IN ('cogs_matt_sofa','cogs')")} AS cogs_matt_sofa,
            ${sum("l.kind = 'cost' AND l.category = 'cogs_bedframe'")} AS cogs_bedframe,
            ${sum("l.kind = 'cost' AND l.category = 'cogs_accessories'")} AS cogs_accessories
       FROM projects p
      WHERE p.archived_at IS NULL
        AND substr(p.end_date, 1, 10) >= ? AND substr(p.end_date, 1, 10) <= ?${activeCompanySql(c, "p.company_id")}`,
  ).bind(from, to).all<Omit<GapProject, "soSen"> & { rental: number; setup: number; transport_fee: number; transport_setup: number; merchandise: number; cogs_matt_sofa: number; cogs_bedframe: number; cogs_accessories: number }>();
  const projects = rows.results;

  const ids = projects.map((p) => String(p.id));
  const sos = await chunkIn<{ project_id: number; local_total_sen: number | null }>(ids, (b, f, t) =>
    scopeToCompany(c.get("supabase").from("mfg_sales_orders")
      .select("project_id, local_total_sen").in("project_id", b)
      .not("status", "in", '("DRAFT","CANCELLED")'), c).order("doc_no").range(f, t));
  if (sos.error) return c.json({ error: "load_failed", reason: `sales orders: ${sos.error.message}` }, 500);
  const soSen = new Map<number, number>();
  for (const s of sos.data) soSen.set(Number(s.project_id), (soSen.get(Number(s.project_id)) ?? 0) + Number(s.local_total_sen ?? 0));

  /* Each event's books line by line (owner 2026-10-19: "which costing is not
     complete" — the data problem, under the process problem above). A line is
     complete when something is keyed on it. */
  const books = projects.map((p) => ({
    id: p.id, name: p.name, brand: p.brand, endDate: String(p.end_date ?? "").slice(0, 10), soSen: soSen.get(p.id) ?? 0,
    lines: {
      sales: Number(p.income), cogs: Number(p.cogs),
      cogsMattSofa: Number(p.cogs_matt_sofa), cogsBedframe: Number(p.cogs_bedframe), cogsAccessories: Number(p.cogs_accessories), rental: Number(p.rental), setup: Number(p.setup), transportFee: Number(p.transport_fee),
      transportSetup: Number(p.transport_setup), commission: Number(p.commission), merchandise: Number(p.merchandise),
    },
  })).sort((a, b) => b.endDate.localeCompare(a.endDate));
  return c.json({ from, to, books, ...classifyProjectGaps(projects.map((p) => ({ ...p, soSen: soSen.get(p.id) ?? 0 }))) });
});
