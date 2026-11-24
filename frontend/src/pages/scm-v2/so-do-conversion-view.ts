// ----------------------------------------------------------------------------
// so-do-conversion-view — the rules of Finance › Reports › SO to DO conversion
// (owner 2026-11-24): the parts' names, what each DO row says about the order
// it came from, the filter the tiles drive, and the sheet Excel, PDF and Print
// are made from. The figures are the server's (acc/so-do-conversion.ts).
// ----------------------------------------------------------------------------

import type { ConversionPart, ConversionRow, OtherReason, SoDoConversionData } from '../../vendor/scm/lib/so-do-conversion-queries';
import { AMOUNT_COLUMN, PCT_COLUMN, type ReportSheet, type SheetRow } from '../../vendor/scm/lib/report-sheet';
import { fmtPct } from '../../vendor/scm/lib/report-layout';
import { fmtSenPlain } from '../../vendor/shared/format';
import { monthName } from './reports/statementColumns';

export const PART_LABEL: Readonly<Record<ConversionPart, string>> = {
  this_month: "This month's orders",
  earlier: 'Earlier orders',
  other: 'Other DOs',
};

export const OTHER_REASON_LABEL: Readonly<Record<OtherReason, string>> = {
  no_order: 'No sales order',
  order_not_found: 'Order not found',
  order_after: 'Order dated after the DO',
};

/** What the list shows: every DO of the month, or one part's. */
export type PartView = 'all' | ConversionPart;

export const partViewOf = (v: string | null): PartView =>
  (v === 'this_month' || v === 'earlier' || v === 'other' ? v : 'all');

export const rowsOfPart = (rows: readonly ConversionRow[], view: PartView): ConversionRow[] =>
  (view === 'all' ? [...rows] : rows.filter((r) => r.part === view));

/** Where a DO's order sits: this month, an earlier month, or why it is in neither. */
export function fromText(r: ConversionRow): string {
  if (r.part === 'this_month') return 'This month';
  if (r.part === 'earlier') return r.soDate ? `Earlier · ${monthName(r.soDate)}` : 'Earlier';
  return r.otherReason ? OTHER_REASON_LABEL[r.otherReason] : PART_LABEL.other;
}

export const dosText = (n: number): string => `${n} ${n === 1 ? 'DO' : 'DOs'}`;

export const shareText = (pct: number | null): string => (pct === null ? '—' : fmtPct(pct));

/** The parts the report shows, in order: Other DOs only when the month has one. */
export const partsShown = (d: SoDoConversionData): ConversionPart[] =>
  (d.parts.other.dos > 0 ? ['this_month', 'earlier', 'other'] : ['this_month', 'earlier']);

export const CONVERSION_NOTES: readonly string[] = [
  'A delivery order counts in the month of its DO date once it has shipped: Draft and Cancelled DOs are left out.',
  "Its part is the SO date of the order it was raised from: this month's orders, or earlier orders. Orders brought over from AutoCount are earlier orders.",
  "Amount is the DO's total. The % is its share of the month's DO total.",
  'Other DOs: a DO with no sales order, or one whose order is dated after the DO.',
];

const TEXT = (label: string) => ({ label, kind: 'text' as const, align: 'left' as const });

/** Excel, PDF and Print: the parts with their totals and shares, then the DOs listed. */
export function conversionSheet(d: SoDoConversionData, view: PartView): ReportSheet {
  const period = monthName(d.from);
  const summary: SheetRow[] = partsShown(d).map((p) => ({
    kind: 'row', depth: 0, label: PART_LABEL[p], cells: [dosText(d.parts[p].dos), d.parts[p].amountSen, d.parts[p].pct],
  }));
  summary.push({ kind: 'total', depth: 0, label: 'Total', cells: [dosText(d.total.dos), d.total.amountSen, d.total.pct] });
  const listed = rowsOfPart(d.rows, view);
  const lines: SheetRow[] = listed.map((r) => ({
    kind: 'row', depth: 0, label: r.doNumber,
    cells: [r.doDate, r.docNo ?? '', r.soDate ?? '', r.customer ?? '', `${fromText(r)}${r.imported ? ' (imported)' : ''}`, r.amountSen],
  }));
  lines.push({ kind: 'total', depth: 0, label: 'Total', cells: [null, null, null, null, dosText(listed.length), listed.reduce((s, r) => s + r.amountSen, 0)] });
  return {
    title: 'SO to DO conversion',
    subtitle: `${period} · by DO date · shipped DOs${view === 'all' ? '' : ` · ${PART_LABEL[view].toLowerCase()}`} · RM`,
    meta: [
      { label: 'Month', value: period },
      { label: 'DOs', value: `${d.total.dos} · RM ${fmtSenPlain(d.total.amountSen)}` },
      { label: PART_LABEL.this_month, value: `RM ${fmtSenPlain(d.parts.this_month.amountSen)} · ${shareText(d.parts.this_month.pct)}` },
    ],
    tables: [
      { title: 'Summary', labelHeader: 'From', columns: [TEXT('DOs'), AMOUNT_COLUMN(), PCT_COLUMN('% of total')], rows: summary },
      {
        title: view === 'all' ? 'Delivery orders' : `Delivery orders · ${PART_LABEL[view]}`,
        labelHeader: 'DO',
        columns: [TEXT('DO date'), TEXT('Order'), TEXT('Order date'), { ...TEXT('Customer'), width: 30 }, TEXT('From'), AMOUNT_COLUMN()],
        rows: lines,
      },
    ],
    notes: [...CONVERSION_NOTES],
  };
}
