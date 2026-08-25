// ----------------------------------------------------------------------------
// Packing List PDF — the LOADING sheet for one trip (one lorry, one day).
//
// THE WHOLE POINT IS THE REVERSAL. Stops are numbered 1..N in delivery order;
// this sheet prints them N..1, because the last delivery is loaded first and
// goes deepest into the lorry (owner 2026-08-25). The reversal itself lives in
// packing-list-model.ts `loadingOrder`, so the screen and this sheet cannot
// drift apart on it — and it is numbered by LOADING order ONLY. The two-number
// form ("LOAD FIRST ① STOP 3") was shown to the owner and rejected: 「这个地方
// 太复杂了」. One number per line.
//
// Letterhead is `drawHeader` from pdf-common — the same one the other twelve
// generators use, reading the COMPANY getters off Settings → Branding. Company
// details are NEVER written here: a packing list can carry either company's
// delivery orders, and the letterhead has to follow the switcher like every
// other document does.
//
// ALL COPY IS ENGLISH (owner checked this explicitly, 2026-08-26).
//
// The tick column is a DRAWN BOX, not a "✓". U+2713 is not one of the 27
// codepoints jspdf's WinAnsi table knows, and `ensurePdfCjkFont` scans the
// PAYLOAD, not the literals in this file — so a typed tick would paint as
// mojibake with nothing to catch it (same trap the Stock Transfer's arrow
// documents). A box is also the thing a loader actually wants: something to
// mark with a pen.
// ----------------------------------------------------------------------------

import {
  COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader,
  drawSignatureBoxes, ensurePdfCjkFont, fmtDocDate, safeName,
  type PdfAction,
} from './pdf-common';
import { drawQrIntoPdf } from './pdf-qr';
import { loadingOrder, fmtM3, formatRacksCompact } from './packing-list-model';
import type { PackingListRow, PackingStop } from './packing-list-queries';

const MARGIN = 14;
const QR_MM = 16;

const qty = (n: number): string => (Number.isInteger(n) ? String(n) : String(n));

/** "12 units", singular-aware. Never printed for a stop we could not read. */
const unitsLabel = (n: number): string => `${qty(n)} ${n === 1 ? 'unit' : 'units'}`;

/**
 * Where the QR points. The EXISTING authed app route for the run — Last Mile
 * Delivery, on this day, focused on this trip. It requires a login by
 * construction (`ScmGuard area="scm.transportation.drivers"` in App.tsx).
 *
 * RE-CHECKED 2026-08-26, when the DELIVERY ORDER's printed QR did go public
 * (`/d/<token>`, no login — the owner's call, 「就跟hookka一样」). This one stays
 * authed, and the reason is structural rather than a deferral: the public token
 * is a column on `scm.delivery_orders`, minted per DOCUMENT, and it resolves to
 * exactly one row — which is what supplies the company scope and what makes the
 * forward-only one-rung ladder meaningful. A packing list is not a row. There is
 * no `packing_lists` table at all (backend/src/scm/lib/packing-list-view.ts: "A
 * PACKING LIST IS A TRIP, RENDERED"), so there is nothing here to hang a token
 * on, and this sheet is a run OVERVIEW rather than a scan target — it advances
 * nothing. Giving a trip its own public token is a separate change with its own
 * decision to take, and it is still not this one.
 */
export function packingRunUrl(origin: string, list: PackingListRow, date: string): string {
  const p = new URLSearchParams();
  p.set('date', list.trip_date ?? date);
  p.set('trip', list.trip_id);
  return `${origin}/scm/fleet-day?${p.toString()}`;
}

/** Draw ONE trip's packing list into `doc`. Split out so a whole-day export can
 *  share a document later without this being rewritten. */
export async function renderPackingListInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  list: PackingListRow,
  opts: { date: string; runUrl: string | null },
): Promise<void> {
  await ensurePdfCjkFont(doc, [list]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const rightEdge = pageW - MARGIN;

  let y = drawHeader(doc, {
    docTitle: 'PACKING LIST',
    rightMeta: [
      { label: 'Trip No', value: list.trip_no ?? '—' },
      { label: 'Date', value: fmtDocDate(list.trip_date ?? opts.date) },
    ],
  });

  /* The one instruction on the sheet. It is the reason the order looks wrong
     to anyone who has not loaded a lorry before. */
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(0);
  doc.text('Load in this order — top of the sheet goes in first, deepest into the lorry.', MARGIN, y);
  y += 7;

  /* Header fields, ONE THING EACH. The combined "Stops / DOs" form was shown to
     the owner and rejected as too complex, so the delivery-order count lives on
     the screen and this sheet states the four numbers a loader uses. */
  const total = [unitsLabel(list.units), fmtM3(list.m3_milli)].filter(Boolean).join(' · ');
  const fields: Array<[string, string]> = [
    ['Lorry', list.lorry_plate ?? '—'],
    ['Driver', list.driver_name ?? '—'],
    ['Stops', String(list.stop_count)],
    ['Total', total],
  ];
  const colW = (pageW - MARGIN * 2) / fields.length;
  fields.forEach(([label, value], i) => {
    const x = MARGIN + colW * i;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(label.toUpperCase(), x, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text(doc.splitTextToSize(value, colW - 4)[0] ?? '—', x, y + 5.5);
  });
  y += 9;
  doc.setDrawColor(180); doc.line(MARGIN, y, rightEdge, y);
  y += 6;

  for (const section of loadingOrder(list.stops)) {
    y = drawSection(doc, autoTable, y, section.load_no, section.stop);
  }

  /* Signatures. The two people this sheet passes between: whoever loaded the
     lorry and whoever drives it away. */
  const sigY = y + 2 > 240 ? (doc.addPage(), MARGIN) : y + 2;
  let ty = drawSignatureBoxes(doc, sigY, 'Loaded By', 'Driver Signature');

  if (opts.runUrl) {
    /* Bottom-right, for the WHOLE run. Placed under the signature boxes, or on
       its own page if they ran to the foot of this one — never on top of the
       page footer at y=290. */
    if (ty + QR_MM + 6 > 282) { doc.addPage(); ty = MARGIN; }
    drawQrIntoPdf(doc, opts.runUrl, rightEdge - QR_MM, ty, QR_MM);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(110);
    doc.text('SCAN · OPEN THIS RUN', rightEdge, ty + QR_MM + 3, { align: 'right' });
    doc.setTextColor(0);
  }

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(list.trip_no ?? 'Packing list', MARGIN, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(list.trip_date ?? opts.date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, rightEdge, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/* One loading section: the band, then the goods. */
function drawSection(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  autoTable: any,
  startY: number,
  loadNo: number,
  stop: PackingStop,
): number {
  const pageW = doc.internal.pageSize.getWidth();
  const rightEdge = pageW - MARGIN;
  let y = startY;
  if (y > 250) { doc.addPage(); y = MARGIN; }

  /* Left: "N · Customer". Right: the unit count for this drop. Wrapped into
     what the right-hand figure leaves, so a long customer name cannot run
     under it. */
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  const unitsText = stop.do_missing ? '' : unitsLabel(stop.units);
  const unitsW = unitsText ? doc.getTextWidth(unitsText) + 4 : 0;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  const head = `${loadNo} · ${stop.customer_name ?? 'No customer name'}`;
  const headLines = doc.splitTextToSize(head, pageW - MARGIN * 2 - unitsW) as string[];
  headLines.forEach((line, i) => doc.text(line, MARGIN, y + i * 5.5));
  if (unitsText) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text(unitsText, rightEdge, y, { align: 'right' });
  }
  y += headLines.length * 5.5;

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
  const addrLines = doc.splitTextToSize(stop.address ?? 'No address on this stop', pageW - MARGIN * 2) as string[];
  addrLines.forEach((line, i) => doc.text(line, MARGIN, y + i * 4));
  y += addrLines.length * 4 + 2;
  doc.setTextColor(0);

  if (stop.do_missing) {
    /* The company predicate did its job. Saying so is the honest line; printing
       an empty goods table under it would read as "nothing to load". */
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text('This stop\'s delivery order is not in the companies you can see. Nothing is listed for it.', MARGIN, y);
    doc.setTextColor(0);
    return y + 8;
  }

  const rows = stop.items.map((it, i) => [
    String(i + 1),
    stop.do_number ?? '—',
    [it.item_code, it.description].filter(Boolean).join('\n'),
    qty(it.qty),
    formatRacksCompact([it.rack]) || '—',
    '',
  ]);

  if (rows.length === 0) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text('No lines on this delivery order.', MARGIN, y);
    doc.setTextColor(0);
    return y + 8;
  }

  autoTable(doc, {
    startY: y,
    head: [['#', 'DO No.', 'Item', 'Qty', 'Rack', 'Tick']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 30 },
      2: { cellWidth: 74 },
      3: { cellWidth: 14, halign: 'right' },
      4: { cellWidth: 30 },
      5: { cellWidth: 16, halign: 'center' },
    },
    margin: { left: MARGIN, right: MARGIN },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    didDrawCell: (data: any) => {
      if (data.section !== 'body' || data.column.index !== 5) return;
      const box = 4;
      const x = data.cell.x + (data.cell.width - box) / 2;
      const cy = data.cell.y + (data.cell.height - box) / 2;
      doc.setDrawColor(120); doc.setLineWidth(0.25);
      doc.rect(x, cy, box, box);
    },
  });
  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y;
  return finalY + 8;
}

/** One trip's packing list → its own file / print job / preview tab. */
export async function generatePackingListPdf(
  list: PackingListRow,
  opts: { date: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const runUrl = typeof window !== 'undefined' ? packingRunUrl(window.location.origin, list, opts.date) : null;
  await renderPackingListInto(doc, autoTable, list, { date: opts.date, runUrl });
  const name = [list.trip_no ?? 'packing-list', list.lorry_plate].filter(Boolean).join('-');
  deliverPdf(doc, `${safeName(name)}.pdf`, opts.action);
}
