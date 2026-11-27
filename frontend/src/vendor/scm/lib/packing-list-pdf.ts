// ----------------------------------------------------------------------------
// Packing List PDF — one lorry, one day (= one trip). Owner spec 2026-11-27.
//
// SAME FRAME AS THE DELIVERY ORDER. The letterhead, the panel style, the
// signature row and the footer are the DO's own drawing functions
// (delivery-order-pdf.ts), not a lookalike: Letter page, black ink only, no
// fills, nothing under 9pt — the sheet goes through the same dot-matrix
// printer. Company details come from Settings -> Branding through the DO
// letterhead, so a 2990 lorry prints 2990's head.
//
// TWO PARTS:
//   A. PICK BY CATEGORY — the warehouse takes everything for the lorry in one
//      walk. Grouping and sorting rules live in packing-list-model.ts
//      (buildPickSections), so they are unit-tested without a PDF.
//   B. LOAD BY CUSTOMER — last stop first (6, 5, 4 ... 1), printing the REAL
//      stop number; each customer's lines in the sales order's line order.
//
// THE TICK COLUMN IS A DRAWN BOX, not a "✓": U+2713 is not in jspdf's WinAnsi
// table and would paint as mojibake.
//
// KEEP-WITH-NEXT. Every category and every sofa group is its own table whose
// heading rows are the table HEAD, so autoTable never leaves a heading alone at
// the foot of a page and repeats it on the page a group continues onto. A
// customer block in Part B checks there is room for its header plus its first
// rows before it starts.
// ----------------------------------------------------------------------------

import { DAY_NAMES } from '../../../lib/meetings';
import { formatPhone } from '@2990s/shared/phone';
import { COMPANY, deliverPdf, ensurePdfCjkFont, fmtDocDate, safeName, type PdfAction } from './pdf-common';
import {
  DO_MARGIN as M,
  DO_PAGE_FORMAT,
  DO_PAGE_H,
  DO_PAGE_W as PAGE_W,
  DO_PHOTOS_PAGE_BOTTOM as CLOSING_TOP,
  FOOTER_RULE_Y,
  RULE_HEAVY,
  RULE_THIN,
  baselineOf,
  drawFooterLine,
  drawLetterhead,
  drawSignatureClosing,
  font,
  rule,
  setInk,
} from './delivery-order-pdf';
import { DO_SIZE as S, DO_THEME as T, pt } from './delivery-order-theme';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
import { stripBookText } from '../../../../../shared/src/vendor/scm/lib/book-text';
import {
  buildPickSections, fmtM3, formatRacksCompact, loadingOrder, packCategory,
  type PickRow, type PickSection,
} from './packing-list-model';
import type { PackingItem, PackingListRow, PackingStop } from './packing-list-queries';
import type { BrandingLogo } from '../../../lib/branding';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';

type Doc = import('jspdf').jsPDF;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jspdf-autotable is loaded dynamically and ships no usable call type
type AutoTable = any;

const CONTENT_W = PAGE_W - M * 2;
const DASH = '—';
const TABLE_BOTTOM = FOOTER_RULE_Y - 6;
const RUNNING_RULE_Y = M + 6;
const CONT_TOP_A = RUNNING_RULE_Y + 4;
const CONT_TOP_B = RUNNING_RULE_Y + 10;

export const SCAN_CAPTION = 'SCAN WHEN FULLY LOADED';

const qtyText = (n: number): string => String(n);
const unitsLabel = (n: number): string => `${qtyText(n)} ${n === 1 ? 'unit' : 'units'}`;
const shortType = (category: string): string => (category === 'ACCESSORIES' ? 'ACCESSORY' : category);

/**
 * Where the QR points: the PUBLIC scan page for this run, /d/<token>, which
 * opens with NO login (a packing list is a trip, and a trip is a row with its
 * own token, mig 0329). Null until the sheet has been armed — a sheet carrying
 * a link only office staff can open is worse than one carrying none.
 */
export function packingRunUrl(origin: string, token: string | null): string | null {
  return token ? `${origin.replace(/\/+$/, '')}/d/${encodeURIComponent(token)}` : null;
}

/** "VJK 8821-2026-11-28.pdf" — plate, then the delivery date. */
export function packingListFileName(list: Pick<PackingListRow, 'lorry_plate' | 'trip_no'>, date: string): string {
  const plate = (list.lorry_plate ?? '').trim() || (list.trip_no ?? '').trim() || 'packing-list';
  return `${safeName(plate)}-${date}.pdf`;
}

function weekday(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : (DAY_NAMES[d.getUTCDay()] ?? null);
}

type Fabric = { ext: Map<string, string>; desc: Map<string, string> };

function variantText(item: PackingItem, fabric: Fabric): string {
  const v = docVariantLine(item, fabric.ext, fabric.desc).trim();
  if (v) return v;
  const d2 = (item.description2 ?? '').trim();
  return d2 && d2 !== (item.description ?? '').trim() ? d2 : '';
}

const NAME_MAX = 34;
function describe(description: string | null, variant: string): string {
  const name = stripBookText((description ?? '').replace(/\s+/g, ' ').trim());
  const short = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 3).trimEnd()}...` : name;
  const text = [short, stripBookText(variant.trim())].filter(Boolean).join('\n');
  return text || DASH;
}

const poCell = (pos: readonly string[]): string => (pos.length > 0 ? pos.join('\n') : DASH);
const rackCell = (racks: readonly string[]): string => formatRacksCompact(racks) || DASH;
const splitRacks = (v: string | null): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const splitPos = splitRacks;

function crewParts(list: PackingListRow): string[] {
  const helpers = [list.helper_1_name, list.helper_2_name].filter(Boolean).join(', ');
  return [list.driver_name ? `Driver ${list.driver_name}` : null, helpers ? `Helpers ${helpers}` : null]
    .filter((v): v is string => !!v);
}


function drawCrewBox(doc: Doc, top: number, list: PackingListRow): number {
  const PAD_X = 4;
  const PAD_Y = 3;
  const colW = CONTENT_W / 3;
  const LABEL_W = 21;
  const volume = fmtM3(list.m3_milli);
  const cols: Array<{ caption: string; rows: Array<[string, string, boolean]> }> = [
    {
      caption: 'Lorry',
      rows: [['Warehouse', list.warehouse_name ?? DASH, false]],
    },
    {
      caption: 'Crew',
      rows: [
        ['Driver', list.driver_name ?? DASH, true],
        ['Phone', list.driver_phone ? formatPhone(list.driver_phone) : DASH, false],
        ['Helper 1', list.helper_1_name ?? DASH, true],
        ['Helper 2', list.helper_2_name ?? DASH, true],
      ],
    },
    {
      caption: 'This run',
      rows: [
        ['Trip No', list.trip_no ?? DASH, false],
        ['Customers', `${list.stop_count} (${list.do_count} DO)`, true],
        ['Total', unitsLabel(list.units), true],
        ['Volume', volume ?? DASH, true],
      ],
    },
  ];

  const drawCol = (i: number, draw: boolean): number => {
    const x = M + colW * i + PAD_X;
    const w = colW - PAD_X * 2;
    let y = top + PAD_Y;
    font(doc, S.caption, 'bold');
    if (draw) { setInk(doc, T.ink); doc.text(cols[i]!.caption.toUpperCase(), x, baselineOf(y, S.caption)); }
    y += pt(S.caption) + 1.5;
    if (i === 0) {
      const PLATE = 20;
      font(doc, PLATE, 'bold');
      const plateLines = doc.splitTextToSize(list.lorry_plate ?? DASH, w) as string[];
      for (const line of plateLines) {
        y += pt(PLATE) * 1.05;
        if (draw) doc.text(line, x, y);
      }
      y += 1;
    }
    for (const [label, value, bold] of cols[i]!.rows) {
      font(doc, S.body, bold ? 'bold' : 'normal');
      const lines = doc.splitTextToSize(value, w - LABEL_W) as string[];
      y += 1.6 + pt(S.body);
      if (draw) {
        font(doc, S.body);
        doc.text(label, x, y);
        font(doc, S.body, bold ? 'bold' : 'normal');
      }
      lines.forEach((line, j) => {
        if (j > 0) y += pt(S.body) + 0.8;
        if (draw) doc.text(line, x + LABEL_W, y);
      });
    }
    return y;
  };

  const bottom = Math.max(drawCol(0, false), drawCol(1, false), drawCol(2, false)) + PAD_Y + 1;
  doc.setDrawColor(T.line[0], T.line[1], T.line[2]);
  doc.setLineWidth(RULE_THIN);
  doc.rect(M, top, CONTENT_W, bottom - top, 'S');
  for (let i = 1; i < 3; i += 1) doc.line(M + colW * i, top, M + colW * i, bottom);
  for (let i = 0; i < 3; i += 1) drawCol(i, true);
  return bottom;
}

function drawPartHeading(doc: Doc, y: number, title: string, note: string): number {
  font(doc, S.sigTitle, 'bold');
  setInk(doc, T.ink);
  doc.text(title, M, baselineOf(y, S.sigTitle));
  let bottom = y + pt(S.sigTitle) + 1;
  font(doc, S.min);
  const lines = doc.splitTextToSize(note, CONTENT_W) as string[];
  for (const line of lines) {
    bottom += pt(S.min) * 1.3;
    doc.text(line, M, bottom);
  }
  return bottom + 2.5;
}


const CELL_PAD = { top: 1, right: 1.4, bottom: 1, left: 1.4 };

function baseTable(opts: { startY: number; contTop: number }) {
  return {
    startY: opts.startY,
    theme: 'plain',
    rowPageBreak: 'avoid',
    showHead: 'everyPage',
    styles: {
      font: 'helvetica',
      fontSize: S.min + 0.5,
      cellPadding: CELL_PAD,
      valign: 'top',
      textColor: T.ink,
      lineColor: T.line,
      lineWidth: { bottom: RULE_THIN },
      overflow: 'linebreak',
    },
    headStyles: { fillColor: false, textColor: T.ink, fontStyle: 'bold', fontSize: S.min },
    margin: { left: M, right: M, top: opts.contTop, bottom: DO_PAGE_H - TABLE_BOTTOM },
  };
}

function drawTickBox(doc: Doc, cell: { x: number; y: number; width: number; height: number }): void {
  const box = 4;
  doc.setDrawColor(T.line[0], T.line[1], T.line[2]);
  doc.setLineWidth(RULE_THIN);
  doc.rect(cell.x + (cell.width - box) / 2, cell.y + 1.4, box, box, 'S');
}

const currentPage = (doc: Doc): number =>
  (doc as unknown as { internal: { getCurrentPageInfo: () => { pageNumber: number } } }).internal.getCurrentPageInfo().pageNumber;

const lastY = (doc: Doc, fallback: number): number =>
  (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;


const COL = { type: 'TYPE', code: 'ITEM CODE', desc: 'DESCRIPTION', po: 'PO NO', rack: 'RACK', qty: 'QTY', cust: 'CUSTOMER', tick: 'TICK' } as const;
const A_HEAD = [COL.code, COL.desc, COL.po, COL.rack, COL.qty, COL.cust, COL.tick];
const A_COLS = {
  0: { cellWidth: 30, fontStyle: 'bold' as const },
  1: { cellWidth: 'auto' as const },
  2: { cellWidth: 31, fontSize: S.min },
  3: { cellWidth: 16, halign: 'center' as const, fontStyle: 'bold' as const },
  4: { cellWidth: 11, halign: 'right' as const, fontStyle: 'bold' as const, fontSize: S.body },
  5: { cellWidth: 21 },
  6: { cellWidth: 11, halign: 'center' as const },
};

const pickBody = (rows: readonly PickRow[]): string[][] => rows.map((r) => [
  r.item_code,
  describe(r.description, r.variant),
  poCell(r.pos),
  rackCell(r.racks),
  qtyText(r.qty),
  r.customers.join(', '),
  '',
]);

function sectionHeadRow(section: PickSection) {
  const piece = section.category === 'BEDFRAME' || section.category === 'SOFA';
  return [
    { content: `${section.category}${piece ? ' · one line per piece' : ''}`, colSpan: 4, styles: { fontStyle: 'bold', fontSize: S.body, halign: 'left' } },
    { content: qtyText(section.units), styles: { fontStyle: 'bold', fontSize: S.body, halign: 'right' } },
    { content: unitsWord(section.units), colSpan: 2, styles: { fontStyle: 'normal', fontSize: S.min, halign: 'left' } },
  ];
}
const ROW_EST = 6.5;
const unitsWord = (n: number): string => (n === 1 ? 'unit' : 'units');

function drawPickTable(
  doc: Doc,
  autoTable: AutoTable,
  startY: number,
  head: unknown[][],
  body: string[][],
  foot: unknown[][] | null,
): number {
  const labelRow = head.findIndex((r) => r === A_HEAD);
  if (startY + (head.length + 1) * ROW_EST > TABLE_BOTTOM) { doc.addPage(); startY = CONT_TOP_A; }
  autoTable(doc, {
    ...baseTable({ startY, contTop: CONT_TOP_A }),
    head,
    body,
    ...(foot ? { foot, showFoot: 'lastPage' } : {}),
    footStyles: { fillColor: false, textColor: T.ink, fontStyle: 'bold', fontSize: S.body },
    columnStyles: A_COLS,
    didDrawCell: (data: {
      section: string; row: { index: number }; column: { index: number };
      cell: { x: number; y: number; width: number; height: number };
    }) => {
      if (data.section === 'head' && data.column.index === 0) {
        if (data.row.index === 0) rule(doc, M, data.cell.y, PAGE_W - M, RULE_HEAVY);
        if (data.row.index === labelRow) rule(doc, M, data.cell.y + data.cell.height, PAGE_W - M, RULE_HEAVY);
      }
      if (data.section === 'foot' && data.column.index === 0) rule(doc, M, data.cell.y, PAGE_W - M, RULE_HEAVY);
      if (data.section === 'body' && data.column.index === 6) drawTickBox(doc, data.cell);
    },
  });
  return lastY(doc, startY);
}

function drawPartA(doc: Doc, autoTable: AutoTable, startY: number, sections: PickSection[]): number {
  let y = startY;
  if (sections.length === 0) {
    font(doc, S.body);
    doc.text('Nothing to pick: no delivery order on this lorry has goods lines.', M, baselineOf(y, S.body));
    return y + 8;
  }
  const total = sections.reduce((n, s) => n + s.units, 0);
  const totalFoot = [[
    { content: 'TOTAL TO PICK', colSpan: 4 },
    { content: qtyText(total), styles: { halign: 'right' } },
    { content: unitsWord(total), colSpan: 2, styles: { fontStyle: 'normal', fontSize: S.min } },
  ]];
  sections.forEach((section, si) => {
    const lastSection = si === sections.length - 1;
    if (section.category !== 'SOFA') {
      y = drawPickTable(doc, autoTable, y, [sectionHeadRow(section), A_HEAD], pickBody(section.rows), lastSection ? totalFoot : null) + 2;
      return;
    }
    section.groups.forEach((g, gi) => {
      const soRow = [{
        content: [
          g.so_doc_no ?? 'No SO',
          `Customer ${g.stop_no}`,
          g.customer_name ?? 'No customer name',
          `${g.pieces} ${g.pieces === 1 ? 'piece' : 'pieces'}`,
          `PO ${g.pos.length > 0 ? g.pos.join(', ') : DASH}`,
        ].join(' · '),
        colSpan: 7,
        styles: { fontStyle: 'bold', fontSize: S.min + 0.5, halign: 'left' },
      }];
      const head = gi === 0 ? [sectionHeadRow(section), A_HEAD, soRow] : [soRow];
      const lastGroup = gi === section.groups.length - 1;
      y = drawPickTable(doc, autoTable, y, head, pickBody(g.rows), lastSection && lastGroup ? totalFoot : null) + (lastGroup ? 2 : 0);
    });
  });
  return y + 3;
}


const B_HEAD = [COL.type, COL.code, COL.desc, COL.po, COL.rack, COL.qty, COL.tick];
const B_COLS = {
  0: { cellWidth: 24, fontSize: S.min },
  1: { cellWidth: 30, fontStyle: 'bold' as const },
  2: { cellWidth: 'auto' as const },
  3: { cellWidth: 31, fontSize: S.min },
  4: { cellWidth: 16, halign: 'center' as const, fontStyle: 'bold' as const },
  5: { cellWidth: 11, halign: 'right' as const, fontStyle: 'bold' as const, fontSize: S.body },
  6: { cellWidth: 11, halign: 'center' as const },
};
const PART_B_MIN_ROOM = 40;
const B_DESC_W = CONTENT_W - 24 - 30 - 31 - 16 - 11 - 11;

function drawStopHeader(doc: Doc, top: number, stop: PackingStop, draw: boolean): number {
  const NUM_BOX = 9;
  const RIGHT_W = 52;
  const midX = M + NUM_BOX + 4;
  const midW = CONTENT_W - NUM_BOX - 4 - RIGHT_W - 4;
  const rightX = PAGE_W - M;

  if (draw) {
    rule(doc, M, top, PAGE_W - M, RULE_HEAVY);
    doc.setDrawColor(T.line[0], T.line[1], T.line[2]);
    doc.setLineWidth(RULE_HEAVY * 0.8);
    doc.rect(M, top + 2, NUM_BOX, NUM_BOX, 'S');
    font(doc, 13, 'bold');
    setInk(doc, T.ink);
    doc.text(String(stop.stop_no), M + NUM_BOX / 2, top + 2 + NUM_BOX / 2 + pt(13) * 0.35, { align: 'center' });
  }

  let y = top + 2;
  font(doc, S.customer - 1, 'bold');
  const nameLines = doc.splitTextToSize(stop.customer_name ?? 'No customer name', midW) as string[];
  for (const line of nameLines) {
    y += pt(S.customer - 1) * 1.1;
    if (draw) doc.text(line, midX, y);
  }
  font(doc, S.min + 0.5);
  const detail = [
    stop.address ?? 'No address on this stop',
    stop.phone ? `Tel ${formatPhone(stop.phone)}` : 'Tel —',
    stop.time_range ? `Time ${stop.time_range}` : null,
  ].filter(Boolean).join('  ·  ');
  const detailLines = doc.splitTextToSize(detail, midW) as string[];
  for (const line of detailLines) {
    y += pt(S.min + 0.5) * 1.3;
    if (draw) doc.text(line, midX, y);
  }

  let ry = top + 2;
  const rightRows: Array<[string, 'bold' | 'normal']> = stop.do_missing
    ? [['DO not visible', 'bold']]
    : [
        [`DO ${stop.do_number ?? DASH}`, 'bold'],
        [`SO ${stop.so_doc_no ?? DASH}  ·  ${unitsLabel(stop.units)}`, 'normal'],
      ];
  for (const [text, style] of rightRows) {
    font(doc, S.min + 0.5, style);
    const lines = doc.splitTextToSize(text, RIGHT_W) as string[];
    for (const line of lines) {
      ry += pt(S.min + 0.5) * 1.3;
      if (draw) doc.text(line, rightX, ry, { align: 'right' });
    }
  }
  return Math.max(y, ry, top + 2 + NUM_BOX) + 1.5;
}

function stopRows(stop: PackingStop, fabric: Fabric): string[][] {
  return stop.items.map((it) => [
    shortType(packCategory(it.item_group)),
    it.item_code,
    describe(it.description, variantText(it, fabric)),
    poCell(splitPos(it.po)),
    rackCell(splitRacks(it.rack)),
    qtyText(it.qty),
    '',
  ]);
}

function estimateRowH(doc: Doc, row: string[]): number {
  font(doc, S.min + 0.5);
  const lines = Math.max(
    (doc.splitTextToSize(row[2] ?? '', B_DESC_W - 3.2) as string[]).length,
    (doc.splitTextToSize(row[3] ?? '', 31 - 3.2) as string[]).length,
    (doc.splitTextToSize(row[1] ?? '', 30 - 3.2) as string[]).length,
  );
  return lines * pt(S.min + 0.5) * 1.15 + CELL_PAD.top + CELL_PAD.bottom + 0.5;
}

function drawPartB(doc: Doc, autoTable: AutoTable, startY: number, stops: readonly PackingStop[], fabric: Fabric): number {
  let y = startY;
  let first = true;
  for (const { stop } of loadingOrder(stops)) {
    const rows = stop.do_missing ? [] : stopRows(stop, fabric);
    const headerH = drawStopHeader(doc, 0, stop, false);
    const firstRows = rows.slice(0, 2).reduce((n, r) => n + estimateRowH(doc, r), 0);
    const need = headerH + (rows.length > 0 ? 7 + firstRows : 8);
    if (y + need > TABLE_BOTTOM) { doc.addPage(); y = CONT_TOP_B; }
    y = drawStopHeader(doc, y, stop, true);

    if (stop.do_missing || rows.length === 0) {
      font(doc, S.min + 0.5);
      setInk(doc, T.ink);
      doc.text(
        stop.do_missing
          ? 'This stop\'s delivery order is not in the companies you can see. Nothing is listed for it.'
          : 'No goods lines on this delivery order.',
        M, baselineOf(y, S.min + 0.5),
      );
      y += 9;
      continue;
    }

    const startPage = doc.getNumberOfPages();
    autoTable(doc, {
      ...baseTable({ startY: y, contTop: CONT_TOP_B }),
      head: [B_HEAD],
      showHead: first ? 'firstPage' : 'never',
      body: rows,
      columnStyles: B_COLS,
      didDrawPage: () => {
        if (currentPage(doc) <= startPage) return;
        font(doc, S.min, 'bold');
        setInk(doc, T.ink);
        const label = `Customer ${stop.stop_no} · ${stop.customer_name ?? ''} (continued)`;
        const fit = (doc.splitTextToSize(label, CONTENT_W) as string[])[0] ?? '';
        doc.text(fit, M, baselineOf(RUNNING_RULE_Y + 2.5, S.min));
      },
      didDrawCell: (data: {
        section: string; row: { index: number }; column: { index: number };
        cell: { x: number; y: number; width: number; height: number };
      }) => {
        if (data.section === 'head' && data.column.index === 0) {
          rule(doc, M, data.cell.y + data.cell.height, PAGE_W - M, RULE_THIN);
        }
        if (data.section === 'body' && data.column.index === 6) drawTickBox(doc, data.cell);
      },
    });
    y = lastY(doc, y) + 3;
    first = false;
  }
  return y;
}


/** Draw ONE trip's packing list into `doc`, starting on its current page. A
 *  whole day's print calls this once per lorry, each on a fresh page. */
export async function renderPackingListInto(
  doc: Doc,
  autoTable: AutoTable,
  list: PackingListRow,
  opts: { date: string; runUrl: string | null; logo: BrandingLogo | null },
): Promise<void> {
  await ensurePdfCjkFont(doc, [list]);
  const allItems = list.stops.flatMap((s) => s.items);
  const fabric = await loadCustomerFabricMaps(allItems);

  const startPage = doc.getNumberOfPages();
  const plate = (list.lorry_plate ?? '').trim() || 'No lorry';
  const dateIso = list.trip_date ?? opts.date;
  const day = weekday(dateIso);
  const dateText = fmtDocDate(dateIso);

  const ruleY = drawLetterhead(doc, {
    titleLines: ['PACKING LIST'],
    docNoText: `Lorry : ${plate}`,
    subLine: `Delivery Date ${dateText}${day ? ` (${day})` : ''}`,
    qr: opts.runUrl ? { url: opts.runUrl, caption: SCAN_CAPTION } : null,
    logo: opts.logo,
  });
  let y = drawCrewBox(doc, ruleY + 4, list) + 5;

  y = drawPartHeading(doc, y, 'PART A · PICK BY CATEGORY',
    'Take everything below in one go. Mattress and accessories are counted together; every bedframe and sofa piece has its own line, rack and PO.');
  y = drawPartA(doc, autoTable, y, buildPickSections(list.stops, (it) => variantText(it, fabric)));

  if (y + PART_B_MIN_ROOM > TABLE_BOTTOM) { doc.addPage(); y = CONT_TOP_A; } else { y += 3; }
  y = drawPartHeading(doc, y, 'PART B · LOAD BY CUSTOMER',
    `Load from the top. The last customer goes in first, deepest into the lorry; customer 1 goes in last, at the door.`);
  y = drawPartB(doc, autoTable, y, list.stops, fabric);

  if (y > CLOSING_TOP) doc.addPage();

  const pageCount = doc.getNumberOfPages();
  const total = pageCount - startPage + 1;
  const crew = crewParts(list);
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    const pageNo = p - startPage + 1;
    const footRight = `${plate} · ${dateText} · Page : ${pageNo} of ${total}`;
    if (p > startPage) drawRunningHeader(doc, plate, [dateText, ...crew]);
    if (p === pageCount) {
      drawSignatureClosing(doc, {
        titles: ['Picked By (Warehouse)', 'Loaded By (Helper)', 'Driver Signature'],
        fields: ['Name', 'Time'],
        footLeft: `By signing, the crew confirms every ticked item is on lorry ${plate}.`,
        footRight,
      });
    } else {
      drawFooterLine(doc, COMPANY.name, footRight);
    }
  }
  setInk(doc, T.ink);
}

function drawRunningHeader(doc: Doc, plate: string, rightParts: string[]): void {
  font(doc, S.body, 'bold');
  setInk(doc, T.ink);
  const left = `PACKING LIST · Lorry : ${plate}`;
  doc.text(left, M, baselineOf(M, S.body));
  const room = CONTENT_W - doc.getTextWidth(left) - 6;
  font(doc, S.min);
  for (let n = rightParts.length; n > 0; n -= 1) {
    const right = rightParts.slice(0, n).join(' · ');
    if (doc.getTextWidth(right) <= room) {
      doc.text(right, PAGE_W - M, baselineOf(M + 0.6, S.min), { align: 'right' });
      break;
    }
  }
  rule(doc, M, RUNNING_RULE_Y, PAGE_W - M, RULE_HEAVY);
}

async function newDoc(): Promise<{ doc: Doc; autoTable: AutoTable }> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  return { doc: new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: DO_PAGE_FORMAT }), autoTable };
}

async function runUrlFor(tripId: string): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const { armPackingScanToken } = await import('./packing-scan-token-arm');
  return packingRunUrl(window.location.origin, await armPackingScanToken(tripId));
}

/** One lorry's packing list -> its own file / print job / preview tab. */
export async function generatePackingListPdf(
  list: PackingListRow,
  opts: { date: string; action: PdfAction },
): Promise<void> {
  const { doc, autoTable } = await newDoc();
  await renderPackingListInto(doc, autoTable, list, { date: opts.date, runUrl: await runUrlFor(list.trip_id), logo: null });
  deliverPdf(doc, packingListFileName(list, list.trip_date ?? opts.date), opts.action);
}

/** Every lorry for a day in ONE file, each lorry starting on its own page. */
export async function generatePackingListsPdf(
  lists: readonly PackingListRow[],
  opts: { date: string; action: PdfAction },
): Promise<void> {
  if (lists.length === 0) return;
  const { doc, autoTable } = await newDoc();
  for (let i = 0; i < lists.length; i += 1) {
    if (i > 0) doc.addPage();
    const list = lists[i]!;
    await renderPackingListInto(doc, autoTable, list, { date: opts.date, runUrl: await runUrlFor(list.trip_id), logo: null });
  }
  deliverPdf(doc, `packing-lists-${opts.date}.pdf`, opts.action);
}
