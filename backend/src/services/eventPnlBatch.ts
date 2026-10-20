// ----------------------------------------------------------------------------
// eventPnlBatch.ts — the event page's P&L (services/eventPnl.ts) for a PAGE of
// events at once, so the Projects list's finance columns read the same figures
// the event page shows (owner 2026-10-19, ledger item 5: the list and the phone
// must read Finance's books too — until now the list summed the typed lines
// alone, and its Rental column read the old project_finance.rental).
//
// The same inputs as one event, read once for the whole page: the typed / auto
// lines, the sales entries, the books (scm/lib/event-books.ts), the orders and
// the rate cards. Best-effort: any failed read leaves the rows as the list's
// own SQL computed them — a list that shows the typed figures is better than
// one that shows nothing.
// ----------------------------------------------------------------------------

import type { Env } from "../types";
import { applyEventBooks, readEventBooksMany } from "../scm/lib/event-books";
import { eventPnl, type EventPnl, type PnlLine } from "./eventPnl";
import { loadCostRates, loadFairSoTotalsMany } from "./eventPnlInputs";

type LedgerRow = PnlLine & { project_id: number | string; id?: number };

/** The P&L of each event on the page, by event id. Empty on any failed read. */
export async function pnlForProjects(
  env: Env,
  rows: ReadonlyArray<{ id: number; brand?: string | null; total_sales?: number | string | null }>,
  companyId: number | null,
  costCategories: readonly string[],
): Promise<Map<number, EventPnl>> {
  const out = new Map<number, EventPnl>();
  const ids = [...new Set(rows.map((r) => Number(r.id)).filter(Number.isInteger))];
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(", ");
  try {
    const [ledger, sales, books, so, rates] = await Promise.all([
      env.DB.prepare(
        `SELECT id, project_id, kind, category, amount, auto_source
           FROM project_finance_lines WHERE archived_at IS NULL AND project_id IN (${marks})`,
      ).bind(...ids).all<LedgerRow>(),
      env.DB.prepare(
        `SELECT project_id, amount FROM sales_entries
          WHERE archived_at IS NULL AND status != 'void' AND project_id IN (${marks})`,
      ).bind(...ids).all<{ project_id: number | string; amount: number | string }>(),
      readEventBooksMany(env.DB, ids, companyId),
      loadFairSoTotalsMany(env, ids, companyId),
      loadCostRates(env, rows.map((r) => r.brand ?? null)),
    ]);
    if (!books.ok) return out;
    const linesOf = new Map<number, PnlLine[]>();
    for (const l of ledger.results ?? []) {
      const id = Number(l.project_id);
      const list = linesOf.get(id);
      if (list) list.push(l); else linesOf.set(id, [l]);
    }
    const salesOf = new Map<number, PnlLine[]>();
    for (const s of sales.results ?? []) {
      const id = Number(s.project_id);
      const line: PnlLine = { kind: "income", category: "sales", amount: Number(s.amount), source: "sales_entry" };
      const list = salesOf.get(id);
      if (list) list.push(line); else salesOf.set(id, [line]);
    }
    for (const r of rows) {
      const id = Number(r.id);
      const applied = applyEventBooks(id, linesOf.get(id) ?? [], { ok: true, legs: books.byProject.get(id) ?? [] }, costCategories);
      out.set(id, eventPnl({
        lines: [...applied.lines, ...(salesOf.get(id) ?? [])],
        booksRows: new Set(applied.books.rows),
        lumpSales: r.total_sales == null ? null : Number(r.total_sales),
        so: so.get(id) ?? null,
        rate: rates.get((r.brand ?? "").trim()) ?? null,
      }));
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Put each row's Total Sales P&L into the list's finance columns. Rows the
 *  map does not cover keep the list's own figures. */
export function withPnlColumns<R extends Record<string, unknown> & { id: number }>(rows: R[], pnl: Map<number, EventPnl>): R[] {
  return rows.map((r) => {
    const p = pnl.get(Number(r.id))?.by_sales;
    if (!p) return r;
    return {
      ...r,
      rental: p.rental,
      fin_revenue: p.sales,
      fin_cogs: p.cogs.total,
      fin_cogs_matt_sofa: p.cogs.mattSofa,
      fin_cogs_bedframe: p.cogs.bedframe,
      fin_cogs_accessories: p.cogs.accessories,
      fin_rental: p.rental,
      fin_total_cost: p.totalCost,
    };
  });
}
