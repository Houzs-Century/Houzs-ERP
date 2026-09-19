// ----------------------------------------------------------------------------
// rp-report-pdf — "Print" for the Cash Flow report (Receipts & Payments until
// 2026-09-18). It prints WHAT THE SCREEN SHOWS: the same columns (Total, plus
// the accounts ticked on the screen), the same rows, the same four balance
// lines — so the paper and the screen can never disagree. Landscape A4 on
// the shared letterhead, the autoTable dress every document wears.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, type PdfAction,
} from './pdf-common';
import type { RpReport } from './rp-report-queries';
import { fmtSenPlain } from '../../shared/format';
import { flattenLaid, fmtPct, type LaidNode } from './report-layout';

/** 1,234.56 with a bracketed negative — the Finance reports' one money dress (fmtSenPlain). */
export const fmtRp = (sen: number): string => fmtSenPlain(sen);

type Line = { kind: 'section' | 'row' | 'category' | 'balance'; label: string; cells: string[] };

/** The table exactly as drawn — pure, so a test reads it without a PDF. The
    rows are the report's tree (docs/bugs/0912): a category with its
    per-column subtotal, its rows indented beneath, % of the side's total
    last; the balance lines carry the side's own %. */
export function rpTable(r: RpReport, shown?: string[]): { head: string[]; lines: Line[] } {
  /* The columns the screen shows: Total alone unless accounts were ticked. */
  const columns = shown ? r.columns.filter((c) => shown.includes(c.code)) : r.columns;
  const codes = columns.map((c) => c.code);
  const head = ['', ...columns.map((c) => `${c.code}\n${c.name}`), 'Total', '%'];
  const treeLines = (nodes: LaidNode[]): Line[] => flattenLaid(nodes).map(({ node, depth }) => ({
    kind: node.kind === 'account' ? 'row' : 'category',
    label: `${'   '.repeat(Math.max(0, depth - 1))}${node.label}`,
    cells: [...codes.map((c) => fmtRp(node.cells?.[c] ?? 0)), fmtRp(node.amountSen), fmtPct(node.pct)],
  }));
  const balance = (label: string, per: Record<string, number>, total: number, pct: string): Line =>
    ({ kind: 'balance', label, cells: [...codes.map((c) => fmtRp(per[c] ?? 0)), fmtRp(total), pct] });
  const blank = codes.map(() => '').concat('', '');
  const lines: Line[] = [];
  for (const n of r.layout.tree) {
    if (n.kind === 'subtotal') { lines.push(balance(n.label, n.cells ?? {}, n.amountSen, '')); continue; }
    lines.push({ kind: 'section', label: n.label, cells: blank });
    lines.push(...treeLines(n.children));
    lines.push(balance(n.totalLabel ?? `Total ${n.label}`, n.cells ?? {}, n.amountSen, fmtPct(n.pct)));
  }
  const surplusPer = Object.fromEntries(r.columns.map((c) => [c.code, (r.totals.receipts[c.code] ?? 0) - (r.totals.payments[c.code] ?? 0)]));
  lines.push(balance('Cash Surplus / (Deficit)', surplusPer, r.totals.receiptsTotalSen - r.totals.paymentsTotalSen, ''));
  lines.push(balance('Balance b/f', r.opening, r.totals.openingTotalSen, ''));
  lines.push(balance('Balance c/f', r.totals.closing, r.totals.closingTotalSen, ''));
  return { head, lines };
}

export async function generateRpPdf(r: RpReport, opts?: { action?: PdfAction; columns?: string[] }): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await ensurePdfCjkFont(doc, [...r.receipts, ...r.payments, ...flattenLaid(r.layout.tree).map((x) => x.node)]);
  const y = drawHeader(doc, {
    docTitle: 'CASH FLOW',
    rightMeta: [
      { label: 'Period', value: `${fmtDocDate(r.from)} – ${fmtDocDate(r.to)}` },
      { label: 'Accounts', value: r.columns.map((c) => c.code).join(', ') },
      { label: 'Rows', value: r.byParty ? 'By debtor / creditor' : "By the owner's accounts" },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });
  const t = rpTable(r, opts?.columns);
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
      if (line.kind === 'section' || line.kind === 'category') data.cell.styles.fontStyle = 'bold';
      if (line.kind === 'balance') { data.cell.styles.fontStyle = 'bold'; data.cell.styles.lineWidth = { top: 0.2, bottom: 0, left: 0, right: 0 }; }
    },
  });
  deliverPdf(doc, `cash-flow-${r.from}-to-${r.to}.pdf`, opts?.action ?? 'preview');
}
