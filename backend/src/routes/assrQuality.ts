/* GET /api/assr/quality-overview?from=YYYY-MM-DD&to=YYYY-MM-DD — the top of
   Quality Overview (owner, 2026-10-17): opened / closed / ongoing in the period,
   age of the open cases, the 12-month trend with backlog, and per supplier how
   often their goods come back and how long their cases take, stage by stage.
   Arithmetic in lib/assr-quality.ts.

   Its own router, mounted before the Service Case router (whose "/:id" would
   take "quality-overview"), because routes/assr.ts sits near its size ceiling.
   Same reach as the other Quality Overview reads: service_cases.read, the
   caller's allowed companies (Service Cases are cross-company by the owner's
   2026-07-19 ruling) and the same row visibility the list applies. The goods
   received per supplier, over the same period, read the same allowed companies. */
import { Hono } from "hono";
import type { Env } from "../types";
import { requirePermission } from "../middleware/auth";
import { allowedCompaniesSql } from "../scm/lib/companyScope";
import { todayMyt } from "../scm/lib/my-time";
import { assrVisibilityScope } from "./assr";
import { qualityOverview, type QCase, type QStageRow, type QReceived } from "./lib/assr-quality";

const app = new Hono<{ Bindings: Env }>();
const ISO = /^\d{4}-\d{2}-\d{2}$/;

app.get("/", requirePermission("service_cases.read"), async (c) => {
  // company-scope: the cases read carries allowedCompaniesSql (Service Cases are cross-company by the owner's 2026-07-19 ruling); items and stage history are read only for those case ids; goods received carry allowedCompaniesSql on g.company_id.
  const today = todayMyt();
  const qf = c.req.query("from") ?? ""; const qt = c.req.query("to") ?? "";
  const from = ISO.test(qf) ? qf : `${today.slice(0, 7)}-01`;
  const to = ISO.test(qt) && qt >= from ? qt : today;
  const since = new Date(Date.parse(`${to}T00:00:00Z`) - 730 * 86400000).toISOString().slice(0, 10);
  const vis = (await assrVisibilityScope(c))("c.");
  const co = allowedCompaniesSql(c, "c.company_id");

  const rows = await c.env.DB.prepare(
    `SELECT c.id, c.stage, COALESCE(c.complained_date, c.created_at) AS opened_at, c.closed_at, c.creditor_code, c.assr_no, c.customer_name, c.complaint_issue, c.issue_category
       FROM assr_cases c
      WHERE c.archived_at IS NULL
        AND (COALESCE(c.complained_date, c.created_at) >= ? OR c.closed_at IS NULL)${co}${vis.sql}`,
  ).bind(since, ...vis.binds).all<{ id: number; stage: string; opened_at: string; closed_at: string | null; creditor_code: string | null; assr_no: string | null; customer_name: string | null; complaint_issue: string | null; issue_category: string | null }>();
  const cases: QCase[] = rows.results.map((r) => ({ id: Number(r.id), stage: String(r.stage), openedAt: String(r.opened_at), closedAt: r.closed_at ? String(r.closed_at) : null, creditor: r.creditor_code || null, assrNo: r.assr_no, customer: r.customer_name, complaint: r.complaint_issue, issueCategory: r.issue_category }));

  /* Ids are integers read from the table just above, so inlining them is safe. */
  const itemsByCase = new Map<number, number>();
  const history: QStageRow[] = [];
  for (let i = 0; i < cases.length; i += 500) {
    const ids = cases.slice(i, i + 500).map((x) => Math.trunc(x.id)).join(",");
    if (!ids) continue;
    const items = await c.env.DB.prepare(`SELECT assr_id, SUM(qty) AS qty FROM assr_items WHERE assr_id IN (${ids}) GROUP BY assr_id`).all<{ assr_id: number; qty: number | null }>();
    for (const r of items.results) itemsByCase.set(Number(r.assr_id), Number(r.qty ?? 0));
    const hist = await c.env.DB.prepare(`SELECT assr_id, stage, entered_at, exited_at, target_days FROM assr_stage_history WHERE assr_id IN (${ids})`).all<{ assr_id: number; stage: string; entered_at: string; exited_at: string | null; target_days: number | null }>();
    for (const r of hist.results) history.push({ caseId: Number(r.assr_id), stage: String(r.stage), enteredAt: String(r.entered_at), exitedAt: r.exited_at ? String(r.exited_at) : null, targetDays: r.target_days == null ? null : Number(r.target_days) });
  }

  const recv = await c.env.DB.prepare(
    `SELECT s.code AS code, s.name AS name, substr(CAST(g.received_at AS TEXT), 1, 7) AS month, SUM(gi.qty_received) AS qty, COUNT(*) AS lines
       FROM scm.grn_items gi
       JOIN scm.grns g ON g.id = gi.grn_id
       JOIN scm.suppliers s ON s.id = g.supplier_id
      WHERE g.status NOT IN ('DRAFT','CANCELLED')
        AND substr(CAST(g.received_at AS TEXT), 1, 10) >= ? AND substr(CAST(g.received_at AS TEXT), 1, 10) <= ?${allowedCompaniesSql(c, "g.company_id")}
      GROUP BY s.code, s.name, substr(CAST(g.received_at AS TEXT), 1, 7)`,
  ).bind(from, to).all<{ code: string | null; name: string | null; month: string | null; qty: number | null; lines: number | null }>();
  const received: QReceived[] = recv.results.filter((r) => r.code).map((r) => ({ creditor: String(r.code), name: String(r.name ?? r.code), month: String(r.month ?? ''), qty: Number(r.qty ?? 0), lines: Number(r.lines ?? 0) }));

  const creditors = await c.env.DB.prepare(`SELECT creditor_code, company_name FROM creditors`).all<{ creditor_code: string; company_name: string | null }>();
  const names = new Map(creditors.results.filter((r) => r.company_name).map((r) => [String(r.creditor_code), String(r.company_name)]));

  return c.json({ from, to, ...qualityOverview(cases, itemsByCase, history, received, from, to, today, names) });
});

export default app;
