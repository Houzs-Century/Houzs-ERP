// Sales Invoice PDF — issued to the customer.
//
// 2026-06-19 — unified "Hookka-tidy" layout shared with SO/PO/DO: real
// letterhead header, the drawInfoColumns info block (BILL TO label-gutter +
// INVOICE DETAILS colon-aligned), and the consistent footer (doc no · portal ·
// page n of m). A4 portrait, pure B&W. Totals + signatures unchanged.
//
// BILL TO prints the customer's ADDRESS + Tel/Email, and INVOICE DETAILS prints
// the customer's own 'Customer PO' reference. All of it was already captured by
// the route and simply never drawn — the invoice, the one document that leaves
// the building, went out with no address on it. Layout is untouched:
// drawInfoColumns skips blank rows, so a record with no address prints exactly
// as before. The SI carries ONE flat address, not the SO's
// ship_to/bill_to/install_to trio — see the SiHeader note.
import { formatPhone } from '@2990s/shared/phone';
import { siDepositAppliedSen } from './si-outstanding';
import { PAYMENT_METHOD_DEFAULT_LABELS } from './payment-methods';
import { DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, drawPaymentDetails, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { getBrandingCache } from '../../../lib/branding';
import { billToBlock } from './pdf-party-blocks';
import { stripBookText } from './book-text';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';

export type SiHeader = {
  invoice_number: string; status: string;
  so_doc_no: string | null; debtor_code: string | null; debtor_name: string;
  invoice_date: string; due_date: string | null; currency: string;
  subtotal_sen: number; discount_sen: number; tax_sen: number;
  total_sen: number; paid_sen: number; notes: string | null;
  /* The slice of the source Sales Order's deposit that settles this invoice,
     served on both the list row and the detail header. Optional because a
     caller may hand this function a header from before that field existed;
     absent reads as 0, which prints the LARGER outstanding — the only
     direction a customer's copy may be wrong in. */
  so_deposit_applied_sen?: number | null;
  /* Every sum received towards this invoice — the order's rows and its own —
     stamped by GET /sales-invoices/:id (backend lib/si-receipts). Absent or
     null prints one line per document instead of one per payment. */
  receipts?: SiReceipts | null;
  /* The route has always CAPTURED these (sales-invoices.ts HEADER + the from-DO
     convert copies them off the DO header) — they were simply never printed, so
     the invoice went to the customer with no address on it. Optional because the
     detail-page item/header shapes are passed through `as never` by the callers
     and older rows may carry nulls; drawInfoColumns skips a blank row, so a
     record with no address prints exactly as it does today.

     NOTE the SI carries ONE flat address (address1/2 · city · state · postcode ·
     phone), NOT the SO's ship_to/bill_to/install_to trio — those columns do not
     exist on sales_invoices. So this is the billing address as captured; the
     delivery address for the same goods lives on the DO, which prints its own. */
  address1?: string | null; address2?: string | null;
  city?: string | null; state?: string | null; postcode?: string | null;
  phone?: string | null; email?: string | null;
  /* The CUSTOMER's own reference — distinct from `so_doc_no`, which is OUR SO
     number. Printed as 'Customer PO', matching the SO PDF's label. */
  po_doc_no?: string | null; customer_so_no?: string | null;
  /* Header delivery date — carried off the DO on convert. Printed in INVOICE
     DETAILS; per-line dates live on the form/detail, but a per-line PDF column
     would overflow the A4 item table, so the header date is what the customer's
     copy shows. Optional + drawInfoColumns skips it if null. */
  customer_delivery_date?: string | null;
};
/** One sum received, as the printed "Payments received" list reads it. */
export type SiReceipt = { paid_at: string | null; method: string | null; amount_sen: number };
export type SiReceipts = { order: SiReceipt[]; invoice: SiReceipt[] };

/* The method as the customer reads it: the system's own label; money brought
   over from AutoCount carries none, so it is just a payment. */
const receiptMethod = (m: string | null): string => {
  if (!m || m === 'imported') return 'Payment';
  if (m === 'converted') return 'Moved from another order';
  return (PAYMENT_METHOD_DEFAULT_LABELS as Readonly<Record<string, string | undefined>>)[m] ?? m;
};
const sumOf = (rows: readonly SiReceipt[]): number => rows.reduce((s, r) => s + Number(r.amount_sen), 0);
/* The rows, when they ARE the figure — every one money in, adding up to it. */
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
  // Older items table rows in 2990s may omit these — keep optional so the
  // detail-page items shape is assignable without forcing a schema-wide
  // type widening.
  discount_sen?: number; tax_sen?: number;
  line_total_sen: number;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

/* Draw ONE sales invoice's content into `doc` (letterhead → info block → items →
   totals → signature → footer). Does NOT create the jsPDF or save — the caller
   finalizes ONCE, so several SIs can share one doc (batch "Export PDF"). The
   footer loop starts at this SI's first page so a combined doc numbers each
   invoice's own pages without re-stamping earlier ones. */
export async function renderSalesInvoiceInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: SiHeader,
  items: SiItem[],
): Promise<void> {
  /* Before ANY drawing: a customer / supplier name, address or remark that
     carries CJK needs the font embedded up front, or helvetica silently paints
     the whole field as mojibake. No-op for a pure-WinAnsi document. */
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

  /* Same composition as the DO's DELIVER TO block (delivery-order-pdf.ts) so the
     two customer-facing documents render one address the same way. */
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
  /* An invoice with no address is not a document that stands alone — it cannot
     be posted, filed or matched to a customer record on its own. Row order +
     labels mirror the SO/DO BILL TO block via the shared billToBlock. */
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
        /* 'SO Ref' is OUR sales order; 'Customer PO' is the number the customer
           files this invoice under — the one their AP clerk searches for. Both
           are captured; print both. Same label + fallback order as the SO PDF. */
        ['SO Ref', header.so_doc_no],
        ['Customer PO', header.po_doc_no ?? header.customer_so_no],
        ['Date', fmtDocDate(header.invoice_date)],
        ['Delivery Date', header.customer_delivery_date ? fmtDocDate(header.customer_delivery_date) : null],
        ['Due', header.due_date ? fmtDocDate(header.due_date) : null],
        ['Status', statusText],
      ],
    },
  );

  const fabric = await loadCustomerFabricMaps(items);
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

  // Totals + payment
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
  /* THIS IS THE CUSTOMER'S COPY, so it is the one place the old bug was worst:
     until 2026-08-23 it printed the full invoice total as Outstanding on an
     invoice whose order had already collected a deposit, and handed that to the
     person who paid it (vendor/scm/lib/si-outstanding.ts). Money taken on the
     order prints as its OWN lines naming the order — a customer reading a
     smaller number with no explanation has the same question the office had.
     Since 2026-10-06 every sum is listed by day and method under "Payments
     received" (paymentsReceivedLines), never called "Deposit". */
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
    ty += 1.5;   /* air between the list and the line it adds up to */
  }
  /* Unfloored, exactly as before: an over-payment must print negative so the
     customer sees the credit rather than a silent "0". The deposit cannot make
     this MORE negative — the allocation never exceeds what the invoice still
     owed, so `paid + deposit <= total` whenever `paid <= total`. */
  drawRow('Outstanding',
          fmtRm(header.total_sen - header.paid_sen - siDeposit, header.currency), ty + 4, true);
  /* Signature boxes removed (owner 2026-09-20): the invoice ends on the Terms
     line right under the totals — no dangling gap where the two boxes were. */
  ty += 10;

  /* Where the customer pays (owner 2026-09-21): the CUSTOMER set from Settings › Branding; blank prints nothing. */
  ty = drawPaymentDetails(doc, ty, getBrandingCache().customerPaymentDetails, margin);

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
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/* Single SI → its own file (unchanged behaviour). */
export async function generateSalesInvoicePdf(
  header: SiHeader,
  items: SiItem[],
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderSalesInvoiceInto(doc, autoTable, header, items);
  deliverPdf(doc, `${header.invoice_number}-${safeName(header.debtor_name)}.pdf`, opts?.action);
}

/** The same pages as bytes — what a sales invoice opened from the AR Invoices
    list shows before anyone prints (owner 2026-10-06: ar invoice 点不开). */
export async function salesInvoicePdfBlob(header: SiHeader, items: SiItem[]): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderSalesInvoiceInto(doc, autoTable, header, items);
  return doc.output('blob');
}

/* Several SIs → ONE combined file, each invoice starting on a new page. For the
   batch "Export PDF" action (download a customer all their invoices in one
   attachment). Each invoice numbers its own pages via renderSalesInvoiceInto's
   startPage-based footer loop. */
export async function generateCombinedSalesInvoicePdf(
  docs: Array<{ header: SiHeader; items: SiItem[] }>,
  opts?: { fileName?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderSalesInvoiceInto(doc, autoTable, docs[i]!.header, docs[i]!.items);
  }
  deliverPdf(doc, opts?.fileName ?? 'sales-invoices.pdf', opts?.action);
}
