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
import { chunkIn, paginateAll } from "../scm/lib/paginate-all";
import { collectReport, indexOrdersByToken, matchBill, type NoteRow, type OrderRow } from "./lib/sales-report-bills";
import { pnlForProjects } from "../services/eventPnlBatch";
import { LEDGER_COST_CATEGORIES } from "../services/projects";
import { activeCompanyId } from "../scm/lib/companyScope";
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
  // company-scope: finance lines are read per project of the active company (activeCompanySql on p.company_id at the end of this statement).
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.brand, p.start_date, p.end_date,
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
      WHERE p.archived_at IS NULL AND COALESCE(p.status, '') <> 'cancelled'
        AND substr(p.end_date, 1, 10) >= ? AND substr(p.end_date, 1, 10) <= ?${activeCompanySql(c, "p.company_id")}`,
  ).bind(from, to).all<Omit<GapProject, "soSen"> & { start_date: string | null; rental: number; setup: number; transport_fee: number; transport_setup: number; merchandise: number; cogs_matt_sofa: number; cogs_bedframe: number; cogs_accessories: number }>();
  const projects = rows.results;

  const ids = projects.map((p) => String(p.id));
  const sos = await chunkIn<{ doc_no: string; project_id: number; local_total_sen: number | null }>(ids, (b, f, t) =>
    scopeToCompany(c.get("supabase").from("mfg_sales_orders")
      .select("doc_no, project_id, local_total_sen").in("project_id", b)
      .not("status", "in", '("DRAFT","CANCELLED")'), c).order("doc_no").range(f, t));
  if (sos.error) return c.json({ error: "load_failed", reason: `sales orders: ${sos.error.message}` }, 500);
  const soSen = new Map<number, number>();
  for (const s of sos.data) soSen.set(Number(s.project_id), (soSen.get(Number(s.project_id)) ?? 0) + Number(s.local_total_sen ?? 0));
  const soDocs = new Map<number, string[]>();
  for (const s of sos.data) soDocs.set(Number(s.project_id), [...(soDocs.get(Number(s.project_id)) ?? []), String(s.doc_no)]);

  /* The three things that make an event's P&L read wrong (owner 2026-10-20):
     1. Sales Orders not daily - each bill of the chat sales report that is not
        opened under this event: not opened at all, or opened under another
        event (to move). Per bill, read as the event page reads it.
     2. Rental not keyed - the P&L's rental (Finance's books or a typed line).
     3. No chat sales report. */
  /* Bills not daily cover every event of the last 180 days with a report -
     running and just ended too (owner 2026-10-20: the newest fairs carry most
     of the unopened bills); rental and the report check stay on the finished
     events above. */
  const recent = todayMyt(-180);
  // company-scope: this company's live events of the last 180 days (activeCompanySql on p.company_id).
  const recentRows = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.start_date, p.end_date FROM projects p
      WHERE p.archived_at IS NULL AND COALESCE(p.status, '') <> 'cancelled'
        AND substr(COALESCE(p.start_date, p.end_date), 1, 10) >= ?${activeCompanySql(c, "p.company_id")}`,
  ).bind(recent).all<{ id: number; code: string; name: string; start_date: string | null; end_date: string | null }>();
  const eventsById = new Map<number, { id: number; code: string; name: string; start_date: string | null; end_date: string | null }>();
  for (const p of projects) eventsById.set(p.id, { id: p.id, code: p.code, name: p.name, start_date: p.start_date, end_date: p.end_date ? String(p.end_date) : null });
  for (const p of recentRows.results) eventsById.set(Number(p.id), { ...p, id: Number(p.id) });
  // company-scope: chat notes of this company's events in the window or the last 180 days (activeCompanySql on p.company_id).
  const noteRows = await c.env.DB.prepare(
    `SELECT a.id, a.project_id, a.note, a.created_at, u.email AS author_email, ps.name AS author_position
       FROM project_activity a JOIN projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN positions ps ON ps.id = u.position_id
      WHERE a.action = 'note' AND a.archived_at IS NULL
        AND (substr(COALESCE(p.start_date, p.end_date), 1, 10) >= ? OR (substr(p.end_date, 1, 10) >= ? AND substr(p.end_date, 1, 10) <= ?))${activeCompanySql(c, "p.company_id")}`,
  ).bind(recent, from, to).all<NoteRow & { project_id: number }>();
  const notesOf = new Map<number, NoteRow[]>();
  for (const n of noteRows.results) notesOf.set(Number(n.project_id), [...(notesOf.get(Number(n.project_id)) ?? []), { ...n, id: Number(n.id) }]);
  const billsOf = new Map<number, ReturnType<typeof collectReport>["bills"]>();
  for (const p of eventsById.values()) {
    const bills = notesOf.has(p.id) ? collectReport(notesOf.get(p.id)!, p.start_date ? String(p.start_date) : null).bills : [];
    if (bills.length) billsOf.set(p.id, bills);
  }
  type ProblemBill = { ref: string; amountSen: number; salesperson: string | null; problem: "not_opened" | "other_event"; soDocNo: string | null; otherEvent: string | null };
  const problems = new Map<number, ProblemBill[]>();
  if (billsOf.size > 0) {
    const starts = [...eventsById.values()].filter((p) => billsOf.has(p.id)).map((p) => String(p.start_date ?? p.end_date ?? "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const since = new Date(Date.parse(`${starts[0] ?? from}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
    const orders = await paginateAll<OrderRow>((f, t) => scopeToCompany(c.get("supabase").from("mfg_sales_orders")
      .select("doc_no, project_id, status, customer_so_no, ref, salesperson_id, local_total_sen, total_revenue_sen")
      .neq("status", "CANCELLED").gte("so_date", since), c).order("doc_no").range(f, t));
    if (orders.error) return c.json({ error: "load_failed", reason: `orders for the sales report: ${orders.error.message}` }, 500);
    const index = indexOrdersByToken(orders.data ?? []);
    const otherIds = new Set<number>();
    for (const [pid, bills] of billsOf) {
      const list: ProblemBill[] = [];
      for (const b of bills) {
        const m = matchBill(b.ref_token, pid, index);
        if (m.status === "opened" && !m.other_event) continue;
        if (m.other_event && m.so_project_id != null) otherIds.add(m.so_project_id);
        list.push({ ref: b.ref_raw || b.ref_token, amountSen: Number(b.amount_sen), salesperson: b.salesperson_name ?? null,
          problem: m.other_event ? "other_event" : "not_opened", soDocNo: m.so_doc_no, otherEvent: m.so_project_id != null ? String(m.so_project_id) : null });
      }
      if (list.length) problems.set(pid, list);
    }
    if (otherIds.size) {
      // company-scope: names of this company's events the bills were opened under.
      const names = await c.env.DB.prepare(
        `SELECT p.id, p.name FROM projects p WHERE p.id IN (${[...otherIds].map(() => "?").join(", ")})${activeCompanySql(c, "p.company_id")}`,
      ).bind(...otherIds).all<{ id: number; name: string }>();
      const nameOf = new Map(names.results.map((r) => [String(r.id), r.name]));
      for (const list of problems.values()) for (const b of list) if (b.otherEvent) b.otherEvent = nameOf.get(b.otherEvent) ?? b.otherEvent;
    }
  }
  const pnls = await pnlForProjects(c.env as unknown as Parameters<typeof pnlForProjects>[0], projects.map((p) => ({ id: p.id, brand: p.brand })), activeCompanyId(c) ?? null, LEDGER_COST_CATEGORIES);

  const books = projects.map((p) => ({
    hasReport: billsOf.has(p.id),
    reportBills: billsOf.get(p.id)?.length ?? 0,
    problemBills: problems.get(p.id) ?? [],
    rental: pnls.get(p.id)?.by_sales.rental ?? Number(p.rental),
    id: p.id, code: p.code, name: p.name, brand: p.brand, endDate: String(p.end_date ?? "").slice(0, 10), soSen: soSen.get(p.id) ?? 0,
    soDocs: soDocs.get(p.id) ?? [],
    lines: {
      sales: Number(p.income), cogs: Number(p.cogs),
      cogsMattSofa: Number(p.cogs_matt_sofa), cogsBedframe: Number(p.cogs_bedframe), cogsAccessories: Number(p.cogs_accessories), rental: Number(p.rental), setup: Number(p.setup), transportFee: Number(p.transport_fee),
      transportSetup: Number(p.transport_setup), commission: Number(p.commission), merchandise: Number(p.merchandise),
    },
  })).sort((a, b) => b.endDate.localeCompare(a.endDate));
  const notDaily = [...problems.entries()].map(([id, bills]) => {
    const e = eventsById.get(id)!;
    return { id, code: e.code, name: e.name, startDate: String(e.start_date ?? "").slice(0, 10), endDate: String(e.end_date ?? "").slice(0, 10), reportBills: billsOf.get(id)?.length ?? 0, bills };
  }).sort((a, b) => b.endDate.localeCompare(a.endDate));
  return c.json({ from, to, books, notDaily, recentFrom: recent, ...classifyProjectGaps(projects.map((p) => ({ ...p, soSen: soSen.get(p.id) ?? 0 }))) });
});
