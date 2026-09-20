// ----------------------------------------------------------------------------
// report-monthly — a Finance report month by month (owner 2026-09-14, docs/bugs/0916:
// 我还有就是能看每个月的 … his sample: 累计 leftmost, then the newest month on the
// left and older months to the right, a % toggle). Every report page already
// draws ONE period on its layout; the monthly view asks the same endpoint once
// per column — the cumulative range first, then each month — and lays the
// answers side by side. Nothing new is computed here: a column IS the report
// for that period, so a month's figure can never disagree with the single-
// period screen for the same month. The balance sheet has no cumulative
// column: a month's column is the balance as at that month's end.
//
// A column's tree may differ from the next (a category prints only when
// something under it did), so the columns are MERGED by line id: the union
// of every column's lines, each kept where its own column had it, a cell
// left empty where a column never printed the line.
// ----------------------------------------------------------------------------

import type { LaidNode } from './report-layout';
import { flattenLaid } from './report-layout';

/** One line of a report as one column printed it. */
export type FlatLine = {
  id: string;
  label: string;
  kind: 'block' | 'category' | 'row' | 'unassigned' | 'total' | 'net';
  depth: number;
  amountSen: number;
  pct: number | null;
  /** An account row's code — what its lines are read by. */
  code?: string;
};

export type MonthlyCell = { amountSen: number; pct: number | null };
export type MonthlyLine = Omit<FlatLine, 'amountSen' | 'pct'> & { cells: Partial<Record<string, MonthlyCell>> };

export type MonthColumn = { key: string; label: string; from: string; to: string; cumulative: boolean };

/* ── Months ──────────────────────────────────────────────────────────────── */

const pad = (n: number): string => String(n).padStart(2, '0');

/** The last day of a month, YYYY-MM → YYYY-MM-DD. */
export const monthEnd = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${pad(last)}`;
};
export const monthStartOf = (ym: string): string => `${ym}-01`;

/** The month `back` months before `ym` (0 = itself). */
export const monthBefore = (ym: string, back: number): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

/** `count` months ending at `latest`, NEWEST FIRST — the owner's column order. */
export const monthsBack = (latest: string, count: number): string[] =>
  Array.from({ length: Math.max(1, count) }, (_, i) => monthBefore(latest, i));

/** A month as the app writes dates — MM/YYYY (no month names on the desktop
    app, the owner's own rule; dd/mm/yyyy everywhere else). */
export const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-');
  return y && m ? `${m}/${y}` : ym;
};

/** The columns of a monthly view: the cumulative range first (unless the
    report has none — the balance sheet), then the months newest → oldest. */
export const monthColumns = (latest: string, count: number, withCumulative: boolean): MonthColumn[] => {
  const months = monthsBack(latest, count);
  const oldest = months[months.length - 1]!;
  const cols: MonthColumn[] = months.map((ym) => ({ key: ym, label: monthLabel(ym), from: monthStartOf(ym), to: monthEnd(ym), cumulative: false }));
  if (withCumulative) {
    cols.unshift({ key: 'cumulative', label: `累计 ${monthLabel(oldest)} – ${monthLabel(latest)}`, from: monthStartOf(oldest), to: monthEnd(latest), cumulative: true });
  }
  return cols;
};

/* ── Lines ───────────────────────────────────────────────────────────────── */

/** A laid tree as flat lines, one level below `depth` — the tree's own ids. */
export const treeLines = (nodes: LaidNode[], depth = 1): FlatLine[] =>
  flattenLaid(nodes, depth).map(({ node, depth: d }) => ({
    id: node.id, label: node.label, kind: node.kind === 'account' ? 'row' : node.kind === 'subtotal' ? 'net' : node.kind, depth: d, amountSen: node.amountSen, pct: node.pct,
    ...(node.code ? { code: node.code } : {}),
  }));

export const fixedLine = (id: string, label: string, kind: FlatLine['kind'], amountSen: number, pct: number | null): FlatLine =>
  ({ id, label, kind, depth: 0, amountSen, pct });

/**
 * Merge the columns' lines into one list: the union by id, every line kept
 * where its own column first had it. The spine is the first column (the
 * cumulative range, which carries whatever any month carried unless it
 * cancelled out); a line another column has and the spine lacks is placed
 * right after the nearest line before it that the merged list already holds.
 */
export function mergeColumns(columns: Array<{ key: string; lines: FlatLine[] }>): MonthlyLine[] {
  const out: MonthlyLine[] = [];
  const at = new Map<string, MonthlyLine>();
  for (const col of columns) {
    let prevId: string | null = null;
    for (const l of col.lines) {
      let line = at.get(l.id);
      if (!line) {
        line = { id: l.id, label: l.label, kind: l.kind, depth: l.depth, cells: {}, ...(l.code ? { code: l.code } : {}) };
        at.set(l.id, line);
        const after = prevId ? out.findIndex((x) => x.id === prevId) : -1;
        out.splice(after + 1, 0, line);
      }
      line.cells[col.key] = { amountSen: l.amountSen, pct: l.pct };
      prevId = l.id;
    }
  }
  return out;
}

/** The lines a level shows: a line prints while its depth is within the
    level; the fixed lines (depth 0) always do. */
export const monthlyLinesAtLevel = (lines: MonthlyLine[], level: number | 'all'): MonthlyLine[] =>
  level === 'all' ? lines : lines.filter((l) => l.depth <= level);

export const monthlyDepth = (lines: MonthlyLine[]): number => lines.reduce((d, l) => Math.max(d, l.depth), 0);

/* ── Each report as lines ─────────────────────────────────────────────────── */

type PnlLike = {
  layout: { baseSen: number | null; tradingIncome: LaidNode[]; costOfSales: LaidNode[]; otherIncome: LaidNode[]; expenses: LaidNode[]; taxation: LaidNode[] };
  taxation?: unknown[];
  totals: { tradingIncomeSen: number; costOfSalesSen: number; grossProfitSen: number; otherIncomeSen: number; expensesSen: number; profitBeforeTaxSen?: number; taxationSen?: number; netProfitSen: number };
};

const pctOfBase = (sen: number, base: number | null): number | null => (base === null || base === 0 ? null : Math.round((sen / base) * 1000) / 10);

/** The P&L as the screen prints it: block, its tree, its total; gross; … net. */
export const pnlLines = (r: PnlLike): FlatLine[] => {
  const b = r.layout.baseSen;
  const block = (key: string, title: string, nodes: LaidNode[], totalLabel: string, totalSen: number): FlatLine[] => [
    fixedLine(`blk:${key}`, title, 'block', 0, null),
    ...treeLines(nodes),
    fixedLine(`tot:${key}`, totalLabel, 'total', totalSen, pctOfBase(totalSen, b)),
  ];
  const t = r.totals;
  return [
    ...block('tradingIncome', 'Trading income', r.layout.tradingIncome, 'Total income', t.tradingIncomeSen),
    ...block('costOfSales', 'Cost of sales', r.layout.costOfSales, 'Total cost of sales', t.costOfSalesSen),
    fixedLine('net:gross', 'GROSS PROFIT', 'net', t.grossProfitSen, pctOfBase(t.grossProfitSen, b)),
    ...block('otherIncome', 'Other income', r.layout.otherIncome, 'Total other income', t.otherIncomeSen),
    ...block('expenses', 'Expenses', r.layout.expenses, 'Total expenses', t.expensesSen),
    ...((r.taxation?.length ?? 0) > 0 ? [
      fixedLine('net:pbt', 'PROFIT BEFORE TAX', 'net', t.profitBeforeTaxSen ?? t.netProfitSen, pctOfBase(t.profitBeforeTaxSen ?? t.netProfitSen, b)),
      ...block('taxation', 'Taxation', r.layout.taxation, 'Total taxation', t.taxationSen ?? 0),
    ] : []),
    fixedLine('net:net', 'NET PROFIT', 'net', t.netProfitSen, pctOfBase(t.netProfitSen, b)),
  ];
};

type BsLike = {
  layout: { baseSen: number | null; assets: LaidNode[]; liabilities: LaidNode[]; equity: LaidNode[] };
  totals: { assetsSen: number; liabilitiesSen: number; equitySen: number; earningsSen: number; checkSen: number };
};

/** The balance sheet as the screen prints it — every % of that column's total assets. */
export const balanceSheetLines = (r: BsLike): FlatLine[] => {
  const b = r.layout.baseSen;
  const block = (key: string, title: string, nodes: LaidNode[], totalLabel: string, totalSen: number): FlatLine[] => [
    fixedLine(`blk:${key}`, title, 'block', 0, null),
    ...treeLines(nodes),
    fixedLine(`tot:${key}`, totalLabel, 'total', totalSen, pctOfBase(totalSen, b)),
  ];
  const t = r.totals;
  return [
    ...block('assets', 'Assets', r.layout.assets, 'Total assets', t.assetsSen),
    ...block('liabilities', 'Liabilities', r.layout.liabilities, 'Total liabilities', t.liabilitiesSen),
    ...block('equity', 'Equity', r.layout.equity, 'Total equity', t.equitySen),
    fixedLine('row:earnings', 'Current period earnings', 'row', t.earningsSen, pctOfBase(t.earningsSen, b)),
    fixedLine('net:check', t.checkSen === 0 ? 'BALANCED' : 'OUT OF BALANCE', 'net', t.checkSen === 0 ? t.assetsSen : t.checkSen, t.checkSen === 0 ? pctOfBase(t.assetsSen, b) : null),
  ];
};

type PerfLike = {
  groups: Array<{ key: string; label: string; salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null }>;
  totals: { salesSen: number; cogsSen: number; gpSen: number; gpPct: number | null };
};
export type PerfSummaryLike = { id?: string; kind: 'total' | 'category' | 'row' | 'net'; label: string; amountSen: number; pct: number | null; depth: number };

/** The Performance P&L as lines: sales per group, cost per group, gross
    profit per group (each with its total), then the summary from gross
    profit to net — the same summary lines the single-period screen draws. */
export const performanceLines = (r: PerfLike, summary: PerfSummaryLike[]): FlatLine[] => {
  const base = r.totals.salesSen > 0 ? r.totals.salesSen : null;
  const per = (key: string, title: string, pick: (g: PerfLike['groups'][number]) => number, totalSen: number, pctOf: (g: PerfLike['groups'][number]) => number | null, totalPct: number | null): FlatLine[] => [
    fixedLine(`blk:${key}`, title, 'block', 0, null),
    ...r.groups.map((g): FlatLine => ({ id: `${key}:${g.key}`, label: g.label, kind: 'row', depth: 1, amountSen: pick(g), pct: pctOf(g) })),
    fixedLine(`tot:${key}`, `Total ${title.toLowerCase()}`, 'total', totalSen, totalPct),
  ];
  return [
    ...per('sales', 'Sales', (g) => g.salesSen, r.totals.salesSen, (g) => pctOfBase(g.salesSen, base), pctOfBase(r.totals.salesSen, base)),
    ...per('cogs', 'Cost of sales', (g) => g.cogsSen, r.totals.cogsSen, (g) => pctOfBase(g.cogsSen, base), pctOfBase(r.totals.cogsSen, base)),
    ...per('gp', 'Gross profit by group', (g) => g.gpSen, r.totals.gpSen, (g) => g.gpPct, r.totals.gpPct),
    ...summary.map((l, i): FlatLine => ({ id: l.id ?? `sum:${i}:${l.label}`, label: l.label, kind: l.kind === 'net' ? 'net' : l.kind, depth: l.depth, amountSen: l.amountSen, pct: l.pct })),
  ];
};

type RpLike = {
  layout: { tree: LaidNode[]; inSen: number; outSen: number };
  totals: { openingTotalSen: number; receiptsTotalSen: number; paymentsTotalSen: number; closingTotalSen: number };
};

/** The Cash Flow as lines, the Total column only: each top category as a
    block, its tree, its own subtotal line; a running subtotal as a bold
    line; then Cash Surplus / (Deficit), Balance b/f and Balance c/f last
    (owner 2026-09-18: b/f and c/f at the foot). % of the side's total. */
export const rpLines = (r: RpLike): FlatLine[] => {
  const t = r.totals;
  const out: FlatLine[] = [];
  for (const n of r.layout.tree) {
    if (n.kind === 'subtotal') { out.push(fixedLine(n.id, n.label, 'net', n.amountSen, null)); continue; }
    out.push(fixedLine(`blk:${n.id}`, n.label, 'block', 0, null));
    out.push(...treeLines(n.children));
    out.push(fixedLine(`tot:${n.id}`, n.totalLabel ?? `Total ${n.label}`, 'total', n.amountSen, n.pct));
  }
  out.push(fixedLine('net:surplus', 'Cash Surplus / (Deficit)', 'net', t.receiptsTotalSen - t.paymentsTotalSen, null));
  out.push(fixedLine('bal:opening', 'Balance b/f', 'total', t.openingTotalSen, null));
  out.push(fixedLine('bal:closing', 'Balance c/f', 'net', t.closingTotalSen, null));
  return out;
};

/* ── The CSV ─────────────────────────────────────────────────────────────── */

const csvCell = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The monthly table as CSV — the same lines and columns the screen shows,
    amounts or %, indented by depth. */
export const monthlyCsv = (title: string, columns: MonthColumn[], lines: MonthlyLine[], showPct: boolean, fmt: (sen: number) => string, fmtPct: (pct: number | null) => string): string => {
  const head = [title, ...columns.map((c) => c.label)];
  const rows = lines.map((l) => [
    `${'  '.repeat(Math.max(0, l.depth - 1))}${l.label}`,
    ...columns.map((c) => {
      const cell = l.cells[c.key];
      if (!cell || l.kind === 'block') return '';
      return showPct ? fmtPct(cell.pct) : fmt(cell.amountSen);
    }),
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
};
