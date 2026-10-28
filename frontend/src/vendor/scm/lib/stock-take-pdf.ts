// Stock Take PDF — the count sheet, and the variance sheet it becomes.
//
// The Stock Take and the Stock Transfer were the only two documents in the
// system with no print handler on any surface.
//
// Two owner quotes were cited here and have been removed: neither appears in any
// message he sent in the session that produced this file. See
// pages/scm-v2/row-menus.ts for the full provenance note.
//
// Same unified layout as the other nine generators: real letterhead, the shared
// info block, the shared table look, the footer (doc no · portal · page n of m)
// on every page. A4 portrait, pure B&W.
//
// NO MONEY. `/stock-takes` carries no value — the header has no total and the
// lines have no price (`stock-takes.ts` HEADER/LINE). Cost enters a take only at
// POST time, inside `resolveForcedUnitCostSen`, to decide whether a positive
// variance may be booked; it is never a figure this document states. THE NUMBER
// A PERSON PRINTS THIS TO LOOK AT IS THE VARIANCE, so the variance column and
// the net-variance rail are what the totals rail carries instead.
//
// BLIND TAKES PRINT AS A COUNT SHEET, and that is not a special case bolted on
// here. While a blind take is OPEN the SERVER strips `system_qty` and `variance`
// from the wire for anyone without `scm.stock_take.supervise` (stock-takes.ts
// GET /:id) — the fields are absent, not hidden. This generator prints what it
// was given: with both columns null on every line it drops them and says why,
// rather than printing a rail of dashes that reads as "no variance".
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
  /* The RESOLVED assignee name, passed by the page from its staff lookup.
     `assignee_staff_id` is a uuid and CLAUDE.md's standing rule is that a uuid
     never reaches a person — so the id is deliberately not accepted here at
     all: there is no lookup inside a pure PDF lib that could resolve one. */
  assignee_name?: string | null;
};

type StkLine = {
  item_code: string;
  product_name: string | null;
  variant_key?: string | null;
  variant_label?: string | null;
  /* null when the server stripped it (blind take, non-supervising viewer) and
     null when nothing has been counted yet — two different absences, told apart
     below by whether EVERY line is missing the system qty. */
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

/* The variant as a counting sheet prints it: the same facts, short words, so a
   bedframe row stays one or two lines instead of four. "fabriccode pc151-01 ·
   divanheight 10\"" → "pc151-01 · divan 10\"". The screen keeps the full label. */
const PRINT_KEY: Record<string, string> = {
  fabriccode: '', special: '', divanheight: 'divan', legheight: 'leg',
  totalheight: 'total', seatheight: 'seat', seatsize: 'seat',
};
export const printVariant = (label: string): string =>
  label.split(' · ').map((part) => {
    const sp = part.indexOf(' ');
    if (sp < 0) return part;
    const key = part.slice(0, sp).toLowerCase();
    if (!(key in PRINT_KEY)) return part;
    const short = PRINT_KEY[key];
    return short ? `${short} ${part.slice(sp + 1)}` : part.slice(sp + 1);
  }).join(' · ');

/** A signed variance reads as a variance only with its sign on it. */
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** What the sheet can show, decided from the DATA rather than from a flag the
 *  caller could forget to pass. A caller-supplied `blind` that went missing
 *  would print a column of dashes; an absent `system_qty` cannot lie. */
const systemQtyWithheld = (lines: StkLine[]): boolean =>
  lines.length > 0 && lines.every((l) => l.system_qty == null);

/* Draw ONE take's content into `doc` (letterhead → info → table → variance rail
   → signatures → footer). Same split as the GRN / DR renderers so a combined
   export can share one doc later; the footer numbers only the pages THIS take
   added. */
export async function renderStockTakeInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  header: StkHeader,
  lines: StkLine[],
): Promise<void> {
  /* Before ANY drawing: a product name, variant label or note carrying CJK
     needs the font embedded up front, or helvetica silently paints the whole
     field as mojibake. No-op for a pure-WinAnsi document. */
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
      /* An UNCOUNTED line has no variance — printing 0 there would say the
         count agreed when nobody has counted it. */
      counting ? '' : l.counted_qty == null || l.variance == null ? '' : signed(l.variance),
      l.notes ?? '',
    ];
  });
  const head = withheld
    ? ['#', 'Item', 'Description', 'Variant', 'Counted', 'Rack', 'Notes']
    : ['#', 'Item', 'Description', 'Variant', 'System', 'Counted', counting ? 'Rack' : 'Variance', 'Notes'];
  /* 182mm of A4 between the margins. */
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

  // ── The rail: counted-ness always, variance only where it is knowable ──
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
  /* A PAGE GUARD, which this document needs more than any other in the system:
     a full-warehouse take is one line per SKU, so its table routinely runs to
     the bottom of the last page — and the rail below it is the reason anyone
     printed the sheet. Without this it would be drawn past the paper, or on
     top of the footer at y=290. The rail is at most five rows (~23mm), so it
     needs to start above 275. `drawSignatureBoxes` carries its own guard. */
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
    /* The reason this document gets printed. Bold and last, where every other
       document in the system puts its GRAND TOTAL. */
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

  // Footer: doc no · portal · page n of m — only on the pages THIS take added.
  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.take_no, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.take_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
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
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderStockTakeInto(doc, autoTable, header, lines);
  const wh = warehouseLabel(header.warehouse) ?? '';
  deliverPdf(doc, `${header.take_no}${wh ? `-${safeName(wh)}` : ''}.pdf`, opts?.action);
}
