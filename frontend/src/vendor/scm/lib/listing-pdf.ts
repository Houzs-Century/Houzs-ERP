// ----------------------------------------------------------------------------
// listing-pdf: a list on paper, as the AR and AP listings print. Landscape A4 on
// the shared letterhead, a sentence on top, the autoTable dress every document
// wears, "Page n of m" at the foot. A screen's table prints WHAT THE SCREEN SHOWS:
// the columns the reader has showing, in their order, the cells its Excel holds,
// the money column totalled. Merchant reports (merchant-recon-pdf.ts) and the
// Payment listing (payment-listing-pdf.ts) print with it.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, type PdfAction,
} from './pdf-common';
import { fmtSenPlain } from '../../shared/format';
import { PDF_COMPRESS } from './pdf-options';

export type Rgb = [number, number, number];
export type Meta = { label: string; value: string };
export type FootCell = string | { content: string; colSpan: number };

/** The cells a table's Excel would hold (DataTable's `onExportPdf`). Money is in ringgit there. */
export type ScreenTableView = {
  keys: string[];
  matrix: { header: string[]; formats: string[]; body: Array<Array<string | number | null>> };
};

export const LISTING_MARGIN = 14;
export const LISTING_CELL = { top: 1.2, bottom: 1.2, left: 1.5, right: 1.5 };
const TOTAL_FILL: Rgb = [236, 238, 234];

const cellText = (v: string | number | null | undefined, format: string | undefined): string => {
  if (v === null || v === undefined || v === '') return '-';
  if (format === 'money' && typeof v === 'number') return fmtSenPlain(Math.round(v * 100));
  if (format === 'date') return fmtDocDate(String(v));
  return String(v);
};

/** A screen's table exactly as drawn, its money column totalled: pure, so a test reads the cells and the total without a PDF. */
export function screenTable({ matrix }: ScreenTableView): {
  head: string[]; body: string[][]; foot: FootCell[] | null; totalSen: number | null;
} {
  const body = matrix.body.map((row) => row.map((v, c) => cellText(v, matrix.formats[c])));
  const moneyCol = matrix.formats.indexOf('money');
  const count = matrix.body.length;
  const label = `Total (${count} row${count === 1 ? '' : 's'})`;
  const width = matrix.header.length;
  let foot: FootCell[] | null = null;
  let totalSen: number | null = null;
  if (moneyCol >= 0) {
    totalSen = matrix.body.reduce((s, row) => s + Math.round(Number(row[moneyCol] ?? 0) * 100), 0);
    const total = fmtSenPlain(totalSen);
    const after = width - moneyCol - 1;
    foot = moneyCol === 0
      ? [total, { content: label, colSpan: after }]
      : [{ content: label, colSpan: moneyCol }, total, ...(after > 0 ? [{ content: '', colSpan: after }] : [])];
  }
  return { head: matrix.header, body, foot, totalSen };
}

export async function openListing(title: string, meta: Meta[], subtitle: string, payload: unknown): Promise<{ doc: jsPDF; startY: number }> {
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4', orientation: 'landscape' });
  /* The sentence on top carries 未标 too: a field missed here would print as mojibake. */
  await ensurePdfCjkFont(doc, { payload, meta, subtitle });
  const y = drawHeader(doc, { docTitle: title, rightMeta: [...meta, { label: 'Printed', value: fmtDocStamp() }] });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
  doc.text(subtitle, LISTING_MARGIN, y + 2, { maxWidth: doc.internal.pageSize.getWidth() - LISTING_MARGIN * 2 });
  doc.setTextColor(0);
  return { doc, startY: y + 7 };
}

export const listingDress = (fontSize: number) => ({
  theme: 'plain' as const,
  rowPageBreak: 'avoid' as const,
  showFoot: 'lastPage' as const,
  styles: { ...DOC_TABLE_STYLES, fontSize, cellPadding: LISTING_CELL },
  headStyles: DOC_TABLE_HEAD_STYLES,
  footStyles: { fontStyle: 'bold' as const, fillColor: TOTAL_FILL },
  margin: { left: LISTING_MARGIN, right: LISTING_MARGIN, top: 12, bottom: 12 },
});

export function closeListing(doc: jsPDF, fileName: string, action: PdfAction = 'preview'): void {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
    doc.text(`Page ${i} of ${pages}`, w - LISTING_MARGIN, h - 7, { align: 'right' });
  }
  doc.setTextColor(0);
  deliverPdf(doc, fileName, action);
}
