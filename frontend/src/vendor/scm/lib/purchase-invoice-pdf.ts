import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { formatPhone } from '@2990s/shared/phone';
import { docPageLabel, COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { supplierBlock } from '../../../../../shared/src/vendor/scm/lib/pdf-party-blocks';
import { loadSupplierDocData, supplierCodeFor, docVariantLine } from './supplier-doc-data';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import { piPoNumbers } from './pi-header-pos';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';

type PiHeader = {
  invoice_number: string; supplier_invoice_ref: string | null; status: string;
  invoice_date: string; due_date: string | null; currency: string;
  subtotal_sen: number; tax_sen: number; total_sen: number;
  paid_sen: number; notes: string | null;
  supplier_id?: string | null;
  supplier?: { code: string; name: string };
  // Source PO / GRN this invoice was raised from — the detail endpoint already
  // embeds them (purchase_order:purchase_orders(po_number), grn:grns(grn_number)).
  // Optional so older call sites compile; printed as PO Ref / GRN Ref so the
  // invoice shows which PO/GRN it came from. Owner 2026-07-20.
  purchase_order?: { po_number: string } | null;
  grn?: { grn_number: string } | null;
};
type PiItem = {
  item_code: string; material_name: string;
  qty: number; unit_price_sen: number; line_total_sen: number;
  supplier_sku?: string | null;
  item_group?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
  source_po_number?: string | null;
};

export async function renderPurchaseInvoiceInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- autotable fn loosely typed (matches the PO generator)
  autoTable: any,
  header: PiHeader,
  items: PiItem[],
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, items]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: 'PURCHASE INVOICE',
    rightMeta: [
      { label: 'Our PI No', value: header.invoice_number },
      { label: 'Date',      value: fmtDocDate(header.invoice_date) },
    ],
  });

  const { skuMap, fabricMap, fabricDescMap, supplier: sFull } = await loadSupplierDocData(header.supplier_id, items);
  const supplierAddressLines = [
    sFull?.address,
    sFull?.area,
    [sFull?.postcode, sFull?.state].filter(Boolean).join(' ').trim() || null,
    sFull?.country,
  ].filter(Boolean) as string[];

  const statusText = statusLabel('pi', header.status);
  /* Every PO the lines bill, not only the header's first (owner 2026-11-10). */
  const poNumbers = piPoNumbers(items.map((it) => it.source_po_number), header.purchase_order?.po_number ?? null);
  const poRefLines: string[] = [];
  for (let i = 0; i < poNumbers.length; i += 2) {
    poRefLines.push(poNumbers.slice(i, i + 2).join(', ') + (i + 2 < poNumbers.length ? ',' : ''));
  }
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
      title: 'INVOICE DETAILS',
      rows: [
        ['Our PI No', header.invoice_number],
        [poNumbers.length > 1 ? 'PO Refs' : 'PO Ref', poRefLines],
        ['GRN Ref', header.grn?.grn_number ?? null],
        ['Supplier Ref', header.supplier_invoice_ref],
        ['Date', fmtDocDate(header.invoice_date)],
        ['Due', header.due_date ? fmtDocDate(header.due_date) : null],
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
      String(it.qty),
      fmtRm(it.unit_price_sen, header.currency),
      fmtRm(it.line_total_sen, header.currency),
    ];
  });
  autoTable(doc, {
    startY: y,
    head: [['#', 'Supplier Code', 'Our Code', 'Description', 'Qty', 'Unit Price', 'Total']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 26, fontStyle: 'bold' },
      2: { cellWidth: 26 },
      3: { cellWidth: 56 },
      4: { cellWidth: 12, halign: 'right' },
      5: { cellWidth: 27, halign: 'right' },
      6: { cellWidth: 27, halign: 'right' },
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
  drawRow('Tax',      fmtRm(header.tax_sen,      header.currency), ty); ty += 5;
  doc.setDrawColor(0); doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.setFontSize(11);
  drawRow('GRAND TOTAL', fmtRm(header.total_sen, header.currency), ty + 2, true); ty += 6;
  doc.setFontSize(9);
  drawRow('Paid',        fmtRm(header.paid_sen, header.currency), ty + 4); ty += 4;
  drawRow('Outstanding', fmtRm(header.total_sen - header.paid_sen, header.currency), ty + 4, true);

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.invoice_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.invoice_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

export async function generatePurchaseInvoicePdf(
  header: PiHeader,
  items: PiItem[],
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderPurchaseInvoiceInto(doc, autoTable, header, items);
  deliverPdf(doc, `${header.invoice_number}-${safeName(header.supplier?.name ?? 'supplier')}.pdf`, opts?.action);
}

export async function generateCombinedPurchaseInvoicePdf(
  docs: Array<{ header: PiHeader; items: PiItem[] }>,
  opts?: { fileName?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderPurchaseInvoiceInto(doc, autoTable, docs[i]!.header, docs[i]!.items);
  }
  deliverPdf(doc, opts?.fileName ?? 'purchase-invoices.pdf', opts?.action);
}
