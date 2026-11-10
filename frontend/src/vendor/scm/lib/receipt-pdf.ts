// ----------------------------------------------------------------------------
// receipt-pdf — the Official Receipt print (GL redesign item 9b; the owner's
// Claude Design, batch 5 §9: A5 landscape, half an A4 sheet).
//
// One page, the shop-counter shape: the letterhead with OFFICIAL RECEIPT, the
// OR number and date on the right; RECEIVED FROM (the name, and the address,
// phone and e-mail when the caller has them) beside PAYMENT DETAILS (method,
// paid on, the sales order, who confirmed the money and when — or that the
// cash was received at the counter); one line `Payment for sales order <SO>`
// with its amount; AMOUNT RECEIVED over a double rule; the amount in words
// (the same amountInWordsMyr every money print here uses); Received by and
// the company chop. A DRAFT receipt prints with a big diagonal DRAFT watermark
// — the salesperson can hand something over the moment the payment is keyed,
// and nobody can mistake it for the confirmed paper (draft 的可以打印,带 DRAFT
// 水印 — the owner's own design). A CANCELLED one (its payment changed or went —
// owner 2026-10-29) prints CANCELLED, its reason under the payment.
//
// The SO page's payments table prints the same paper (one generator keeps the
// two identical).
// ----------------------------------------------------------------------------

import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, drawHeader, drawInfoColumns, deliverPdf,
  amountInWordsMyr, fmtRm, fmtDocDate, safeName, type PdfAction,
} from './pdf-common';
import { PAYMENT_METHOD_DEFAULT_LABELS } from '@2990s/shared/payment-methods';
import { PDF_COMPRESS } from './pdf-options';

export type ReceiptPdfData = {
  or_number: string;
  status: string;            // DRAFT | FORMAL | CANCELLED
  doc_no: string | null;
  customer_name: string | null;
  method: string | null;
  amount_sen: number;
  paid_at: string | null;
  issued_at: string | null;
  issued_by: string | null;
  cancel_reason?: string | null;
  /** RECEIVED FROM's other lines, when the caller has the customer's details. */
  address_lines?: string[] | null;
  phone?: string | null;
  email?: string | null;
  /** The sales order the payment is for, when doc_no is not one (a sales invoice's payment). */
  sales_order?: string | null;
  /** SOPAY or SIPAY: a sales invoice's payment keeps the invoice's id in doc_no — never an order number to print. */
  payment_source?: string | null;
};

/* The SHARED method vocabulary — the same labels the payment rows render, so
   the receipt cannot call a method something the recording screen does not.
   The widened value type makes the miss (an unknown method string on an old
   row) visible to the compiler; noUncheckedIndexedAccess is off here. */
const labelOf: Record<string, string | undefined> = { ...PAYMENT_METHOD_DEFAULT_LABELS };
const methodLabel = (m: string | null): string => (m ? labelOf[m] ?? m : '—');

/* The fact that says the money is real, as the design names it (kept apart
   from any stored status word — confirmRungReadsSubmitted.test.ts). */
const MONEY_SEEN = 'Confirmed';

type JsPdf = import('jspdf').jsPDF;
type AutoTable = (doc: JsPdf, options: Record<string, unknown>) => void;

/** Who saw the money and when — or the counter, for cash; nothing on a draft. */
const confirmedLine = (r: ReceiptPdfData): string | null => {
  const formal = r.status.toUpperCase() === 'FORMAL';
  if (!formal) return null;
  if (r.method === 'cash') return `Cash received at the counter${r.issued_at ? ` · ${fmtDocDate(r.issued_at)}` : ''}`;
  return r.issued_by ? `${r.issued_by}${r.issued_at ? ` · ${fmtDocDate(r.issued_at)}` : ''}` : null;
};

/** One receipt on the current page of an A5 landscape document. */
function renderReceiptInto(doc: JsPdf, autoTable: AutoTable, r: ReceiptPdfData): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;
  const status = r.status.toUpperCase();
  const order = r.sales_order ?? (r.payment_source === 'SIPAY' ? null : r.doc_no);

  let y = drawHeader(doc, {
    docTitle: 'OFFICIAL RECEIPT',
    rightMeta: [
      { label: 'OR No', value: r.or_number },
      { label: 'Date', value: fmtDocDate(r.paid_at) },
    ],
  });

  y = drawInfoColumns(doc, y,
    {
      title: 'RECEIVED FROM',
      rows: [
        ['Name', r.customer_name || '—'],
        ...(r.address_lines ?? []).map((line, i): [string, string] => [i === 0 ? 'Address' : ' ', line]),
        ['Phone', r.phone ?? null],
        ['Email', r.email ?? null],
      ],
    },
    {
      title: 'PAYMENT DETAILS',
      rows: [
        ['Method', methodLabel(r.method)],
        ['Paid on', fmtDocDate(r.paid_at)],
        ['Sales order', order],
        [MONEY_SEEN, confirmedLine(r)],
        ['Status', status === 'DRAFT' ? 'Draft · money not confirmed'
          : status === 'CANCELLED' ? `Cancelled · ${r.cancel_reason || 'its payment changed'}` : null],
      ],
    },
  );

  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Amount (RM)']],
    body: [['1', order ? `Payment for sales order ${order}` : 'Payment received', fmtRm(r.amount_sen)]],
    theme: 'plain',
    styles: { ...DOC_TABLE_STYLES, fontSize: 9 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 8, halign: 'right' }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 40, halign: 'right' } },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 5;

  /* AMOUNT RECEIVED over a double rule — the figure the paper is for. */
  const totalsX = pageW - margin - 86;
  doc.setDrawColor(0);
  doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.line(totalsX, ty - 1.2, pageW - margin, ty - 1.2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  doc.text('AMOUNT RECEIVED', totalsX, ty + 4);
  doc.text(fmtRm(r.amount_sen), pageW - margin, ty + 4, { align: 'right' });
  ty += 10;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('RINGGIT (IN WORDS)', margin, ty);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(r.amount_sen), margin, ty + 4, { maxWidth: pageW - margin * 2 });
  ty += 9;

  /* Received by and the company chop, straight after — sized to what is left
     of the half sheet, so a long address never pushes them off the page. */
  const boxH = Math.max(12, Math.min(20, pageH - 8 - (ty + 2)));
  const boxW = (pageW - margin * 2) / 2 - 5;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  doc.text('Received by', margin, ty);
  doc.text('Company chop', pageW / 2 + 5, ty);
  doc.setLineDashPattern([1.5, 1.5], 0);
  doc.setDrawColor(120);
  doc.rect(margin, ty + 2, boxW, boxH);
  doc.rect(pageW / 2 + 5, ty + 2, boxW, boxH);
  doc.setLineDashPattern([], 0);

  /* The watermark LAST, over everything: a draft must read as a draft from
     across the counter, and a cancelled receipt as cancelled. */
  if (status !== 'FORMAL') {
    const cancelled = status === 'CANCELLED';
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(cancelled ? 48 : 64);
    doc.setTextColor(180, 30, 30);
    doc.text(cancelled ? 'CANCELLED' : 'DRAFT', pageW / 2, pageH / 2, { align: 'center', angle: 25 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
  }
}

const tools = async (): Promise<{ doc: JsPdf; autoTable: AutoTable }> => {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  return { doc: new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a5', orientation: 'landscape' }), autoTable: autoTableModule.default as unknown as AutoTable };
};

export async function generateReceiptPdf(r: ReceiptPdfData, opts?: { action?: PdfAction }): Promise<void> {
  const { doc, autoTable } = await tools();
  renderReceiptInto(doc, autoTable, r);
  deliverPdf(doc, `${r.or_number}-${safeName(r.customer_name ?? r.doc_no ?? 'receipt')}.pdf`, opts?.action);
}

/** The ticked receipts as ONE A5 document, one receipt per page, in the order
 *  given (Money in › Receipts' batch Print, the owner's Claude Design batch 5). */
export async function generateReceiptsPdf(list: ReceiptPdfData[], opts?: { action?: PdfAction }): Promise<void> {
  if (list.length === 0) return;
  if (list.length === 1) { await generateReceiptPdf(list[0]!, opts); return; }
  const { doc, autoTable } = await tools();
  list.forEach((r, i) => {
    if (i > 0) doc.addPage('a5', 'landscape');
    renderReceiptInto(doc, autoTable, r);
  });
  deliverPdf(doc, `official-receipts-${list.length}.pdf`, opts?.action);
}

/** For tests: draw one receipt onto a given document. */
export { renderReceiptInto };
