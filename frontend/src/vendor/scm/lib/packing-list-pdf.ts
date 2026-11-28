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
  drawSignatureClosing,
  font,
  rule,
  setInk,
  WORKED_OUT_NOTE,
} from './delivery-order-pdf';
import { DO_SIZE as S, DO_THEME as T, pt } from './delivery-order-theme';
import { docVariantLine, loadCustomerFabricMaps } from './supplier-doc-data';
import { stripBookText } from '../../../../../shared/src/vendor/scm/lib/book-text';
import {
  buildPickSections, isSofaAccessory, fmtM3, formatRacksCompact, loadingOrder, lorriesFor, packCategory, regionLorryLabel, regionStops,
  type PickRow, type PickSection,
} from './packing-list-model';
import type { PackingItem, PackingListRow, PackingRegionRow, PackingStop } from './packing-list-queries';
import { partLabel, splitPackingList, splitPackingRegion, type SheetPart } from './packing-list-split';
import { getBrandingLogoCache, type BrandingLogo } from '../../../lib/branding';
import { drawQrIntoPdf } from './pdf-qr';
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

export const SCAN_CAPTION = 'SCAN: PREPARED, THEN LOADED';

const partSuffix = (part: SheetPart | null) => (part ? ` · ${partLabel(part)}` : '');

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

function itemCell(doc: Doc, colW: number, code: string, description: string | null, variant: string, withCode: boolean): string {
  const name = stripBookText((description ?? '').replace(/\s+/g, ' ').trim());
  font(doc, S.min + 0.5, 'bold');
  const room = colW - CELL_PAD.left - CELL_PAD.right - 0.5;
  let short = name;
  if (doc.getTextWidth(short) > room) {
    while (short.length > 1 && doc.getTextWidth(`${short}...`) > room) short = short.slice(0, -1);
    short = `${short.trimEnd()}...`;
  }
  const c = code.trim() || DASH;
  if (!withCode) return [short || c, stripBookText(variant.trim())].filter(Boolean).join('\n');
  return [c, short && short !== c ? short : '', stripBookText(variant.trim())].filter(Boolean).join('\n');
}

/* A worked-out value (no dispatch stamp yet) carries " *", the DO PDF's mark, and the sheet
   prints WORKED_OUT_NOTE once. A dash is never starred. */
const star = (cell: string, worked: boolean): string => (worked && cell !== DASH ? `${cell} *` : cell);
const poCell = (pos: readonly string[], worked: boolean): string => star(pos.length > 0 ? pos.join('\n') : DASH, worked);
const rackCell = (racks: readonly string[], worked: boolean): string => star(formatRacksCompact(racks) || DASH, worked);
const splitRacks = (v: string | null): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const splitPos = splitRacks;

function crewParts(list: PackingListRow): string[] {
  const helpers = [list.helper_1_name, list.helper_2_name].filter(Boolean).join(', ');
  return [list.driver_name ? `Driver ${list.driver_name}` : null, helpers ? `Helpers ${helpers}` : null]
    .filter((v): v is string => !!v);
}


type HeaderSpec = { docNoText: string; subLine: string; qr: { url: string; caption: string } | null; logo: BrandingLogo | null };

function drawSlimHeader(doc: Doc, spec: HeaderSpec): number {
  const right = PAGE_W - M;
  const TITLE = 16;
  setInk(doc, T.ink);
  font(doc, TITLE, 'bold');
  let ty = baselineOf(M, TITLE);
  doc.text('PACKING LIST', right, ty, { align: 'right' });
  let rightW = doc.getTextWidth('PACKING LIST');
  font(doc, S.docNo, 'bold');
  ty += pt(S.docNo) + 1.6;
  doc.text(spec.docNoText, right, ty, { align: 'right' });
  rightW = Math.max(rightW, doc.getTextWidth(spec.docNoText));
  font(doc, S.meta);
  ty += pt(S.meta) + 1.4;
  doc.text(spec.subLine, right, ty, { align: 'right' });
  rightW = Math.max(rightW, doc.getTextWidth(spec.subLine));
  let bottom = ty + 1.2;

  if (spec.qr) {
    const QR = 14;
    const GAP = 6;
    const qrRight = right - rightW - GAP;
    const drawn = drawQrIntoPdf(doc, spec.qr.url, qrRight - QR, M, QR);
    font(doc, S.footer, 'bold');
    setInk(doc, T.ink);
    const cap = baselineOf(M + Math.max(drawn, QR) + 0.8, S.footer);
    const capW = doc.getTextWidth(spec.qr.caption);
    doc.text(spec.qr.caption, qrRight, cap, { align: 'right' });
    rightW += GAP + Math.max(QR, drawn, capW);
    bottom = Math.max(bottom, cap + 0.8);
  }

  let x = M;
  let logoH = 0;
  const logo = spec.logo ?? getBrandingLogoCache();
  if (logo) {
    const BOX_W = 22;
    const BOX_H = 14;
    const scale = Math.min(BOX_W / logo.width, BOX_H / logo.height);
    try {
      doc.addImage(logo.dataUrl, logo.format, M, M, logo.width * scale, logo.height * scale);
      x = M + logo.width * scale + 4;
      logoH = logo.height * scale;
      bottom = Math.max(bottom, M + logo.height * scale);
    } catch { }
  }
  const room = Math.max(30, right - rightW - 6 - x);
  font(doc, S.company - 2, 'bold');
  setInk(doc, T.ink);
  const name = doc.splitTextToSize(COMPANY.name, room) as string[];
  const shown = name.slice(0, 2);
  const nameH = pt(S.company - 2) * (1 + 1.1 * (shown.length - 1));
  let ny = baselineOf(M + Math.max(1, (logoH - nameH) / 2), S.company - 2);
  shown.forEach((line, i) => {
    if (i) ny += pt(S.company - 2) * 1.1;
    doc.text(line, x, ny);
  });
  bottom = Math.max(bottom, ny + 1.2);

  const ruleY = bottom + 2;
  rule(doc, M, ruleY, right, RULE_HEAVY);
  return ruleY;
}

type StripCol = { caption: string; lines: Array<[string, boolean]> };

function drawInfoStrip(doc: Doc, top: number, cols: StripCol[]): number {
  const PAD_X = 3;
  const PAD_Y = 1.8;
  const colW = CONTENT_W / cols.length;
  const drawCol = (i: number, draw: boolean): number => {
    const x = M + colW * i + PAD_X;
    const w = colW - PAD_X * 2;
    let y = top + PAD_Y;
    font(doc, S.min, 'bold');
    if (draw) { setInk(doc, T.ink); doc.text(cols[i]!.caption.toUpperCase(), x, baselineOf(y, S.min)); }
    y += pt(S.min) + 0.4;
    for (const [value, bold] of cols[i]!.lines) {
      font(doc, S.body - 0.5, bold ? 'bold' : 'normal');
      for (const line of doc.splitTextToSize(value, w) as string[]) {
        y += pt(S.body - 0.5) * 1.12;
        if (draw) doc.text(line, x, y);
      }
    }
    return y;
  };
  const bottom = Math.max(...cols.map((_, i) => drawCol(i, false))) + PAD_Y + 0.4;
  doc.setDrawColor(T.line[0], T.line[1], T.line[2]);
  doc.setLineWidth(RULE_THIN);
  doc.rect(M, top, CONTENT_W, bottom - top, 'S');
  for (let i = 1; i < cols.length; i += 1) doc.line(M + colW * i, top, M + colW * i, bottom);
  cols.forEach((_, i) => drawCol(i, true));
  return bottom;
}

function drawCrewBox(doc: Doc, top: number, list: PackingListRow): number {
  const volume = list.m3_milli ? fmtM3(list.m3_milli) : null;
  const helpers = [list.helper_1_name, list.helper_2_name].filter((h): h is string => !!h);
  const extra = [list.trip_no ? `Trip ${list.trip_no}` : null, list.warehouse_name].filter((v): v is string => !!v).join(' · ');
  const driver: Array<[string, boolean]> = [[list.driver_name ?? DASH, true]];
  if (list.driver_phone) driver.push([formatPhone(list.driver_phone), false]);
  const load: Array<[string, boolean]> = [
    [`${list.stop_count} ${list.stop_count === 1 ? 'customer' : 'customers'} · ${list.do_count} DO · ${unitsLabel(list.units)}`, true],
  ];
  const second = [volume, extra].filter(Boolean).join(' · ');
  if (second) load.push([second, false]);
  return drawInfoStrip(doc, top, [
    { caption: 'Driver', lines: driver },
    { caption: 'Helpers', lines: helpers.length > 0 ? [[helpers.join(', '), true]] : [[DASH, false]] },
    { caption: 'Load', lines: load },
  ]);
}

function drawPartHeading(doc: Doc, y: number, title: string): number {
  font(doc, S.sigTitle + 1, 'bold');
  setInk(doc, T.ink);
  doc.text(title, M, baselineOf(y, S.sigTitle + 1));
  return y + pt(S.sigTitle + 1) + 2;
}


const CELL_PAD = { top: 1.2, right: 1.4, bottom: 1.2, left: 1.4 };

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
      lineWidth: 0,
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

type CellBox = { x: number; y: number; width: number; height: number; text: string[]; raw?: unknown; padding: (side: 'top' | 'left' | 'right') => number };
const itemLines = new WeakMap<object, string[]>();

function holdItemCell(cell: CellBox): void {
  itemLines.set(cell, cell.text);
  cell.text = [];
}
function drawItemCell(doc: Doc, cell: CellBox): void {
  const lines = itemLines.get(cell);
  if (!lines) return;
  const size = doc.getFontSize();
  const k = (doc as unknown as { internal: { scaleFactor: number } }).internal.scaleFactor;
  const fs = size / k;
  const lh = fs * doc.getLineHeightFactor();
  const w = cell.width - cell.padding('left') - cell.padding('right');
  const code = String(cell.raw ?? '').split('\n')[0] ?? '';
  font(doc, size, 'bold');
  const codeLines = (doc.splitTextToSize(code, w) as string[]).length;
  setInk(doc, T.ink);
  let y = cell.y + cell.padding('top') + fs * (2 - 1.15);
  lines.forEach((line, i) => {
    font(doc, size, i < codeLines ? 'bold' : 'normal');
    doc.text(line, cell.x + cell.padding('left'), y);
    y += lh;
  });
}

const currentPage = (doc: Doc): number =>
  (doc as unknown as { internal: { getCurrentPageInfo: () => { pageNumber: number } } }).internal.getCurrentPageInfo().pageNumber;

const lastY = (doc: Doc, fallback: number): number =>
  (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback;


const COL = { type: 'TYPE', item: 'ITEM', po: 'PO NO', rack: 'RACK', qty: 'QTY', cust: 'CUST', lorry: 'LORRY', tick: 'TICK' } as const;

type PickLayout = {
  head: string[];
  cols: Record<number, Record<string, unknown>>;
  lorryOf: ((customers: readonly number[]) => string[]) | null;
  showCust: boolean;
  emptyText: string;
};

const LORRY_LAYOUT: PickLayout = {
  head: [COL.item, COL.po, COL.rack, COL.qty, COL.cust, COL.tick],
  cols: {
    0: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
    1: { cellWidth: 33, fontSize: S.min },
    2: { cellWidth: 18, halign: 'center' as const, fontStyle: 'bold' as const },
    3: { cellWidth: 12, halign: 'right' as const, fontStyle: 'bold' as const, fontSize: S.body },
    4: { cellWidth: 17, halign: 'center' as const, fontStyle: 'bold' as const },
    5: { cellWidth: 11, halign: 'center' as const },
  },
  lorryOf: null,
  showCust: true,
  emptyText: 'Nothing to pick: no delivery order on this lorry has goods lines.',
};

function regionLayout(region: Pick<PackingRegionRow, 'dos'>): PickLayout {
  return {
    head: [COL.item, COL.po, COL.rack, COL.qty, COL.lorry, COL.tick],
    cols: {
      0: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
      1: { cellWidth: 33, fontSize: S.min },
      2: { cellWidth: 18, halign: 'center' as const, fontStyle: 'bold' as const },
      3: { cellWidth: 12, halign: 'right' as const, fontStyle: 'bold' as const, fontSize: S.body },
      4: { cellWidth: 22, fontSize: S.min },
      5: { cellWidth: 11, halign: 'center' as const },
    },
    lorryOf: (customers) => lorriesFor(customers, region),
    showCust: false,
    emptyText: 'Nothing to pick: no delivery order in this region has goods lines.',
  };
}

const itemColW = (layout: PickLayout): number =>
  CONTENT_W - Object.values(layout.cols).reduce<number>((n, c) => n + (typeof c.cellWidth === 'number' ? c.cellWidth : 0), 0);

const pickBody = (doc: Doc, rows: readonly PickRow[], layout: PickLayout, withCode: boolean): string[][] => rows.map((r) => [
  itemCell(doc, itemColW(layout), r.item_code, r.description, r.variant, withCode),
  poCell(r.pos, r.worked_out),
  rackCell(r.racks, r.worked_out),
  qtyText(r.qty),
  ...(layout.showCust ? [r.customers.join(', ')] : []),
  ...(layout.lorryOf ? [layout.lorryOf(r.customers).join('\n') || DASH] : []),
  '',
]);

function sectionHeadRow(section: PickSection, layout: PickLayout) {
  const big = { fontStyle: 'bold', fontSize: S.customer - 1, cellPadding: { top: 1.8, right: 1.4, bottom: 1, left: 1.4 } };
  return [
    { content: section.category, colSpan: 3, styles: { ...big, halign: 'left' } },
    { content: unitsLabel(section.units), colSpan: layout.head.length - 3, styles: { ...big, halign: 'right' } },
  ];
}
const ROW_EST = 6.5;

function estimatePickRowH(doc: Doc, layout: PickLayout, row: readonly string[]): number {
  const colOf = (i: number) => layout.cols[i] as Record<string, unknown> | undefined;
  const widths = layout.head.map((_, i) => colOf(i)?.cellWidth);
  const fixed = widths.reduce<number>((n, w) => n + (typeof w === 'number' ? w : 0), 0);
  let lines = 1;
  row.forEach((cell, i) => {
    const w = typeof widths[i] === 'number' ? (widths[i] as number) : CONTENT_W - fixed;
    const size = Number(colOf(i)?.fontSize ?? S.min + 0.5);
    font(doc, size, colOf(i)?.fontStyle === 'bold' ? 'bold' : 'normal');
    lines = Math.max(lines, (doc.splitTextToSize(cell, w - CELL_PAD.left - CELL_PAD.right) as string[]).length);
  });
  return lines * pt(S.min + 0.5) * 1.15 + CELL_PAD.top + CELL_PAD.bottom + 0.5;
}

function drawPickTable(
  doc: Doc,
  autoTable: AutoTable,
  startY: number,
  layout: PickLayout,
  head: unknown[][],
  body: string[][],
  foot: unknown[][] | null,
): number {
  const tickCol = layout.head.length - 1;
  const firstRowH = body[0] ? estimatePickRowH(doc, layout, body[0]) : ROW_EST;
  const headH = head.reduce<number>((n, r) => {
    const first = r[0] as { content?: unknown; colSpan?: number; styles?: { fontSize?: number; cellPadding?: { top: number; bottom: number } } } | undefined;
    if (!first || typeof first.content !== 'string') return n + ROW_EST;
    const size = first.styles?.fontSize ?? S.min + 0.5;
    const pad = first.styles?.cellPadding ?? CELL_PAD;
    const span = first.colSpan ?? 1;
    let w = itemColW(layout);
    for (let i = 1; i < span; i += 1) {
      const cw = (layout.cols[i] as { cellWidth?: unknown } | undefined)?.cellWidth;
      w += typeof cw === 'number' ? cw : 0;
    }
    font(doc, size, 'bold');
    const lines = (doc.splitTextToSize(first.content, w - CELL_PAD.left - CELL_PAD.right) as string[]).length;
    return n + Math.max(ROW_EST, lines * pt(size) * 1.15 + pad.top + pad.bottom + 0.5);
  }, 0);
  const footH = foot && body.length === 1 ? pt(S.body) * 1.15 + CELL_PAD.top + CELL_PAD.bottom + 0.5 : 0;
  if (startY + headH + firstRowH + footH > TABLE_BOTTOM) { doc.addPage(); startY = CONT_TOP_A; }
  autoTable(doc, {
    ...baseTable({ startY, contTop: CONT_TOP_A }),
    head,
    body,
    ...(foot ? { foot, showFoot: 'lastPage' } : {}),
    footStyles: { fillColor: false, textColor: T.ink, fontStyle: 'bold', fontSize: S.body },
    columnStyles: layout.cols,
    didDrawCell: (data: {
      section: string; row: { index: number; raw: unknown }; column: { index: number }; cell: CellBox;
    }) => {
      if (data.section === 'head' && data.column.index === 0) {
        if (data.row.raw === layout.head) rule(doc, M, data.cell.y + data.cell.height, PAGE_W - M, RULE_THIN);
        else if (data.row.raw === head.find((r) => r !== layout.head)) rule(doc, M, data.cell.y, PAGE_W - M, RULE_HEAVY);
      }
      if (data.section === 'foot' && data.column.index === 0) rule(doc, M, data.cell.y, PAGE_W - M, RULE_HEAVY);
      if (data.section === 'body' && data.column.index === 0) drawItemCell(doc, data.cell);
      if (data.section === 'body' && data.column.index === tickCol) drawTickBox(doc, data.cell);
    },
    willDrawCell: (data: { section: string; column: { index: number }; cell: CellBox }) => {
      if (data.section === 'body' && data.column.index === 0) holdItemCell(data.cell);
    },
  });
  return lastY(doc, startY);
}

function drawPartA(doc: Doc, autoTable: AutoTable, startY: number, sections: PickSection[], layout: PickLayout): number {
  let y = startY;
  if (sections.length === 0) {
    font(doc, S.body);
    doc.text(layout.emptyText, M, baselineOf(y, S.body));
    return y + 8;
  }
  const total = sections.reduce((n, s) => n + s.units, 0);
  const totalFoot = [[
    { content: 'TOTAL TO PICK', colSpan: 3 },
    { content: unitsLabel(total), colSpan: layout.head.length - 3, styles: { halign: 'right' } },
  ]];
  sections.forEach((section, si) => {
    const lastSection = si === sections.length - 1;
    const labels = si === 0 ? [layout.head] : [];
    if (si > 0) y += 3;
    if (section.category !== 'SOFA') {
      y = drawPickTable(doc, autoTable, y, layout, [...labels, sectionHeadRow(section, layout)], pickBody(doc, section.rows, layout, false), lastSection ? totalFoot : null);
      return;
    }
    section.groups.forEach((g, gi) => {
      const lorry = layout.lorryOf ? layout.lorryOf([g.stop_no]).join(', ') : null;
      const soPad = { top: 1.8, right: 1.4, bottom: 0.6, left: 1.4 };
      const soRow = [
        {
          content: [g.so_doc_no ?? 'No SO', `Customer ${g.stop_no}`, g.customer_name ?? 'No customer name'].join(' · '),
          colSpan: 3,
          styles: { fontStyle: 'bold', fontSize: S.min + 0.5, halign: 'left', cellPadding: soPad },
        },
        {
          content: [`${g.pieces} ${g.pieces === 1 ? 'piece' : 'pieces'}`, lorry ? `Lorry ${lorry}` : null].filter(Boolean).join(' · '),
          colSpan: layout.head.length - 3,
          styles: { fontStyle: 'normal', fontSize: S.min, halign: 'left', cellPadding: soPad },
        },
      ];
      const head = gi === 0 ? [...labels, sectionHeadRow(section, layout), soRow] : [soRow];
      const lastGroup = gi === section.groups.length - 1;
      y = drawPickTable(doc, autoTable, y, layout, head, pickBody(doc, g.rows, layout, true), lastSection && lastGroup ? totalFoot : null);
    });
  });
  return y + 3;
}


const B_HEAD = [COL.type, COL.item, COL.po, COL.rack, COL.qty, COL.tick];
const B_COLS = {
  0: { cellWidth: 25, fontSize: S.min },
  1: { cellWidth: 'auto' as const, fontStyle: 'bold' as const },
  2: { cellWidth: 33, fontSize: S.min },
  3: { cellWidth: 18, halign: 'center' as const, fontStyle: 'bold' as const },
  4: { cellWidth: 12, halign: 'right' as const, fontStyle: 'bold' as const, fontSize: S.body },
  5: { cellWidth: 11, halign: 'center' as const },
};
const PART_B_MIN_ROOM = 40;
const B_ITEM_W = CONTENT_W - 25 - 33 - 18 - 12 - 11;

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

function stopRows(doc: Doc, stop: PackingStop, fabric: Fabric): string[][] {
  return stop.items.map((it) => [
    isSofaAccessory(it.item_group) ? 'SOFA ACC' : shortType(packCategory(it.item_group)),
    itemCell(doc, B_ITEM_W, it.item_code, it.description, variantText(it, fabric), packCategory(it.item_group) === 'SOFA'),
    poCell(splitPos(it.po), it.worked_out),
    rackCell(splitRacks(it.rack), it.worked_out),
    qtyText(it.qty),
    '',
  ]);
}

function estimateRowH(doc: Doc, row: string[]): number {
  font(doc, S.min + 0.5, 'bold');
  const item = (doc.splitTextToSize(row[1] ?? '', B_ITEM_W - 2.8) as string[]).length;
  font(doc, S.min);
  const po = (doc.splitTextToSize(row[2] ?? '', 33 - 2.8) as string[]).length;
  const lines = Math.max(item, po);
  return lines * pt(S.min + 0.5) * 1.15 + CELL_PAD.top + CELL_PAD.bottom + 0.5;
}

function drawPartB(doc: Doc, autoTable: AutoTable, startY: number, stops: readonly PackingStop[], fabric: Fabric): number {
  let y = startY;
  let first = true;
  for (const { stop } of loadingOrder(stops)) {
    const rows = stop.do_missing ? [] : stopRows(doc, stop, fabric);
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
      didDrawCell: (data: { section: string; column: { index: number }; cell: CellBox }) => {
        if (data.section === 'head' && data.column.index === 0) {
          rule(doc, M, data.cell.y + data.cell.height, PAGE_W - M, RULE_THIN);
        }
        if (data.section === 'body' && data.column.index === 1) drawItemCell(doc, data.cell);
        if (data.section === 'body' && data.column.index === 5) drawTickBox(doc, data.cell);
      },
      willDrawCell: (data: { section: string; column: { index: number }; cell: CellBox }) => {
        if (data.section === 'body' && data.column.index === 1) holdItemCell(data.cell);
      },
    });
    y = lastY(doc, y) + 3;
    first = false;
  }
  return y;
}


/** WORKED_OUT_NOTE under the sheet's last table when any PO / Rack cell on it carries " *"
 *  (the same footnote the DO PDF prints). */
function drawWorkedOutNote(doc: Doc, startY: number, items: readonly PackingItem[]): number {
  if (!items.some((it) => it.worked_out)) return startY;
  let y = startY;
  if (y + 7 > TABLE_BOTTOM) { doc.addPage(); y = CONT_TOP_A; }
  font(doc, S.body);
  setInk(doc, T.ink);
  doc.text(WORKED_OUT_NOTE, M, baselineOf(y + 1, S.body));
  return y + 7;
}

/** Draw ONE trip's packing list into `doc`, starting on its current page. A
 *  whole day's print calls this once per lorry, each on a fresh page. */
export async function renderPackingListInto(
  doc: Doc,
  autoTable: AutoTable,
  list: PackingListRow,
  opts: { date: string; runUrl: string | null; logo: BrandingLogo | null; part: SheetPart | null },
): Promise<void> {
  await ensurePdfCjkFont(doc, [list]);
  const allItems = list.stops.flatMap((s) => s.items);
  const fabric = await loadCustomerFabricMaps(allItems);

  const startPage = doc.getNumberOfPages();
  const plate = (list.lorry_plate ?? '').trim() || 'No lorry';
  const dateIso = list.trip_date ?? opts.date;
  const day = weekday(dateIso);
  const dateText = fmtDocDate(dateIso);

  const ruleY = drawSlimHeader(doc, {
    docNoText: `Lorry : ${plate}${partSuffix(opts.part)}`,
    subLine: `Delivery Date ${dateText}${day ? ` (${day})` : ''}`,
    qr: opts.runUrl ? { url: opts.runUrl, caption: SCAN_CAPTION } : null,
    logo: opts.logo,
  });
  let y = drawCrewBox(doc, ruleY + 3, list) + 5;

  y = drawPartHeading(doc, y, 'PART A · PICK BY CATEGORY');
  y = drawPartA(doc, autoTable, y, buildPickSections(list.stops, (it) => variantText(it, fabric)), LORRY_LAYOUT);

  if (y + PART_B_MIN_ROOM > TABLE_BOTTOM) { doc.addPage(); y = CONT_TOP_A; } else { y += 3; }
  y = drawPartHeading(doc, y, 'PART B · LOAD BY CUSTOMER (LAST CUSTOMER IN FIRST)');
  y = drawPartB(doc, autoTable, y, list.stops, fabric);
  y = drawWorkedOutNote(doc, y, list.stops.filter((s) => !s.do_missing).flatMap((s) => s.items));

  if (y > CLOSING_TOP) doc.addPage();

  const pageCount = doc.getNumberOfPages();
  const total = pageCount - startPage + 1;
  const crew = crewParts(list);
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    const pageNo = p - startPage + 1;
    const footRight = `${plate}${partSuffix(opts.part)} · ${dateText} · Page : ${pageNo} of ${total}`;
    if (p > startPage) drawRunningHeader(doc, `PACKING LIST · Lorry : ${plate}${partSuffix(opts.part)}`, [dateText, ...crew]);
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

function drawRunningHeader(doc: Doc, left: string, rightParts: string[]): void {
  font(doc, S.body, 'bold');
  setInk(doc, T.ink);
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

export async function runUrlFor(
  list: Pick<PackingListRow, 'trip_id' | 'source' | 'lorry_plate' | 'trip_date' | 'stops'>,
  date: string,
  part: SheetPart | null,
): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const arm = await import('./packing-scan-token-arm');
  if (list.source === 'trip') return packingRunUrl(window.location.origin, await arm.armPackingScanToken(list.trip_id));
  const plate = (list.lorry_plate ?? '').trim();
  const doIds = loadingOrder(list.stops).map((s) => s.stop.do_id).filter((id): id is string => !!id);
  if (!plate || doIds.length === 0) return null;
  const token = await arm.armLorryDayScanToken({ lorryPlate: plate, deliveryDate: list.trip_date ?? date, doIds, part });
  return packingRunUrl(window.location.origin, token);
}

/** Where a region sheet's QR points: a region-day token holding the DOs printed on it,
 *  in sheet order. Null off the browser or when arming fails. */
export async function regionRunUrlFor(
  region: { region: string; dos: ReadonlyArray<{ do_id: string | null }> },
  date: string,
  part: SheetPart | null,
): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const doIds = region.dos.map((d) => d.do_id).filter((id): id is string => !!id);
  if (!region.region.trim() || doIds.length === 0) return null;
  const arm = await import('./packing-scan-token-arm');
  const token = await arm.armRegionDayScanToken({ region: region.region, deliveryDate: date, doIds, part });
  return packingRunUrl(window.location.origin, token);
}

async function renderListPieces(doc: Doc, autoTable: AutoTable, list: PackingListRow, date: string): Promise<void> {
  const pieces = splitPackingList(list);
  for (let i = 0; i < pieces.length; i += 1) {
    if (i > 0) doc.addPage();
    const { sheet, part } = pieces[i]!;
    await renderPackingListInto(doc, autoTable, sheet, { date, runUrl: await runUrlFor(sheet, date, part), logo: null, part });
  }
}

/** One lorry's packing list -> its own file / print job / preview tab. */
export async function generatePackingListPdf(
  list: PackingListRow,
  opts: { date: string; action: PdfAction },
): Promise<void> {
  const { doc, autoTable } = await newDoc();
  await renderListPieces(doc, autoTable, list, opts.date);
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
    await renderListPieces(doc, autoTable, lists[i]!, opts.date);
  }
  deliverPdf(doc, `packing-lists-${opts.date}.pdf`, opts.action);
}


/** "KL-SEL-2026-11-28.pdf". */
export function packingRegionFileName(region: Pick<PackingRegionRow, 'label' | 'region'>, date: string): string {
  return `${safeName((region.label || region.region).trim() || 'region')}-${date}.pdf`;
}

function drawRegionSummary(doc: Doc, top: number, region: PackingRegionRow): number {
  return drawInfoStrip(doc, top, [
    {
      caption: 'This region',
      lines: [[`${region.do_count} DO · ${region.customer_count} ${region.customer_count === 1 ? 'customer' : 'customers'} · ${unitsLabel(region.units)}`, true]],
    },
    { caption: 'Lorries', lines: [[region.lorry_plates.length > 0 ? region.lorry_plates.join(', ') : 'None yet', true]] },
  ]);
}

const KEY_HEAD = ['NO', 'CUSTOMER', 'DO NO', 'SO NO', COL.lorry, 'UNITS'];
const KEY_COLS = {
  0: { cellWidth: 9, halign: 'center' as const, fontStyle: 'bold' as const },
  1: { cellWidth: 'auto' as const },
  2: { cellWidth: 34 },
  3: { cellWidth: 34 },
  4: { cellWidth: 26 },
  5: { cellWidth: 13, halign: 'right' as const, fontStyle: 'bold' as const },
};

function drawCustomerKey(doc: Doc, autoTable: AutoTable, startY: number, region: PackingRegionRow): number {
  const title = [{ content: 'CUSTOMERS IN THIS REGION', colSpan: KEY_HEAD.length, styles: { fontStyle: 'bold', fontSize: S.body, halign: 'left' } }];
  let y = startY;
  if (y + 3 * ROW_EST > TABLE_BOTTOM) { doc.addPage(); y = CONT_TOP_A; }
  autoTable(doc, {
    ...baseTable({ startY: y, contTop: CONT_TOP_A }),
    head: [title, KEY_HEAD],
    body: region.dos.map((d, i) => [
      String(i + 1),
      d.customer_name ?? 'No customer name',
      d.do_number ?? DASH,
      d.so_doc_no ?? DASH,
      regionLorryLabel(d),
      qtyText(d.units),
    ]),
    columnStyles: KEY_COLS,
    didDrawCell: (data: { section: string; row: { index: number }; column: { index: number }; cell: { y: number; height: number } }) => {
      if (data.section !== 'head' || data.column.index !== 0) return;
      if (data.row.index === 0) rule(doc, M, data.cell.y, PAGE_W - M, RULE_HEAVY);
      if (data.row.index === 1) rule(doc, M, data.cell.y + data.cell.height, PAGE_W - M, RULE_HEAVY);
    },
  });
  return lastY(doc, y) + 3;
}

/** Draw ONE region's packing list into `doc`, starting on its current page: Part A with a LORRY
 *  column, then a customer key so the CUSTOMER numbers mean something without a Part B (a region
 *  is not one lorry's route, so it has no loading order). */
export async function renderPackingRegionInto(
  doc: Doc,
  autoTable: AutoTable,
  region: PackingRegionRow,
  opts: { date: string; runUrl: string | null; logo: BrandingLogo | null; part: SheetPart | null },
): Promise<void> {
  await ensurePdfCjkFont(doc, [region]);
  const fabric = await loadCustomerFabricMaps(region.dos.flatMap((d) => d.items));
  const startPage = doc.getNumberOfPages();
  const label = region.label || region.region;
  const day = weekday(opts.date);
  const dateText = fmtDocDate(opts.date);

  const ruleY = drawSlimHeader(doc, {
    docNoText: `Region : ${label}${partSuffix(opts.part)}`,
    subLine: `Delivery Date ${dateText}${day ? ` (${day})` : ''}`,
    qr: opts.runUrl ? { url: opts.runUrl, caption: SCAN_CAPTION } : null,
    logo: opts.logo,
  });
  let y = drawRegionSummary(doc, ruleY + 3, region) + 5;
  y = drawPartHeading(doc, y, 'PICK BY CATEGORY');
  y = drawPartA(doc, autoTable, y, buildPickSections(regionStops(region), (it) => variantText(it, fabric)), regionLayout(region));
  y = drawCustomerKey(doc, autoTable, y, region);
  y = drawWorkedOutNote(doc, y, region.dos.flatMap((d) => d.items));

  if (y > CLOSING_TOP) doc.addPage();

  const pageCount = doc.getNumberOfPages();
  const total = pageCount - startPage + 1;
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    const footRight = `${label}${partSuffix(opts.part)} · ${dateText} · Page : ${p - startPage + 1} of ${total}`;
    if (p > startPage) drawRunningHeader(doc, `PACKING LIST · Region : ${label}${partSuffix(opts.part)}`, [dateText, `${region.do_count} DO`]);
    if (p === pageCount) {
      drawSignatureClosing(doc, {
        titles: ['Picked By (Warehouse)', 'Checked By'],
        fields: ['Name', 'Time'],
        footLeft: 'By signing, the warehouse confirms every ticked item was picked.',
        footRight,
      });
    } else {
      drawFooterLine(doc, COMPANY.name, footRight);
    }
  }
  setInk(doc, T.ink);
}

/** Regions -> one file, each region starting on its own page. */
export async function generatePackingRegionsPdf(
  regions: readonly PackingRegionRow[],
  opts: { date: string; action: PdfAction },
): Promise<void> {
  if (regions.length === 0) return;
  const { doc, autoTable } = await newDoc();
  for (let i = 0; i < regions.length; i += 1) {
    const pieces = splitPackingRegion(regions[i]!);
    for (let j = 0; j < pieces.length; j += 1) {
      if (i > 0 || j > 0) doc.addPage();
      const { sheet, part } = pieces[j]!;
      await renderPackingRegionInto(doc, autoTable, sheet, { date: opts.date, runUrl: await regionRunUrlFor(sheet, opts.date, part), logo: null, part });
    }
  }
  const name = regions.length === 1 ? packingRegionFileName(regions[0]!, opts.date) : `packing-regions-${opts.date}.pdf`;
  deliverPdf(doc, name, opts.action);
}
