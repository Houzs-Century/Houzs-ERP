// ----------------------------------------------------------------------------
// product-changes-view — the pure half of Finance's two product change reports
// (owner 2026-11-23: 「我主要是看销售价和成本的变动，因为我要确定这些改动销售价是足够
// cover成本的变动」; the change report by month: 「我要可以选择月份去看」; the summary
// 「类似 p&L」). The rows come from the server one per change event; this names
// them, filters them by bucket, adds them up by month and by salesperson, and
// builds the Excel / PDF sheet of each report from what the screen shows.
// ----------------------------------------------------------------------------

import type { ChangedLine, ProductChangeBucket, ProductChangeRow, ProductChangeType } from '../../vendor/scm/lib/product-change-queries';
import { AMOUNT_COLUMN, type ReportSheet, type SheetRow, type SheetValue } from '../../vendor/scm/lib/report-sheet';
import { fmtSenPlain } from '../../vendor/shared/format';
import { monthEnd } from '../../lib/dateRangePresets';
import { monthName } from './reports/statementColumns';

export const TYPE_LABEL: Record<ProductChangeType, string> = {
  sku: 'Product',
  height: 'Seat height',
  option: 'Option',
  pieces: 'Sofa pieces',
  qty: 'Qty',
  new_line: 'New line',
  removed_line: 'Removed line',
};

export const BUCKET_LABEL: Record<ProductChangeBucket, string> = {
  SELLING: 'Selling changed',
  COST_ONLY: 'Selling same, cost changed',
};

/** The bucket filter: both, or one of them. */
export type BucketView = 'all' | ProductChangeBucket;

export const typesText = (r: Pick<ProductChangeRow, 'types'>): string => r.types.map((t) => TYPE_LABEL[t]).join(', ');

export const routeText = (r: Pick<ProductChangeRow, 'route' | 'amendmentNos'>): string =>
  (r.route === 'AMENDMENT' ? `Amendment ${r.amendmentNos.join(' + ')}`.trim() : 'Direct edit');

/** The route as a row reads it beside its order: the amendment's own part (A1 + A2). */
export const routeShort = (r: Pick<ProductChangeRow, 'route' | 'amendmentNos' | 'docNo'>): string =>
  (r.route === 'AMENDMENT'
    ? `Amendment ${r.amendmentNos.map((n) => (n.startsWith(`${r.docNo}/`) ? n.slice(r.docNo.length + 1) : n)).join(' + ')}`.trim()
    : 'Direct edit');

/** Who changed it: the editors, or for an amendment who asked and who approved. */
export const whoText = (r: Pick<ProductChangeRow, 'route' | 'changedBy' | 'approvedBy'>): string => {
  const by = r.changedBy.join(', ') || '—';
  return r.route === 'AMENDMENT' && r.approvedBy.length > 0 ? `${by} · approved by ${r.approvedBy.join(', ')}` : by;
};

const sideText = (s: ChangedLine['before']): string => (s ? `${s.code} x${s.qty}` : '—');

/** One changed line as a sentence: "JAGER-(Q) x1 → NTYR-(Q) x1", "+ CODY-(Q) x1", "− PILLOW x2". */
export function lineText(l: ChangedLine): string {
  if (!l.before && l.after) return `+ ${sideText(l.after)}`;
  if (l.before && !l.after) return `− ${sideText(l.before)}`;
  const same = l.before && l.after && l.before.code === l.after.code && l.before.qty === l.after.qty;
  return same ? `${sideText(l.after)} (price or cost)` : `${sideText(l.before)} → ${sideText(l.after)}`;
}

/** A change in sen with its sign: "+500.00", "(500.00)", "0.00". */
export const fmtDelta = (sen: number): string => (sen > 0 ? `+${fmtSenPlain(sen)}` : fmtSenPlain(sen));

/* Owner 2026-11-23: 「默认只看新单」. An order brought over from AutoCount at the
   cutover is left out unless the reader asks for it. */
export const ordersShown = (rows: readonly ProductChangeRow[], includeImported: boolean): ProductChangeRow[] =>
  (includeImported ? [...rows] : rows.filter((r) => !r.imported));

export const ordersScope = (includeImported: boolean): string => (includeImported ? 'imported orders included' : 'new orders only');

export function filterRows(rows: readonly ProductChangeRow[], bucket: BucketView, notCoveredOnly: boolean): ProductChangeRow[] {
  return rows.filter((r) => (bucket === 'all' || r.bucket === bucket) && (!notCoveredOnly || !r.covered));
}

export type ChangeTotals = {
  events: number;
  sellingDeltaSen: number;
  costDeltaSen: number;
  marginDeltaSen: number;
  notCovered: number;
  shortfallSen: number;
};

export const EMPTY_TOTALS: ChangeTotals = { events: 0, sellingDeltaSen: 0, costDeltaSen: 0, marginDeltaSen: 0, notCovered: 0, shortfallSen: 0 };

export function totalsOf(rows: readonly ProductChangeRow[]): ChangeTotals {
  return rows.reduce<ChangeTotals>((t, r) => ({
    events: t.events + 1,
    sellingDeltaSen: t.sellingDeltaSen + r.sellingDeltaSen,
    costDeltaSen: t.costDeltaSen + r.costDeltaSen,
    marginDeltaSen: t.marginDeltaSen + r.marginDeltaSen,
    notCovered: t.notCovered + (r.covered ? 0 : 1),
    shortfallSen: t.shortfallSen + r.shortfallSen,
  }), EMPTY_TOTALS);
}

/** The whole months from `from` to `to` (any day in each), `YYYY-MM` each. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (let guard = 0; guard < 120; guard += 1) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    out.push(ym);
    if (ym >= last) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The months a picker offers: from September 2026 (when the record starts) to this month, newest first. */
export function pickableMonths(today: string, first = '2026-09'): string[] {
  const start = today.slice(0, 7) < first ? today.slice(0, 7) : first;
  return monthsBetween(start, today).reverse();
}

/** A month's first and last days. */
export const monthBounds = (ym: string): { from: string; to: string } => ({ from: `${ym}-01`, to: monthEnd(`${ym}-01`) });

export const periodText = (from: string, to: string): string => {
  const a = monthName(from);
  const b = monthName(to);
  return a === b ? a : `${a} – ${b}`;
};

/** The summary, P&L-style: each bucket's lines per month and in total. */
export type SummaryColumn = { key: string; label: string; a: ChangeTotals; b: ChangeTotals; all: ChangeTotals };

export function summaryColumns(rows: readonly ProductChangeRow[], from: string, to: string): SummaryColumn[] {
  const months = monthsBetween(from, to);
  const col = (key: string, label: string, rs: readonly ProductChangeRow[]): SummaryColumn => ({
    key, label,
    a: totalsOf(rs.filter((r) => r.bucket === 'SELLING')),
    b: totalsOf(rs.filter((r) => r.bucket === 'COST_ONLY')),
    all: totalsOf(rs),
  });
  const cols = months.map((m) => col(m, monthName(`${m}-01`), rows.filter((r) => r.changeDay.slice(0, 7) === m)));
  return months.length > 1 ? [...cols, col('total', 'Total', rows)] : cols;
}

/** The P&L lines, in order: a section title (no figures) or a figure line. */
export type SummaryLine =
  | { kind: 'section'; label: string }
  | { kind: 'money' | 'count'; label: string; total?: boolean; value: (c: SummaryColumn) => number; bad?: boolean };

/** A figure the eye should catch: a fall in margin, or any not covered / shortfall. */
export const summaryRed = (l: Extract<SummaryLine, { kind: 'money' | 'count' }>, v: number): boolean =>
  (l.bad === true && v > 0) || (l.total === true && v < 0);

export const SUMMARY_LINES: readonly SummaryLine[] = [
  { kind: 'section', label: 'Selling changed' },
  { kind: 'count', label: 'Changes', value: (c) => c.a.events },
  { kind: 'money', label: 'Selling change', value: (c) => c.a.sellingDeltaSen },
  { kind: 'money', label: 'Cost change', value: (c) => c.a.costDeltaSen },
  { kind: 'money', label: 'Margin change', value: (c) => c.a.marginDeltaSen, total: true },
  { kind: 'count', label: 'Not covered', value: (c) => c.a.notCovered, bad: true },
  { kind: 'money', label: 'Shortfall', value: (c) => c.a.shortfallSen, bad: true },
  { kind: 'section', label: 'Selling same, cost changed' },
  { kind: 'count', label: 'Changes', value: (c) => c.b.events },
  { kind: 'money', label: 'Cost change', value: (c) => c.b.costDeltaSen },
  { kind: 'money', label: 'Margin change', value: (c) => c.b.marginDeltaSen, total: true },
  { kind: 'count', label: 'Cost went up', value: (c) => c.b.notCovered, bad: true },
  { kind: 'money', label: 'Shortfall', value: (c) => c.b.shortfallSen, bad: true },
  { kind: 'section', label: 'All product changes' },
  { kind: 'count', label: 'Changes', value: (c) => c.all.events },
  { kind: 'money', label: 'Selling change', value: (c) => c.all.sellingDeltaSen },
  { kind: 'money', label: 'Cost change', value: (c) => c.all.costDeltaSen },
  { kind: 'money', label: 'Margin change', value: (c) => c.all.marginDeltaSen, total: true },
  { kind: 'count', label: 'Not covered', value: (c) => c.all.notCovered, bad: true },
  { kind: 'money', label: 'Shortfall', value: (c) => c.all.shortfallSen, bad: true },
];

export type SalespersonRow = ChangeTotals & { salesperson: string };

/** By who sold the order, the largest shortfall first. */
export function bySalesperson(rows: readonly ProductChangeRow[]): SalespersonRow[] {
  const groups = new Map<string, ProductChangeRow[]>();
  for (const r of rows) groups.set(r.salesperson, [...(groups.get(r.salesperson) ?? []), r]);
  return [...groups.entries()]
    .map(([salesperson, rs]) => ({ salesperson, ...totalsOf(rs) }))
    .sort((x, y) => y.shortfallSen - x.shortfallSen || x.marginDeltaSen - y.marginDeltaSen || x.salesperson.localeCompare(y.salesperson));
}

const TEXT = (label: string) => ({ label, kind: 'text' as const, align: 'left' as const });

export function detailSheet(rows: readonly ProductChangeRow[], from: string, to: string, bucket: BucketView, notCoveredOnly: boolean, includeImported: boolean): ReportSheet {
  const t = totalsOf(rows);
  const lead = (v: SheetValue): SheetValue[] => (includeImported ? [v] : []);
  const table: SheetRow[] = rows.map((r) => ({
    kind: 'row', depth: 0, label: r.docNo,
    cells: [
      ...lead(r.imported ? 'Imported' : null),
      r.changeDay, r.salesperson, whoText(r), routeText(r), typesText(r), BUCKET_LABEL[r.bucket],
      r.sellingBeforeSen, r.sellingAfterSen, r.sellingDeltaSen,
      r.costBeforeSen, r.costAfterSen, r.costDeltaSen,
      r.sellingBeforeSen - r.costBeforeSen, r.sellingAfterSen - r.costAfterSen, r.marginDeltaSen,
      `${r.covered ? 'Covered' : 'Not covered'}${r.costEstimated ? ' (estimated cost)' : ''}`, r.shortfallSen || null,
      r.lines.filter((l) => l.types.length > 0).map(lineText).join('; '),
    ] satisfies SheetValue[],
  }));
  table.push({
    kind: 'total', depth: 0, label: 'Total',
    cells: [...lead(null), null, null, null, null, `${t.events} ${t.events === 1 ? 'change' : 'changes'}`, null, null, null, t.sellingDeltaSen, null, null, t.costDeltaSen, null, null, t.marginDeltaSen, `${t.notCovered} not covered`, t.shortfallSen, null],
  });
  return {
    title: 'Product changes',
    subtitle: `${periodText(from, to)} · ${bucket === 'all' ? 'all changes' : BUCKET_LABEL[bucket].toLowerCase()}${notCoveredOnly ? ' · not covered only' : ''} · ${ordersScope(includeImported)} · product lines · RM`,
    meta: [
      { label: 'Month', value: periodText(from, to) },
      { label: 'Changes', value: String(t.events) },
      { label: 'Not covered', value: `${t.notCovered} · RM ${fmtSenPlain(t.shortfallSen)}` },
    ],
    tables: [{
      labelHeader: 'Order',
      columns: [
        ...(includeImported ? [TEXT('Order from')] : []),
        TEXT('Change date'), TEXT('Salesperson'), TEXT('Changed by'), TEXT('How'), TEXT('What changed'), TEXT('Kind'),
        AMOUNT_COLUMN('Selling before'), AMOUNT_COLUMN('Selling after'), AMOUNT_COLUMN('Selling change'),
        AMOUNT_COLUMN('Cost before'), AMOUNT_COLUMN('Cost after'), AMOUNT_COLUMN('Cost change'),
        AMOUNT_COLUMN('Margin before'), AMOUNT_COLUMN('Margin after'), AMOUNT_COLUMN('Margin change'),
        TEXT('Covered'), AMOUNT_COLUMN('Shortfall'), { ...TEXT('Lines'), width: 60 },
      ],
      rows: table,
    }],
    notes: [...CHANGE_NOTES],
  };
}

export function summarySheet(rows: readonly ProductChangeRow[], from: string, to: string, includeImported: boolean): ReportSheet {
  const cols = summaryColumns(rows, from, to);
  const pnl: SheetRow[] = SUMMARY_LINES.map((l) => (l.kind === 'section'
    ? { kind: 'block', depth: 0, label: l.label, cells: cols.map(() => null) }
    : { kind: l.total ? 'total' : 'row', depth: 1, label: l.label, cells: cols.map((c) => (l.kind === 'count' ? String(l.value(c)) : l.value(c))) }));
  const people: SheetRow[] = bySalesperson(rows).map((p) => ({
    kind: 'row', depth: 0, label: p.salesperson,
    cells: [String(p.events), p.sellingDeltaSen, p.costDeltaSen, p.marginDeltaSen, String(p.notCovered), p.shortfallSen],
  }));
  const t = totalsOf(rows);
  people.push({ kind: 'total', depth: 0, label: 'Total', cells: [String(t.events), t.sellingDeltaSen, t.costDeltaSen, t.marginDeltaSen, String(t.notCovered), t.shortfallSen] });
  return {
    title: 'Product changes P&L',
    subtitle: `${periodText(from, to)} · ${ordersScope(includeImported)} · product lines · RM`,
    meta: [{ label: 'Months', value: periodText(from, to) }, { label: 'Changes', value: String(t.events) }],
    tables: [
      { title: 'By month', columns: cols.map((c) => AMOUNT_COLUMN(c.label)), rows: pnl },
      {
        title: 'By salesperson', labelHeader: 'Salesperson',
        columns: [{ label: 'Changes', kind: 'text' }, AMOUNT_COLUMN('Selling change'), AMOUNT_COLUMN('Cost change'), AMOUNT_COLUMN('Margin change'), { label: 'Not covered', kind: 'text' }, AMOUNT_COLUMN('Shortfall')],
        rows: people,
      },
    ],
    notes: [...CHANGE_NOTES],
  };
}

export const CHANGE_NOTES: readonly string[] = [
  'A product change is another product, seat height or option, sofa pieces added or removed, a line added or removed, or a quantity change that moved the selling amount. Colour, fabric, side, price alone and dates are not.',
  'Selling and cost are the order’s product lines; delivery, disposal and other service lines are left out. A direct edit counts once per order per day; an amendment once, its product and price halves together.',
  'Not covered: the margin fell, because the selling change was smaller than the cost change. Selling same, cost changed: the cost moved with no new price.',
  'The changed part is costed on the change day; unchanged lines keep their order-date cost.',
  'Orders brought over from AutoCount at the cutover are left out unless Include imported orders is on; their rows are marked Imported.',
  'Changes from before the record went live were rebuilt from each order’s own history. Estimated marks a cost that history did not hold, taken from the product’s own cost.',
];
