// bill-pile-sort — which read pages of the pile are receipts, which are not
// bills at all, and which repeat a receipt already in the pile.
//
// Owner 2026-11-03 (我要claim 3,427.29，但是读出来怪怪的): a staff claim PDF,
// split by page, put its summary pages and its bank transfer slips in the pile
// as bills — each slip restating the receipts behind it — and a Grab receipt
// printed on two pages counted twice. The reader now says what each page IS;
// this module turns that into the pile's three heaps. The person can still
// overrule any of it: nothing here deletes a page.

import type { BillExtraction, ExtractedBill } from './payment-voucher-queries';

type OkBill = Extract<ExtractedBill, { ok: true }>;

/** A page the reader says only proves a payment or lists other receipts. */
export const isNotABill = (ex: Pick<BillExtraction, 'documentKind'>): boolean =>
  ex.documentKind === 'payment_proof' || ex.documentKind === 'summary';

export const NOT_A_BILL_LABEL: Record<string, string> = {
  payment_proof: 'payment slip',
  summary: 'summary / listing',
};

const foldNo = (s: string | null): string => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** bill index → the EARLIER bill it repeats: the same printed number at the
    same total (a receipt that runs two pages, each page read as a bill). A
    bill without a number or a total repeats nothing — two cash receipts of
    RM 10 are two receipts. */
export function repeatsOf(bills: OkBill[]): Map<number, number> {
  const first = new Map<string, number>();
  const out = new Map<number, number>();
  for (const b of [...bills].sort((x, y) => x.index - y.index)) {
    if (isNotABill(b.extraction)) continue;
    const no = foldNo(b.extraction.invoiceNumber);
    if (!no || b.extraction.totalSen == null) continue;
    const key = `${no}|${b.extraction.totalSen}`;
    const seen = first.get(key);
    if (seen == null) first.set(key, b.index);
    else out.set(b.index, seen);
  }
  return out;
}

export type VoucherLine = { description: string | null; amountSen: number | null };

/** The voucher lines ONE receipt contributes to a petty-cash voucher: one
    line at the receipt's total, described by what was bought — or, for a page
    of several separate purchases, one line per purchase. */
export function voucherLinesOf(ex: BillExtraction, fallback: string): VoucherLine[] {
  const charged = ex.lines.filter((l) => l.description && l.amountSen != null && l.amountSen > 0);
  if (ex.severalReceipts && charged.length > 1) {
    return charged.map((l) => ({ description: l.description!.trim().slice(0, 200), amountSen: l.amountSen }));
  }
  const bought = charged.map((l) => l.description!.trim()).filter(Boolean).join(' · ');
  return [{ description: bought ? bought.slice(0, 200) : fallback, amountSen: ex.totalSen }];
}
