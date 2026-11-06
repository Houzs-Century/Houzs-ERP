// ----------------------------------------------------------------------------
// merchant-recon-pdf: the two lists on Merchant reports on paper (owner 2026-11-06:
// 支持pdf?). Like the AR and AP listings they print WHAT THE SCREEN SHOWS, landscape
// A4 on the shared letterhead, in the autoTable dress every document wears:
//   · "Card payments no merchant report has reported yet": the columns the reader
//     has showing, in their order, the cells the Excel holds, Amount totalled;
//   · "Merchant reports still to reconcile": the screen's two bands, each report
//     named once above its own lines.
// A report's name is drawn INSIDE its first line's row. Down the side, as the screen
// has it, falls apart once a report is longer than a page (AEON's run past line 80);
// as a row of its own, the first sample left one alone at the foot of a page.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable, { type RowInput } from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, type PdfAction,
} from './pdf-common';
import { fmtSenPlain, todayMY } from '../../shared/format';

type Rgb = [number, number, number];
type Meta = { label: string; value: string };
type FootCell = string | { content: string; colSpan: number };
type Options = { merchant?: string | null; action?: PdfAction };

const MARGIN = 14;
const CELL = { top: 1.2, bottom: 1.2, left: 1.5, right: 1.5 };
const RED: Rgb = [176, 32, 32];
const GREEN: Rgb = [24, 110, 60];
const TOTAL_FILL: Rgb = [236, 238, 234];
const BAND_FILL: Rgb = [244, 245, 242];
/** The room a report's name takes above its first line. */
const BAND_H = 5.6;
/** The screen turns Days red past this. */
const LATE_DAYS = 14;

/* ── The card payments list ─────────────────────────────────────────────────── */

/** The cells the table's Excel would hold (DataTable's `onExportPdf`). Money is in ringgit there. */
export type WaitingCardsView = {
  keys: string[];
  matrix: { header: string[]; formats: string[]; body: Array<Array<string | number | null>> };
};

const cellText = (v: string | number | null | undefined, format: string | undefined): string => {
  if (v === null || v === undefined || v === '') return '-';
  if (format === 'money' && typeof v === 'number') return fmtSenPlain(Math.round(v * 100));
  if (format === 'date') return fmtDocDate(String(v));
  return String(v);
};

/** The table exactly as drawn: pure, so a test reads the cells and the total without a PDF. */
export function waitingCardsTable({ keys, matrix }: WaitingCardsView): {
  head: string[]; body: string[][]; foot: FootCell[] | null; totalSen: number | null; daysCol: number;
} {
  const body = matrix.body.map((row) => row.map((v, c) => cellText(v, matrix.formats[c])));
  const moneyCol = matrix.formats.indexOf('money');
  const count = matrix.body.length;
  const label = `Total (${count} row${count === 1 ? '' : 's'})`;
  const width = matrix.header.length;
  let foot: FootCell[] | null = null;
  let totalSen: number | null = null;
  if (moneyCol >= 0) {
    totalSen = matrix.body.reduce((s, row) => s + Math.round(Number(row[moneyCol] ?? 0) * 100), 0);
    const total = fmtSenPlain(totalSen);
    const after = width - moneyCol - 1;
    foot = moneyCol === 0
      ? [total, { content: label, colSpan: after }]
      : [{ content: label, colSpan: moneyCol }, total, ...(after > 0 ? [{ content: '', colSpan: after }] : [])];
  }
  return { head: matrix.header, body, foot, totalSen, daysCol: keys.indexOf('days') };
}

/** The sentence on top: what the list is, how many have no bank, which merchant it was cut to. */
export function waitingCardsSubtitle({ keys, matrix }: WaitingCardsView, merchant: string | null): string {
  const m = keys.indexOf('merchant');
  const untagged = m < 0 ? 0 : matrix.body.filter((row) => row[m] === '未标').length;
  return [
    merchant ? `Merchant: ${merchant}.` : '',
    'Card payments no merchant report has reported yet.',
    untagged > 0 ? `${untagged} keyed in without a bank (未标).` : '',
    'All amounts in RM.',
  ].filter(Boolean).join(' ');
}

/* ── The reports still to reconcile ─────────────────────────────────────────── */

export type PrintedOrder = {
  docNo: string; customer: string | null; sales: string | null; sheet: string | null;
  paidOn: string | null; code: string | null; amountSen: number | null;
};
export type PrintedLine = {
  date: string; lineNo: number; ref: string | null; grossSen: number; feeSen: number; netSen: number;
  /** What the Document column says when no order is named: "7 possible". */
  document: string | null;
  orders: PrintedOrder[];
  status: string;
  tone: 'good' | 'bad' | null;
};
export type PrintedReport = { merchant: string; file: string; netSen: number; lines: PrintedLine[] };

const REPORT_HEAD: RowInput[] = [
  [
    { content: 'What the merchant reported', colSpan: 5, styles: { halign: 'center' } },
    { content: 'The sale it paid for', colSpan: 7, styles: { halign: 'center' } },
    { content: 'Status', rowSpan: 2 },
  ],
  ['Date', 'Reference', 'Gross', 'Fee', 'Net', 'Document', 'Customer', 'Sales', 'Account sheet', 'Paid on', 'Approval', 'Amount'],
];
const REPORT_WIDTHS = [17, 17, 17, 13, 17, 26, 42, 20, 22, 17, 17, 17, 27];
const REPORT_FIGURES = new Set([2, 3, 4, 11]);
const REPORT_SEAM = 5;
const REPORT_STATUS = 12;

/** The table exactly as drawn. `bands` names a report on the body row of its first line. */
export function reportLinesTable(reports: PrintedReport[]): {
  body: string[][]; bands: Map<number, string>; tones: Array<PrintedLine['tone']>; foot: FootCell[];
} {
  const body: string[][] = [];
  const bands = new Map<number, string>();
  const tones: Array<PrintedLine['tone']> = [];
  const total = { grossSen: 0, feeSen: 0, netSen: 0, amountSen: 0 };
  for (const report of reports) {
    report.lines.forEach((l, i) => {
      if (i === 0) bands.set(body.length, `${report.merchant}   ${report.file}   net ${fmtSenPlain(report.netSen)}`);
      tones.push(l.tone);
      total.grossSen += l.grossSen; total.feeSen += l.feeSen; total.netSen += l.netSen;
      total.amountSen += l.orders.reduce((s, o) => s + (o.amountSen ?? 0), 0);
      /* One line settling several orders stacks inside its cells, as on the screen. */
      const stack = (pick: (o: PrintedOrder) => string | null) => (
        l.orders.length === 0 ? '-' : l.orders.map((o) => pick(o) || '-').join('\n')
      );
      body.push([
        `${fmtDocDate(l.date)}\nline ${l.lineNo}`, l.ref ?? '-',
        fmtSenPlain(l.grossSen), fmtSenPlain(l.feeSen), fmtSenPlain(l.netSen),
        l.orders.length === 0 ? (l.document ?? '-') : stack((o) => o.docNo),
        stack((o) => o.customer), stack((o) => o.sales), stack((o) => o.sheet),
        stack((o) => (o.paidOn ? fmtDocDate(o.paidOn) : null)), stack((o) => o.code),
        stack((o) => (o.amountSen == null ? null : fmtSenPlain(o.amountSen))),
        l.status,
      ]);
    });
  }
  const count = body.length;
  return {
    body, bands, tones,
    foot: [
      { content: `Total (${count} line${count === 1 ? '' : 's'})`, colSpan: 2 },
      fmtSenPlain(total.grossSen), fmtSenPlain(total.feeSen), fmtSenPlain(total.netSen),
      { content: '', colSpan: 6 }, fmtSenPlain(total.amountSen), '',
    ],
  };
}

/* ── On paper ───────────────────────────────────────────────────────────────── */

async function openListing(title: string, meta: Meta[], subtitle: string, payload: unknown): Promise<{ doc: jsPDF; startY: number }> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  /* The sentence on top carries 未标 too: a field missed here would print as mojibake. */
  await ensurePdfCjkFont(doc, { payload, meta, subtitle });
  const y = drawHeader(doc, { docTitle: title, rightMeta: [...meta, { label: 'Printed', value: fmtDocStamp() }] });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
  doc.text(subtitle, MARGIN, y + 2, { maxWidth: doc.internal.pageSize.getWidth() - MARGIN * 2 });
  doc.setTextColor(0);
  return { doc, startY: y + 7 };
}

const listingDress = (fontSize: number) => ({
  theme: 'plain' as const,
  rowPageBreak: 'avoid' as const,
  showFoot: 'lastPage' as const,
  styles: { ...DOC_TABLE_STYLES, fontSize, cellPadding: CELL },
  headStyles: DOC_TABLE_HEAD_STYLES,
  footStyles: { fontStyle: 'bold' as const, fillColor: TOTAL_FILL },
  margin: { left: MARGIN, right: MARGIN, top: 12, bottom: 12 },
});

function closeListing(doc: jsPDF, fileName: string, action: PdfAction = 'preview'): void {
  const pages = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
    doc.text(`Page ${i} of ${pages}`, w - MARGIN, h - 7, { align: 'right' });
  }
  doc.setTextColor(0);
  deliverPdf(doc, fileName, action);
}

export async function generateWaitingCardsPdf(view: WaitingCardsView, opts: Options = {}): Promise<void> {
  const t = waitingCardsTable(view);
  const meta: Meta[] = [
    { label: 'Rows', value: String(t.body.length) },
    ...(t.totalSen == null ? [] : [{ label: 'Total', value: `RM ${fmtSenPlain(t.totalSen)}` }]),
  ];
  const { doc, startY } = await openListing('CARD PAYMENTS NOT REPORTED', meta, waitingCardsSubtitle(view, opts.merchant ?? null), t);
  const { formats, body } = view.matrix;
  const figure = (c: number) => formats[c] === 'money' || formats[c] === 'number';
  autoTable(doc, {
    ...listingDress(8),
    startY,
    head: [t.head],
    body: t.body,
    ...(t.foot ? { foot: [t.foot] } : {}),
    didParseCell: (d) => {
      const c = d.column.index;
      if (figure(c)) d.cell.styles.halign = 'right';
      if (d.section === 'body' && c === t.daysCol && Number(body[d.row.index]?.[c]) > LATE_DAYS) {
        d.cell.styles.textColor = RED;
        d.cell.styles.fontStyle = 'bold';
      }
    },
  });
  closeListing(doc, `card-payments-not-reported-${todayMY()}.pdf`, opts.action);
}

export async function generateReportLinesPdf(reports: PrintedReport[], opts: Options = {}): Promise<void> {
  const t = reportLinesTable(reports);
  const subtitle = `${opts.merchant ? `Merchant: ${opts.merchant}. ` : ''}Merchant reports still to reconcile: every line still to decide, with the sale it paid for. All amounts in RM.`;
  const meta: Meta[] = [{ label: 'Reports', value: String(reports.length) }, { label: 'Lines', value: String(t.body.length) }];
  const { doc, startY } = await openListing('MERCHANT REPORTS TO RECONCILE', meta, subtitle, t);
  autoTable(doc, {
    ...listingDress(7.5),
    startY,
    head: REPORT_HEAD,
    body: t.body,
    foot: [t.foot],
    columnStyles: Object.fromEntries(REPORT_WIDTHS.map((cellWidth, c) => [c, { cellWidth }])),
    didParseCell: (d) => {
      const c = d.column.index;
      const headedFigure = d.section === 'body' || d.section === 'foot' || d.row.index === 1;
      if (REPORT_FIGURES.has(c) && headedFigure) d.cell.styles.halign = 'right';
      /* The rule down the seam, between what the merchant said and what the ERP said. */
      if (c === REPORT_SEAM) d.cell.styles.lineWidth = { top: 0.1, right: 0.1, bottom: 0.1, left: 0.4 };
      if (d.section !== 'body') return;
      if (t.bands.has(d.row.index)) d.cell.styles.cellPadding = { ...CELL, top: CELL.top + BAND_H };
      if (c === REPORT_STATUS) {
        const tone = t.tones[d.row.index];
        if (tone) d.cell.styles.textColor = tone === 'good' ? GREEN : RED;
      }
    },
    /* After the row's last cell, so the band lies over the columns' rules. */
    didDrawCell: (d) => {
      if (d.section !== 'body' || d.column.index !== REPORT_STATUS) return;
      const band = t.bands.get(d.row.index);
      if (!band) return;
      doc.setFillColor(...BAND_FILL); doc.setDrawColor(120); doc.setLineWidth(0.1);
      doc.rect(MARGIN, d.cell.y, doc.internal.pageSize.getWidth() - MARGIN * 2, BAND_H, 'FD');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(0);
      doc.text(band, MARGIN + CELL.left, d.cell.y + BAND_H - 1.9);
    },
  });
  closeListing(doc, `merchant-reports-to-reconcile-${todayMY()}.pdf`, opts.action);
}
