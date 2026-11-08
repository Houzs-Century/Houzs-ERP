// ----------------------------------------------------------------------------
// pv-pay-to — the bank a voucher pays into, in three fields of its own (owner
// 2026-11-08: 「pv notes 我不想要全部挤在一排，然后把notes 换成description」).
// The voucher form fills them from the supplier (Supplier maintenance) or from
// the payment request; they change until the voucher is checked (the server's
// pvCanEdit); the Description says only what the money is for.
// ----------------------------------------------------------------------------

export type PayTo = { bank: string; accountNo: string; accountName: string };
export const NO_PAY_TO: PayTo = { bank: '', accountNo: '', accountName: '' };

type BankShape = { bank_name?: string | null; bank_account_no?: string | null; bank_account_name?: string | null } | null | undefined;
const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A supplier's or a payment request's bank. */
export const payToOf = (r: BankShape): PayTo => ({
  bank: clean(r?.bank_name), accountNo: clean(r?.bank_account_no), accountName: clean(r?.bank_account_name),
});

/** The bank a saved voucher pays into, as the server reads it: its own, else its request's, else its supplier's. */
export const payToOfVoucher = (v: Record<string, unknown>): PayTo => ({
  bank: clean(v.pay_bank), accountNo: clean(v.pay_account_no), accountName: clean(v.pay_account_name),
});

export const isBlankPayTo = (p: PayTo): boolean => !p.bank.trim() && !p.accountNo.trim() && !p.accountName.trim();
export const samePayTo = (a: PayTo, b: PayTo): boolean =>
  a.bank === b.bank && a.accountNo === b.accountNo && a.accountName === b.accountName;

/** What a save sends: each field trimmed, a blank as nothing. */
export const payToBody = (p: PayTo): { payToBankName: string | null; payToAccountNo: string | null; payToAccountName: string | null } => ({
  payToBankName: p.bank.trim() || null,
  payToAccountNo: p.accountNo.trim() || null,
  payToAccountName: p.accountName.trim() || null,
});
