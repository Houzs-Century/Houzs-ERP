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
import { flattenLaid, fmtPct, linesVisible, pctOf, type LaidNode } from './report-layout';
import type { FlatLine, MonthColumn, MonthlyLine } from './report-monthly';
import { AUTOCOUNT_LINE_ID, AUTOCOUNT_LINE_LABEL, balanceParts, withAutoCountLine, type RpReport } from './rp-report-queries';
import { performanceNotes, performanceSummaryLines, type PerformanceReport } from './performance-report-queries';

export type SheetRowKind = 'block' | 'category' | 'row' | 'unassigned' | 'total' | 'net' | 'memo';
export type SheetColumn = {
  label: string;
  kind: 'amount' | 'pct' | 'text';
  /** A % column that rides BESIDE the amount column before it (By month in
      amounts mode): two cells in Excel, one printed cell on paper. */
  beside?: boolean;
  /** The 累计 column — a rule after it, as on the screen. */
  edge?: boolean;
  /** A heading the column shares with the columns beside it (the Cash Flow's month over
      Settlement | Deposit): side by side, the same heading prints once, above them all. */
  group?: string;
  /** Read left to right — a name, a date, a note: heading and cells flush left (the
      Event Commission's order lists, owner 2026-11-13: 「export 出来…做好看一点」).
      Right when absent, as every figure. */
  align?: 'left' | 'right';
  /** Its width in Excel characters where an amount's is too narrow (a fair's name);
      never narrower than the column already is. */
  width?: number;
};
/** sen for an amount column, one-decimal % for a pct column, a string for text; null prints a dash. */
export type SheetValue = number | string | null;
export type SheetRow = {
  kind: SheetRowKind; depth: number; label: string; cells: SheetValue[];
  /** A group's own Total name (layout totalLabel). */
  totalLabel?: string;
  /** Cells that run across columns: the cell's index → how many columns it covers (the
      covered cells are null). A Cash Flow line not split, across a month's two columns. */
  spans?: Partial<Record<number, number>>;
};
export type SheetTable = {
  columns: SheetColumn[];
  rows: SheetRow[];
  /** A section's own title, on a row above its header — one sheet holding several
      tables reads which is which. Absent: the header is the table's first row. */
  title?: string;
  /** The name column's heading ("Order"); blank when absent. */
  labelHeader?: string;
};

/** The screen's totals-below rule on a file (owner 2026-11-05: Excel and PDF the same
    way): a group below the top level whose rows follow it is open — its figures move to
    a "Total <name>" row after them and its title prints bare; a folded group (no rows
    after it) keeps its figures. */
export function rowsWithTotalsBelow(rows: SheetRow[]): SheetRow[] {
  const out: SheetRow[] = [];
  const stack: SheetRow[] = [];
  const close = (g: SheetRow) =>
    out.push({ kind: 'total', depth: g.depth, label: g.totalLabel ?? `Total ${g.label}`, cells: g.cells, ...(g.spans ? { spans: g.spans } : {}) });
  rows.forEach((r, i) => {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= r.depth) close(stack.pop()!);
    const group = r.depth > 0 && (r.kind === 'category' || r.kind === 'unassigned') && (rows[i + 1]?.depth ?? -1) > r.depth;
    if (group) {
      const bare: SheetRow = { ...r, cells: [] };
      delete bare.spans;
      out.push(bare);
      stack.push(r);
    } else out.push(r);
  });
  while (stack.length > 0) close(stack.pop()!);
  return out;
}
export const sheetWithTotalsBelow = <S extends { tables: SheetTable[] }>(sheet: S): S =>
  ({ ...sheet, tables: sheet.tables.map((t) => ({ ...t, rows: rowsWithTotalsBelow(t.rows) })) });
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
  lines.map((l) => ({ kind: l.kind, depth: l.depth, label: l.label, ...(l.totalLabel ? { totalLabel: l.totalLabel } : {}), cells: l.kind === 'block' ? [] : [l.amountSen, l.pct] }));

export const statementTable = (lines: FlatLine[], pctTitle: string): SheetTable =>
  ({ columns: [AMOUNT_COLUMN(), PCT_COLUMN(pctTitle)], rows: statementRows(lines) });

/* ── The Cash Flow, one period ───────────────────────────────────────────── */

export type CashFlowSheetOptions = {
  /** The account columns ticked on the screen, before Total. */
  columns?: string[];
  level?: number | 'all';
  open?: Record<string, boolean>;
  /** The % beside Total, as the screen shows it (on unless switched off). */
  pct?: boolean;
};

/** The Cash Flow's rows as the screen draws them: each top category as a
    block with its tree folded to the level, its own subtotal name; a running
    subtotal as a bold line; Cash surplus / (deficit) — its % of the receipts —
    Balance b/f and c/f last. A zero in an account column prints as a dash, as
    on the screen; the Total prints. */
export function cashFlowTable(r: RpReport, opts: CashFlowSheetOptions = {}): SheetTable {
  const codes = opts.columns ?? [];
  const level = opts.level ?? 'all';
  const open = opts.open ?? {};
  const withPct = opts.pct ?? true;
  const named = r.columns.filter((c) => codes.includes(c.code));
  const columns: SheetColumn[] = [
    ...named.map((c): SheetColumn => ({ label: `${c.code} ${c.name}`, kind: 'amount' })),
    AMOUNT_COLUMN('Total'),
    ...(withPct ? [PCT_COLUMN('%')] : []),
  ];
  const cellsOf = (per: Record<string, number> | undefined, total: number, pct: number | null): SheetValue[] =>
    [...named.map((c) => { const v = per?.[c.code] ?? 0; return v === 0 ? null : v; }), total, ...(withPct ? [pct] : [])];
  const rows: SheetRow[] = [];
  for (const n of r.layout.tree) {
    if (n.kind === 'subtotal') { rows.push({ kind: 'net', depth: 0, label: n.label, cells: cellsOf(n.cells, n.amountSen, null) }); continue; }
    rows.push({ kind: 'block', depth: 0, label: n.label, cells: [] });
    /* The AutoCount line (owner 2026-11-08) where the screen prints it; the block's end is its fallback place. */
    type Placed = { id: string; depth: number; node: LaidNode | null };
    const end: Placed = { id: `tot:${n.id}`, depth: 0, node: null };
    const lines = withAutoCountLine(r, [...flattenLaid(n.children).map(({ node, depth }): Placed => ({ id: node.id, depth, node })), end],
      (depth): Placed => ({ id: AUTOCOUNT_LINE_ID, depth, node: null })).filter((l) => l !== end);
    for (const { id, node, depth } of linesVisible(lines, level, open)) {
      if (!node) {
        if (id === AUTOCOUNT_LINE_ID) rows.push({ kind: 'memo', depth, label: AUTOCOUNT_LINE_LABEL, cells: cellsOf(undefined, r.autoCount?.sen ?? 0, null) });
        continue;
      }
      rows.push({ kind: node.kind === 'account' ? 'row' : node.kind === 'unassigned' ? 'unassigned' : 'category', depth, label: node.label, ...(node.totalLabel ? { totalLabel: node.totalLabel } : {}), cells: cellsOf(node.cells, node.amountSen, node.pct) });
    }
    rows.push({ kind: 'total', depth: 0, label: n.totalLabel ?? `Total ${n.label}`, cells: cellsOf(n.cells, n.amountSen, n.pct) });
  }
  const surplusPer = Object.fromEntries(r.columns.map((c) => [c.code, (r.totals.receipts[c.code] ?? 0) - (r.totals.payments[c.code] ?? 0)]));
  const surplus = r.totals.receiptsTotalSen - r.totals.paymentsTotalSen;
  rows.push({ kind: 'net', depth: 0, label: 'Cash surplus / (deficit)', cells: cellsOf(surplusPer, surplus, pctOf(surplus, r.totals.receiptsTotalSen)) });
  const parts = (per: Record<string, number>, total: number): SheetRow[] =>
    balanceParts(r, 'bal', per, total).map((p) => ({ kind: 'row', depth: 1, label: p.label, cells: cellsOf(p.per, p.sen, null) }));
  rows.push({ kind: 'total', depth: 0, label: 'Balance b/f', cells: cellsOf(r.opening, r.totals.openingTotalSen, null) });
  rows.push(...parts(r.opening, r.totals.openingTotalSen));
  rows.push({ kind: 'net', depth: 0, label: 'Balance c/f', cells: cellsOf(r.totals.closing, r.totals.closingTotalSen, null) });
  rows.push(...parts(r.totals.closing, r.totals.closingTotalSen));
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
    kind: l.kind, depth: l.depth, label: l.label, ...(l.totalLabel ? { totalLabel: l.totalLabel } : {}),
    cells: l.kind === 'block' ? [] : columns.flatMap((c): SheetValue[] => {
      const cell = l.cells[c.key];
      if (!cell) return showPct ? [null] : [null, null];
      return showPct ? [cell.pct] : [cell.amountSen, cell.pct];
    }),
  }));
  return { columns: cols, rows };
}

/** A statement's columns as the screen shows them (the redesign's Compare and
    By month, or one period without its %): each column an amount, its % beside
    it where the screen prints one; a Total column ruled after, as on screen. A
    column under a shared heading keeps it (the Cash Flow's month over Settlement |
    Deposit), and a line's figure running across columns on the screen runs across
    the same cells here. */
export function statementColumnsTable(
  columns: ReadonlyArray<{ key: string; label: string; pct: boolean; edge?: boolean; group?: string }>,
  shown: MonthlyLine[],
): SheetTable {
  const cols: SheetColumn[] = columns.flatMap((c): SheetColumn[] => {
    const group = c.group ? { group: c.group } : {};
    return c.pct
      ? [{ label: c.label, kind: 'amount', ...group }, { label: '%', kind: 'pct', beside: true, edge: c.edge, ...group }]
      : [{ label: c.label, kind: 'amount', edge: c.edge, ...group }];
  });
  /* Where each screen column's cells start on the sheet, and how wide a run of them is. */
  const width = (c: { pct: boolean }): number => (c.pct ? 2 : 1);
  const starts = columns.map((_, i) => columns.slice(0, i).reduce((n, c) => n + width(c), 0));
  const spansOf = (l: MonthlyLine): SheetRow['spans'] => {
    const out: Partial<Record<number, number>> = {};
    columns.forEach((c, i) => {
      const n = l.spans?.[c.key] ?? 1;
      if (n > 1) out[starts[i]!] = columns.slice(i, i + n).reduce((w, x) => w + width(x), 0);
    });
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const rows = shown.map((l): SheetRow => {
    const spans = l.kind === 'block' ? undefined : spansOf(l);
    return {
      kind: l.kind, depth: l.depth, label: l.label, ...(l.totalLabel ? { totalLabel: l.totalLabel } : {}),
      cells: l.kind === 'block' ? [] : columns.flatMap((c): SheetValue[] => {
        const cell = l.cells[c.key];
        if (!cell) return c.pct ? [null, null] : [null];
        return c.pct ? [cell.amountSen, cell.pct] : [cell.amountSen];
      }),
      ...(spans ? { spans } : {}),
    };
  });
  return { columns: cols, rows };
}

/** Which lines of a laid block the screen shows at a level — the fold rule the pages use. */
export const visibleLaid = (nodes: LaidNode[], level: number | 'all', open: Record<string, boolean>): Array<{ node: LaidNode; depth: number }> =>
  linesVisible(flattenLaid(nodes).map(({ node, depth }) => ({ id: node.id, depth, node })), level, open);

/** A file name a report exports under: the report, the period, the extension. */
export const exportFileName = (report: string, from: string, to: string, ext: 'xlsx' | 'pdf'): string =>
  `${report}-${from}${to && to !== from ? `-to-${to}` : ''}.${ext}`;
