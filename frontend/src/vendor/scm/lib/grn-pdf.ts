import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { formatPhone } from '@2990s/shared/phone';
import { docPageLabel, COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, warehousePrintName, drawSignatureBoxes, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { supplierBlock } from '../../../../../shared/src/vendor/scm/lib/pdf-party-blocks';
import { loadSupplierDocData, supplierCodeFor, docVariantLine } from './supplier-doc-data';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';

type GrnHeader = {
  grn_number: string; status: string;
  received_at: string; delivery_note_ref: string | null;
  notes: string | null; posted_at: string | null;
  supplier_id?: string | null;
  warehouse_name?: string | null;
  warehouse_code?: string | null;
  supplier?: { code: string; name: string };
  purchase_order?: { id: string; po_number: string };
};
type GrnItem = {
  item_code: string; material_name: string;
  qty_received: number; qty_accepted: number; qty_rejected: number;
  rejection_reason: string | null; unit_price_sen: number;
  supplier_sku?: string | null;
  item_group?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
};

export async function renderGrnInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: GrnHeader,
  items: GrnItem[],
  opts?: { docTitle?: string; docNoLabel?: string },
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, items]);

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const startPage = doc.getNumberOfPages();

  let y = drawHeader(doc, {
    docTitle: opts?.docTitle ?? 'GOODS RECEIPT NOTE',
    rightMeta: [
      { label: opts?.docNoLabel ?? 'GRN No', value: header.grn_number },
      { label: 'Date', value: fmtDocDate(header.received_at) },
    ],
  });

  const { skuMap, fabricMap, fabricDescMap, supplier: sFull } = await loadSupplierDocData(header.supplier_id, items);
  const supplierAddressLines = [
    sFull?.address,
    sFull?.area,
    [sFull?.postcode, sFull?.state].filter(Boolean).join(' ').trim() || null,
    sFull?.country,
  ].filter(Boolean) as string[];

  const statusText = statusLabel('grn', header.status);
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
      note: header.notes,
    }),
    {
      title: 'GRN DETAILS',
      rows: [
        [opts?.docNoLabel ?? 'GRN No', header.grn_number],
        ['Received', fmtDocDate(header.received_at)],
        ['Warehouse', warehousePrintName(header)],
        ['DN Ref', header.delivery_note_ref],
        ['PO Ref', header.purchase_order?.po_number],
        ['Posted', header.posted_at ? fmtDocDate(header.posted_at) : null],
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
      String(it.qty_received),
      String(it.qty_accepted),
      String(it.qty_rejected),
      it.rejection_reason ?? (it.qty_rejected > 0 ? '—' : ''),
      fmtRm(it.unit_price_sen),
    ];
  });
  autoTable(doc, {
    startY: y,
    head: [['#', 'Supplier Code', 'Our Code', 'Description', 'Recv', 'Acc', 'Rej', 'Reason', 'Unit Price']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 24, fontStyle: 'bold' },
      2: { cellWidth: 24 },
      3: { cellWidth: 47 },
      4: { cellWidth: 11, halign: 'right' },
      5: { cellWidth: 11, halign: 'right' },
      6: { cellWidth: 11, halign: 'right' },
      7: { cellWidth: 24 },
      8: { cellWidth: 22, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  drawSignatureBoxes(doc, lastY, 'Warehouse Received By', 'Supplier Driver Signature');

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.grn_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.received_at)}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

export async function generateGrnPdf(
  header: GrnHeader,
  items: GrnItem[],
  opts?: { docTitle?: string; docNoLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderGrnInto(doc, autoTable, header, items, opts);
  deliverPdf(doc, `${header.grn_number}-${safeName(header.supplier?.name ?? 'supplier')}.pdf`, opts?.action);
}

export async function generateCombinedGrnPdf(
  docs: Array<{ header: GrnHeader; items: GrnItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderGrnInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  deliverPdf(doc, opts?.fileName ?? 'goods-received.pdf', opts?.action);
}
