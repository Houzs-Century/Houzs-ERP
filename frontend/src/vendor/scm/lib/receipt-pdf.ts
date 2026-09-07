// ----------------------------------------------------------------------------
// receipt-pdf — the Official Receipt print (GL redesign item 9b).
//
// One page, the shop-counter shape: letterhead, OR number and date on the
// right, received-from / the document it pays / how it was paid, the amount
// in figures AND in words (the same amountInWordsMyr every money print here
// uses), and a received-by box. A DRAFT receipt prints with a big diagonal
// DRAFT watermark — the salesperson can hand something over the moment the
// payment is keyed, and nobody can mistake it for the confirmed paper
// (draft 的可以打印,带 DRAFT 水印 — the owner's own design).
// ----------------------------------------------------------------------------

import {
  drawHeader, drawTwoColInfo, drawSignatureBoxes, deliverPdf,
  amountInWordsMyr, fmtRm, fmtDocDate, safeName, type PdfAction,
} from './pdf-common';
import { PAYMENT_METHOD_DEFAULT_LABELS } from '@2990s/shared/payment-methods';

export type ReceiptPdfData = {
  or_number: string;
  status: string;            // DRAFT | FORMAL
  doc_no: string | null;
  customer_name: string | null;
  method: string | null;
  amount_sen: number;
  paid_at: string | null;
  issued_at: string | null;
  issued_by: string | null;
};

/* The SHARED method vocabulary — the same labels the payment rows render, so
   the receipt cannot call a method something the recording screen does not.
   The widened value type makes the miss (an unknown method string on an old
   row) visible to the compiler; noUncheckedIndexedAccess is off here. */
const labelOf: Record<string, string | undefined> = { ...PAYMENT_METHOD_DEFAULT_LABELS };
const methodLabel = (m: string | null): string => (m ? labelOf[m] ?? m : '—');

export async function generateReceiptPdf(r: ReceiptPdfData, opts?: { action?: PdfAction }): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a5', orientation: 'landscape' });

  let y = drawHeader(doc, {
    docTitle: 'OFFICIAL RECEIPT',
    rightMeta: [
      { label: 'OR No', value: r.or_number },
      { label: 'Date', value: fmtDocDate(r.paid_at) },
    ],
  });

  y = drawTwoColInfo(doc, y + 2, 'RECEIVED FROM', 'PAYMENT',
    [
      r.customer_name || '—',
      r.doc_no ? `For: ${r.doc_no}` : null,
    ],
    [
      `Method: ${methodLabel(r.method)}`,
      `Amount: ${fmtRm(r.amount_sen)}`,
      r.status === 'FORMAL' && r.issued_by
        ? `Confirmed by: ${r.issued_by}${r.issued_at ? ` · ${fmtDocDate(r.issued_at)}` : ''}`
        : null,
    ]);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('RINGGIT (IN WORDS)', 14, y + 2);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(r.amount_sen), 14, y + 7, { maxWidth: doc.internal.pageSize.getWidth() - 28 });
  y += 12;

  drawSignatureBoxes(doc, y + 4, 'Received by', 'Company chop');

  /* The watermark LAST, over everything: a draft must read as a draft from
     across the counter. */
  if (r.status !== 'FORMAL') {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(64);
    doc.setTextColor(180, 30, 30);
    doc.text('DRAFT', pageW / 2, pageH / 2, { align: 'center', angle: 25 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
  }

  deliverPdf(doc, `${r.or_number}-${safeName(r.customer_name ?? r.doc_no ?? 'receipt')}.pdf`, opts?.action);
}
