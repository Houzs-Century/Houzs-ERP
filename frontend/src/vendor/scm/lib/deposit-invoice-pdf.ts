// ----------------------------------------------------------------------------
// deposit-invoice-pdf — the Deposit Invoice print (owner 2026-09-12:
// 打印版，根据 PV/OR PDF 可以，需要显示 SO 号和付款方式，要批量打印; docs/bugs/0834).
//
// A4 in the SALES INVOICE's layout since 2026-10-06 (owner: print 出来不好看 —
// the A5 receipt shape printed a name and an amount and little else): the
// letterhead, BILL TO with the order's address, phone and e-mail beside the
// DEPOSIT DETAILS (DI no, the sales order, the day, how it was paid), ONE line
// in the items table, the deposit total with the order's total, what had been
// received on it by this deposit and the balance, the amount in words, where
// the customer pays, an issued-by box and the footer every invoice carries.
// The order's figures come from GET /deposit-invoices/sheets; a sheet without
// them prints without those lines. A CANCELLED invoice prints with a diagonal
// CANCELLED watermark and its reason — the paper must read as void from across
// the counter. Several invoices print as ONE document, a page each, in list
// order.
// ----------------------------------------------------------------------------

import { formatPhone } from '@2990s/shared/phone';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, drawHeader, drawInfoColumns, drawPaymentDetails, drawSignatureBoxes,
  deliverPdf, deliverPdfBlob, ensurePdfCjkFont, amountInWordsMyr, fmtRm, fmtDocDate, safeName, type PdfAction,
} from './pdf-common';
import { billToBlock } from './pdf-party-blocks';
import { orderAddressLines, type OrderAddressFields } from './order-address';
import { getBrandingCache } from '../../../lib/branding';
import { PAYMENT_METHOD_DEFAULT_LABELS } from './payment-methods';

/** The order behind a deposit invoice, as GET /deposit-invoices/sheets serves it. */
export type DepositInvoiceOrder = OrderAddressFields & {
  phone: string | null;
  email: string | null;
  total_sen: number | null;
  /** Received on the order up to and including this deposit; null when its payment is gone. */
  paid_to_date_sen: number | null;
};

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
  order?: DepositInvoiceOrder | null;
};

const labelOf: Record<string, string | undefined> = { ...PAYMENT_METHOD_DEFAULT_LABELS };
const methodLabel = (m: string | null): string => (m ? labelOf[m] ?? m : '—');
/* A customer id (2990 keys its customers by uuid) is no code to print. */
const printableCode = (code: string | null): string | null =>
  code && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code) ? code : null;

type JsPdf = import('jspdf').jsPDF;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AutoTable = any;

/** Draw one deposit invoice from the CURRENT page of `doc` (A4 portrait). */
export async function renderDepositInvoiceInto(doc: JsPdf, autoTable: AutoTable, d: DepositInvoicePdfData): Promise<void> {
  /* A customer name or address in Chinese needs the font up front, or helvetica paints mojibake. */
  await ensurePdfCjkFont(doc, d);
  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 14;
  const o = d.order ?? null;

  let y = drawHeader(doc, {
    docTitle: 'DEPOSIT INVOICE',
    rightMeta: [
      { label: 'DI No', value: d.di_number },
      { label: 'Date', value: fmtDocDate(d.invoice_date) },
    ],
  });

  y = drawInfoColumns(doc, y,
    billToBlock({
      name: d.party_name ?? '—',
      code: printableCode(d.party_code),
      address: o ? orderAddressLines(o).join(', ') : null,
      phone: o?.phone ? formatPhone(o.phone) : null,
      email: o?.email ?? null,
    }),
    {
      title: 'DEPOSIT DETAILS',
      rows: [
        ['DI No', d.di_number],
        ['SO Ref', d.so_doc_no],
        ['Date', fmtDocDate(d.invoice_date)],
        ['Paid by', methodLabel(d.method)],
        ['Status', d.status === 'CANCELLED' ? 'Cancelled' : 'Issued'],
        ['Closed by', d.credit_note_number ? `Credit note ${d.credit_note_number}` : null],
      ],
    },
  );

  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Amount']],
    body: [['1', `Deposit received for Sales Order ${d.so_doc_no}`, fmtRm(d.amount_sen)]],
    theme: 'plain',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 8, halign: 'right' }, 1: { cellWidth: 140 }, 2: { cellWidth: 34, halign: 'right' } },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  /* The deposit, then — when the order is known — where the order stands with it. */
  const totalsX = pageW - margin - 70;
  const row = (label: string, value: string, at: number, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(label, totalsX, at);
    doc.text(value, pageW - margin, at, { align: 'right' });
  };
  doc.setFontSize(11);
  row('DEPOSIT TOTAL', fmtRm(d.amount_sen), ty + 2, true);
  ty += 8;
  doc.setFontSize(9);
  if (o?.total_sen != null) { row('Order total', fmtRm(o.total_sen), ty); ty += 4.5; }
  if (o?.paid_to_date_sen != null) {
    row('Paid to date (this order)', fmtRm(o.paid_to_date_sen), ty); ty += 4.5;
    /* Unfloored: money over the order's total prints negative, never a silent 0. */
    if (o.total_sen != null) { row('Balance on order', fmtRm(o.total_sen - o.paid_to_date_sen), ty, true); ty += 4.5; }
  }
  ty += 5;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('RINGGIT (IN WORDS)', margin, ty);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(d.amount_sen), margin, ty + 5, { maxWidth: pageW - margin * 2 });
  ty += 12;

  /* Where the customer pays (owner 2026-09-21): the CUSTOMER set from Settings › Branding; blank prints nothing. */
  ty = drawPaymentDetails(doc, ty, getBrandingCache().customerPaymentDetails, margin);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text(`This deposit is deducted from the final invoice of sales order ${d.so_doc_no}.`, margin, ty + 2, { maxWidth: pageW - margin * 2 });
  doc.setTextColor(0);

  drawSignatureBoxes(doc, ty + 8, 'Issued by', 'Company chop');

  /* The watermark LAST, over everything: a void invoice must read as void. */
  if (d.status === 'CANCELLED') {
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(80);
    doc.setTextColor(180, 30, 30);
    doc.text('CANCELLED', pageW / 2, pageH / 2, { align: 'center', angle: 30 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
    if (d.cancel_reason) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(180, 30, 30);
      doc.text(`Cancelled: ${d.cancel_reason}`, margin, pageH - 14, { maxWidth: pageW - margin * 2 });
      doc.setTextColor(0, 0, 0);
    }
  }

  /* The footer every invoice carries: its number and page n of m. */
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(d.di_number, margin, pageH - 7);
    doc.text(`Page ${p - startPage + 1} of ${pageCount - startPage + 1}`, pageW - margin, pageH - 7, { align: 'right' });
    doc.setTextColor(0);
  }
}

const tools = async (): Promise<{ doc: JsPdf; autoTable: AutoTable }> => {
  const [{ jsPDF }, autoTable] = await Promise.all([import('jspdf'), import('jspdf-autotable').then((m) => m.default)]);
  return { doc: new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' }), autoTable };
};

const fileNameOf = (d: DepositInvoicePdfData): string => `${d.di_number}-${safeName(d.party_name ?? d.so_doc_no)}.pdf`;

export async function generateDepositInvoicePdf(d: DepositInvoicePdfData, opts?: { action?: PdfAction }): Promise<void> {
  const { doc, autoTable } = await tools();
  await renderDepositInvoiceInto(doc, autoTable, d);
  deliverPdf(doc, fileNameOf(d), opts?.action);
}

/** The same page as bytes — what the invoice's pop-out shows before anyone prints. */
export async function depositInvoicePdfBlob(d: DepositInvoicePdfData): Promise<Blob> {
  const { doc, autoTable } = await tools();
  await renderDepositInvoiceInto(doc, autoTable, d);
  return doc.output('blob');
}

/** Several invoices as ONE document, a page each, in the order given. */
export async function generateDepositInvoicesPdf(list: DepositInvoicePdfData[], opts?: { action?: PdfAction }): Promise<void> {
  if (list.length === 0) return;
  const { doc, autoTable } = await tools();
  for (let i = 0; i < list.length; i += 1) {
    if (i > 0) doc.addPage('a4', 'portrait');
    await renderDepositInvoiceInto(doc, autoTable, list[i]!);
  }
  deliverPdfBlob(doc.output('blob'), 'deposit-invoices.pdf', opts?.action ?? 'save');
}
