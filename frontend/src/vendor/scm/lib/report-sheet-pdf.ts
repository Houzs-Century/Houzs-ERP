// ----------------------------------------------------------------------------
// report-sheet-pdf — a Finance report's sheet on paper, the way the screen
// draws it (owner 2026-09-19: export 出来 … pdf 不好看，就应该和原本的一样): the
// shared letterhead, the title and period, the same columns and rows — a
// block title bold, a category bold, an account row indented by its depth,
// an unassigned row italic, a total row shaded with a rule above, a
// subtotal (net) row shaded darker with a heavier rule — the screen's own
// shades. On By month a % that rides beside its amount prints under it in
// the same cell, so 累计 and twelve months still fit one landscape page.
// Portrait for a narrow statement, landscape for a wide one.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont, fmtDocStamp, type PdfAction,
} from './pdf-common';
import { fmtSenPlain } from '../../shared/format';
import { sheetText, type ReportSheet, type SheetRowKind, type SheetTable } from './report-sheet';

/** A printed column: which sheet columns it carries (an amount and the % beside it), and whether a rule follows it. */
export type PrintedColumn = { label: string; cols: number[]; edge: boolean };

/** The columns as printed: a % that rides beside an amount merges into its cell, one line under the other. */
export const printedColumns = (t: SheetTable): PrintedColumn[] => {
  const out: PrintedColumn[] = [];
  t.columns.forEach((c, i) => {
    if (c.beside && out.length > 0) {
      const last = out[out.length - 1];
      last.cols.push(i);
      if (c.edge) last.edge = true;
      return;
    }
    out.push({ label: c.label, cols: [i], edge: Boolean(c.edge) });
  });
  return out;
};

/** The table exactly as printed — pure, so a test reads it without a PDF. */
export function printedTable(t: SheetTable, fmt: (sen: number) => string = fmtSenPlain): { head: string[]; body: string[][]; printed: PrintedColumn[] } {
  const printed = printedColumns(t);
  const head = ['', ...printed.map((p) => p.label)];
  const body = t.rows.map((r) => [
    r.label,
    ...printed.map((p) => (r.cells.length === 0 ? '' : p.cols.map((ci) => sheetText(t.columns[ci]!, r.cells[ci] ?? null, fmt)).join('\n'))),
  ]);
  return { head, body, printed };
}

export type PrintedStyle = { bold: boolean; italic: boolean; soft: boolean; fill: [number, number, number] | null; rule: number };

/** A row's dress on paper — the screen's own: bold, a fill, a rule above. */
export const printedStyle = (kind: SheetRowKind): PrintedStyle => {
  switch (kind) {
    case 'block': return { bold: true, italic: false, soft: false, fill: null, rule: 0 };
    case 'category': return { bold: true, italic: false, soft: false, fill: null, rule: 0 };
    case 'unassigned': return { bold: false, italic: true, soft: true, fill: null, rule: 0 };
    case 'total': return { bold: true, italic: false, soft: false, fill: [236, 238, 234], rule: 0.2 };
    case 'net': return { bold: true, italic: false, soft: false, fill: [227, 230, 224], rule: 0.4 };
    default: return { bold: false, italic: false, soft: false, fill: null, rule: 0 };
  }
};

/** Landscape once a table prints more than four figure columns. */
export const isLandscape = (sheet: ReportSheet): boolean => sheet.tables.some((t) => printedColumns(t).length > 4);

type Lines = { top: number; right: number; bottom: number; left: number };
const lines = (over: Partial<Lines>): Lines => ({ top: 0, right: 0, bottom: 0, left: 0, ...over });

export async function generateReportPdf(sheet: ReportSheet, opts: { fileName: string; action?: PdfAction }): Promise<void> {
  const landscape = isLandscape(sheet);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' });
  await ensurePdfCjkFont(doc, { title: sheet.title, subtitle: sheet.subtitle, meta: sheet.meta, tables: sheet.tables, notes: sheet.notes ?? [] });
  const fmt = sheet.fmt ?? fmtSenPlain;
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const avail = pageW - margin * 2;
  let y = drawHeader(doc, {
    docTitle: sheet.title.toUpperCase(),
    rightMeta: [...sheet.meta, { label: 'Printed', value: fmtDocStamp() }],
  });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
  doc.text(sheet.subtitle, margin, y + 2, { maxWidth: avail });
  doc.setTextColor(0);
  y += 7;

  for (const t of sheet.tables) {
    const p = printedTable(t, fmt);
    const n = p.printed.length;
    const fontSize = n <= 4 ? 8.5 : n <= 8 ? 7.5 : 6.5;
    const figureW = landscape ? (n > 8 ? 16.5 : 22) : 30;
    const labelW = Math.max(55, Math.min(landscape ? 95 : 110, avail - n * figureW));
    autoTable(doc, {
      startY: y,
      head: [p.head],
      body: p.body,
      theme: 'plain',
      rowPageBreak: 'avoid',
      styles: { ...DOC_TABLE_STYLES, fontSize, cellPadding: { top: 1.2, bottom: 1.2, left: 2, right: 2 } },
      headStyles: { ...DOC_TABLE_HEAD_STYLES, halign: 'right' },
      columnStyles: { 0: { cellWidth: labelW, halign: 'left' }, ...Object.fromEntries(p.printed.map((_, i) => [i + 1, { halign: 'right' as const }])) },
      margin: { left: margin, right: margin },
      didParseCell: (data) => {
        const pc = data.column.index > 0 ? p.printed[data.column.index - 1] : null;
        if (data.section === 'head') {
          if (data.column.index === 0) data.cell.styles.halign = 'left';
          return;
        }
        const row = t.rows.at(data.row.index);
        if (!row) return;
        const s = printedStyle(row.kind);
        if (s.bold) data.cell.styles.fontStyle = 'bold';
        if (s.italic) data.cell.styles.fontStyle = 'italic';
        if (s.soft) data.cell.styles.textColor = 120;
        if (s.fill) data.cell.styles.fillColor = s.fill;
        const edge = pc?.edge ? { right: 0.4 } : {};
        if (s.rule > 0 || pc?.edge) data.cell.styles.lineWidth = lines({ top: s.rule, ...edge });
        if (data.column.index === 0) {
          data.cell.styles.cellPadding = { top: row.kind === 'block' ? 3.5 : 1.2, bottom: 1.2, left: 2 + 3 * row.depth, right: 2 };
        }
      },
    });
    y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  }

  if (sheet.notes && sheet.notes.length > 0) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90);
    for (const note of sheet.notes) {
      const wrapped = doc.splitTextToSize(`• ${note}`, avail) as string[];
      if (y + wrapped.length * 4 > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
      doc.text(wrapped, margin, y);
      y += wrapped.length * 4 + 1.5;
    }
    doc.setTextColor(0);
  }
  deliverPdf(doc, opts.fileName, opts.action ?? 'preview');
}
