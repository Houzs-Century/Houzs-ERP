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
import { COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, drawSignatureBoxes, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { billToBlock } from './pdf-party-blocks';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';

type SiHeader = {
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
};
type SiItem = {
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
        ['Due', header.due_date ? fmtDocDate(header.due_date) : null],
        ['Status', statusText],
      ],
    },
  );

  const fabric = await loadCustomerFabricMaps(items);
  const rows = items.map((it, idx) => [
    String(idx + 1),
    it.item_code,
    [it.description, docVariantLine(it, fabric.ext, fabric.desc)].filter(Boolean).join('\n') || '—',
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
     person who paid it (vendor/scm/lib/si-outstanding.ts). The deposit prints
     as its OWN line naming the order — a customer reading a smaller number with
     no explanation has the same question the office had. */
  const siDeposit = siDepositAppliedSen(header);
  drawRow(siDeposit > 0 ? 'Paid (this invoice)' : 'Paid',
          fmtRm(header.paid_sen, header.currency), ty + 4); ty += 4;
  if (siDeposit > 0) {
    drawRow(`Deposit (${header.so_doc_no ?? 'sales order'})`,
            fmtRm(siDeposit, header.currency), ty + 4); ty += 4;
  }
  /* Unfloored, exactly as before: an over-payment must print negative so the
     customer sees the credit rather than a silent "0". The deposit cannot make
     this MORE negative — the allocation never exceeds what the invoice still
     owed, so `paid + deposit <= total` whenever `paid <= total`. */
  drawRow('Outstanding',
          fmtRm(header.total_sen - header.paid_sen - siDeposit, header.currency), ty + 4, true);
  ty += 12;

  ty = drawSignatureBoxes(doc, ty, 'Customer Acknowledgement', `${COMPANY.name} Authorised Signature`);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text('Terms: Payment due as per invoice. Late payments may incur a service charge.', margin, ty);
  doc.setTextColor(0);

  // Footer: doc no · portal · page n of m on every page of THIS invoice
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.invoice_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.invoice_date)}`, pageW / 2, 290, { align: 'center' });
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
