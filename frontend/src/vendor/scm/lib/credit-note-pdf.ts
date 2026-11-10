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
//
// The owner's Claude Design (batch 5 §9.1): a note to a customer or an other
// debtor takes the A4 family — CUSTOMER beside NOTE DETAILS (the papers it
// answers and why), each line's description and amount with the accounts off
// the paper, TOTAL CREDIT / TOTAL DEBIT, the amount in words, Issued by and the
// company chop. A supplier's credit note (Money out) keeps its paper.
//
// A credit note to a customer or an other debtor prints what it knocked off
// (the design's KNOCKED OFF AGAINST, owner 2026-11-03: 「要」): each invoice with
// its date, its amount and the part taken, then what is left as credit on the
// account — a close-out names the final invoice it closed against.
// ----------------------------------------------------------------------------

import {
  drawHeader, drawInfoColumns, drawTwoColInfo, drawSignatureBoxes, deliverPdf, deliverPdfBlob,
  amountInWordsMyr, fmtRm, fmtDocDate, safeName, DOC_TABLE_STYLES, DOC_TABLE_HEAD_STYLES, type PdfAction,
} from './pdf-common';
import type { CreditNoteDetail } from './credit-note-queries';
import { PDF_COMPRESS } from './pdf-options';

export type CreditNotePdfHeader = {
  note_number: string;
  kind: 'CN' | 'DN' | 'SCN' | 'OCN';
  status: string;            // DRAFT | POSTED | CANCELLED
  note_date: string;
  party_name: string | null;
  party_code: string | null;
  /** An other debtor's account code, read off the registry beside the note (its party_code stays blank). */
  debtor_code?: string | null;
  so_doc_no: string | null;
  source_doc_no: string | null;
  sales_invoice_number?: string | null;
  reason: string | null;
  total_sen: number;
  je_no: string | null;
};
export type CreditNotePdfLine = { description: string | null; account_code: string; amount_sen: number };

/** What a credit note knocked off — each document with its date, its amount and
    the part taken — and the credit it leaves on the account. */
export type CreditNoteKnockedOff = {
  rows: Array<{ number: string; date: string | null; totalSen: number | null; knockedSen: number }>;
  leftSen: number;
};

/** The block off a note's detail: a posted note's knock-offs (a draft's plan),
    or the final invoice a close-out closed against. Null when there is none to
    print: a debit note, a supplier's, a refund's or a move's, a cancelled one. */
export function knockedOffOf(d: Pick<CreditNoteDetail, 'note' | 'allocations' | 'depositPaper' | 'closedInvoice'>): CreditNoteKnockedOff | null {
  const n = d.note;
  if ((n.kind !== 'CN' && n.kind !== 'OCN') || n.status === 'CANCELLED') return null;
  if (d.depositPaper) {
    return d.depositPaper.kind === 'closes' && d.closedInvoice
      ? { rows: [{ number: d.closedInvoice.number, date: d.closedInvoice.date, totalSen: d.closedInvoice.totalSen, knockedSen: Number(n.total_sen) }], leftSen: 0 }
      : null;
  }
  const posted = n.status === 'POSTED';
  const rows = (d.allocations ?? [])
    .map((a) => ({ number: a.number ?? '—', date: a.docDate ?? null, totalSen: a.docTotalSen ?? null, knockedSen: posted ? a.appliedSen : a.amountSen }))
    .filter((r) => r.knockedSen > 0);
  return { rows, leftSen: Math.max(0, Number(n.total_sen) - rows.reduce((sum, r) => sum + r.knockedSen, 0)) };
}

/* An other debtor's credit note prints as the debtor's bill does — to the
   party it billed, under CUSTOMER (2026-10-28). */
const KIND_TITLE: Record<CreditNotePdfHeader['kind'], string> = {
  CN: 'CREDIT NOTE', DN: 'DEBIT NOTE', SCN: 'SUPPLIER CREDIT NOTE', OCN: 'CREDIT NOTE',
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
  knockedOff: CreditNoteKnockedOff | null = null,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const startPage = doc.getNumberOfPages();

  const y = drawHeader(doc, {
    docTitle: KIND_TITLE[h.kind],
    rightMeta: [
      { label: 'Note No', value: h.note_number },
      { label: 'Date', value: fmtDocDate(h.note_date) },
    ],
  });

  const closesDeposit = looksLikeDepositInvoice(h.source_doc_no);
  /* A note to a customer or an other debtor takes the design's A4 family; a supplier's keeps its paper. */
  if (h.kind === 'SCN') renderSupplierNoteBody(doc, autoTable, h, lines, accountName, y, closesDeposit);
  else renderCustomerNoteBody(doc, autoTable, h, lines, accountName, y, closesDeposit, knockedOff);

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

/** A supplier's credit note below the letterhead (Money out): SUPPLIER and the papers it answers, each line with its account, TOTAL, Prepared by. */
function renderSupplierNoteBody(
  doc: JsPdf,
  autoTable: AutoTable,
  h: CreditNotePdfHeader,
  lines: CreditNotePdfLine[],
  accountName: (code: string) => string | null,
  startY: number,
  closesDeposit: boolean,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = startY;
  y = drawTwoColInfo(doc, y + 2, 'SUPPLIER', 'REFERENCES',
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
}

const noteStatusWord = (s: string): string => (s === 'DRAFT' ? 'Draft' : s === 'CANCELLED' ? 'Cancelled' : s === 'POSTED' ? 'Posted' : s);

/** A customer's or other debtor's note below the letterhead: CUSTOMER and NOTE
 *  DETAILS, the lines without our accounts, TOTAL CREDIT / DEBIT, the words,
 *  Issued by. */
function renderCustomerNoteBody(
  doc: JsPdf,
  autoTable: AutoTable,
  h: CreditNotePdfHeader,
  lines: CreditNotePdfLine[],
  accountName: (code: string) => string | null,
  startY: number,
  closesDeposit: boolean,
  knockedOff: CreditNoteKnockedOff | null,
): void {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = drawInfoColumns(doc, startY,
    { title: 'CUSTOMER', rows: [['Name', h.party_name || '—'], ['Code', h.party_code ?? h.debtor_code ?? null]] },
    {
      title: 'NOTE DETAILS',
      rows: [
        ['Note No', h.note_number],
        ['Date', fmtDocDate(h.note_date)],
        ['Sales order', h.so_doc_no],
        ['Deposit invoice', closesDeposit ? h.source_doc_no : null],
        ['Final invoice', h.sales_invoice_number ?? null],
        ['Reference', !closesDeposit ? h.source_doc_no : null],
        ['Reason', h.reason],
        ['Status', noteStatusWord(h.status)],
      ],
    },
  );
  /* What it is for and how much — the account behind a line stays off the paper; an unnamed line reads as its account's name. */
  const rows = lines.map((l, idx) => [
    String(idx + 1),
    l.description?.trim() ? l.description : (accountName(l.account_code) ?? '—'),
    fmtRm(Number(l.amount_sen)),
  ]);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Amount']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 9 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 8, halign: 'right' }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 36, halign: 'right' } },
    margin: { left: margin, right: margin },
  });
  y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  const totalsX = pageW - margin - 70;
  doc.setDrawColor(0); doc.line(totalsX, y - 2, pageW - margin, y - 2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(h.kind === 'DN' ? 'TOTAL DEBIT' : 'TOTAL CREDIT', totalsX, y + 3);
  doc.text(fmtRm(h.total_sen), pageW - margin, y + 3, { align: 'right' });
  y += 10;
  if (h.kind !== 'DN' && knockedOff && (knockedOff.rows.length > 0 || knockedOff.leftSen > 0)) {
    /* What it knocked off, then what stays as credit on the account (the design's words). */
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('KNOCKED OFF AGAINST', margin, y);
    const body = knockedOff.rows.map((r) => [r.number, r.date ? fmtDocDate(r.date) : '', r.totalSen == null ? '' : fmtRm(r.totalSen), fmtRm(r.knockedSen)]);
    if (knockedOff.leftSen > 0) {
      body.push([knockedOff.rows.length > 0 ? 'Not applied · credit on account' : 'Not knocked off · credit on account', '', '', fmtRm(knockedOff.leftSen)]);
    }
    const lastBold = knockedOff.leftSen > 0 ? body.length - 1 : -1;
    autoTable(doc, {
      startY: y + 2,
      head: [['Invoice No', 'Date', 'Invoice amount', 'Knocked off']],
      body,
      theme: 'plain',
      rowPageBreak: 'avoid',
      styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
      headStyles: DOC_TABLE_HEAD_STYLES,
      columnStyles: { 0: { cellWidth: 'auto' }, 1: { cellWidth: 28 }, 2: { cellWidth: 34, halign: 'right' }, 3: { cellWidth: 34, halign: 'right' } },
      margin: { left: margin, right: margin },
      didParseCell: (data) => { if (data.section === 'body' && data.row.index === lastBold) data.cell.styles.fontStyle = 'bold'; },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 8;
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('RINGGIT (IN WORDS)', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(h.total_sen), margin, y + 4, { maxWidth: pageW - margin * 2 });
  y += 10;
  drawSignatureBoxes(doc, y + 4, 'Issued by', 'Company chop');
}

const load = async (): Promise<{ jsPDF: typeof import('jspdf').jsPDF; autoTable: AutoTable }> => {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return { jsPDF, autoTable };
};

export async function generateCreditNotePdf(
  h: CreditNotePdfHeader,
  lines: CreditNotePdfLine[],
  accountName: (code: string) => string | null,
  opts?: { action?: PdfAction; knockedOff?: CreditNoteKnockedOff | null },
): Promise<void> {
  const { jsPDF, autoTable } = await load();
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  renderCreditNoteInto(doc, autoTable, h, lines, accountName, opts?.knockedOff ?? null);
  deliverPdf(doc, `${h.note_number}-${safeName(h.party_name ?? h.kind)}.pdf`, opts?.action);
}

/** Several notes as ONE document, each starting on a fresh page, in the order given. */
export async function generateCreditNotesPdf(
  items: Array<{ header: CreditNotePdfHeader; lines: CreditNotePdfLine[]; knockedOff?: CreditNoteKnockedOff | null }>,
  accountName: (code: string) => string | null,
  opts?: { action?: PdfAction },
): Promise<void> {
  if (items.length === 0) return;
  const { jsPDF, autoTable } = await load();
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  items.forEach((it, i) => {
    if (i > 0) doc.addPage();
    renderCreditNoteInto(doc, autoTable, it.header, it.lines, accountName, it.knockedOff ?? null);
  });
  deliverPdfBlob(doc.output('blob'), 'credit-notes.pdf', opts?.action ?? 'save');
}
