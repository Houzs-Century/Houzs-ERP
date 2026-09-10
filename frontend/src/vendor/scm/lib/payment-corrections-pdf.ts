// ----------------------------------------------------------------------------
// payment-corrections-pdf — the printed Finance report of payment corrections.
//
// Owner 2026-09-10: a report of every customer-payment correction made on the
// amend right, with the reason typed at the time and what it did to the
// ledger. Same shape as the bank reconciliation statement: every line of the
// document is decided in `correctionsDocument`, a pure function the test
// reads back without rendering a PDF; `generatePaymentCorrectionsPdf` only
// draws what that returns.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, safeName, type PdfAction,
} from './pdf-common';
/* Money reads 'RM 1,990.00' on this report, as it does on the screen and every
   other Finance page — pdf-common's fmtRm spells the ISO code ('MYR'), which
   is right on a document a supplier abroad may read and wrong here. */
import { fmtSen as fmtRm } from '../../shared/format';

/* What the report endpoint hands over, structurally — named here so the
   document can be built and tested without the page's query module. */
export type CorrectionRowInput = {
  at: string;
  by: string;
  docNo: string;
  customer: string | null;
  kind: 'edited' | 'deleted';
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  amountFromSen: number | null;
  amountToSen: number | null;
  reason: string;
  originalJeNo: string | null;
  contraJeNo: string | null;
  jeNo: string | null;
};

export type CorrectionsInput = {
  month: string;
  rows: CorrectionRowInput[];
  summary: { corrections: number; edited: number; deleted: number; netMovedSen: number; deletedSen: number };
};

export type CorrectionsDocument = {
  title: string;
  monthText: string;
  /** The three figures the screen's cards show, as label/value pairs. */
  summary: Array<{ label: string; value: string }>;
  /** One line per correction, in the report's column order:
      when + who / order + customer / what changed / reason / ledger. */
  lines: string[][];
  /** The sentence printed instead of a table when there is nothing to list. */
  empty: string | null;
};

/* The audit's field names, in the words the screen uses. Anything not listed
   prints as its raw name rather than being dropped — a field the report does
   not know is still a field that moved. */
const FIELD_WORDS: Record<string, string> = {
  amountSen: 'Amount', paidAt: 'Date', method: 'Method', merchantProvider: 'Bank',
  installmentMonths: 'Plan', onlineType: 'Sub-type', approvalCode: 'Approval code',
  accountSheet: 'Account sheet', collectedBy: 'Collected by',
};

const valueText = (field: string, v: unknown): string => {
  if (v == null || v === '') return '—';
  if (field === 'amountSen') return fmtRm(Number(v));
  if (field === 'paidAt') return fmtDocDate(String(v).slice(0, 10));
  return String(v);
};

/** "Amount RM 1,990.00 → RM 1,991.00; Method cash → transfer" — or, for a
    delete, what was removed. */
export const whatChanged = (r: CorrectionRowInput): string => {
  if (r.kind === 'deleted') {
    return r.amountFromSen == null ? 'Deleted' : `Deleted — ${fmtRm(r.amountFromSen)} removed`;
  }
  const parts = r.changes.map((c) => `${FIELD_WORDS[c.field] ?? c.field} ${valueText(c.field, c.from)} → ${valueText(c.field, c.to)}`);
  return parts.length > 0 ? parts.join('; ') : 'Edited';
};

/** Three numbers in the order the books moved: the ORIGINAL, the contra that
    voided it, the entry booked in its place —
    "0047 → reversed by 0099 → 0100". A delete stops at the reversal; a row
    that knows only the contra (the one legacy row) says "reversed by …" and
    never presents the contra as the original — that misreading is what this
    wording replaces (owner, 2026-09-10: 不明白; docs/bugs/0786). */
export const ledgerText = (r: CorrectionRowInput): string => {
  const parts: string[] = [];
  if (r.originalJeNo) parts.push(r.originalJeNo);
  if (r.contraJeNo) parts.push(`reversed by ${r.contraJeNo}`);
  if (r.jeNo) parts.push(parts.length > 0 ? r.jeNo : `booked ${r.jeNo}`);
  return parts.length > 0 ? parts.join(' → ') : '—';
};

export const monthText = (month: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[2]}/${m[1]}` : month;
};

const signed = (sen: number): string => (sen < 0 ? `−${fmtRm(-sen)}` : sen > 0 ? `+${fmtRm(sen)}` : fmtRm(0));

export function correctionsDocument(input: CorrectionsInput): CorrectionsDocument {
  const s = input.summary;
  return {
    title: 'PAYMENT CORRECTIONS',
    monthText: monthText(input.month),
    summary: [
      { label: 'Corrections', value: String(s.corrections) },
      { label: 'Edited / deleted', value: `${s.edited} / ${s.deleted}` },
      { label: 'Money received, net effect', value: signed(s.netMovedSen) },
    ],
    lines: input.rows.map((r) => [
      `${fmtDocDate(r.at.slice(0, 10))}\n${r.by}`,
      `${r.docNo}${r.customer ? `\n${r.customer}` : ''}`,
      whatChanged(r),
      r.reason || '—',
      ledgerText(r),
    ]),
    empty: input.rows.length === 0
      ? `No payment correction on the amend right was recorded for ${monthText(input.month)}.`
      : null,
  };
}

export async function generatePaymentCorrectionsPdf(
  input: CorrectionsInput, opts?: { action?: PdfAction },
): Promise<void> {
  const report = correctionsDocument(input);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await ensurePdfCjkFont(doc, report.lines.flat());

  let y = drawHeader(doc, {
    docTitle: report.title,
    rightMeta: [
      { label: 'Month', value: report.monthText },
      { label: 'Printed', value: fmtDocStamp() },
    ],
  });

  autoTable(doc, {
    startY: y + 2,
    body: report.summary.map((r) => [r.label, r.value]),
    theme: 'plain',
    styles: { ...DOC_TABLE_STYLES, fontSize: 10 },
    columnStyles: { 0: { cellWidth: 70 }, 1: { halign: 'right', cellWidth: 50 } },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  if (report.empty) {
    doc.setFontSize(10);
    doc.text(report.empty, 15, y + 8);
  } else {
    autoTable(doc, {
      startY: y + 4,
      head: [['Corrected', 'Sales order', 'What changed', 'Reason', 'Ledger']],
      body: report.lines,
      styles: { ...DOC_TABLE_STYLES, fontSize: 8, cellPadding: 1.5, valign: 'top' },
      headStyles: DOC_TABLE_HEAD_STYLES,
      columnStyles: { 0: { cellWidth: 32 }, 1: { cellWidth: 48 }, 2: { cellWidth: 70 }, 3: { cellWidth: 70 }, 4: { cellWidth: 46 } },
    });
  }

  deliverPdf(doc, `${safeName(`payment-corrections-${input.month}`)}.pdf`, opts?.action);
}
