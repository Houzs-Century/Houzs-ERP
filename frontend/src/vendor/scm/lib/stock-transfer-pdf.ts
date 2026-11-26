import { docPageLabel,
  COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader,
  drawInfoColumns, drawSignatureBoxes, ensurePdfCjkFont, safeName, fmtDocDate,
  type PdfAction,
} from './pdf-common';
import { warehouseLabel, type WarehouseLabelSource } from './warehouse-label';
import { variantKeyLabel } from './variant-key-label';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from '../../../../../shared/src/vendor/scm/lib/status-pill';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';

type StWarehouse = WarehouseLabelSource & { name?: string | null };

type StHeader = {
  transfer_no: string;
  status: string;
  transfer_date: string;
  notes: string | null;
  posted_at?: string | null;
  cancelled_at?: string | null;
  from_warehouse_id?: string | null;
  to_warehouse_id?: string | null;
  from_warehouse?: StWarehouse | null;
  to_warehouse?: StWarehouse | null;
};

type StLine = {
  item_code: string;
  product_name: string | null;
  qty: number;
  notes?: string | null;
  variant_key?: string | null;
};

const whLabel = (w: StWarehouse | null | undefined, id: string | null | undefined): string =>
  warehouseLabel(w) ?? (id ?? '—');

const whSubLabel = (w: StWarehouse | null | undefined): string => {
  const name = (w?.name ?? '').trim();
  return name && name !== warehouseLabel(w) ? name : '';
};

export async function renderStockTransferInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: StHeader,
  lines: StLine[],
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, lines]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, {
    docTitle: 'STOCK TRANSFER',
    rightMeta: [
      { label: 'ST No', value: header.transfer_no },
      { label: 'Date', value: fmtDocDate(header.transfer_date) },
    ],
  });

  const fromLabel = whLabel(header.from_warehouse, header.from_warehouse_id);
  const toLabel   = whLabel(header.to_warehouse,   header.to_warehouse_id);
  const fromName  = whSubLabel(header.from_warehouse);
  const toName    = whSubLabel(header.to_warehouse);

  const colW = (pageW - margin * 2 - 14) / 2;
  const rightX = margin + colW + 14;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(110);
  doc.text('FROM WAREHOUSE', margin, y);
  doc.text('TO WAREHOUSE', rightX, y);
  doc.setTextColor(0);
  y += 6;
  const LABEL_LH = 5.5;
  const NAME_LH = 4;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  const fromLines = doc.splitTextToSize(fromLabel, colW) as string[];
  const toLines = doc.splitTextToSize(toLabel, colW) as string[];
  fromLines.forEach((line, i) => doc.text(line, margin, y + i * LABEL_LH));
  toLines.forEach((line, i) => doc.text(line, rightX, y + i * LABEL_LH));
  const arrowY = y - 1.5;
  const arrowX = margin + colW + 3;
  doc.setDrawColor(60); doc.setLineWidth(0.5);
  doc.line(arrowX, arrowY, arrowX + 8, arrowY);
  doc.line(arrowX + 8, arrowY, arrowX + 5.4, arrowY - 2);
  doc.line(arrowX + 8, arrowY, arrowX + 5.4, arrowY + 2);
  doc.setLineWidth(0.2);
  y += Math.max(fromLines.length, toLines.length, 1) * LABEL_LH;

  if (fromName || toName) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    const fromNameLines = fromName ? doc.splitTextToSize(fromName, colW) as string[] : [];
    const toNameLines = toName ? doc.splitTextToSize(toName, colW) as string[] : [];
    fromNameLines.forEach((line, i) => doc.text(line, margin, y + i * NAME_LH));
    toNameLines.forEach((line, i) => doc.text(line, rightX, y + i * NAME_LH));
    doc.setTextColor(0);
    y += Math.max(fromNameLines.length, toNameLines.length, 1) * NAME_LH;
  }
  y += 3;
  doc.setDrawColor(180); doc.line(margin, y, pageW - margin, y);
  y += 5;

  const totalQty = lines.reduce((s, l) => s + l.qty, 0);

  y = drawInfoColumns(doc, y,
    {
      title: 'MOVEMENT',
      rows: [
        ['From', fromLabel],
        ['To', toLabel],
        ['Notes', header.notes],
      ],
    },
    {
      title: 'TRANSFER DETAILS',
      rows: [
        ['ST No', header.transfer_no],
        ['Date', fmtDocDate(header.transfer_date)],
        ['Status', statusLabel('stockTransfer', header.status)],
        ['Posted', header.posted_at ? fmtDocDate(header.posted_at) : null],
        ['Cancelled', header.cancelled_at ? fmtDocDate(header.cancelled_at) : null],
        ['Lines', String(lines.length)],
      ],
    },
  );

  const rows = lines.map((l, idx) => {
    const variant = variantKeyLabel(l.variant_key, '');
    const desc = [l.product_name, variant].filter(Boolean).join('\n');
    return [
      String(idx + 1),
      l.item_code,
      desc || '—',
      String(l.qty),
      l.notes ?? '',
    ];
  });
  autoTable(doc, {
    startY: y,
    head: [['#', 'Item', 'Description', 'Qty', 'Notes']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 30 },
      2: { cellWidth: 70 },
      3: { cellWidth: 18, halign: 'right' },
      4: { cellWidth: 56 },
    },
    margin: { left: margin, right: margin },
  });
  const lastY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  let totalY = lastY + 2;
  if (totalY > 275) {
    doc.addPage();
    totalY = margin;
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('TOTAL QTY', totalsX, totalY);
  doc.text(String(totalQty), pageW - margin, totalY, { align: 'right' });

  const sigMaxW = (pageW - margin * 2) / 2 - 7;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  const sigLabel = (role: string, wh: string): string => {
    if (wh === '—') return role;
    const full = `${role} — ${wh}`;
    return doc.getTextWidth(full) <= sigMaxW ? full : role;
  };
  const ty = drawSignatureBoxes(
    doc, totalY + 10,
    sigLabel('Released By', fromLabel),
    sigLabel('Received By', toLabel),
  );

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
  doc.text(
    'Note: this document records a movement of stock between warehouses. It states no value.',
    margin, ty,
  );
  doc.setTextColor(0);

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.transfer_no, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.transfer_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/** One stock transfer → its own file / print job / preview tab. */
export async function generateStockTransferPdf(
  header: StHeader,
  lines: StLine[],
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderStockTransferInto(doc, autoTable, header, lines);
  const pair = [
    whLabel(header.from_warehouse, header.from_warehouse_id),
    whLabel(header.to_warehouse, header.to_warehouse_id),
  ].join(' to ');
  deliverPdf(doc, `${header.transfer_no}-${safeName(pair)}.pdf`, opts?.action);
}
