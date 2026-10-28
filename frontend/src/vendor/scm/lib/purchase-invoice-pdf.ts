// Purchase Invoice PDF — internal copy / for filing.
// Dual-code layout (Commander): supplier code first, our code alongside.
// purchase_invoice_items has NO supplier_sku column — resolved at print time
// from supplier_material_bindings via the doc's supplier_id.
//
// 2026-06-19 — unified "Hookka-tidy" layout shared with SO/PO/DO/SI: real
// letterhead header, the drawInfoColumns info block (SUPPLIER label-gutter +
// INVOICE DETAILS colon-aligned), and the consistent footer (doc no · portal ·
// page n of m). A4 portrait, pure B&W. Dual-code table + totals unchanged.
import {
  orderSofaModuleRowsWithinBuilds,
  sortSoLinesByGroupRank,
} from '@2990s/shared/so-line-display';
import { formatPhone } from '@2990s/shared/phone';
import { COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, drawInfoColumns, ensurePdfCjkFont, fmtRm, safeName, fmtDocDate, type PdfAction } from './pdf-common';
import { supplierBlock } from './pdf-party-blocks';
import { loadSupplierDocData, supplierCodeFor, docVariantLine } from './supplier-doc-data';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';

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
  /* Dual-code extras — optional so older call sites keep compiling. */
  supplier_sku?: string | null;
  item_group?: string | null;
  description?: string | null;
  variants?: Record<string, unknown> | null;
};

/* Draw ONE purchase invoice's content into `doc` (letterhead → info → codes
   note → table → totals → footer). Does NOT make the doc or save it — the
   caller finalizes ONCE, so several PIs can share one combined doc. The footer
   page loop runs from `startPage` so a combined doc only re-numbers THIS PI's
   pages on each invocation (jsPDF has no per-section page reset). */
export async function renderPurchaseInvoiceInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- autotable fn loosely typed (matches the PO generator)
  autoTable: any,
  header: PiHeader,
  items: PiItem[],
): Promise<void> {
  /* Before ANY drawing: a customer / supplier name, address or remark that
     carries CJK needs the font embedded up front, or helvetica silently paints
     the whole field as mojibake. No-op for a pure-WinAnsi document. */
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

  /* Load supplier master + dual-code lookups BEFORE the info block so the
     canonical SUPPLIER block can include address / tel / attn / terms — the
     PI's own header carries only { code, name } (endpoint economy), the top-up
     comes from GET /suppliers/:id. loadSupplierDocData is a single parallel
     round; moving it forward doesn't add a request. */
  const { skuMap, fabricMap, fabricDescMap, supplier: sFull } = await loadSupplierDocData(header.supplier_id, items);
  const supplierAddressLines = [
    sFull?.address,
    sFull?.area,
    [sFull?.postcode, sFull?.state].filter(Boolean).join(' ').trim() || null,
    sFull?.country,
  ].filter(Boolean) as string[];

  const statusText = statusLabel('pi', header.status);
  y = drawInfoColumns(doc, y,
    /* Canonical supplier block via the shared helper — Company, Code,
       Address, Tel, Fax, Email, Attn, Terms, Note. Previously the PI printed
       only Company + Code + Note; matching the PO / GRN / PR now, every
       purchasing doc reads the same rows. */
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
        ['PO Ref', header.purchase_order?.po_number ?? null],
        ['GRN Ref', header.grn?.grn_number ?? null],
        ['Supplier Ref', header.supplier_invoice_ref],
        ['Date', fmtDocDate(header.invoice_date)],
        ['Due', header.due_date ? fmtDocDate(header.due_date) : null],
        ['Status', statusText],
      ],
    },
  );

  // Codes note (dual-code lookups already loaded above, next to the supplier
  // block, so the block prints with a full supplier profile in one round).
  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(80);
  doc.text('Codes shown are SUPPLIER codes; our reference in second column.', margin, y);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
  y += 4;

  /* Canonical SKU/build order (sofa modules LHF→NA→RHF, mains→accessories→
     services) — mirror the sales side. The shared helper keys on `item_code`;
     PI lines expose `item_code`, so sort a shimmed view that carries the
     original row back unchanged (render-time only, no persistence touched). */
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

  // Footer: doc no · portal · page n of m on every page (of THIS PI's run)
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

/* Single PI → its own file (unchanged behaviour). */
export async function generatePurchaseInvoicePdf(
  header: PiHeader,
  items: PiItem[],
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderPurchaseInvoiceInto(doc, autoTable, header, items);
  deliverPdf(doc, `${header.invoice_number}-${safeName(header.supplier?.name ?? 'supplier')}.pdf`, opts?.action);
}

/* Several PIs → ONE combined file, each PI starting on a new page. For the
   batch "Export PDF" action on the Purchase Invoices list. */
export async function generateCombinedPurchaseInvoicePdf(
  docs: Array<{ header: PiHeader; items: PiItem[] }>,
  opts?: { fileName?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderPurchaseInvoiceInto(doc, autoTable, docs[i]!.header, docs[i]!.items);
  }
  deliverPdf(doc, opts?.fileName ?? 'purchase-invoices.pdf', opts?.action);
}
