// ----------------------------------------------------------------------------
// credit-note-pdf — the Credit / Debit Note print (owner 2026-09-12: 打印版，根据
// PV/OR PDF 可以; CN 要显示它关的 DI 号和 final invoice 号; docs/bugs/0834).
//
// The Payment Voucher's shape: letterhead, note number and date on the right,
// the party and the papers the note answers (sales order, the deposit invoice
// it closes, the final invoice, a free reference, the reason), one line per
// account with the amount, TOTAL, the amount in words, a prepared-by box.
// The title is the kind's — CREDIT NOTE, DEBIT NOTE, SUPPLIER CREDIT NOTE.
// A DRAFT prints with a DRAFT watermark, a CANCELLED note with CANCELLED.
// Several notes print as ONE document, a page each, in list order.
// ----------------------------------------------------------------------------

import {
  drawHeader, drawTwoColInfo, drawSignatureBoxes, deliverPdf, deliverPdfBlob,
  amountInWordsMyr, fmtRm, fmtDocDate, safeName, DOC_TABLE_STYLES, DOC_TABLE_HEAD_STYLES, type PdfAction,
} from './pdf-common';

export type CreditNotePdfHeader = {
  note_number: string;
  kind: 'CN' | 'DN' | 'SCN';
  status: string;            // DRAFT | POSTED | CANCELLED
  note_date: string;
  party_name: string | null;
  party_code: string | null;
  so_doc_no: string | null;
  source_doc_no: string | null;
  sales_invoice_number?: string | null;
  reason: string | null;
  total_sen: number;
  je_no: string | null;
};
export type CreditNotePdfLine = { description: string | null; account_code: string; amount_sen: number };

const KIND_TITLE: Record<CreditNotePdfHeader['kind'], string> = {
  CN: 'CREDIT NOTE', DN: 'DEBIT NOTE', SCN: 'SUPPLIER CREDIT NOTE',
};

/** A deposit invoice number under any company's prefix: {co}-DI-YYMM-NNN. */
const looksLikeDepositInvoice = (s: string | null): boolean => /-DI-\d{4}-\d+$/.test(String(s ?? ''));

type JsPdf = import('jspdf').jsPDF;
type AutoTable = typeof import('jspdf-autotable').default;

/** Draw one note onto the CURRENT page of `doc` (A4 portrait). */
export function renderCreditNoteInto(
  doc: JsPdf,
  autoTable: AutoTable,
  h: CreditNotePdfHeader,
  lines: CreditNotePdfLine[],
  accountName: (code: string) => string | null,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const startPage = doc.getNumberOfPages();

  let y = drawHeader(doc, {
    docTitle: KIND_TITLE[h.kind],
    rightMeta: [
      { label: 'Note No', value: h.note_number },
      { label: 'Date', value: fmtDocDate(h.note_date) },
    ],
  });

  const closesDeposit = looksLikeDepositInvoice(h.source_doc_no);
  y = drawTwoColInfo(doc, y + 2, h.kind === 'SCN' ? 'SUPPLIER' : 'CUSTOMER', 'REFERENCES',
    [
      h.party_name || '—',
      h.party_code ? `Code: ${h.party_code}` : null,
    ],
    [
      h.so_doc_no ? `Sales order: ${h.so_doc_no}` : null,
      closesDeposit ? `Deposit invoice: ${h.source_doc_no}` : null,
      h.sales_invoice_number ? `Final invoice: ${h.sales_invoice_number}` : null,
      !closesDeposit && h.source_doc_no ? `Reference: ${h.source_doc_no}` : null,
      h.reason ? `Reason: ${h.reason}` : null,
    ]);

  const rows = lines.map((l, idx) => [
    String(idx + 1),
    l.description?.trim() ? l.description : '—',
    l.account_code,
    accountName(l.account_code) ?? '—',
    fmtRm(Number(l.amount_sen)),
  ]);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Account Code', 'Account Name', 'Amount']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 74 },
      2: { cellWidth: 26, fontStyle: 'bold' },
      3: { cellWidth: 40 },
      4: { cellWidth: 34, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  const totalsX = pageW - margin - 70;
  doc.setDrawColor(0); doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('TOTAL', totalsX, ty + 3);
  doc.text(fmtRm(h.total_sen), pageW - margin, ty + 3, { align: 'right' });
  ty += 8;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text(amountInWordsMyr(h.total_sen), margin, ty, { maxWidth: pageW - margin * 2 });
  ty += 8;

  drawSignatureBoxes(doc, ty + 6, 'Prepared by', 'Company chop');

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(h.note_number, margin, 290);
    if (h.je_no) doc.text(`Journal ${h.je_no}`, pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
    if (h.status !== 'POSTED') {
      const pageH = doc.internal.pageSize.getHeight();
      doc.saveGraphicsState();
      doc.setGState(doc.GState({ opacity: 0.14 }));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(64);
      doc.setTextColor(180, 30, 30);
      doc.text(h.status === 'CANCELLED' ? 'CANCELLED' : 'DRAFT', pageW / 2, pageH / 2, { align: 'center', angle: 30 });
      doc.restoreGraphicsState();
      doc.setTextColor(0, 0, 0);
    }
  }
  doc.setPage(pageCount);
}

const load = async (): Promise<{ jsPDF: typeof import('jspdf').jsPDF; autoTable: AutoTable }> => {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return { jsPDF, autoTable };
};

export async function generateCreditNotePdf(
  h: CreditNotePdfHeader,
  lines: CreditNotePdfLine[],
  accountName: (code: string) => string | null,
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF, autoTable } = await load();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  renderCreditNoteInto(doc, autoTable, h, lines, accountName);
  deliverPdf(doc, `${h.note_number}-${safeName(h.party_name ?? h.kind)}.pdf`, opts?.action);
}

/** Several notes as ONE document, each starting on a fresh page, in the order given. */
export async function generateCreditNotesPdf(
  items: Array<{ header: CreditNotePdfHeader; lines: CreditNotePdfLine[] }>,
  accountName: (code: string) => string | null,
  opts?: { action?: PdfAction },
): Promise<void> {
  if (items.length === 0) return;
  const { jsPDF, autoTable } = await load();
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  items.forEach((it, i) => {
    if (i > 0) doc.addPage();
    renderCreditNoteInto(doc, autoTable, it.header, it.lines, accountName);
  });
  deliverPdfBlob(doc.output('blob'), 'credit-notes.pdf', opts?.action ?? 'save');
}
