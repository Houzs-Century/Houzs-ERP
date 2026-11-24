// ----------------------------------------------------------------------------
// so-backlog-cover-view — the rules of Finance › Reports › SO conversion &
// backlog (owner 2026-11-24): the parts' names, what each order row says, the
// filter the tiles drive, the average's months, and the sheet Excel, PDF and
// Print are made from. The figures are the server's (acc/so-backlog-cover.ts).
// ----------------------------------------------------------------------------

import type { Count, CoverPart, CoverRates, CoverRow, SoBacklogCoverData } from '../../vendor/scm/lib/so-backlog-cover-queries';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetRow, type SheetTable } from '../../vendor/scm/lib/report-sheet';
import { fmtPct } from '../../vendor/scm/lib/report-layout';
import { fmtQty, fmtSenPlain } from '../../vendor/shared/format';
import { monthName } from './reports/statementColumns';

export const PART_LABEL: Readonly<Record<CoverPart, string>> = {
  this_month: "This month's orders",
  backlog: 'Backlog orders',
};

/** What the list shows: every order processed in the month, or one part's. */
export type PartView = 'all' | CoverPart;

export const partViewOf = (v: string | null): PartView => (v === 'this_month' || v === 'backlog' ? v : 'all');

export const rowsOfPart = (rows: readonly CoverRow[], view: PartView): CoverRow[] =>
  (view === 'all' ? [...rows] : rows.filter((r) => r.part === view));

/** Where an order sits: this month's, or the backlog with the month it was raised in. */
export const partText = (r: CoverRow): string => (r.part === 'this_month' ? 'This month' : `Backlog · ${monthName(r.soDate)}`);

export const ordersText = (n: number): string => `${fmtQty(n)} ${n === 1 ? 'order' : 'orders'}`;

export const shareText = (pct: number | null): string => (pct === null ? '—' : fmtPct(pct));

/** "1 Nov 2026": the day the backlog is counted on. */
export const firstOfText = (month: string): string => `1 ${monthName(`${month}-01`)}`;

/** The average's months: "Sep 2026 – Nov 2026", or one month. */
export const averagePeriod = (d: SoBacklogCoverData): string => {
  const a = monthName(`${d.average.from}-01`);
  const b = monthName(`${d.average.to}-01`);
  return a === b ? a : `${a} – ${b}`;
};

/** A ?avg value the report can use: a month no later than the report's; anything else is the default. */
export const avgFromOf = (v: string | null, month: string): string | null =>
  (v !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) && v <= month ? v : null);

export const COVER_NOTES: readonly string[] = [
  'An order counts in the month of its Processing Date: the date written on the order, not the day it was entered. Draft and Cancelled orders are left out.',
  'An order with no Processing Date that has gone out on a delivery order counts on its first DO date (marked First DO).',
  'Backlog: orders raised before the month that had not been processed by its 1st, orders brought over from AutoCount included.',
  'Cover rate on backlog: backlog processed in the month ÷ the backlog at its 1st. On month: backlog processed ÷ everything processed in the month. Each is shown by amount and by number of orders.',
  "Average: each month's rate added up and divided by the months, from the Average from month to this one. By default it starts at the company's first month in the ERP with a backlog; a month with no backlog is left out.",
];

const TEXT = (label: string) => ({ label, kind: 'text' as const, align: 'left' as const });
const COUNT = (label: string) => ({ label, kind: 'text' as const, align: 'right' as const });

/** A by-month table of the sheet: each month's backlog, processed and the two rates, the average under them. */
function monthsTable(d: SoBacklogCoverData, by: 'amount' | 'orders'): SheetTable {
  const cell = (c: Count) => (by === 'amount' ? c.amountSen : fmtQty(c.orders));
  const rates = (r: CoverRates) => [r.onBacklog, r.onMonth];
  const rows: SheetRow[] = d.months.map((m) => ({
    kind: 'row', depth: 0, label: monthName(`${m.month}-01`),
    cells: [cell(m.backlog), cell(m.backlogProcessed), cell(m.processed), ...rates(m[by])],
  }));
  rows.push({ kind: 'total', depth: 0, label: 'Average', cells: [null, null, null, ...rates(d.average[by])] });
  const base = by === 'amount'
    ? [AMOUNT_COLUMN('Backlog at the 1st'), AMOUNT_COLUMN('Backlog processed'), AMOUNT_COLUMN('Processed in month')]
    : [COUNT('Backlog orders at the 1st'), COUNT('Backlog orders processed'), COUNT('Orders processed')];
  return {
    title: `Backlog cover by month · by ${by}`,
    labelHeader: 'Month',
    columns: [...base, PCT_COLUMN('On backlog'), PCT_COLUMN('On month')],
    rows,
  };
}

/** Excel, PDF and Print: the parts, the backlog cover by month with its average, then the orders. */
export function coverSheet(d: SoBacklogCoverData, view: PartView): ReportSheet {
  const period = monthName(d.from);
  const parts: SheetRow[] = (['this_month', 'backlog'] as const).map((p) => ({
    kind: 'row', depth: 0, label: PART_LABEL[p], cells: [ordersText(d.parts[p].orders), d.parts[p].amountSen, d.parts[p].pct],
  }));
  parts.push({ kind: 'total', depth: 0, label: 'Processed in the month', cells: [ordersText(d.total.orders), d.total.amountSen, d.total.amountSen === 0 ? null : 100] });
  const listed = rowsOfPart(d.rows, view);
  const lines: SheetRow[] = listed.map((r) => ({
    kind: 'row', depth: 0, label: r.docNo,
    cells: [r.soDate, r.processedOn, r.dateFrom === 'first_do' ? 'First DO' : 'Processing Date', r.customer ?? '', `${partText(r)}${r.imported ? ' (imported)' : ''}`, r.amountSen],
  }));
  lines.push({ kind: 'total', depth: 0, label: 'Total', cells: [null, null, null, null, ordersText(listed.length), listed.reduce((s, r) => s + r.amountSen, 0)] });
  return {
    title: 'SO conversion & backlog',
    subtitle: `${period} · by Processing Date${view === 'all' ? '' : ` · ${PART_LABEL[view].toLowerCase()}`} · RM`,
    meta: [
      { label: 'Month', value: period },
      { label: 'Processed', value: `${ordersText(d.total.orders)} · RM ${fmtSenPlain(d.total.amountSen)}` },
      { label: `Backlog at ${firstOfText(d.month)}`, value: `${ordersText(d.backlog.orders)} · RM ${fmtSenPlain(d.backlog.amountSen)}` },
      { label: 'Average', value: averagePeriod(d) },
    ],
    tables: [
      { title: 'Summary', labelHeader: 'Orders', columns: [TEXT('Orders'), AMOUNT_COLUMN(), PCT_COLUMN('% of processed')], rows: parts },
      monthsTable(d, 'amount'),
      monthsTable(d, 'orders'),
      {
        title: view === 'all' ? 'Orders processed' : `Orders processed · ${PART_LABEL[view]}`,
        labelHeader: 'Order',
        columns: [TEXT('Order date'), TEXT('Processing date'), TEXT('Date from'), { ...TEXT('Customer'), width: 30 }, TEXT('Part'), AMOUNT_COLUMN()],
        rows: lines,
      },
    ],
    notes: [...COVER_NOTES],
  };
}
