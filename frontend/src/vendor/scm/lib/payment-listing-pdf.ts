// ----------------------------------------------------------------------------
// payment-listing-pdf: the Payment listing on paper (owner 2026-11-08: 每天要过账
// 的 listing). What the screen shows, landscape A4 on the letterhead
// (listing-pdf.ts): the columns showing, in their order, the Amount totalled in
// RM; a voucher in another currency prints its own amount under the ringgit.
// ----------------------------------------------------------------------------

import autoTable from 'jspdf-autotable';
import type { PdfAction } from './pdf-common';
import { fmtMoneySen, fmtSenPlain, todayMY } from '../../shared/format';
import { closeListing, listingDress, openListing, screenTable, type FootCell, type ScreenTableView } from './listing-pdf';

/** What a printed row needs beyond its cells: a voucher not in ringgit prints its own amount too. */
type Own = { currency?: string | null; total_sen?: number | null };
export type PaymentListingView = ScreenTableView & { rows: readonly Own[] };

/** The table exactly as drawn: pure, so a test reads the cells and the total without a PDF. */
export function paymentListingTable(view: PaymentListingView): {
  head: string[]; body: string[][]; foot: FootCell[] | null; totalSen: number | null;
} {
  const t = screenTable(view);
  const amount = view.keys.indexOf('amount');
  if (amount < 0) return t;
  return {
    ...t,
    body: t.body.map((cells, i) => {
      const r = view.rows.at(i);
      const cur = String(r?.currency ?? 'MYR').toUpperCase();
      return cur === 'MYR' ? cells : cells.map((c, j) => (j === amount ? `${c}\n${fmtMoneySen(Number(r?.total_sen ?? 0), cur)}` : c));
    }),
  };
}

export async function generatePaymentListingPdf(view: PaymentListingView, opts: { subtitle: string; action?: PdfAction }): Promise<void> {
  const t = paymentListingTable(view);
  const meta = [
    { label: 'Vouchers', value: String(t.body.length) },
    ...(t.totalSen == null ? [] : [{ label: 'Total', value: `RM ${fmtSenPlain(t.totalSen)}` }]),
  ];
  const { doc, startY } = await openListing('PAYMENT LISTING', meta, opts.subtitle, t);
  const figure = (c: number) => view.matrix.formats[c] === 'money' || view.matrix.formats[c] === 'number';
  autoTable(doc, {
    ...listingDress(8),
    startY,
    head: [t.head],
    body: t.body,
    ...(t.foot ? { foot: [t.foot] } : {}),
    didParseCell: (d) => { if (figure(d.column.index)) d.cell.styles.halign = 'right'; },
  });
  closeListing(doc, `payment-listing-${todayMY()}.pdf`, opts.action);
}
