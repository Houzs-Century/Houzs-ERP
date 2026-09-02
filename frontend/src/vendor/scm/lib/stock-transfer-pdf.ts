// Stock Transfer PDF — the warehouse hand-off sheet.
//
// The Stock Transfer and the Stock Take were the only two documents in the
// system that could not be printed at all — neither had ever had a print
// handler, on any surface.
//
// Two owner quotes were cited here and have been removed: neither appears in any
// message he sent in the session that produced this file. See
// pages/scm-v2/row-menus.ts for the full provenance note.
//
// Same unified layout as SO / PO / DO / SI / GRN / DR: real letterhead, the
// shared info block, the shared table look, the same footer (doc no · portal ·
// page n of m) on every page. A4 portrait, pure B&W.
//
// NO MONEY, DELIBERATELY. `/stock-transfers` carries no value of any kind — no
// unit price, no line total, no header total (`stock-transfers.ts` HEADER/LINE).
// The cost side of a transfer exists only inside the movement rows
// fn_stock_transfer_apply writes, and it is a FIFO basis carried from the source
// lot, not a figure this document states. A totals rail here would be inventing
// one, so the only total printed is the one the document genuinely has: quantity.
//
// THE WAREHOUSE PAIR IS THE DOCUMENT. Everything else on a transfer describes
// the pair, so FROM and TO get their own band under the letterhead rather than
// a row in the label gutter (same treatment the Purchase Order gives DELIVER TO).
import {
  COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader,
  drawInfoColumns, drawSignatureBoxes, ensurePdfCjkFont, safeName, fmtDocDate,
  type PdfAction,
} from './pdf-common';
import { warehouseLabel, type WarehouseLabelSource } from './warehouse-label';
import { variantKeyLabel } from './variant-key-label';
/* The status WORD comes from the one home for it, never from a caser here:
   what this document prints and what the screen shows must be the same word.
   docs/modules/document-status-vocabulary.md §1. */
import { statusLabel } from './status-pill';

type StWarehouse = WarehouseLabelSource & { name?: string | null };

type StHeader = {
  transfer_no: string;
  status: string;
  transfer_date: string;
  notes: string | null;
  posted_at?: string | null;
  cancelled_at?: string | null;
  /* Ids are the FALLBACK, never the headline: an unresolved embed still has to
     say something, but a uuid on a printed sheet tells a storekeeper nothing. */
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
  /* The route SELECTs it (`stock-transfers.ts` LINE) and it is the bucket that
     actually moved; optional because the frontend's `StockTransferLine` type
     does not spell it and a legacy row stores ''. */
  variant_key?: string | null;
};

/** Code first then name — `warehouse-label.ts`, the one rule — with the raw id
 *  behind it so an unresolved embed is still identifiable. */
const whLabel = (w: StWarehouse | null | undefined, id: string | null | undefined): string =>
  warehouseLabel(w) ?? (id ?? '—');

/** The warehouse's full name, only when it adds something the label did not.
 *  `warehouseLabel` returns the CODE when there is one, so a storekeeper on the
 *  receiving dock otherwise gets a code and no words. */
const whSubLabel = (w: StWarehouse | null | undefined): string => {
  const name = (w?.name ?? '').trim();
  return name && name !== warehouseLabel(w) ? name : '';
};

/* Draw ONE transfer's content into `doc` (letterhead → movement band → info →
   table → qty total → signatures → footer). Split out from the single-file
   generator on the same shape as the GRN / DR renderers, so a combined export
   can share one doc later without this being rewritten; the footer numbers only
   the pages THIS transfer added. */
export async function renderStockTransferInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: StHeader,
  lines: StLine[],
): Promise<void> {
  /* Before ANY drawing: a product name or note carrying CJK needs the font
     embedded up front, or helvetica silently paints the whole field as
     mojibake. No-op for a pure-WinAnsi document. */
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

  // ── The movement band ───────────────────────────────────────────────
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
  /* WRAPPED, and the band's height follows the wrap. A warehouse with no code
     falls back to its NAME (warehouse-label.ts), which can be long enough to
     take two lines at this size — and a fixed step here would put the second
     line straight through the name row below it. */
  const LABEL_LH = 5.5;
  const NAME_LH = 4;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  const fromLines = doc.splitTextToSize(fromLabel, colW) as string[];
  const toLines = doc.splitTextToSize(toLabel, colW) as string[];
  fromLines.forEach((line, i) => doc.text(line, margin, y + i * LABEL_LH));
  toLines.forEach((line, i) => doc.text(line, rightX, y + i * LABEL_LH));
  /* The arrow sits on the two labels' FIRST baseline, in the gutter between
     them — the direction is the one thing a reader must not have to work out.
     DRAWN, not typed: U+2192 is not one of the 27 codepoints jspdf's WinAnsi
     table knows, and `ensurePdfCjkFont` only scans the PAYLOAD, so an arrow
     written as a literal here would paint as mojibake with nothing to catch it. */
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

  /* No `?? 0` guard: the route refuses a line whose qty is not a positive
     integer at create time (`stock-transfers.ts` — `qty must be > 0`), so the
     column is never null and a nullish default here would be a condition the
     linter is right to call dead. */
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

  /* Server order is kept as it comes (`.order('created_at')`), and the sofa
     build walk the sales/purchase documents apply is NOT used here: transfer
     lines carry no `item_group` and no `variants`, so it would be a no-op that
     only added imports. */
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

  /* The ONLY total this document has. Named TOTAL QTY rather than TOTAL so it
     can never be mistaken for a value on a sheet that states none.

     Page-guarded for the same reason the Stock Take's rail is: a table that
     runs to the bottom of the last page would otherwise put this line past the
     paper, or on top of the footer at y=290. */
  const totalsX = pageW - margin - 70;
  let totalY = lastY + 2;
  if (totalY > 275) {
    doc.addPage();
    totalY = margin;
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('TOTAL QTY', totalsX, totalY);
  doc.text(String(totalQty), pageW - margin, totalY, { align: 'right' });

  /* Naming the two warehouses on the signature boxes is what makes this a
     hand-off sheet rather than a form — but drawSignatureBoxes does not wrap,
     and the two labels sit half a page apart, so an over-long one would run
     into its neighbour. MEASURED at the font drawSignatureBoxes draws them in,
     and dropped rather than collided with: a warehouse whose label does not
     fit falls back to the bare role, which is still true. */
  const sigMaxW = (pageW - margin * 2) / 2 - 7;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  const sigLabel = (role: string, wh: string): string => {
    if (wh === '—') return role;
    const full = `${role} — ${wh}`;
    return doc.getTextWidth(full) <= sigMaxW ? full : role;
  };
  const ty = drawSignatureBoxes(
    /* From the total's OWN y, not from lastY — if the total moved to a new
       page, the signatures follow it there. */
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

  // Footer: doc no · portal · page n of m — only on the pages THIS transfer added.
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.transfer_no, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.transfer_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
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
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderStockTransferInto(doc, autoTable, header, lines);
  const pair = [
    whLabel(header.from_warehouse, header.from_warehouse_id),
    whLabel(header.to_warehouse, header.to_warehouse_id),
  ].join(' to ');
  deliverPdf(doc, `${header.transfer_no}-${safeName(pair)}.pdf`, opts?.action);
}
