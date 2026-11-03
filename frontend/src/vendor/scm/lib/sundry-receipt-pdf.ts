// ----------------------------------------------------------------------------
// sundry-receipt-pdf — a sundry income receipt on paper (the owner's Claude
// Design, batch 5 §9; no print existed before): the A4 RECEIPT
// (receipt-a4-pdf.ts) — who paid, the receipt's number, date, the account
// the money went into and its journal; each line's description and amount
// (the account it credits stays off the paper — an unnamed line reads as its
// account's name); a voided receipt prints VOID.
// ----------------------------------------------------------------------------

import { generateA4ReceiptsPdf, type A4ReceiptPaper } from './receipt-a4-pdf';
import { fmtDocDate, safeName, type PdfAction } from './pdf-common';

export type SundryReceiptPdfData = {
  receipt: {
    receipt_number: string; payer_name: string; receipt_date: string; bank_account_code: string;
    total_sen: number; status: string; notes: string | null;
  };
  lines: Array<{ description: string | null; credit_account_code: string; amount_sen: number }>;
  /** The chart's name for an account — the money account's, and a blank line's. */
  accountName?: (code: string) => string | null | undefined;
  /** Its journal, when the page has read it. */
  journalNo?: string | null;
};

/** The sundry receipt as the A4 RECEIPT draws it. */
export function sundryReceiptPaper(d: SundryReceiptPdfData): A4ReceiptPaper {
  const r = d.receipt;
  const voided = r.status.toUpperCase() === 'CANCELLED';
  const named = (code: string): string => {
    const name = d.accountName?.(code);
    return name ? `${code} ${name}` : code;
  };
  return {
    number: r.receipt_number,
    date: r.receipt_date,
    from: [['Name', r.payer_name]],
    details: [
      ['Receipt No', r.receipt_number],
      ['Date', fmtDocDate(r.receipt_date)],
      ['Received into', named(r.bank_account_code)],
      ['Journal', d.journalNo ?? null],
      ['Status', voided ? 'Voided' : 'Posted'],
    ],
    lines: d.lines.map((l) => ({
      description: l.description?.trim() ? l.description.trim() : (d.accountName?.(l.credit_account_code) ?? '—'),
      amountSen: Number(l.amount_sen),
    })),
    totalSen: Number(r.total_sen),
    note: r.notes,
    watermark: voided ? 'VOID' : null,
    fileStem: `${r.receipt_number}-${safeName(r.payer_name)}`,
  };
}

export async function generateSundryReceiptPdf(d: SundryReceiptPdfData, opts?: { action?: PdfAction }): Promise<void> {
  await generateA4ReceiptsPdf([sundryReceiptPaper(d)], opts);
}
