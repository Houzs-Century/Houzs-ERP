import { formatPhone } from '@2990s/shared/phone';
import { siCreditNotesSen, siDepositAppliedSen } from './si-outstanding';
import { PAYMENT_METHOD_DEFAULT_LABELS } from './payment-methods';
import { docPageLabel, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, drawHeader, drawInfoColumns, drawPaymentDetails, ensurePdfCjkFont, fmtRm, fmtDocDate } from './pdf-core';
import { billToBlock } from './pdf-party-blocks';
import { stripBookText } from './book-text';
import { docVariantLine, type SupplierDocLoaders } from './supplier-doc-data-core';
import { statusLabel } from './status-pill';

/** The invoice's print-time reads, injected so the browser and the Worker (AI Connector get_pdf) draw the same page. */
export type SiPdfSources = {
  customerFabricMaps: SupplierDocLoaders['loadCustomerFabricMaps'];
  /** Settings > Branding "customer payment details" (blank prints nothing). */
  customerPaymentDetails(): string | null | undefined;
};

export type SiHeader = {
  invoice_number: string; status: string;
  so_doc_no: string | null; debtor_code: string | null; debtor_name: string;
  invoice_date: string; due_date: string | null; currency: string;
  subtotal_sen: number; discount_sen: number; tax_sen: number;
  total_sen: number; paid_sen: number; notes: string | null;
  so_deposit_applied_sen?: number | null;
  credit_notes_sen?: number | null;
  receipts?: SiReceipts | null;
  address1?: string | null; address2?: string | null;
  city?: string | null; state?: string | null; postcode?: string | null;
  phone?: string | null; email?: string | null;
  po_doc_no?: string | null; customer_so_no?: string | null;
  customer_delivery_date?: string | null;
};
/** One sum received, as the printed "Payments received" list reads it. */
export type SiReceipt = { paid_at: string | null; method: string | null; amount_sen: number };
export type SiReceipts = { order: SiReceipt[]; invoice: SiReceipt[] };

const receiptMethod = (m: string | null): string => {
  if (!m || m === 'imported') return 'Payment';
  if (m === 'converted') return 'Moved from another order';
  return (PAYMENT_METHOD_DEFAULT_LABELS as Readonly<Record<string, string | undefined>>)[m] ?? m;
};
const sumOf = (rows: readonly SiReceipt[]): number => rows.reduce((s, r) => s + Number(r.amount_sen), 0);
const itemised = (rows: readonly SiReceipt[] | undefined, figure: number): readonly SiReceipt[] | null =>
  rows && rows.length > 0 && rows.every((r) => Number(r.amount_sen) > 0) && sumOf(rows) === figure ? rows : null;

/** "Payments received" (owner 2026-10-06: the print called all of it
    "Deposit (<order>)", even money that paid the order in full): one line per
    sum — day · method · on the order or on this invoice — when the rows add
    up to what settles the invoice; otherwise one line per document (an order
    split over several invoices). Nothing received, no lines. */
export function paymentsReceivedLines(header: SiHeader): Array<{ label: string; amountSen: number }> {
  const lines: Array<{ label: string; amountSen: number }> = [];
  const fromOrder = siDepositAppliedSen(header);
  const order = header.so_doc_no ?? 'the sales order';
  const orderRows = itemised(header.receipts?.order, fromOrder);
  if (orderRows) {
    for (const r of orderRows) lines.push({ label: `${fmtDocDate(r.paid_at)} · ${receiptMethod(r.method)} · on order ${order}`, amountSen: Number(r.amount_sen) });
  } else if (fromOrder > 0) {
    lines.push({ label: `Paid on order ${order}`, amountSen: fromOrder });
  }
  const own = Number(header.paid_sen);
  const ownRows = itemised(header.receipts?.invoice, own);
  if (ownRows) {
    for (const r of ownRows) lines.push({ label: `${fmtDocDate(r.paid_at)} · ${receiptMethod(r.method)} · on this invoice`, amountSen: Number(r.amount_sen) });
  } else if (own > 0) {
    lines.push({ label: 'Paid on this invoice', amountSen: own });
  }
  return lines;
}

export type SiItem = {
  item_code: string; description: string | null;
  qty: number; unit_price_sen: number;
  discount_sen?: number; tax_sen?: number;
  line_total_sen: number;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

export async function drawSalesInvoiceInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jspdf-autotable's default export, passed in so this module stays loader-free
  autoTable: any,
  sources: SiPdfSources,
  header: SiHeader,
  items: SiItem[],
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, items]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: 'SALES INVOICE',
    rightMeta: [
      { label: 'Invoice No', value: header.invoice_number },
      { label: 'Date',       value: fmtDocDate(header.invoice_date) },
    ],
  });

  const addressValue = [
    header.address1,
    header.address2,
    [header.postcode, header.city, header.state]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' '),
  ]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(', ');
  const statusText = statusLabel('si', header.status);
  y = drawInfoColumns(doc, y,
    billToBlock({
      name: header.debtor_name,
      code: header.debtor_code,
      address: addressValue,
      phone: header.phone ? formatPhone(header.phone) : null,
      email: header.email,
      note: header.notes,
    }),
    {
      title: 'INVOICE DETAILS',
      rows: [
        ['Invoice No', header.invoice_number],
        ['SO Ref', header.so_doc_no],
        ['Customer PO', header.po_doc_no ?? header.customer_so_no],
        ['Date', fmtDocDate(header.invoice_date)],
        ['Delivery Date', header.customer_delivery_date ? fmtDocDate(header.customer_delivery_date) : null],
        ['Due', header.due_date ? fmtDocDate(header.due_date) : null],
        ['Status', statusText],
      ],
    },
  );

  const fabric = await sources.customerFabricMaps(items);
  const rows = items.map((it, idx) => [
    String(idx + 1),
    it.item_code,
    stripBookText([it.description, docVariantLine(it, fabric.ext, fabric.desc)].filter(Boolean).join('\n')) || '—',
    String(it.qty),
    fmtRm(it.unit_price_sen, header.currency),
    (it.discount_sen ?? 0) > 0 ? fmtRm(it.discount_sen ?? 0, header.currency) : '—',
    fmtRm(it.line_total_sen, header.currency),
  ]);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Item', 'Description', 'Qty', 'Unit Price', 'Disc', 'Total']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 24 },
      2: { cellWidth: 68 },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 24, halign: 'right' },
      5: { cellWidth: 18, halign: 'right' },
      6: { cellWidth: 26, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  const drawRow = (label: string, val: string, ty: number, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.text(label, totalsX, ty);
    doc.text(val, pageW - margin, ty, { align: 'right' });
  };
  doc.setFontSize(9);
  let ty = lastY;
  drawRow('Subtotal', fmtRm(header.subtotal_sen, header.currency), ty); ty += 4;
  drawRow('Discount', fmtRm(header.discount_sen, header.currency), ty); ty += 4;
  drawRow('Tax',      fmtRm(header.tax_sen,      header.currency), ty); ty += 5;
  doc.setDrawColor(0); doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.setFontSize(11);
  drawRow('GRAND TOTAL', fmtRm(header.total_sen, header.currency), ty + 2, true);
  ty += 6;
  doc.setFontSize(9);
  const siDeposit = siDepositAppliedSen(header);
  const received = paymentsReceivedLines(header);
  if (received.length > 0) {
    const listX = pageW - margin - 130;
    doc.setFont('helvetica', 'bold');
    doc.text('Payments received', listX, ty + 4); ty += 4;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    for (const r of received) {
      const label = doc.splitTextToSize(r.label, 100) as string[];
      doc.text(label, listX + 2, ty + 4.5);
      doc.text(fmtRm(r.amountSen, header.currency), pageW - margin, ty + 4.5, { align: 'right' });
      ty += 4.5 * Math.max(1, label.length);
    }
    doc.setFontSize(9);
    ty += 1.5;
  }
  /* A credit note knocked off it (owner 2026-11-03) is no payment: its own line, then off the balance. */
  const credited = siCreditNotesSen(header);
  if (credited > 0) { drawRow('Credit notes', `-${fmtRm(credited, header.currency)}`, ty + 4); ty += 5.5; }
  drawRow('Outstanding',
          fmtRm(header.total_sen - header.paid_sen - siDeposit - credited, header.currency), ty + 4, true);
  /* Signature boxes removed (owner 2026-09-20): the invoice ends on the Terms
     line right under the totals — no dangling gap where the two boxes were. */
  ty += 10;

  /* Where the customer pays (owner 2026-09-21): the CUSTOMER set from Settings › Branding; blank prints nothing. */
  ty = drawPaymentDetails(doc, ty, sources.customerPaymentDetails(), margin);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text('Terms: Payment due as per invoice. Late payments may incur a service charge.', margin, ty);
  doc.setTextColor(0);

  /* Footer: doc no · page n of m on every page of THIS invoice. The centred
     "<portal> · <date>" line was removed (owner 2026-09-20). */
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.invoice_number, margin, 290);
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

