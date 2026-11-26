
import { generateA4ReceiptsPdf, type A4ReceiptPaper } from './receipt-a4-pdf';
import { fmtDocDate, safeName, type PdfAction } from './pdf-common';
import { partyAddressLines, type DebtorPartyColumns } from './debtor-party';

export type DebtorReceiptPdfData = {
  receipt: {
    receipt_number: string; receipt_date: string; bank_account_code: string; total_sen: number; status: string;
    submitted_at: string | null; checked_at: string | null; notes: string | null;
  };
  debtor: ({ name: string; phone: string | null } & Partial<DebtorPartyColumns>) | null;
  bills: Array<{ billNumber: string | null; description: string | null; amountSen: number }>;
  accountName?: (code: string) => string | null | undefined;
  journalNo?: string | null;
};

const stageOf = (r: DebtorReceiptPdfData['receipt']): string => {
  const status = r.status.toUpperCase();
  if (status === 'CANCELLED') return 'Cancelled';
  if (status === 'POSTED') return 'Approved';
  return r.checked_at ? 'Checked' : r.submitted_at ? 'Prepared' : 'Draft';
};

/** The debtor receipt as the A4 RECEIPT draws it. */
export function debtorReceiptPaper(d: DebtorReceiptPdfData): A4ReceiptPaper {
  const r = d.receipt;
  const status = r.status.toUpperCase();
  const debtor = d.debtor;
  const name = d.accountName?.(r.bank_account_code);
  const address = debtor ? partyAddressLines(debtor) : [];
  const note = String(r.notes ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[rejected]')).join(' · ');
  return {
    number: r.receipt_number,
    date: r.receipt_date,
    from: [
      ['Name', debtor?.name ?? '—'],
      ['Account', debtor?.code ?? null],
      ...address.map((line, i): [string, string] => [i === 0 ? 'Address' : ' ', line]),
      ['Phone', debtor ? [debtor.phone, debtor.mobile].filter((p) => p?.trim()).join(' / ') || null : null],
      ['Email', debtor?.email ?? null],
      ['Reg No', debtor?.business_reg_no ?? null],
    ],
    details: [
      ['Receipt No', r.receipt_number],
      ['Date', fmtDocDate(r.receipt_date)],
      ['Received into', name ? `${r.bank_account_code} ${name}` : r.bank_account_code],
      ['Journal', d.journalNo ?? (status === 'POSTED' || status === 'CANCELLED' ? null : 'Written at approval')],
      ['Stage', stageOf(r)],
    ],
    lines: d.bills.map((b) => ({
      description: [`Payment for invoice ${b.billNumber ?? '—'}`, b.description?.trim()].filter(Boolean).join(' · '),
      amountSen: Number(b.amountSen),
    })),
    totalSen: Number(r.total_sen),
    note: note || null,
    watermark: status === 'CANCELLED' ? 'VOID' : status === 'POSTED' ? null : 'DRAFT',
    fileStem: `${r.receipt_number}-${safeName(debtor?.name ?? 'receipt')}`,
  };
}

export async function generateDebtorReceiptPdf(d: DebtorReceiptPdfData, opts?: { action?: PdfAction }): Promise<void> {
  await generateA4ReceiptsPdf([debtorReceiptPaper(d)], opts);
}
