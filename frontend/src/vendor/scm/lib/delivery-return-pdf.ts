import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { formatPhone } from '@2990s/shared/phone';
import { docPageLabel, COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, drawSignatureBoxes, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { billToBlock } from './pdf-party-blocks';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
import { stripBookText } from './book-text';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';
import { PDF_COMPRESS } from './pdf-options';

type DrHeader = {
  return_number: string; status: string; return_date: string;
  debtor_code: string | null; debtor_name: string;
  reason: string | null; refund_sen: number; notes: string | null;
  delivery_order_id: string | null; sales_invoice_id: string | null;
  address1?: string | null; address2?: string | null;
  city?: string | null; state?: string | null; postcode?: string | null;
  phone?: string | null; email?: string | null;
  customer_state?: string | null;
};
type DrItem = {
  item_code: string; description: string | null;
  qty_returned: number; condition: string | null;
  unit_price_sen: number; refund_sen: number;
  item_group?: string | null;
  variants?: Record<string, unknown> | null;
};

type DrOpts = { docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string };

export async function renderDeliveryReturnInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: DrHeader,
  items: DrItem[],
  opts?: DrOpts,
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, items]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'DELIVERY RETURN',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'DR No', value: header.return_number },
      { label: 'Date', value: fmtDocDate(header.return_date) },
    ],
  });

  const statusText = statusLabel('dr', header.status);
  const addressValue = [
    header.address1,
    header.address2,
    [header.postcode, header.city, header.state ?? header.customer_state]
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' '),
  ]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join(', ');
  y = drawInfoColumns(doc, y,
    billToBlock({
      name: header.debtor_name,
      code: header.debtor_code,
      address: addressValue,
      phone: header.phone ? formatPhone(header.phone) : null,
      email: header.email,
      extras: [['Reason', header.reason]],
      note: header.notes,
    }, { title: 'FROM CUSTOMER' }),
    {
      title: 'RETURN DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'DR No', header.return_number],
        ['Date', fmtDocDate(header.return_date)],
        ['Status', statusText],
      ],
    },
  );

  const fabric = await loadCustomerFabricMaps(items);
  const orderedItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(items, (r) => r.item_group as string | null | undefined),
  );
  const rows = orderedItems.map((it, idx) => [
    String(idx + 1),
    it.item_code,
    stripBookText([it.description, docVariantLine(it, fabric.ext, fabric.desc)].filter(Boolean).join('\n')) || '—',
    String(it.qty_returned),
    it.condition ?? '—',
    fmtRm(it.unit_price_sen),
    fmtRm(it.refund_sen),
  ]);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Item', 'Description', 'Qty', 'Condition', 'Unit Price', opts?.amountLabel ?? 'Refund']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 24 },
      2: { cellWidth: 60 },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 22 },
      5: { cellWidth: 24, halign: 'right' },
      6: { cellWidth: 26, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(opts?.totalLabel ?? 'TOTAL REFUND', totalsX, lastY + 2);
  doc.text(fmtRm(header.refund_sen), pageW - margin, lastY + 2, { align: 'right' });

  const ty = drawSignatureBoxes(doc, lastY + 12, 'Customer Confirms Return', `${COMPANY.name} Received By`);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text('Note: By signing above, both parties confirm the return of the items listed above.', margin, ty);
  doc.setTextColor(0);

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.return_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.return_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

export async function generateDeliveryReturnPdf(
  header: DrHeader,
  items: DrItem[],
  opts?: DrOpts & { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderDeliveryReturnInto(doc, autoTable, header, items, opts);
  deliverPdf(doc, `${header.return_number}-${safeName(header.debtor_name)}.pdf`, opts?.action);
}

export async function generateCombinedDeliveryReturnPdf(
  docs: Array<{ header: DrHeader; items: DrItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderDeliveryReturnInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  deliverPdf(doc, opts?.fileName ?? 'delivery-returns.pdf', opts?.action);
}
