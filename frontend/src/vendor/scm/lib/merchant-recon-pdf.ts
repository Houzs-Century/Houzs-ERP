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

import autoTable, { type RowInput } from 'jspdf-autotable';
import { fmtDocDate, type PdfAction } from './pdf-common';
import { fmtSenPlain, todayMY } from '../../shared/format';
import {
  LISTING_CELL as CELL, LISTING_MARGIN as MARGIN, closeListing, listingDress, openListing, screenTable,
  type FootCell, type Meta, type Rgb, type ScreenTableView,
} from './listing-pdf';

type Options = { merchant?: string | null; action?: PdfAction };

const RED: Rgb = [176, 32, 32];
const GREEN: Rgb = [24, 110, 60];
const BAND_FILL: Rgb = [244, 245, 242];
/** The room a report's name takes above its first line. */
const BAND_H = 5.6;
/** The screen turns Days red past this. */
const LATE_DAYS = 14;

/* ── The card payments list ─────────────────────────────────────────────────── */

/** The cells the table's Excel would hold (DataTable's `onExportPdf`). Money is in ringgit there. */
export type WaitingCardsView = ScreenTableView;

/** The table exactly as drawn: pure, so a test reads the cells and the total without a PDF. */
export function waitingCardsTable(view: WaitingCardsView): {
  head: string[]; body: string[][]; foot: FootCell[] | null; totalSen: number | null; daysCol: number;
} {
  return { ...screenTable(view), daysCol: view.keys.indexOf('days') };
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
