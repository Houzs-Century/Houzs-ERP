// ----------------------------------------------------------------------------
// report-sheet — a Finance report AS THE SCREEN SHOWS IT, in one shape the
// Excel and the PDF exports both draw (owner 2026-09-19: export 出来 excel pdf
// 不好看，就应该和原本的一样 … 我这页显示什么就要 export 什么 … finance 这里的 report
// 都是要这样). A sheet is a title, a subtitle, the letterhead's meta lines,
// one or more tables — each a row of columns and rows of the kinds the
// screen dresses (a block title, a category, an account row, an unassigned
// row, a total, a subtotal) with their depth and RAW figures — and notes.
// The pages build it from the SAME lines they render, folded to the same
// level, in the same amounts-or-% mode, with the same columns, so paper,
// workbook and screen can never disagree. Nothing is recomputed here.
// ----------------------------------------------------------------------------

import { fmtSenPlain } from '../../shared/format';
import { flattenLaid, fmtPct, linesVisible, type LaidNode } from './report-layout';
import type { FlatLine, MonthColumn, MonthlyLine } from './report-monthly';
import type { RpReport } from './rp-report-queries';
import { performanceNotes, performanceSummaryLines, type PerformanceReport } from './performance-report-queries';

export type SheetRowKind = 'block' | 'category' | 'row' | 'unassigned' | 'total' | 'net';
export type SheetColumn = {
  label: string;
  kind: 'amount' | 'pct' | 'text';
  /** A % column that rides BESIDE the amount column before it (By month in
      amounts mode): two cells in Excel, one printed cell on paper. */
  beside?: boolean;
  /** The 累计 column — a rule after it, as on the screen. */
  edge?: boolean;
};
/** sen for an amount column, one-decimal % for a pct column, a string for text; null prints a dash. */
export type SheetValue = number | string | null;
export type SheetRow = { kind: SheetRowKind; depth: number; label: string; cells: SheetValue[] };
export type SheetTable = { columns: SheetColumn[]; rows: SheetRow[] };
export type ReportSheet = {
  title: string;
  subtitle: string;
  /** The letterhead's right-hand lines (Period, Rows …); Printed is added on paper. */
  meta: Array<{ label: string; value: string }>;
  tables: SheetTable[];
  notes?: string[];
  /** The report's money dress; fmtSenPlain when absent. */
  fmt?: (sen: number) => string;
};

/** A cell as the screen would print it. */
export const sheetText = (col: SheetColumn, v: SheetValue, fmt: (sen: number) => string = fmtSenPlain): string =>
  (v === null ? '-' : typeof v === 'string' ? v : col.kind === 'pct' ? fmtPct(v) : fmt(v));

export const AMOUNT_COLUMN = (label = 'Amount'): SheetColumn => ({ label, kind: 'amount' });
export const PCT_COLUMN = (label: string): SheetColumn => ({ label, kind: 'pct' });

/* ── The single-period statements (P&L, Balance Sheet) ───────────────────── */

/** A statement's lines — pnlLines / balanceSheetLines, already folded to what
    the screen shows — as rows of amount and %. A block title carries no figure. */
export const statementRows = (lines: FlatLine[]): SheetRow[] =>
  lines.map((l) => ({ kind: l.kind, depth: l.depth, label: l.label, cells: l.kind === 'block' ? [] : [l.amountSen, l.pct] }));

export const statementTable = (lines: FlatLine[], pctTitle: string): SheetTable =>
  ({ columns: [AMOUNT_COLUMN(), PCT_COLUMN(pctTitle)], rows: statementRows(lines) });

/* ── The Cash Flow, one period ───────────────────────────────────────────── */

export type CashFlowSheetOptions = {
  /** The account columns ticked on the screen, before Total. */
  columns?: string[];
  level?: number | 'all';
  open?: Record<string, boolean>;
};

/** The Cash Flow's rows as the screen draws them: each top category as a
    block with its tree folded to the level, its own subtotal name; a running
    subtotal as a bold line; Cash Surplus, Balance b/f and c/f last. A zero in
    an account column prints as a dash, as on the screen; the Total prints. */
export function cashFlowTable(r: RpReport, opts: CashFlowSheetOptions = {}): SheetTable {
  const codes = opts.columns ?? [];
  const level = opts.level ?? 'all';
  const open = opts.open ?? {};
  const named = r.columns.filter((c) => codes.includes(c.code));
  const columns: SheetColumn[] = [
    ...named.map((c): SheetColumn => ({ label: `${c.code} ${c.name}`, kind: 'amount' })),
    AMOUNT_COLUMN('Total'),
    PCT_COLUMN('%'),
  ];
  const cellsOf = (per: Record<string, number> | undefined, total: number, pct: number | null): SheetValue[] =>
    [...named.map((c) => { const v = per?.[c.code] ?? 0; return v === 0 ? null : v; }), total, pct];
  const rows: SheetRow[] = [];
  for (const n of r.layout.tree) {
    if (n.kind === 'subtotal') { rows.push({ kind: 'net', depth: 0, label: n.label, cells: cellsOf(n.cells, n.amountSen, null) }); continue; }
    rows.push({ kind: 'block', depth: 0, label: n.label, cells: [] });
    const lines = flattenLaid(n.children).map(({ node, depth }) => ({ id: node.id, depth, node }));
    for (const { node, depth } of linesVisible(lines, level, open)) {
      rows.push({ kind: node.kind === 'account' ? 'row' : node.kind === 'unassigned' ? 'unassigned' : 'category', depth, label: node.label, cells: cellsOf(node.cells, node.amountSen, node.pct) });
    }
    rows.push({ kind: 'total', depth: 0, label: n.totalLabel ?? `Total ${n.label}`, cells: cellsOf(n.cells, n.amountSen, n.pct) });
  }
  const surplusPer = Object.fromEntries(r.columns.map((c) => [c.code, (r.totals.receipts[c.code] ?? 0) - (r.totals.payments[c.code] ?? 0)]));
  rows.push({ kind: 'net', depth: 0, label: 'Cash Surplus / (Deficit)', cells: cellsOf(surplusPer, r.totals.receiptsTotalSen - r.totals.paymentsTotalSen, null) });
  rows.push({ kind: 'total', depth: 0, label: 'Balance b/f', cells: cellsOf(r.opening, r.totals.openingTotalSen, null) });
  rows.push({ kind: 'net', depth: 0, label: 'Balance c/f', cells: cellsOf(r.totals.closing, r.totals.closingTotalSen, null) });
  return { columns, rows };
}

/* ── The Performance P&L, one period ─────────────────────────────────────── */

export type PerformanceSheetOptions = { level?: number | 'all'; open?: Record<string, boolean> };

/** The two tables the screen draws: the groups (sales, cost, gross profit,
    GP %) with their total, then the summary from gross profit to net on the
    report's tree, folded to the level; the notes ride along. */
export function performanceTables(r: PerformanceReport, opts: PerformanceSheetOptions = {}): { tables: SheetTable[]; notes: string[] } {
  const groups: SheetTable = {
    columns: [AMOUNT_COLUMN('Sales'), AMOUNT_COLUMN('Cost of sales'), AMOUNT_COLUMN('Gross profit'), PCT_COLUMN('GP %')],
    rows: [
      ...r.groups.map((g): SheetRow => ({ kind: 'row', depth: 0, label: g.label, cells: [g.salesSen, g.cogsSen, g.gpSen, g.gpPct] })),
      { kind: 'total', depth: 0, label: 'Total', cells: [r.totals.salesSen, r.totals.cogsSen, r.totals.gpSen, r.totals.gpPct] },
    ],
  };
  const all = performanceSummaryLines(r);
  const summary: SheetTable = {
    columns: [AMOUNT_COLUMN(), PCT_COLUMN('% of sales')],
    rows: linesVisible(all, opts.level ?? 'all', opts.open ?? {}).map((l): SheetRow => ({ kind: l.kind, depth: l.depth, label: l.label, cells: [l.amountSen, l.pct] })),
  };
  return { tables: [groups, summary], notes: performanceNotes(r) };
}

/* ── By month ────────────────────────────────────────────────────────────── */

/** The monthly grid as shown: 累计 then the months, each an amount with its %
    beside it — or the % alone on the % toggle; the lines folded to the level. */
export function monthlyTable(columns: MonthColumn[], shown: MonthlyLine[], showPct: boolean): SheetTable {
  const cols: SheetColumn[] = columns.flatMap((c): SheetColumn[] => (showPct
    ? [{ label: c.label, kind: 'pct', edge: c.cumulative }]
    : [{ label: c.label, kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: c.cumulative }]));
  const rows = shown.map((l): SheetRow => ({
    kind: l.kind, depth: l.depth, label: l.label,
    cells: l.kind === 'block' ? [] : columns.flatMap((c): SheetValue[] => {
      const cell = l.cells[c.key];
      if (!cell) return showPct ? [null] : [null, null];
      return showPct ? [cell.pct] : [cell.amountSen, cell.pct];
    }),
  }));
  return { columns: cols, rows };
}

/** Which lines of a laid block the screen shows at a level — the fold rule the pages use. */
export const visibleLaid = (nodes: LaidNode[], level: number | 'all', open: Record<string, boolean>): Array<{ node: LaidNode; depth: number }> =>
  linesVisible(flattenLaid(nodes).map(({ node, depth }) => ({ id: node.id, depth, node })), level, open);

/** A file name a report exports under: the report, the period, the extension. */
export const exportFileName = (report: string, from: string, to: string, ext: 'xlsx' | 'pdf'): string =>
  `${report}-${from}${to && to !== from ? `-to-${to}` : ''}.${ext}`;
