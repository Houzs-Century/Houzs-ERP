// ----------------------------------------------------------------------------
// daily-bank-pdf — the Daily Bank board as a PDF (owner 2026-09-29: the
// sample's Get image / PNG / PDF). It prints the SAME table model the page
// and the image read (daily-bank-report.ts): the three totals, then a table
// per bank under its Bank Balance, the rows coloured as on screen. Landscape
// A4 on the shared letterhead; the CJK font rides along for 未标银行 or a
// Chinese payee.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont, fmtDocStamp, type PdfAction } from '../../vendor/scm/lib/pdf-common';
import { fmtSenPlain } from '../../vendor/shared/format';
import type { DailyBankBoard } from './accounting-phase1-queries';
import { DAILY_BANK_HEAD, DB_COLORS, boardDayLabel, boardTotalsLine, cellMoney, dailyBankSections, isDetailRow, rowColor } from './daily-bank-report';

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

export async function generateDailyBankPdf(board: DailyBankBoard, opts?: { action?: PdfAction }): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const sections = dailyBankSections(board);
  await ensurePdfCjkFont(doc, sections);
  let y = drawHeader(doc, {
    docTitle: 'BANK BALANCE AVAILABLE',
    rightMeta: [
      { label: 'Day', value: boardDayLabel(board.date) },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });
  doc.setFontSize(9);
  doc.setTextColor(...rgb(DB_COLORS.green));
  doc.text(boardTotalsLine(board), 14, y + 2);
  doc.setTextColor(0, 0, 0);
  y += 6;

  for (const sec of sections) {
    autoTable(doc, {
      startY: y,
      head: [
        [
          { content: sec.code ? `${sec.title}  ·  ${sec.code}` : sec.title, colSpan: 4, styles: { fillColor: rgb(DB_COLORS.sectionBg), fontStyle: 'bold', fontSize: 9.5 } },
          {
            content: sec.bankBalanceSen != null ? `Bank Balance  ${fmtSenPlain(sec.bankBalanceSen)}` : '',
            colSpan: 2,
            styles: { fillColor: rgb(DB_COLORS.sectionBg), fontStyle: 'bold', fontSize: 9.5, halign: 'right', textColor: rgb(sec.bankBalanceSen != null && sec.bankBalanceSen < 0 ? DB_COLORS.red : DB_COLORS.ink) },
          },
        ],
        [...DAILY_BANK_HEAD],
      ],
      /* A group's own words span the party, number and description columns; a line keeps its three. */
      body: sec.rows.map((r) => (isDetailRow(r.kind)
        ? [`· ${r.who}`, r.doc, r.description, cellMoney(r.receivedSen), cellMoney(r.paidSen), cellMoney(r.lastSen)]
        : [{ content: r.who, colSpan: 3 }, cellMoney(r.receivedSen), cellMoney(r.paidSen), cellMoney(r.lastSen)])),
      theme: 'plain',
      rowPageBreak: 'avoid',
      styles: { ...DOC_TABLE_STYLES, fontSize: 8 },
      headStyles: { ...DOC_TABLE_HEAD_STYLES, textColor: rgb(DB_COLORS.soft), fontSize: 7.5 },
      columnStyles: {
        0: { cellWidth: 52 },
        1: { cellWidth: 40 },
        3: { cellWidth: 28, halign: 'right' },
        4: { cellWidth: 28, halign: 'right' },
        5: { cellWidth: 30, halign: 'right' },
      },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const r = sec.rows.at(data.row.index);
        if (!r) return;
        const strong = r.kind === 'available' || r.kind === 'withTransit' || r.kind.endsWith('Head') || r.kind === 'bf';
        data.cell.styles.textColor = rgb(isDetailRow(r.kind) && (data.column.index === 1 || data.column.index === 2) ? DB_COLORS.soft : rowColor(r.kind));
        if (strong) data.cell.styles.fontStyle = 'bold';
        if (r.kind === 'available') data.cell.styles.fillColor = rgb(DB_COLORS.band);
        if (data.column.index === 3 && r.receivedSen != null) data.cell.styles.textColor = rgb(DB_COLORS.green);
        if (data.column.index === 4 && r.paidSen != null) data.cell.styles.textColor = rgb(DB_COLORS.red);
        if (data.column.index === 5 && (r.kind === 'available' || r.kind === 'withTransit') && (r.lastSen ?? 0) < 0) data.cell.styles.textColor = rgb(DB_COLORS.red);
      },
    });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 5;
  }
  doc.setFontSize(7.5);
  doc.setTextColor(...rgb(DB_COLORS.soft));
  doc.text('Live from the ledger — posted entries only. Pending = checked vouchers awaiting approval; transit money is shown, never counted as movable.', 14, y + 2);
  deliverPdf(doc, `daily-bank-${board.date}.pdf`, opts?.action ?? 'save');
}
