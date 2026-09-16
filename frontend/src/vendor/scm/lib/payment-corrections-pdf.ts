// ----------------------------------------------------------------------------
// payment-corrections-pdf — the printed Finance report of payment corrections.
//
// Owner 2026-09-10: a report of every customer-payment correction made on the
// amend right, with the reason typed at the time and what it did to the
// ledger; 2026-09-14 (docs/bugs/0888): every payment action by a role holding
// the right — added, edited, deleted, proof attached — beside who FIRST
// recorded the payment. Same shape as the bank reconciliation statement:
// every line of the document is decided in `correctionsDocument`, a pure
// function the test reads back without rendering a PDF;
// `generatePaymentCorrectionsPdf` only draws what that returns.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont, paperText,
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
  kind: 'added' | 'edited' | 'deleted' | 'proof';
  changes: Array<{ field: string; from: unknown; to: unknown }>;
  amountFromSen: number | null;
  amountToSen: number | null;
  reason: string;
  /** No reason because the row predates the rule (owner 2026-09-14: 规则之前). */
  beforeRule: boolean;
  /** Who first recorded the payment this row concerns, and when (ISO). */
  recordedBy: string | null;
  recordedOn: string | null;
  originalJeNo: string | null;
  contraJeNo: string | null;
  jeNo: string | null;
};

export type CorrectionsInput = {
  month: string;
  rows: CorrectionRowInput[];
  summary: {
    corrections: number; added: number; edited: number; deleted: number; proof: number;
    netMovedSen: number; addedSen: number; deletedSen: number;
  };
};

export type CorrectionsDocument = {
  title: string;
  monthText: string;
  /** The three figures the screen's cards show, as label/value pairs. */
  summary: Array<{ label: string; value: string }>;
  /** One line per action, in the report's column order: when + who / order +
      customer / what was done / who first recorded the payment / reason /
      ledger. */
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
  accountSheet: 'Account sheet', collectedBy: 'Collected by', slipKey: 'Proof',
};

const valueText = (field: string, v: unknown): string => {
  if (v == null || v === '') return '—';
  if (field === 'amountSen') return fmtRm(Number(v));
  if (field === 'paidAt') return fmtDocDate(String(v).slice(0, 10));
  return String(v);
};

const changeValue = (r: CorrectionRowInput, field: string): unknown =>
  r.changes.find((c) => c.field === field)?.to ?? null;

/** "Amount RM 1,990.00 → RM 1,991.00; Method cash → transfer" — or, for a
    delete, what was removed; for an add, what was recorded; for a proof,
    whether it was attached or replaced. */
export const whatChanged = (r: CorrectionRowInput): string => {
  if (r.kind === 'deleted') {
    return r.amountFromSen == null ? 'Deleted' : `Deleted — ${fmtRm(r.amountFromSen)} removed`;
  }
  if (r.kind === 'added') {
    if (r.amountToSen == null) return 'Added';
    const method = changeValue(r, 'method');
    const paidAt = changeValue(r, 'paidAt');
    const how = [
      typeof method === 'string' && method !== '' ? method : null,
      typeof paidAt === 'string' && paidAt !== '' ? `on ${fmtDocDate(paidAt.slice(0, 10))}` : null,
    ].filter((s): s is string => s !== null).join(' ');
    return `Added — ${fmtRm(r.amountToSen)}${how ? ` (${how})` : ''}`;
  }
  if (r.kind === 'proof') {
    const slip = r.changes.find((c) => c.field === 'slipKey');
    return slip && slip.from != null && slip.from !== '' ? 'Proof replaced' : 'Proof attached';
  }
  const parts = r.changes.map((c) => `${FIELD_WORDS[c.field] ?? c.field} ${valueText(c.field, c.from)} → ${valueText(c.field, c.to)}`);
  return parts.length > 0 ? parts.join('; ') : 'Edited';
};

/** Who first recorded the payment, and the day — "Rachael\n29/08/2026"; a
    dash when nothing could be read (never a guess). */
export const recordedText = (r: CorrectionRowInput): string => {
  if (!r.recordedBy && !r.recordedOn) return '—';
  const day = r.recordedOn ? fmtDocDate(r.recordedOn.slice(0, 10)) : null;
  return [r.recordedBy ?? '—', day].filter((s): s is string => s !== null).join('\n');
};

/** The reason given — or, on a row from before the rule, that there was
    nothing asked (owner 2026-09-14: 规则之前). */
export const reasonText = (r: CorrectionRowInput): string =>
  (r.reason ? r.reason : r.beforeRule ? 'Before the rule' : '—');

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

const signed = (sen: number): string => (sen < 0 ? `-${fmtRm(-sen)}` : sen > 0 ? `+${fmtRm(sen)}` : fmtRm(0));

/** The sentence an empty month prints and shows: what was LOOKED FOR, in the
    month named — never a claim about the business. */
export const emptyText = (month: string): string =>
  `No payment action on the correction right was found for ${monthText(month)}.`;

export function correctionsDocument(input: CorrectionsInput): CorrectionsDocument {
  const s = input.summary;
  return {
    title: 'PAYMENT CORRECTIONS',
    monthText: monthText(input.month),
    summary: [
      { label: 'Payment actions', value: String(s.corrections) },
      { label: 'Added / edited / deleted / proof', value: `${s.added} / ${s.edited} / ${s.deleted} / ${s.proof}` },
      { label: 'Money received, net effect', value: signed(s.netMovedSen) },
    ],
    lines: input.rows.map((r) => [
      `${fmtDocDate(r.at.slice(0, 10))}\n${r.by}`,
      `${r.docNo}${r.customer ? `\n${r.customer}` : ''}`,
      whatChanged(r),
      recordedText(r),
      reasonText(r),
      ledgerText(r),
    ].map(paperText)),
    empty: input.rows.length === 0 ? emptyText(input.month) : null,
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
      head: [['Done', 'Sales order', 'What', 'First recorded by', 'Reason', 'Ledger']],
      body: report.lines,
      styles: { ...DOC_TABLE_STYLES, fontSize: 8, cellPadding: 1.5, valign: 'top' },
      headStyles: DOC_TABLE_HEAD_STYLES,
      columnStyles: { 0: { cellWidth: 30 }, 1: { cellWidth: 44 }, 2: { cellWidth: 62 }, 3: { cellWidth: 40 }, 4: { cellWidth: 52 }, 5: { cellWidth: 39 } },
    });
  }

  deliverPdf(doc, `${safeName(`payment-corrections-${input.month}`)}.pdf`, opts?.action);
}
