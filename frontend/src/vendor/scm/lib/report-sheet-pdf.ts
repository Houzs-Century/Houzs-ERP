// ----------------------------------------------------------------------------
// report-sheet-pdf — a Finance report's sheet on paper, the way the screen
// draws it (owner 2026-09-19: export 出来 … pdf 不好看，就应该和原本的一样): the
// shared letterhead, the title and period, the same columns and rows — a
// block title bold, a category bold, an account row indented by its depth,
// an unassigned row italic, a total row shaded with a rule above, a
// subtotal (net) row shaded darker with a heavier rule — the screen's own
// shades. On By month a % that rides beside its amount prints BESIDE it in
// the same cell, small and grey, exactly as the screen has it (owner
// 2026-09-20: 百分比应该在数字旁边而不是下面). The paper grows with the table
// rather than the type shrinking: portrait A4 for a narrow statement,
// landscape A4 past four figure columns, landscape A3 past eight — so 累计
// and twelve months read at the same size as six.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont, fmtDocStamp, type PdfAction,
} from './pdf-common';
import { fmtSenPlain } from '../../shared/format';
import { sheetText, sheetWithTotalsBelow, type ReportSheet, type SheetRow, type SheetRowKind, type SheetTable } from './report-sheet';
import { PDF_COMPRESS } from './pdf-options';

/** A printed column: which sheet columns it carries (an amount and the % beside it), whether
    a rule follows it, and the heading it shares with the columns beside it. */
export type PrintedColumn = { label: string; cols: number[]; edge: boolean; group?: string; align?: 'left' | 'right' };

/** The columns as printed: a % that rides beside an amount merges into its cell. */
export const printedColumns = (t: SheetTable): PrintedColumn[] => {
  const out: PrintedColumn[] = [];
  t.columns.forEach((c, i) => {
    if (c.beside && out.length > 0) {
      const last = out[out.length - 1];
      last.cols.push(i);
      if (c.edge) last.edge = true;
      return;
    }
    out.push({ label: c.label, cols: [i], edge: Boolean(c.edge), ...(c.group ? { group: c.group } : {}), ...(c.align ? { align: c.align } : {}) });
  });
  return out;
};

/** Where a printed column's text sits: a column asked to read left to right, else right. */
const alignOf = (pc: PrintedColumn): 'left' | 'right' => (pc.align === 'left' ? 'left' : 'right');
/** A cell as autoTable takes it: its text, or its text running across columns or rows. */
export type PrintedCell = string | { content: string; colSpan?: number; rowSpan?: number; styles?: { halign: 'center' | 'left' } };

/** The table exactly as printed — pure, so a test reads it without a PDF.
    `head` is the columns' names; `headRows` the header as printed — that one row, or,
    where columns share a heading (the Cash Flow's month over Settlement | Deposit), the
    headings over their columns and the names under them. `body` is each cell's text (an
    amount alone where a % rides beside it; a figure running across columns, centred, as
    one cell); `beside` is that %, drawn small and grey to the amount's right, or null. */
export function printedTable(t: SheetTable, fmt: (sen: number) => string = fmtSenPlain): {
  head: string[]; headRows: PrintedCell[][]; body: PrintedCell[][]; beside: Array<Array<string | null>>; printed: PrintedColumn[];
} {
  const printed = printedColumns(t);
  const head = [t.labelHeader ?? '', ...printed.map((p) => p.label)];
  const cellText = (r: SheetRow, ci: number): string => sheetText(t.columns[ci]!, r.cells[ci] ?? null, fmt);
  /* A sheet column's printed column — a run of sheet cells becomes a run of printed ones. */
  const printedAt = new Map<number, number>();
  printed.forEach((p, pi) => p.cols.forEach((ci) => printedAt.set(ci, pi)));
  const body = t.rows.map((r): PrintedCell[] => {
    if (r.cells.length === 0) return [r.label, ...printed.map(() => '')];
    const runs = new Map<number, number>();
    for (const [at, n] of Object.entries(r.spans ?? {})) {
      const from = printedAt.get(Number(at));
      const to = printedAt.get(Number(at) + (n ?? 1) - 1);
      if (from !== undefined && to !== undefined && to > from) runs.set(from, to - from + 1);
    }
    const out: PrintedCell[] = [r.label];
    for (let pi = 0; pi < printed.length; pi += 1) {
      const text = cellText(r, printed[pi]!.cols[0]!);
      const n = runs.get(pi);
      if (n) { out.push({ content: text, colSpan: n, styles: { halign: 'center' } }); pi += n - 1; } else out.push(text);
    }
    return out;
  });
  const beside = t.rows.map((r) => [null, ...printed.map((p) => (r.cells.length === 0 || p.cols.length < 2 ? null : cellText(r, p.cols[1]!)))]);
  const columnHead = printed.some((p) => p.group) ? groupedHead(printed, t.labelHeader ?? '') : [head];
  /* A section's title on a row of its own above the header, across the table. */
  const titleRow: PrintedCell[][] = t.title ? [[{ content: t.title, colSpan: printed.length + 1, styles: { halign: 'left' } }]] : [];
  return { head, headRows: [...titleRow, ...columnHead], body, beside, printed };
}

/** The two header rows of columns under shared headings: the name column and a column
    without a heading stand two rows tall; a heading spans its columns, their names below. */
function groupedHead(printed: PrintedColumn[], name = ''): PrintedCell[][] {
  const top: PrintedCell[] = [{ content: name, rowSpan: 2 }];
  const under: PrintedCell[] = [];
  printed.forEach((p, i) => {
    if (!p.group) { top.push({ content: p.label, rowSpan: 2 }); return; }
    under.push(p.label);
    if (printed[i - 1]?.group === p.group) return;
    let n = 1;
    while (printed[i + n]?.group === p.group) n += 1;
    top.push({ content: p.group, colSpan: n, styles: { halign: 'center' } });
  });
  return [top, under];
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

/** The page a sheet prints on: portrait A4 for a narrow statement, landscape
    A4 once a table prints more than four figure columns, landscape A3 past
    eight — the paper grows, the type stays readable. */
export type PrintedPage = { format: 'a4' | 'a3'; orientation: 'portrait' | 'landscape'; fontSize: number; labelW: number };
export const pageFor = (sheet: ReportSheet): PrintedPage => {
  const widest = Math.max(0, ...sheet.tables.map((t) => printedColumns(t).length));
  if (widest <= 4) return { format: 'a4', orientation: 'portrait', fontSize: 8.5, labelW: Math.max(55, Math.min(110, 182 - widest * 30)) };
  if (widest <= 8) return { format: 'a4', orientation: 'landscape', fontSize: 7, labelW: 80 };
  return { format: 'a3', orientation: 'landscape', fontSize: 6.5, labelW: 70 };
};
export const isLandscape = (sheet: ReportSheet): boolean => pageFor(sheet).orientation === 'landscape';

type Lines = { top: number; right: number; bottom: number; left: number };
const lines = (over: Partial<Lines>): Lines => ({ top: 0, right: 0, bottom: 0, left: 0, ...over });

/* Points per millimetre — jsPDF's own k for unit 'mm'. */
const K = 72 / 25.4;
/* autoTable sets a top-aligned line's baseline this far below the padding, in font-size units. */
const BASELINE = 2 - 1.15;

export async function generateReportPdf(given: ReportSheet, opts: { fileName: string; action?: PdfAction }): Promise<void> {
  const sheet = sheetWithTotalsBelow(given);
  const page = pageFor(sheet);
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: page.format, orientation: page.orientation });
  await ensurePdfCjkFont(doc, { title: sheet.title, subtitle: sheet.subtitle, meta: sheet.meta, tables: sheet.tables, notes: sheet.notes ?? [] });
  const fmt = sheet.fmt ?? fmtSenPlain;
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const avail = pageW - margin * 2;
  /* A % beside its amount: a size and a half smaller, in the room `slot` keeps free at the cell's right. */
  const pctFont = page.fontSize - 1.5;
  const slot = page.fontSize * 1.05;
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
    /* Sideways, every figure column gets an equal share; upright, the widest content decides. */
    const figureW = page.orientation === 'landscape' && n > 0 ? (avail - page.labelW) / n : undefined;
    autoTable(doc, {
      startY: y,
      head: p.headRows,
      body: p.body,
      theme: 'plain',
      rowPageBreak: 'avoid',
      styles: { ...DOC_TABLE_STYLES, fontSize: page.fontSize, cellPadding: { top: 1.2, bottom: 1.2, left: 1.5, right: 1.5 } },
      headStyles: { ...DOC_TABLE_HEAD_STYLES, halign: 'right' },
      columnStyles: {
        0: { cellWidth: page.labelW, halign: 'left' },
        ...Object.fromEntries(p.printed.map((pc, i) => [i + 1, { halign: alignOf(pc), ...(figureW ? { cellWidth: figureW } : {}) }])),
      },
      margin: { left: margin, right: margin },
      didParseCell: (data) => {
        const pc = data.column.index > 0 ? p.printed[data.column.index - 1] : null;
        if (data.section === 'head') {
          if (data.column.index === 0) data.cell.styles.halign = 'left';
          else if (pc) data.cell.styles.halign = alignOf(pc);
          /* The section title: a size up, no rules, a little air above. */
          if (t.title && data.row.index === 0) {
            data.cell.styles.fontSize = page.fontSize + 1.5;
            data.cell.styles.lineWidth = 0;
            data.cell.styles.cellPadding = { top: 3, bottom: 1.2, left: 1.5, right: 1.5 };
          }
          return;
        }
        const row = t.rows.at(data.row.index);
        if (!row) return;
        const s = printedStyle(row.kind);
        if (s.bold) data.cell.styles.fontStyle = 'bold';
        if (s.italic) data.cell.styles.fontStyle = 'italic';
        if (s.soft) data.cell.styles.textColor = 120;
        if (s.fill) data.cell.styles.fillColor = s.fill;
        /* A cell running across columns takes the rule of the last one it covers. */
        const lastPc = pc && data.cell.colSpan > 1 ? p.printed[data.column.index - 2 + data.cell.colSpan] : pc;
        const edge = lastPc?.edge ? { right: 0.4 } : {};
        if (s.rule > 0 || lastPc?.edge) data.cell.styles.lineWidth = lines({ top: s.rule, ...edge });
        if (data.column.index === 0) {
          data.cell.styles.cellPadding = { top: row.kind === 'block' ? 3.5 : 1.2, bottom: 1.2, left: 1.5 + 3 * row.depth, right: 1.5 };
        } else if (pc && pc.cols.length > 1) {
          /* The amount keeps to the left of the slot the % is drawn in. */
          data.cell.styles.cellPadding = { top: 1.2, bottom: 1.2, left: 1.5, right: 1.5 + slot };
        }
      },
      didDrawCell: (data) => {
        if (data.section !== 'body' || data.column.index === 0) return;
        const text = p.beside.at(data.row.index)?.[data.column.index];
        const row = t.rows.at(data.row.index);
        if (!text || !row) return;
        const s = printedStyle(row.kind);
        /* On the amount's own baseline, small and grey, flush with the cell's right edge. */
        const baseline = data.cell.y + data.cell.padding('top') + (page.fontSize / K) * BASELINE;
        doc.setFont('helvetica', s.bold ? 'bold' : 'normal');
        doc.setFontSize(pctFont);
        doc.setTextColor(s.soft ? 150 : 110);
        doc.text(text, data.cell.x + data.cell.width - 1.5, baseline, { align: 'right' });
        doc.setTextColor(0);
        doc.setFontSize(page.fontSize);
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
