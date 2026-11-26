// ----------------------------------------------------------------------------
// eventCommissionPdf — Event Commission on paper, from eventCommissionExport
// (owner 2026-11-16: 导出的效果不满意 — 排版): landscape A4 on the shared letterhead
// (it went to A3 at 6.5 pt once a table passed eight columns, every column the
// same width), each table under its title with the columns its reader has
// showing, each as wide as what is in it; a salesperson's name over their lines,
// their subtotal shaded, the total shaded darker over a rule; for each salesperson
// in turn, each from a new page under their name. "Page n of m" at the foot.
// ----------------------------------------------------------------------------

import autoTable from 'jspdf-autotable';
import type { ExportCell } from '../../components/dataTableLineExport';
import { fmtDocDate, type PdfAction } from '../../vendor/scm/lib/pdf-common';
import { LISTING_CELL, LISTING_MARGIN, closeListing, listingDress, openListing, type Rgb } from '../../vendor/scm/lib/listing-pdf';
import type { EcBlock, EcColumn, EcRowKind, EcSection } from './eventCommissionExport';
import { fmtRm } from './eventCommissionModel';

/** A cell as printed: money in Finance's bracketed format, a day year first. Words in a
    date column — a table's foot label when its first column is a date — print as they are. */
export const ecPrintedText = (c: EcColumn, v: ExportCell): string => {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && c.format === 'money') return fmtRm(Math.round(v * 100));
  if (c.format === 'date' && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(String(v))) return fmtDocDate(String(v));
  return String(v);
};

export type EcPrintedCell = string | { content: string; colSpan: number };
/** A block exactly as printed — pure, so a test reads the cells without a PDF: a line's
    empty cell a dash; a salesperson's name across the row; a foot's empty cells blank. */
export function ecPrintedBlock(b: EcBlock): { head: string[]; body: EcPrintedCell[][]; kinds: EcRowKind[]; right: boolean[] } {
  return {
    head: b.columns.map((c) => c.label),
    body: b.rows.map((row): EcPrintedCell[] => {
      if (row.kind === 'group') return [{ content: row.cells.find((v) => v != null && v !== '')?.toString() ?? '', colSpan: Math.max(1, b.columns.length) }];
      return b.columns.map((c, i) => {
        const t = ecPrintedText(c, row.cells[i] ?? null);
        return t === '' && (row.kind === 'row' || row.kind === 'memo' || row.kind === 'inner') ? '–' : t;
      });
    }),
    kinds: b.rows.map((row) => row.kind),
    right: b.columns.map((c) => c.align === 'right'),
  };
}

const FILL: Partial<Record<EcRowKind, Rgb>> = { subtotal: [241, 242, 238], total: [227, 230, 224] };
const fontFor = (columns: number): number => (columns <= 9 ? 7.5 : columns <= 13 ? 7 : 6.5);
const TOP = 16;

export async function generateEcPdf(sections: readonly EcSection[], opts: {
  meta: Array<{ label: string; value: string }>; subtitle: string; fileName: string; action?: PdfAction;
}): Promise<void> {
  const { doc, startY } = await openListing('EVENT COMMISSION', opts.meta, opts.subtitle, sections);
  const pageH = doc.internal.pageSize.getHeight();
  const width = doc.internal.pageSize.getWidth() - LISTING_MARGIN * 2;
  let y = startY;
  sections.forEach((s, si) => {
    if (s.newPage && si > 0) { doc.addPage(); y = TOP; }
    if (s.heading) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(0);
      doc.text(s.heading, LISTING_MARGIN, y + 2);
      y += 8;
    }
    for (const b of s.blocks) {
      if (y > pageH - 40) { doc.addPage(); y = TOP; }
      if (b.title) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(0);
        doc.text(b.title, LISTING_MARGIN, y);
        y += 4;
      }
      if (b.note) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90);
        const lines = doc.splitTextToSize(b.note, width) as string[];
        doc.text(lines, LISTING_MARGIN, y);
        doc.setTextColor(0);
        y += lines.length * 3.4;
      }
      const p = ecPrintedBlock(b);
      autoTable(doc, {
        ...listingDress(fontFor(b.columns.length)),
        startY: y,
        head: [p.head],
        body: p.body,
        tableWidth: b.narrow ? 'wrap' : 'auto',
        columnStyles: Object.fromEntries(p.right.map((right, i) => [i, { halign: right ? 'right' : 'left' }])),
        didParseCell: (d) => {
          if (d.section === 'head') { d.cell.styles.halign = p.right[d.column.index] ? 'right' : 'left'; return; }
          const kind = p.kinds.at(d.row.index);
          if (!kind) return;
          if (kind === 'group') { d.cell.styles.halign = 'left'; d.cell.styles.cellPadding = { ...LISTING_CELL, top: 3 }; }
          if (kind === 'group' || kind === 'subtotal' || kind === 'total') d.cell.styles.fontStyle = 'bold';
          if (kind === 'memo') d.cell.styles.textColor = 110;
          if ((kind === 'memo' || kind === 'inner') && d.column.index === 0) d.cell.styles.cellPadding = { ...LISTING_CELL, left: 4.5 };
          const fill = FILL[kind];
          if (fill) d.cell.styles.fillColor = fill;
          if (kind === 'total') d.cell.styles.lineWidth = { top: 0.3, right: 0, bottom: 0, left: 0 };
        },
      });
      y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 7;
    }
    if (s.notes.length > 0) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(90);
      for (const note of s.notes) {
        const lines = doc.splitTextToSize(note, width) as string[];
        if (y + lines.length * 3.4 > pageH - 14) { doc.addPage(); y = TOP; }
        doc.text(lines, LISTING_MARGIN, y);
        y += lines.length * 3.4 + 2;
      }
      doc.setTextColor(0);
    }
  });
  closeListing(doc, opts.fileName, opts.action);
}
