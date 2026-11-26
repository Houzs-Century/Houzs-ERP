// bill-pile-sort — which read pages of the pile are receipts, which are not
// bills at all, and which repeat a receipt already in the pile.
//
// Owner 2026-11-03 (我要claim 3,427.29，但是读出来怪怪的): a staff claim PDF,
// split by page, put its summary pages and its bank transfer slips in the pile
// as bills — each slip restating the receipts behind it — and a Grab receipt
// printed on two pages counted twice. The reader now says what each page IS;
// this module turns that into the pile's three heaps. The person can still
// overrule any of it: nothing here deletes a page.
//
// A CLAIM FORM IS THE CLAIM (owner 2026-11-16, Elise's claim — a form of 16
// rows, RM 5,494.66, its receipts behind it — read as "summary / listing" and
// set aside, nothing to open: 已经有 claim form 还是会读错就不应该). A form that
// itemises the claim, every row at its amount and the rows adding up to its
// total, is what is paid: its rows are the voucher's lines, and the receipts
// it lists are its evidence, not more lines. A listing without amounts, or
// whose rows do not reach its total, is still only a listing.

import type { BillExtraction, ExtractedBill } from './payment-voucher-queries';

type OkBill = Extract<ExtractedBill, { ok: true }>;

/** A claim form that itemises the claim: its rows carry amounts that add up
    to its total (a row whose amount could not be read leaves it short). */
export const isClaimForm = (ex: Pick<BillExtraction, 'documentKind' | 'lines' | 'totalSen'>): boolean => {
  if (ex.documentKind !== 'summary' || ex.totalSen == null || ex.totalSen <= 0) return false;
  const rows = ex.lines.filter((l) => l.amountSen != null);
  return rows.length > 0 && rows.reduce((s, l) => s + (l.amountSen ?? 0), 0) === ex.totalSen;
};

/** A page the reader says only proves a payment, or lists other receipts
    without itemising a claim of its own. */
export const isNotABill = (ex: Pick<BillExtraction, 'documentKind' | 'lines' | 'totalSen'>): boolean =>
  ex.documentKind === 'payment_proof' || (ex.documentKind === 'summary' && !isClaimForm(ex));

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
  if ((ex.severalReceipts || isClaimForm(ex)) && charged.length > 1) {
    return charged.map((l) => ({ description: l.description!.trim().slice(0, 200), amountSen: l.amountSen }));
  }
  const bought = charged.map((l) => l.description!.trim()).filter(Boolean).join(' · ');
  return [{ description: bought ? bought.slice(0, 200) : fallback, amountSen: ex.totalSen }];
}

/** A page set aside as a claim form's evidence: the form it belongs to, and
    the form's row it is the receipt for (1-based), or null when it is a page
    of the form's own file that no row names. */
export type ClaimEvidence = { claim: number; row: number | null };

/** bill index → the claim form it is evidence for. Each row of a claim form in
    the pile takes the earliest receipt not yet taken whose total is that row's
    amount; any other receipt cut from the form's own file (a PDF split by
    page) is the form's too — the form is what is claimed, so a page it does
    not list is never a line of its own unless a person says so. Receipts from
    other files that no row names stay receipts. `receipts` are the pages still
    counted (no payment slip, no repeat, no listing). */
export function claimEvidenceOf(receipts: OkBill[], sourceOf: (index: number) => string): Map<number, ClaimEvidence> {
  const inOrder = [...receipts].sort((x, y) => x.index - y.index);
  const claims = inOrder.filter((b) => isClaimForm(b.extraction));
  const out = new Map<number, ClaimEvidence>();
  if (claims.length === 0) return out;
  const loose = inOrder.filter((b) => !isClaimForm(b.extraction));
  for (const c of claims) {
    c.extraction.lines.forEach((l, i) => {
      if (l.amountSen == null || l.amountSen <= 0) return;
      const r = loose.find((b) => !out.has(b.index) && b.extraction.totalSen === l.amountSen);
      if (r) out.set(r.index, { claim: c.index, row: i + 1 });
    });
  }
  for (const b of loose) {
    if (out.has(b.index)) continue;
    const own = claims.find((c) => sourceOf(c.index) === sourceOf(b.index));
    if (own) out.set(b.index, { claim: own.index, row: null });
  }
  return out;
}
