// ----------------------------------------------------------------------------
// unmatched-payments-pdf: Payments not matched yet on paper (owner 2026-11-10:
// 也要支持pdf，这个export可以根据我显示的column 来export). One part per list —
// the merchant report lines, the payments, the bank's money in — each printing
// what its table shows: the columns showing, in their order, its money column
// totalled (listing-pdf.ts). One list's Export prints its part; Export all prints
// the three, each from a new page.
// ----------------------------------------------------------------------------

import autoTable from 'jspdf-autotable';
import type { PdfAction } from './pdf-common';
import { fmtSenPlain, todayMY } from '../../shared/format';
import { LISTING_MARGIN, closeListing, listingDress, openListing, screenTable, type FootCell, type ScreenTableView } from './listing-pdf';

export type UnmatchedPdfPart = { title: string; view: ScreenTableView };

/** Each part exactly as drawn: pure, so a test reads the cells and the totals without a PDF. */
export function unmatchedPdfTables(parts: readonly UnmatchedPdfPart[]): Array<{
  title: string; head: string[]; body: string[][]; foot: FootCell[] | null; totalSen: number | null; figures: boolean[];
}> {
  return parts.map((p) => {
    const t = screenTable(p.view);
    const figures = p.view.matrix.formats.map((f) => f === 'money' || f === 'number');
    return { title: `${p.title} — ${t.body.length} row${t.body.length === 1 ? '' : 's'}`, ...t, figures };
  });
}

export async function generateUnmatchedPdf(parts: readonly UnmatchedPdfPart[], opts: { subtitle: string; action?: PdfAction }): Promise<void> {
  const tables = unmatchedPdfTables(parts);
  const meta = tables.map((t, i) => ({
    label: parts[i]!.title,
    value: t.totalSen == null ? String(t.body.length) : `${t.body.length} · RM ${fmtSenPlain(t.totalSen)}`,
  }));
  const { doc, startY } = await openListing('PAYMENTS NOT MATCHED YET', meta, opts.subtitle, tables);
  tables.forEach((t, i) => {
    let y = startY;
    if (i > 0) { doc.addPage(); y = 16; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0);
    doc.text(t.title, LISTING_MARGIN, y);
    autoTable(doc, {
      ...listingDress(7.5),
      startY: y + 3,
      head: [t.head],
      body: t.body.length > 0 ? t.body : [[{ content: 'Nothing on this list for these dates.', colSpan: Math.max(1, t.head.length) }]],
      ...(t.foot && t.body.length > 0 ? { foot: [t.foot] } : {}),
      didParseCell: (d) => { if (t.figures[d.column.index]) d.cell.styles.halign = 'right'; },
    });
  });
  closeListing(doc, `payments-not-matched-${todayMY()}.pdf`, opts.action);
}
