// ----------------------------------------------------------------------------
// rp-report-pdf — "Print" for the Receipts & Payments report. It prints WHAT
// THE SCREEN SHOWS: the same columns, the same rows, the same four balance
// lines — so the paper and the screen can never disagree. Landscape A4 on
// the shared letterhead, the autoTable dress every document wears.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, type PdfAction,
} from './pdf-common';
import type { RpReport, RpRow } from './rp-report-queries';

/** 1,234.56 with a bracketed negative — the report's own money dress. */
export const fmtRp = (sen: number): string => {
  const abs = Math.abs(sen) / 100;
  const s = abs.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sen < 0 ? `(${s})` : s;
};

type Line = { kind: 'section' | 'row' | 'total' | 'balance'; label: string; cells: string[] };

/** The table exactly as drawn — pure, so a test reads it without a PDF. */
export function rpTable(r: RpReport): { head: string[]; lines: Line[] } {
  const codes = r.columns.map((c) => c.code);
  const head = ['', ...r.columns.map((c) => `${c.code}\n${c.name}`), 'Total'];
  const rowLine = (row: RpRow): Line => ({
    kind: 'row',
    label: row.code && row.name !== row.code ? `${row.code} · ${row.name}` : row.name,
    cells: [...codes.map((c) => fmtRp(row.cells[c] ?? 0)), fmtRp(row.totalSen)],
  });
  const balance = (label: string, per: Record<string, number>, total: number): Line =>
    ({ kind: 'balance', label, cells: [...codes.map((c) => fmtRp(per[c] ?? 0)), fmtRp(total)] });
  const lines: Line[] = [
    balance('Opening balance', r.opening, r.totals.openingTotalSen),
    { kind: 'section', label: 'RECEIPTS', cells: codes.map(() => '').concat('') },
    ...r.receipts.map(rowLine),
    balance('Total receipts', r.totals.receipts, r.totals.receiptsTotalSen),
    { kind: 'section', label: 'PAYMENTS', cells: codes.map(() => '').concat('') },
    ...r.payments.map(rowLine),
    balance('Total payments', r.totals.payments, r.totals.paymentsTotalSen),
    balance('Closing balance', r.totals.closing, r.totals.closingTotalSen),
  ];
  return { head, lines };
}

export async function generateRpPdf(r: RpReport, opts?: { action?: PdfAction }): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await ensurePdfCjkFont(doc, [...r.receipts, ...r.payments]);
  const y = drawHeader(doc, {
    docTitle: 'RECEIPTS & PAYMENTS',
    rightMeta: [
      { label: 'Period', value: `${fmtDocDate(r.from)} – ${fmtDocDate(r.to)}` },
      { label: 'Accounts', value: r.columns.map((c) => c.code).join(', ') },
      { label: 'Rows', value: r.byParty ? 'By debtor / creditor' : "By the owner's accounts" },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });
  const t = rpTable(r);
  autoTable(doc, {
    startY: y + 2,
    head: [t.head],
    body: t.lines.map((l) => [l.label, ...l.cells]),
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: Object.fromEntries([[0, { cellWidth: 70 }], ...t.head.slice(1).map((_, i) => [i + 1, { halign: 'right' as const }])]),
    didParseCell: (data) => {
      const line = t.lines.at(data.row.index);
      if (data.section !== 'body' || !line) return;
      if (line.kind === 'section') data.cell.styles.fontStyle = 'bold';
      if (line.kind === 'balance') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.lineWidth = { top: 0.2, bottom: 0, left: 0, right: 0 }; }
    },
  });
  deliverPdf(doc, `receipts-payments-${r.from}-to-${r.to}.pdf`, opts?.action ?? 'preview');
}
