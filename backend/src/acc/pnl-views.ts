// ----------------------------------------------------------------------------
// pnl-views — the Overall P&L's views side by side (owner 2026-11-25: 一张表并排,
// Actual | Performance | Forecast): the Performance P&L and the Forecast P&L
// laid on the P&L's OWN tree, so a row is the same row in every column (an
// account's row id is its code on every tree; a category's is the layout's).
// The P&L itself (Actual, the books) is buildPnl's, unchanged.
//
//   · Performance: its sales by product group on the group's bound sales
//     account (scm.acc_item_group_accounts.sales_account, the group's code in
//     any case; an unbound group under Unassigned); its cost of sales as ONE
//     line — the cost of the goods on the orders, which no ledger account
//     carries, so it never stands on a purchase account's row; its other
//     income and expenses as its own report has them (the operating expense
//     at its rate under the account it replaces, the commission at the bills).
//     No taxation.
//   · Forecast: each account's forecast added up over the months, on the
//     account's row; the totals the months' own.
//
// Pure: the route (scm/routes/accounting-pnl-views.ts) reads, this lays.
// ----------------------------------------------------------------------------

import type { ForecastFigures } from '../scm/shared/forecast-pnl';
import { performanceExpenseLines, type PerformanceReport } from './performance-pnl';
import { layOutBlock, type LaidLine, type LaidNode, type Layout } from './report-layout';

export type PnlViewBlock = 'tradingIncome' | 'costOfSales' | 'otherIncome' | 'expenses' | 'taxation';

export type PnlViewTotals = {
  tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number;
  expensesSen: number; profitBeforeTaxSen: number; taxationSen: number; netProfitSen: number;
};

/** One view on the P&L's tree — the shape the P&L screen prints from (report-monthly pnlLines). */
export type PnlViewSide = {
  layout: { baseSen: number | null } & Record<PnlViewBlock, LaidNode[]>;
  taxation: LaidLine[];
  totals: PnlViewTotals;
};

/** The row the Performance P&L's cost of sales stands on. */
export const ORDERS_COST_ID = 'acc:orders-cost';
export const ORDERS_COST_LABEL = 'Cost of the goods on the orders';

const pctOf = (sen: number, baseSen: number | null): number | null =>
  (baseSen === null || baseSen === 0 ? null : Math.round((sen / baseSen) * 1000) / 10);

/** Each product group's sales account, from the item groups' bindings, the group's code in any case. */
export function salesAccountOfGroup(bindings: ReadonlyArray<{ group_code: string; sales_account: string | null }>): (group: string) => string | null {
  const byGroup = new Map<string, string>();
  for (const b of bindings) {
    const code = String(b.sales_account ?? '').trim();
    if (code) byGroup.set(b.group_code.trim().toUpperCase(), code);
  }
  return (group) => byGroup.get(group.trim().toUpperCase()) ?? null;
}

/** The Performance P&L on the P&L's tree. */
export function performanceOnPnl(
  r: PerformanceReport,
  layout: Layout,
  companyId: number,
  salesAccountOf: (group: string) => string | null,
  nameOf: (code: string) => string,
): PnlViewSide {
  const baseSen = r.totals.salesSen !== 0 ? r.totals.salesSen : null;
  const onTree = (block: PnlViewBlock, lines: LaidLine[]): LaidNode[] => layOutBlock(layout.blocks[block] ?? [], lines, companyId, baseSen);

  const sales = new Map<string, LaidLine>();
  for (const g of r.groups) {
    if (g.salesSen === 0) continue;
    const code = salesAccountOf(g.key);
    const line: LaidLine = code
      ? { code, name: nameOf(code), amountSen: 0 }
      : { code: `group:${g.key}`, name: g.label, label: `${g.label} (no sales account)`, amountSen: 0 };
    const at = sales.get(line.code) ?? line;
    at.amountSen += g.salesSen;
    sales.set(line.code, at);
  }
  const cost: LaidNode[] = r.totals.cogsSen !== 0 || r.totals.salesSen !== 0
    ? [{ kind: 'account', id: ORDERS_COST_ID, label: ORDERS_COST_LABEL, amountSen: r.totals.cogsSen, pct: pctOf(r.totals.cogsSen, baseSen), children: [] }]
    : [];
  const expensesSen = r.operatingExpense.amountSen + r.otherExpensesSen;
  return {
    layout: {
      baseSen,
      tradingIncome: onTree('tradingIncome', [...sales.values()]),
      costOfSales: cost,
      otherIncome: onTree('otherIncome', r.otherIncome),
      expenses: onTree('expenses', performanceExpenseLines(r)),
      taxation: [],
    },
    taxation: [],
    totals: {
      tradingIncomeSen: r.totals.salesSen, costOfSalesSen: r.totals.cogsSen, grossProfitSen: r.totals.gpSen,
      otherIncomeSen: r.otherIncomeSen, expensesSen, profitBeforeTaxSen: r.netSen, taxationSen: 0, netProfitSen: r.netSen,
    },
  };
}

/** The Forecast P&L over its months on the P&L's tree; null when no month has a forecast. */
export function forecastOnPnl(months: readonly ForecastFigures[], layout: Layout, companyId: number): PnlViewSide | null {
  if (months.length === 0) return null;
  const byCode = new Map<string, LaidLine & { block: PnlViewBlock }>();
  for (const m of months) {
    for (const l of m.lines) {
      const at = byCode.get(l.code) ?? { code: l.code, name: l.name, amountSen: 0, block: l.block };
      at.amountSen += l.amountSen;
      byCode.set(l.code, at);
    }
  }
  const linesOf = (block: PnlViewBlock): LaidLine[] =>
    [...byCode.values()].filter((l) => l.block === block && l.amountSen !== 0).map(({ code, name, amountSen }) => ({ code, name, amountSen }));
  const sum = (key: keyof PnlViewTotals): number => months.reduce((s, m) => s + m.totals[key], 0);
  const totals: PnlViewTotals = {
    tradingIncomeSen: sum('tradingIncomeSen'), costOfSalesSen: sum('costOfSalesSen'), grossProfitSen: sum('grossProfitSen'),
    otherIncomeSen: sum('otherIncomeSen'), expensesSen: sum('expensesSen'), profitBeforeTaxSen: sum('profitBeforeTaxSen'),
    taxationSen: sum('taxationSen'), netProfitSen: sum('netProfitSen'),
  };
  const baseSen = totals.tradingIncomeSen !== 0 ? totals.tradingIncomeSen : null;
  const onTree = (block: PnlViewBlock): LaidNode[] => layOutBlock(layout.blocks[block] ?? [], linesOf(block), companyId, baseSen);
  return {
    layout: {
      baseSen,
      tradingIncome: onTree('tradingIncome'), costOfSales: onTree('costOfSales'), otherIncome: onTree('otherIncome'),
      expenses: onTree('expenses'), taxation: onTree('taxation'),
    },
    taxation: linesOf('taxation'),
    totals,
  };
}
