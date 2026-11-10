// ----------------------------------------------------------------------------
// receipt-a4-pdf — the A4 RECEIPT every Money-in receipt that is not an
// official receipt prints on (the owner's Claude Design, batch 5 §9): a sundry
// receipt and an other debtor's receipt. The A4 family's shape — the
// letterhead with RECEIPT, its number and date on the right; RECEIVED FROM
// beside RECEIPT DETAILS; the lines as the reader needs them (what it was
// for and how much — our accounts stay off the paper); AMOUNT RECEIVED over a
// double rule; the amount in words; a note; Received by and the company chop.
// A voided receipt prints VOID across it, one not yet approved DRAFT.
//
// sundry-receipt-pdf.ts and debtor-receipt-pdf.ts turn their receipts into
// this paper; several print as ONE document, a page each, in list order.
// ----------------------------------------------------------------------------

import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, amountInWordsMyr, deliverPdf, drawHeader, drawInfoColumns, drawSignatureBoxes,
  ensurePdfCjkFont, fmtDocDate, fmtRm, type PdfAction,
} from './pdf-common';
import { PDF_COMPRESS } from './pdf-options';

/** One receipt as the A4 paper draws it. */
export type A4ReceiptPaper = {
  number: string;
  /** ISO date. */
  date: string;
  /** RECEIVED FROM — label, value; a blank value is left out. */
  from: Array<[string, string | null | undefined]>;
  /** RECEIPT DETAILS — label, value; a blank value is left out. */
  details: Array<[string, string | null | undefined]>;
  lines: Array<{ description: string; amountSen: number }>;
  totalSen: number;
  note?: string | null;
  watermark?: 'DRAFT' | 'VOID' | null;
  /** The file's name, before `.pdf`. */
  fileStem: string;
};

type JsPdf = import('jspdf').jsPDF;
type AutoTable = (doc: JsPdf, options: Record<string, unknown>) => void;

/** Draw one receipt from the CURRENT page of `doc` (A4 portrait). */
export async function renderA4ReceiptInto(doc: JsPdf, autoTable: AutoTable, p: A4ReceiptPaper): Promise<void> {
  /* A Chinese payer or description needs the font up front, or helvetica paints mojibake. */
  await ensurePdfCjkFont(doc, p);
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: 'RECEIPT',
    rightMeta: [
      { label: 'Receipt No', value: p.number },
      { label: 'Date', value: fmtDocDate(p.date) },
    ],
  });
  y = drawInfoColumns(doc, y, { title: 'RECEIVED FROM', rows: p.from }, { title: 'RECEIPT DETAILS', rows: p.details });

  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Amount']],
    body: p.lines.map((l, i) => [String(i + 1), l.description, fmtRm(l.amountSen)]),
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 9 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 8, halign: 'right' }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 36, halign: 'right' } },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  /* AMOUNT RECEIVED over a double rule — what the paper is for. */
  const totalsX = pageW - margin - 80;
  doc.setDrawColor(0);
  doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.line(totalsX, ty - 1.2, pageW - margin, ty - 1.2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('AMOUNT RECEIVED', totalsX, ty + 4);
  doc.text(fmtRm(p.totalSen), pageW - margin, ty + 4, { align: 'right' });
  ty += 12;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('RINGGIT (IN WORDS)', margin, ty);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(p.totalSen), margin, ty + 4, { maxWidth: pageW - margin * 2 });
  ty += 10;

  if (p.note?.trim()) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('NOTE', margin, ty);
    doc.setFont('helvetica', 'normal');
    doc.text(p.note.trim(), margin, ty + 4, { maxWidth: pageW - margin * 2 });
    ty += 10;
  }

  drawSignatureBoxes(doc, ty + 4, 'Received by', 'Company chop');

  /* The watermark LAST, over everything: a voided or unapproved receipt must read as one from across the counter. */
  if (p.watermark) {
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(80);
    doc.setTextColor(180, 30, 30);
    doc.text(p.watermark, pageW / 2, pageH / 2, { align: 'center', angle: 30 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
  }
}

const tools = async (): Promise<{ doc: JsPdf; autoTable: AutoTable }> => {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return { doc: new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4', orientation: 'portrait' }), autoTable: autoTableModule.default as unknown as AutoTable };
};

/** One receipt, or several as ONE document — a page each, in the order given. */
export async function generateA4ReceiptsPdf(papers: A4ReceiptPaper[], opts?: { action?: PdfAction; fileName?: string }): Promise<void> {
  if (papers.length === 0) return;
  const { doc, autoTable } = await tools();
  for (let i = 0; i < papers.length; i += 1) {
    if (i > 0) doc.addPage('a4', 'portrait');
    await renderA4ReceiptInto(doc, autoTable, papers[i]!);
  }
  const name = opts?.fileName ?? (papers.length === 1 ? `${papers[0]!.fileStem}.pdf` : `receipts-${papers.length}.pdf`);
  deliverPdf(doc, name, opts?.action);
}
