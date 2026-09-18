// ----------------------------------------------------------------------------
// deposit-invoice-pdf — the Deposit Invoice print (owner 2026-09-12:
// 打印版，根据 PV/OR PDF 可以，需要显示 SO 号和付款方式，要批量打印; docs/bugs/0834).
//
// The Official Receipt's shape, because it is the same moment on the counter:
// letterhead, DI number and date on the right, BILL TO / DEPOSIT (the sales
// order it is for, how it was paid, the amount), the amount in words, an
// issued-by box. A CANCELLED invoice prints with a diagonal CANCELLED
// watermark and its reason — the paper must read as void from across the
// counter. Several invoices print as ONE document, a page each, in list order.
// ----------------------------------------------------------------------------

import {
  drawHeader, drawTwoColInfo, drawSignatureBoxes, deliverPdf, deliverPdfBlob,
  amountInWordsMyr, fmtRm, fmtDocDate, safeName, type PdfAction,
} from './pdf-common';
import { PAYMENT_METHOD_DEFAULT_LABELS } from './payment-methods';

export type DepositInvoicePdfData = {
  di_number: string;
  status: string;            // ISSUED | CANCELLED
  invoice_date: string;
  party_name: string | null;
  party_code: string | null;
  so_doc_no: string;
  method: string | null;
  amount_sen: number;
  je_no: string | null;
  credit_note_number?: string | null;
  cancel_reason?: string | null;
};

const labelOf: Record<string, string | undefined> = { ...PAYMENT_METHOD_DEFAULT_LABELS };
const methodLabel = (m: string | null): string => (m ? labelOf[m] ?? m : '—');

type JsPdf = import('jspdf').jsPDF;

/** Draw one deposit invoice onto the CURRENT page of `doc` (A5 landscape). */
export function renderDepositInvoiceInto(doc: JsPdf, d: DepositInvoicePdfData): void {
  let y = drawHeader(doc, {
    docTitle: 'DEPOSIT INVOICE',
    rightMeta: [
      { label: 'DI No', value: d.di_number },
      { label: 'Date', value: fmtDocDate(d.invoice_date) },
    ],
  });

  y = drawTwoColInfo(doc, y + 2, 'BILL TO', 'DEPOSIT',
    [
      d.party_name || '—',
      d.party_code ? `Customer code: ${d.party_code}` : null,
    ],
    [
      `Sales order: ${d.so_doc_no}`,
      `Paid by: ${methodLabel(d.method)}`,
      `Amount: ${fmtRm(d.amount_sen)}`,
      d.credit_note_number ? `Closed by credit note ${d.credit_note_number}` : null,
    ]);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('RINGGIT (IN WORDS)', 14, y + 2);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(d.amount_sen), 14, y + 7, { maxWidth: doc.internal.pageSize.getWidth() - 28 });
  y += 12;

  doc.setFontSize(8); doc.setTextColor(90);
  doc.text(`Deposit received against sales order ${d.so_doc_no}, recognised as a sale on receipt; closed by a credit note when the final invoice is issued.`, 14, y + 2, { maxWidth: doc.internal.pageSize.getWidth() - 28 });
  doc.setTextColor(0);
  y += 8;

  drawSignatureBoxes(doc, y + 2, 'Issued by', 'Company chop');

  /* The watermark LAST, over everything: a void invoice must read as void. */
  if (d.status === 'CANCELLED') {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(64);
    doc.setTextColor(180, 30, 30);
    doc.text('CANCELLED', pageW / 2, pageH / 2, { align: 'center', angle: 25 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
    if (d.cancel_reason) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(180, 30, 30);
      doc.text(`Cancelled: ${d.cancel_reason}`, 14, pageH - 8, { maxWidth: pageW - 28 });
      doc.setTextColor(0, 0, 0);
    }
  }
}

const newDoc = async (): Promise<JsPdf> => {
  const { jsPDF } = await import('jspdf');
  return new jsPDF({ unit: 'mm', format: 'a5', orientation: 'landscape' });
};

export async function generateDepositInvoicePdf(d: DepositInvoicePdfData, opts?: { action?: PdfAction }): Promise<void> {
  const doc = await newDoc();
  renderDepositInvoiceInto(doc, d);
  deliverPdf(doc, `${d.di_number}-${safeName(d.party_name ?? d.so_doc_no)}.pdf`, opts?.action);
}

/** Several invoices as ONE document, a page each, in the order given. */
export async function generateDepositInvoicesPdf(list: DepositInvoicePdfData[], opts?: { action?: PdfAction }): Promise<void> {
  if (list.length === 0) return;
  const doc = await newDoc();
  list.forEach((d, i) => {
    if (i > 0) doc.addPage('a5', 'landscape');
    renderDepositInvoiceInto(doc, d);
  });
  deliverPdfBlob(doc.output('blob'), 'deposit-invoices.pdf', opts?.action ?? 'save');
}
