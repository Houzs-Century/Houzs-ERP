// ----------------------------------------------------------------------------
// pv-list-pdf: the Payment vouchers list on paper (owner 2026-11-09: 「我filter 了，
// right click header print 不行？」). The header's right-click Export to PDF prints
// what the screen shows — the columns showing, in their order, the rows the stage,
// the month, the search and the funnels leave — on the listing paper (listing-pdf.ts)
// the Payment listing prints on. The row's buttons stay on the screen. The Amount
// prints in RM, a voucher in another currency with its own amount under the ringgit,
// totalled as the footer totals (pv-list-total.ts): a cancelled voucher is listed,
// not counted.
// ----------------------------------------------------------------------------

import autoTable from 'jspdf-autotable';
import type { PdfAction } from './pdf-common';
import { fmtMoneySen, fmtSenPlain, todayMY } from '../../shared/format';
import { closeListing, listingDress, openListing, screenTable, type FootCell, type ScreenTableView } from './listing-pdf';
import { isForeignPv, pvListTotal, ringgitSenOfPv, type PvMoneyRow } from './pv-list-total';

export type PvListView = ScreenTableView & { rows: readonly PvMoneyRow[] };

/** The row's next-step buttons: a screen's door, not a line on paper. */
const SCREEN_ONLY = new Set(['next_step']);
const AMOUNT_KEY = 'total_sen';
/** The grid's Date leaves as ISO text; on paper it reads as the screen shows it. */
const DATE_KEYS = new Set(['voucher_date']);

/** The table exactly as printed: pure, so a test reads the cells and the total without a PDF. */
export function pvListTable(view: PvListView): {
  head: string[]; body: string[][]; foot: FootCell[] | null; totalSen: number | null; cancelled: number; figures: boolean[];
} {
  const keep = view.keys.flatMap((k, i) => (SCREEN_ONLY.has(k) ? [] : [i]));
  const pick = <V>(cells: readonly V[]): V[] => keep.map((i) => cells[i] as V);
  const keys = pick(view.keys);
  const amountAt = keys.indexOf(AMOUNT_KEY);
  /* The Amount in ringgit: the screen's cell is in the voucher's own currency. */
  const matrix = {
    header: pick(view.matrix.header).map((h, c) => (c === amountAt ? 'Amount (RM)' : h)),
    formats: pick(view.matrix.formats).map((f, c) => (c === amountAt ? 'money' : DATE_KEYS.has(keys[c] ?? '') ? 'date' : f)),
    body: view.matrix.body.map((row, i) => pick(row).map((v, c) => (c === amountAt ? ringgitSenOfPv(view.rows.at(i) ?? {}) / 100 : v))),
  };
  const { head, body } = screenTable({ keys, matrix });
  const figures = matrix.formats.map((f) => f === 'money' || f === 'number');
  if (amountAt < 0) return { head, body, foot: null, totalSen: null, cancelled: 0, figures };

  const printed = body.map((cells, i) => {
    const r = view.rows.at(i);
    return r && isForeignPv(r)
      ? cells.map((cell, c) => (c === amountAt ? `${cell}\n${fmtMoneySen(Number(r.total_sen ?? 0), String(r.currency))}` : cell))
      : cells;
  });
  const t = pvListTotal(view.rows);
  const n = body.length;
  const label = `Total (${n} row${n === 1 ? '' : 's'}${t.cancelled > 0 ? `, ${t.cancelled} cancelled not counted` : ''})`;
  const total = fmtSenPlain(t.sen);
  const after = head.length - amountAt - 1;
  const foot: FootCell[] = amountAt === 0
    ? [total, ...(after > 0 ? [{ content: label, colSpan: after }] : [])]
    : [{ content: label, colSpan: amountAt }, total, ...(after > 0 ? [{ content: '', colSpan: after }] : [])];
  return { head, body: printed, foot, totalSen: t.sen, cancelled: t.cancelled, figures };
}

/** The first sentence on top: what the screen was cut to. Plain quotes, so the letterhead font prints them. */
export function pvListCutTo(f: { stage: string; month: string; search: string }): string {
  const lead = 'Payment vouchers as filtered on the screen.';
  return f.search
    ? `${lead} Search: "${f.search}", any stage and month.`
    : `${lead} Stage: ${f.stage}. Month: ${f.month || 'All months'}.`;
}

export async function generatePvListPdf(view: PvListView, opts: { cutTo: string; action?: PdfAction }): Promise<void> {
  const t = pvListTable(view);
  const subtitle = [
    opts.cutTo,
    'All amounts in RM; a voucher in another currency shows its own amount under the ringgit.',
    t.cancelled > 0 ? 'Cancelled vouchers are listed but not counted in the total.' : '',
  ].filter(Boolean).join(' ');
  const meta = [
    { label: 'Vouchers', value: String(t.body.length) },
    ...(t.totalSen == null ? [] : [{ label: 'Total', value: `RM ${fmtSenPlain(t.totalSen)}` }]),
  ];
  const { doc, startY } = await openListing('PAYMENT LISTING', meta, subtitle, t);
  autoTable(doc, {
    ...listingDress(8),
    startY,
    head: [t.head],
    body: t.body,
    ...(t.foot ? { foot: [t.foot] } : {}),
    didParseCell: (d) => { if (t.figures[d.column.index]) d.cell.styles.halign = 'right'; },
  });
  closeListing(doc, `payment-vouchers-${todayMY()}.pdf`, opts.action);
}
