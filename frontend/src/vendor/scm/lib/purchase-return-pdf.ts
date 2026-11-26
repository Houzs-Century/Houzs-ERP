import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { formatPhone } from '@2990s/shared/phone';
import { docPageLabel, COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, drawSignatureBoxes, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { supplierBlock } from '../../../../../shared/src/vendor/scm/lib/pdf-party-blocks';
import { loadSupplierDocData, supplierCodeFor, docVariantLine } from './supplier-doc-data';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';

type PrHeader = {
  return_number: string; status: string; return_date: string;
  reason: string | null; refund_sen: number; credit_note_ref: string | null;
  notes: string | null;
  supplier_id?: string | null;
  supplier?: { code: string; name: string };
  purchase_order?: { id: string; po_number: string };
  grn?: { id: string; grn_number: string };
};
type PrItem = {
  item_code: string; material_name: string;
  qty_returned: number; unit_price_sen: number; line_refund_sen: number;
  reason: string | null;
  supplier_sku?: string | null;
  item_group?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
};

export async function renderPurchaseReturnInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: PrHeader,
  items: PrItem[],
  opts?: { docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string },
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, items]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'PURCHASE RETURN',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'PR No', value: header.return_number },
      { label: 'Date', value: fmtDocDate(header.return_date) },
    ],
  });

  const { skuMap, fabricMap, fabricDescMap, supplier: sFull } = await loadSupplierDocData(header.supplier_id, items);
  const supplierAddressLines = [
    sFull?.address,
    sFull?.area,
    [sFull?.postcode, sFull?.state].filter(Boolean).join(' ').trim() || null,
    sFull?.country,
  ].filter(Boolean) as string[];

  const statusText = statusLabel('pr', header.status);
  y = drawInfoColumns(doc, y,
    supplierBlock({
      name: header.supplier?.name ?? sFull?.name,
      code: header.supplier?.code ?? sFull?.code,
      address: supplierAddressLines.join(', '),
      phone: formatPhone(sFull?.phone ?? sFull?.mobile ?? '') || (sFull?.phone ?? sFull?.mobile),
      fax: sFull?.fax,
      email: sFull?.email,
      attention: sFull?.attention ?? sFull?.contact_person,
      paymentTerms: sFull?.payment_terms,
      extras: [['Reason', header.reason]],
      note: header.notes,
    }),
    {
      title: 'RETURN DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'PR No', header.return_number],
        ['Date', fmtDocDate(header.return_date)],
        ['PO Ref', header.purchase_order?.po_number],
        ['GRN Ref', header.grn?.grn_number],
        ['Supplier CN', header.credit_note_ref],
        ['Status', statusText],
      ],
    },
  );

  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(80);
  doc.text('Codes shown are SUPPLIER codes; our reference in second column.', margin, y);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
  y += 4;

  const orderedItems = orderSofaModuleRowsWithinBuilds(
    sortSoLinesByGroupRank(
      items.map((it) => ({ ...it, item_code: it.item_code, __row: it })),
      (r) => r.item_group as string | null | undefined,
    ),
  ).map((r) => r.__row);

  const rows = orderedItems.map((it, idx) => {
    const specs = docVariantLine(it, fabricMap, fabricDescMap, { labelled: true });
    const desc = it.description ?? it.material_name;
    return [
      String(idx + 1),
      supplierCodeFor(it, skuMap),
      it.item_code,
      specs ? `${desc}\n${specs}` : desc,
      String(it.qty_returned),
      fmtRm(it.unit_price_sen),
      fmtRm(it.line_refund_sen),
      it.reason ?? '—',
    ];
  });
  autoTable(doc, {
    startY: y,
    head: [['#', 'Supplier Code', 'Our Code', 'Description', 'Qty', 'Unit Price', opts?.amountLabel ?? 'Refund', 'Reason']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 24, fontStyle: 'bold' },
      2: { cellWidth: 24 },
      3: { cellWidth: 44 },
      4: { cellWidth: 10, halign: 'right' },
      5: { cellWidth: 24, halign: 'right' },
      6: { cellWidth: 24, halign: 'right' },
      7: { cellWidth: 24 },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(opts?.totalLabel ?? 'TOTAL REFUND', totalsX, lastY + 2);
  doc.text(fmtRm(header.refund_sen), pageW - margin, lastY + 2, { align: 'right' });

  drawSignatureBoxes(doc, lastY + 12, `${COMPANY.name} Issued By`, 'Supplier Acknowledgement');

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

export async function generatePurchaseReturnPdf(
  header: PrHeader,
  items: PrItem[],
  opts?: { docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderPurchaseReturnInto(doc, autoTable, header, items, opts);
  deliverPdf(doc, `${header.return_number}-${safeName(header.supplier?.name ?? 'supplier')}.pdf`, opts?.action);
}

export async function generateCombinedPurchaseReturnPdf(
  docs: Array<{ header: PrHeader; items: PrItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; amountLabel?: string; totalLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderPurchaseReturnInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  deliverPdf(doc, opts?.fileName ?? 'purchase-returns.pdf', opts?.action);
}
