// ----------------------------------------------------------------------------
// eventPnlInputs.ts — what eventPnl.ts needs that the event page did not read:
// the Sales Orders opened at the fair (their total and their cost buckets) and
// the brand's rate card. The finance lines and the books are already read by
// services/projectFinanceLines.ts and are passed in.
//
// The orders are read through env.DB (the event page's own connection, which
// reaches the scm schema — scm/lib/event-books.ts reads the GL the same way).
// Cancelled orders are not sales; drafts count, as on the Sales Orders block
// beside the P&L ("Opened" — routes/project-sales-orders.ts), so the two never
// disagree about how much was opened. The order's total is the same rule that
// block prints (scm/shared/so-outstanding.ts::soDisplayTotalSen).
//
// Best-effort: an unreadable order list or rate card yields NO P&L rather than
// one built on a guess — the page then shows its typed figures as before.
// ----------------------------------------------------------------------------

import type { Env } from "../types";
import { soDisplayTotalSen, soPaidInputsOf } from "../scm/shared/so-outstanding";
import { eventPnl, type CostRate, type EventPnl, type PnlLine, type SoTotals } from "./eventPnl";

const n = (v: unknown): number => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(x) ? x : 0;
};

/** Several fairs' opened orders at once, in RM, by event — the one read the
 *  event page (one id) and the Projects list (a page of ids) share. Throws on a
 *  failed read. A fair with no order is absent from the map. */
export async function loadFairSoTotalsMany(env: Env, projectIds: readonly number[], companyId: number | null): Promise<Map<number, SoTotals>> {
  const out = new Map<number, SoTotals>();
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return out;
  const res = await env.DB.prepare(
    `SELECT project_id, local_total_sen, total_revenue_sen, mattress_sofa_cost_sen, bedframe_cost_sen,
            accessories_cost_sen, others_cost_sen
       FROM scm.mfg_sales_orders
      WHERE project_id IN (${ids.map(() => "?").join(", ")}) AND status <> 'CANCELLED'${companyId != null ? " AND company_id = ?" : ""}`,
  ).bind(...ids, ...(companyId != null ? [companyId] : [])).all<Record<string, unknown>>();
  for (const r of res.results ?? []) {
    const id = n(r.project_id);
    const t = out.get(id) ?? { count: 0, salesRm: 0, costRm: { mattSofa: 0, bedframe: 0, accessories: 0, others: 0 } };
    t.count += 1;
    t.salesRm += soDisplayTotalSen(soPaidInputsOf({ local_total_sen: n(r.local_total_sen), total_revenue_sen: n(r.total_revenue_sen) }, 0, false)) / 100;
    t.costRm.mattSofa += n(r.mattress_sofa_cost_sen) / 100;
    t.costRm.bedframe += n(r.bedframe_cost_sen) / 100;
    t.costRm.accessories += n(r.accessories_cost_sen) / 100;
    t.costRm.others += n(r.others_cost_sen) / 100;
    out.set(id, t);
  }
  return out;
}

/** The fair's opened orders, in RM. Throws on a failed read. */
export async function loadFairSoTotals(env: Env, projectId: number, companyId: number | null): Promise<SoTotals> {
  return (await loadFairSoTotalsMany(env, [projectId], companyId)).get(projectId)
    ?? { count: 0, salesRm: 0, costRm: { mattSofa: 0, bedframe: 0, accessories: 0, others: 0 } };
}

/** Several brands' rate cards, by brand. Throws on a failed read. */
export async function loadCostRates(env: Env, brands: ReadonlyArray<string | null | undefined>): Promise<Map<string, CostRate>> {
  const out = new Map<string, CostRate>();
  const list = [...new Set(brands.map((b) => (b ?? "").trim()).filter(Boolean))];
  if (list.length === 0) return out;
  const res = await env.DB.prepare(
    `SELECT brand, transport_pct, merchandise_pct, commission_normal_pct, commission_boost_pct, boost_min_gp_pct, boost_min_sales
       FROM project_cost_rates WHERE brand IN (${list.map(() => "?").join(", ")})`,
  ).bind(...list).all<Record<string, unknown>>();
  const opt = (v: unknown) => (v == null ? null : n(v));
  for (const r of res.results ?? []) {
    out.set(String(r.brand ?? "").trim(), {
      transport_pct: n(r.transport_pct),
      merchandise_pct: n(r.merchandise_pct),
      commission_normal_pct: n(r.commission_normal_pct),
      commission_boost_pct: opt(r.commission_boost_pct),
      boost_min_gp_pct: opt(r.boost_min_gp_pct),
      boost_min_sales: opt(r.boost_min_sales),
    });
  }
  return out;
}

/** The brand's rate card, or null when it has none. Throws on a failed read. */
export async function loadCostRate(env: Env, brand: string | null | undefined): Promise<CostRate | null> {
  return (await loadCostRates(env, [brand])).get((brand ?? "").trim()) ?? null;
}

/** The event's two P&Ls, or null when its orders or rate card could not be read. */
export async function loadEventPnl(
  env: Env,
  project: { id: number; brand: string | null | undefined; companyId: number | null },
  lines: readonly PnlLine[],
  booksRows: readonly string[],
  lumpSales: number | null,
): Promise<EventPnl | null> {
  try {
    const [so, rate] = await Promise.all([
      loadFairSoTotals(env, project.id, project.companyId),
      loadCostRate(env, project.brand),
    ]);
    return eventPnl({ lines, booksRows: new Set(booksRows), lumpSales, so, rate });
  } catch {
    return null;
  }
}
