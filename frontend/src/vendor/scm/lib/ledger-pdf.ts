// ----------------------------------------------------------------------------
// ledger-pdf — "Print" for the General Ledger (docs/bugs/0924). It prints WHAT
// THE SCREEN SHOWS: one block per account, BALANCE B/F, the lines, the
// block's totals, the grand totals — the AutoCount page on the shared
// letterhead, landscape A4, the autoTable dress every document wears.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, type PdfAction,
} from './pdf-common';
import { LEDGER_COLUMNS, counterLabel, fmtLedger, fmtSide, journalLabel, type LedgerReport } from './ledger-queries';

export type LedgerPdfLine = { kind: 'account' | 'bf' | 'line' | 'total' | 'grand'; cells: string[] };

/** The table exactly as drawn — pure, so a test reads it without a PDF. */
export function ledgerTable(r: LedgerReport): { head: string[]; lines: LedgerPdfLine[] } {
  const lines: LedgerPdfLine[] = [];
  const blank = (n: number): string[] => Array.from({ length: n }, () => '');
  for (const b of r.blocks) {
    lines.push({ kind: 'account', cells: [`${b.code}  ${b.name}`, ...blank(9)] });
    lines.push({ kind: 'bf', cells: [...blank(6), 'BALANCE B/F', '', '', fmtLedger(b.openingSen)] });
    for (const l of b.lines) {
      lines.push({
        kind: 'line',
        cells: [fmtDocDate(l.date), l.jeNo, journalLabel(l.journal), counterLabel(l.counter), l.doc ?? '', l.doc2 ?? '',
          `${l.description ?? ''}${l.reversal ? ` [${l.reversal}]` : ''}`, fmtSide(l.debitSen), fmtSide(l.creditSen), fmtLedger(l.balanceSen)],
      });
    }
    lines.push({ kind: 'total', cells: [...blank(6), 'TOTAL', fmtLedger(b.debitSen), fmtLedger(b.creditSen), fmtLedger(b.closingSen)] });
  }
  lines.push({ kind: 'grand', cells: [...blank(6), 'GRAND TOTAL', fmtLedger(r.totals.debitSen), fmtLedger(r.totals.creditSen), ''] });
  return { head: [...LEDGER_COLUMNS], lines };
}

const scopeLabel = (r: LedgerReport): string =>
  r.scope.all ? 'Every account'
  : r.scope.codes.length > 0 ? r.scope.codes.join(', ')
  : `${r.scope.fromCode ?? '…'} – ${r.scope.toCode ?? '…'}`;

export async function generateLedgerPdf(r: LedgerReport, opts?: { action?: PdfAction }): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await ensurePdfCjkFont(doc, r.blocks.flatMap((b) => [b, ...b.lines]));
  const y = drawHeader(doc, {
    docTitle: 'GENERAL LEDGER',
    rightMeta: [
      { label: 'Period', value: `${fmtDocDate(r.from)} – ${fmtDocDate(r.to)}` },
      { label: 'Accounts', value: scopeLabel(r) },
      { label: 'Reversed', value: r.showReversed ? 'Listed, not counted' : 'Left out' },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });
  const t = ledgerTable(r);
  autoTable(doc, {
    startY: y + 2,
    head: [t.head],
    body: t.lines.map((l) => (l.kind === 'account' ? [{ content: l.cells[0] ?? '', colSpan: t.head.length }] : l.cells)),
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 7 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 18 }, 1: { cellWidth: 30 }, 2: { cellWidth: 16 }, 3: { cellWidth: 40 }, 4: { cellWidth: 34 }, 5: { cellWidth: 26 }, 7: { halign: 'right', cellWidth: 22 }, 8: { halign: 'right', cellWidth: 22 }, 9: { halign: 'right', cellWidth: 24 } },
    didParseCell: (data) => {
      const line = t.lines.at(data.row.index);
      if (data.section !== 'body' || !line) return;
      if (line.kind === 'account') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.fillColor = [240, 237, 230]; }
      if (line.kind === 'bf') data.cell.styles.fontStyle = 'italic';
      if (line.kind === 'total' || line.kind === 'grand') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.lineWidth = { top: 0.2, bottom: 0, left: 0, right: 0 }; }
    },
  });
  deliverPdf(doc, `general-ledger-${r.from}-to-${r.to}.pdf`, opts?.action ?? 'preview');
}
