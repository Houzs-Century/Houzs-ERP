// ----------------------------------------------------------------------------
// performance-pnl-pdf — "PDF" for the Performance P&L (docs/bugs/0835). It
// prints WHAT THE SCREEN SHOWS: the groups table, the summary lines, the
// notes — the same pure lines the screen and the CSV read, so paper and
// screen can never disagree. A4 portrait on the shared letterhead.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, fmtDocDate, fmtDocStamp, type PdfAction,
} from './pdf-common';
import {
  fmtPerf, fmtPerfPct, performanceNotes, performanceSummaryLines,
  type PerformanceReport, type PerformanceSummaryLine,
} from './performance-report-queries';

export type PerfGroupLine = { kind: 'row' | 'total'; cells: string[] };

/** The two tables exactly as drawn — pure, so a test reads them without a PDF. */
export function performanceTables(r: PerformanceReport): { head: string[]; groups: PerfGroupLine[]; summary: PerformanceSummaryLine[]; notes: string[] } {
  const head = ['Group', 'Sales', 'Cost of sales', 'Gross profit', 'GP %'];
  const groups: PerfGroupLine[] = [
    ...r.groups.map((g): PerfGroupLine => ({ kind: 'row', cells: [g.label, fmtPerf(g.salesSen), fmtPerf(g.cogsSen), fmtPerf(g.gpSen), fmtPerfPct(g.gpPct)] })),
    { kind: 'total', cells: ['Total', fmtPerf(r.totals.salesSen), fmtPerf(r.totals.cogsSen), fmtPerf(r.totals.gpSen), fmtPerfPct(r.totals.gpPct)] },
  ];
  return { head, groups, summary: performanceSummaryLines(r), notes: performanceNotes(r) };
}

export async function generatePerformancePdf(r: PerformanceReport, opts?: { action?: PdfAction }): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const t = performanceTables(r);
  const y = drawHeader(doc, {
    docTitle: 'PERFORMANCE P&L',
    rightMeta: [
      { label: 'Period', value: `${fmtDocDate(r.from)} – ${fmtDocDate(r.to)}` },
      { label: 'Orders', value: `${r.orders.counted} (${r.orders.notDelivered} not yet delivered)` },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });
  autoTable(doc, {
    startY: y + 2,
    head: [t.head],
    body: t.groups.map((l) => l.cells),
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 62 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right', cellWidth: 20 } },
    margin: { left: margin, right: margin },
    didParseCell: (data) => {
      const line = t.groups.at(data.row.index);
      if (data.section !== 'body' || !line) return;
      if (line.kind === 'total') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.lineWidth = { top: 0.2, bottom: 0, left: 0, right: 0 }; }
    },
  });
  const afterGroups = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  autoTable(doc, {
    startY: afterGroups,
    head: [['', 'Amount', '']],
    body: t.summary.map((l) => [l.label, fmtPerf(l.amountSen), l.note ?? '']),
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: { 0: { cellWidth: 118 }, 1: { halign: 'right', cellWidth: 34 }, 2: { cellWidth: 30 } },
    margin: { left: margin, right: margin },
    didParseCell: (data) => {
      const line = t.summary.at(data.row.index);
      if (data.section !== 'body' || !line) return;
      if (line.kind === 'total') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.lineWidth = { top: 0.2, bottom: 0, left: 0, right: 0 }; }
      if (line.kind === 'net') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.lineWidth = { top: 0.4, bottom: 0.4, left: 0, right: 0 }; }
    },
  });
  let ny = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? afterGroups) + 8;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90);
  for (const note of t.notes) {
    const wrapped = doc.splitTextToSize(`• ${note}`, pageW - margin * 2) as string[];
    if (ny + wrapped.length * 4 > doc.internal.pageSize.getHeight() - 14) { doc.addPage(); ny = margin; }
    doc.text(wrapped, margin, ny);
    ny += wrapped.length * 4 + 1.5;
  }
  doc.setTextColor(0);
  deliverPdf(doc, `performance-pnl-${r.from}-to-${r.to}.pdf`, opts?.action ?? 'preview');
}
