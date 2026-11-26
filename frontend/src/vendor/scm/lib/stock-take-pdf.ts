import { docPageLabel,
  COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader,
  drawInfoColumns, drawSignatureBoxes, ensurePdfCjkFont, safeName, fmtDocDate,
  type PdfAction,
} from './pdf-common';
import { warehouseLabel, type WarehouseLabelSource } from './warehouse-label';
import { printVariant, variantKeyLabel } from './variant-key-label';

export { printVariant };
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';
import { PDF_COMPRESS } from './pdf-options';

type StkWarehouse = WarehouseLabelSource & { name?: string | null };

type StkHeader = {
  take_no: string;
  status: string;
  take_date: string;
  scope_type: string;
  scope_value: string | null;
  notes: string | null;
  posted_at?: string | null;
  cancelled_at?: string | null;
  blind?: boolean;
  warehouse_id?: string | null;
  warehouse?: StkWarehouse | null;
  assignee_name?: string | null;
};

type StkLine = {
  item_code: string;
  product_name: string | null;
  variant_key?: string | null;
  variant_label?: string | null;
  system_qty: number | null;
  counted_qty: number | null;
  variance: number | null;
  notes?: string | null;
};

const SCOPE_LABEL = (scopeType: string, scopeValue: string | null): string => {
  if (scopeType === 'ALL') return 'All SKUs';
  if (scopeType === 'NONZERO') return 'SKUs with stock';
  if (scopeType === 'CATEGORY') return `Category · ${scopeValue ?? '—'}`;
  if (scopeType === 'CODE_PREFIX') return `Prefix · ${scopeValue ?? '—'}`;
  return scopeType;
};

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

const systemQtyWithheld = (lines: StkLine[]): boolean =>
  lines.length > 0 && lines.every((l) => l.system_qty == null);

export async function renderStockTakeInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: StkHeader,
  lines: StkLine[],
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, lines]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const withheld = systemQtyWithheld(lines);

  let y = drawHeader(doc, {
    docTitle: 'STOCK TAKE',
    rightMeta: [
      { label: 'STK No', value: header.take_no },
      { label: 'Date', value: fmtDocDate(header.take_date) },
    ],
  });

  const whLabel = warehouseLabel(header.warehouse) ?? (header.warehouse_id ?? '—');
  const whName = (header.warehouse?.name ?? '').trim();

  y = drawInfoColumns(doc, y,
    {
      title: 'COUNT',
      rows: [
        ['Warehouse', whName && whName !== whLabel ? `${whLabel} · ${whName}` : whLabel],
        ['Scope', SCOPE_LABEL(header.scope_type, header.scope_value)],
        ['Assignees', header.assignee_name],
        ['Notes', header.notes],
      ],
    },
    {
      title: 'TAKE DETAILS',
      rows: [
        ['STK No', header.take_no],
        ['Date', fmtDocDate(header.take_date)],
        ['Status', statusLabel('stockTake', header.status)],
        ['Posted', header.posted_at ? fmtDocDate(header.posted_at) : null],
        ['Cancelled', header.cancelled_at ? fmtDocDate(header.cancelled_at) : null],
        ['Blind', header.blind ? 'Yes' : null],
        ['Lines', String(lines.length)],
      ],
    },
  );

  if (withheld) {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(80);
    doc.text(
      'Blind count — system quantities and variances are not shown on this sheet.',
      margin, y,
    );
    doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
    y += 4;
  }

  /* COMPACT (owner 2026-10-06: a 704-line take printed to 40+ pages). One
     line per row: the name is cut with an ellipsis rather than wrapped, the
     variant has its own narrow column (it tells two buckets of one SKU apart, so
     it is never cut), and each row keeps just enough height to write a count
     by hand. An OPEN sheet is a counting sheet: its Variance column (empty on
     paper) gives way to a blank RACK column for where the goods actually sit.
     Server order is kept as it comes (`.order('item_code')`). */
  const counting = header.status === 'OPEN';
  const rows = lines.map((l, idx) => {
    const variant = printVariant(l.variant_label ?? variantKeyLabel(l.variant_key, ''));
    const base = [String(idx + 1), l.item_code, l.product_name || '—', variant];
    const counted = l.counted_qty == null ? '' : String(l.counted_qty);
    if (withheld) return [...base, counted, '', l.notes ?? ''];
    return [
      ...base,
      l.system_qty == null ? '—' : String(l.system_qty),
      counted,
      counting ? '' : l.counted_qty == null || l.variance == null ? '' : signed(l.variance),
      l.notes ?? '',
    ];
  });
  const head = withheld
    ? ['#', 'Item', 'Description', 'Variant', 'Counted', 'Rack', 'Notes']
    : ['#', 'Item', 'Description', 'Variant', 'System', 'Counted', counting ? 'Rack' : 'Variance', 'Notes'];
  const columnStyles = withheld
    ? {
      0: { cellWidth: 7, halign: 'right' },
      1: { cellWidth: 40, fontSize: 7 },
      2: { cellWidth: 44, overflow: 'ellipsize' },
      3: { cellWidth: 40, fontSize: 6.5 },
      4: { cellWidth: 15, halign: 'right' },
      5: { cellWidth: 16 },
      6: { cellWidth: 20 },
    }
    : {
      0: { cellWidth: 7, halign: 'right' },
      1: { cellWidth: 38, fontSize: 7 },
      2: { cellWidth: 34, overflow: 'ellipsize' },
      3: { cellWidth: 42, fontSize: 6.5 },
      4: { cellWidth: 13, halign: 'right' },
      5: { cellWidth: 14, halign: 'right' },
      6: { cellWidth: 16, halign: counting ? 'left' : 'right' },
      7: { cellWidth: 18 },
    };
  autoTable(doc, {
    startY: y,
    head: [head],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 7.5, cellPadding: { top: 1, bottom: 1, left: 1.2, right: 1.2 }, minCellHeight: 5.5, valign: 'middle' },
    headStyles: { ...DOC_TABLE_HEAD_STYLES, fontSize: 7.5 },
    columnStyles,
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  let counted = 0;
  let variancePos = 0;
  let varianceNeg = 0;
  for (const l of lines) {
    if (l.counted_qty == null) continue;
    counted += 1;
    if (l.variance == null) continue;
    if (l.variance > 0) variancePos += l.variance;
    if (l.variance < 0) varianceNeg += l.variance;
  }
  const uncounted = lines.length - counted;

  const railX = pageW - margin - 70;
  let railY = lastY + 2;
  if (railY + 23 > 275) {
    doc.addPage();
    railY = margin;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text('Counted', railX, railY);
  doc.text(`${counted} of ${lines.length}`, pageW - margin, railY, { align: 'right' });
  railY += 5;
  doc.text('Not counted', railX, railY);
  doc.text(String(uncounted), pageW - margin, railY, { align: 'right' });

  if (!withheld) {
    railY += 5;
    doc.text('Variance up', railX, railY);
    doc.text(signed(variancePos), pageW - margin, railY, { align: 'right' });
    railY += 5;
    doc.text('Variance down', railX, railY);
    doc.text(signed(varianceNeg), pageW - margin, railY, { align: 'right' });
    railY += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('NET VARIANCE', railX, railY);
    doc.text(signed(variancePos + varianceNeg), pageW - margin, railY, { align: 'right' });
  }

  const ty = drawSignatureBoxes(doc, railY + 10, 'Counted By', 'Verified By');

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text(
    'Note: quantities only. Posting this count books one stock adjustment per line with a variance.',
    margin, ty,
  );
  doc.setTextColor(0);

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.take_no, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.take_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/** One stock take → its own file / print job / preview tab. */
export async function generateStockTakePdf(
  header: StkHeader,
  lines: StkLine[],
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderStockTakeInto(doc, autoTable, header, lines);
  const wh = warehouseLabel(header.warehouse) ?? '';
  deliverPdf(doc, `${header.take_no}${wh ? `-${safeName(wh)}` : ''}.pdf`, opts?.action);
}
