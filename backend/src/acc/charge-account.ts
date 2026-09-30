/* Where a bank charge may go, and the charge kept off a CREDIT.

   Two kinds of charge share this: the one the bank deducts from a payment
   ADVICE day (acc/payout-charge, Public Bank's RM 324, docs/bugs/0787) and the
   one an acquirer keeps off a bank credit when it sends no advice at all
   (GHL's RM 54, owner 2026-09-30). Both book Dr <the chosen expense> / Cr the
   acquirer's transit under source SETTLECHARGE, and both ask the same four
   questions of the account. A leaf module on purpose: the receipt poster
   (acc/settlement) and the advice poster both read it, and neither imports
   the other through here. */

import { postJournal, reverseJournal } from './engine';
import type { postSoPayment } from './payments';

/* Borrowed from the poster rather than spelled out again — a new file's lint
   ceiling is zero, and a second name for the same client would be worse. */
type Db = Parameters<typeof postSoPayment>[0];

export const CHARGE_SOURCE = 'SETTLECHARGE';

/** The reason the account was refused — one sentence, shown as it is. */
export type BadAccount = { ok: false; status: 'bad_account'; reason: string };

/**
 * May the gate post an expense here? The FOUR refusals the merchant fee account
 * already answers with, in the same words, because it is the same question:
 * in this company's chart, switched on, an expense, and a leaf.
 */
export async function checkExpenseLeaf(
  sb: Db, companyId: number, code: string, what: string,
): Promise<{ ok: true } | BadAccount | { ok: false; status: 'load_failed'; reason: string }> {
  const { data: acct, error: aErr } = await sb.from('accounts')
    .select('account_code, account_type, is_active').eq('company_id', companyId).eq('account_code', code).maybeSingle();
  if (aErr) return { ok: false, status: 'load_failed', reason: aErr.message };
  const a = acct as { account_type?: string; is_active?: boolean } | null;
  if (!a) return { ok: false, status: 'bad_account', reason: `${code} is not in this company's chart.` };
  if (a.is_active === false) return { ok: false, status: 'bad_account', reason: `${code} is switched off in this company's chart, so nothing could be booked to it.` };
  if (a.account_type !== 'EXPENSE') return { ok: false, status: 'bad_account', reason: `${code} is ${String(a.account_type ?? 'not an expense account')} — ${what} is an expense.` };
  const { data: kids, error: kErr } = await sb.from('accounts')
    .select('account_code').eq('company_id', companyId).eq('parent_code', code).limit(1);
  if (kErr) return { ok: false, status: 'load_failed', reason: kErr.message };
  if (((kids ?? []) as unknown[]).length > 0) return { ok: false, status: 'bad_account', reason: `${code} has sub-accounts, so nothing posts to it directly. Pick one of them.` };
  return { ok: true };
}

/* ── A charge kept off a CREDIT (owner 2026-09-30: 这个RM54 是charges 来的，和
   之前的public bank一样 → 做) ──────────────────────────────────────────────
   GHL paid RM 3,128.40 for a report netting RM 3,182.40 and sends no advice, so
   there is no advice day to hang the RM 54.00 on. The charge belongs to the
   bank CREDIT it was kept from: the receipt row (migration 20260930T1030). The
   same journal as the advice day's, the same four account refusals, dated the
   report's settlement day as the advice charge is; keyed SETTLECHARGE-R<receipt>
   so the two kinds of key never collide. The receipt poster (acc/settlement)
   calls these — a credit and the charge kept off it are booked, and undone,
   together. */

/** The journal key of the charge kept off one credit. */
export const receiptChargeKey = (receiptId: number): string => `${CHARGE_SOURCE}-R${receiptId}`;

export type ReceiptChargeInput = { amountSen: number; accountCode: string; note: string };

/** What a kept charge must be before anything is written: said what it is for,
    a positive amount, and an expense leaf of this company. */
export async function checkReceiptCharge(
  sb: Db, companyId: number, input: ReceiptChargeInput,
): Promise<{ ok: true; charge: ReceiptChargeInput } | { ok: false; status: string; reason: string }> {
  const note = String(input.note ?? '').trim();
  if (!note) return { ok: false, status: 'note_required', reason: 'Say what the bank kept this for — the ledger and the corrections report print it.' };
  const amountSen = Math.round(Number(input.amountSen));
  if (!Number.isFinite(amountSen) || amountSen <= 0) {
    return { ok: false, status: 'bad_amount', reason: 'Give the amount the bank kept, more than zero.' };
  }
  const accountCode = String(input.accountCode ?? '').trim();
  const okAccount = await checkExpenseLeaf(sb, companyId, accountCode, 'a bank charge');
  if (!okAccount.ok) return okAccount;
  return { ok: true, charge: { amountSen, accountCode, note } };
}

/** Book the charge kept off one credit: Dr the chosen expense / Cr the acquirer's transit. */
export async function postReceiptCharge(
  sb: Db, companyId: number,
  p: { receiptId: number; acquirerCode: string; transitAccountCode: string; settledOn: string; receivedOn: string; charge: ReceiptChargeInput },
): Promise<{ ok: true; jeNo: string; jeId: string } | { ok: false; status: string; reason: string }> {
  const posted = await postJournal(sb, {
    companyId,
    entryDate: p.settledOn,
    sourceType: CHARGE_SOURCE,
    sourceDocNo: receiptChargeKey(p.receiptId),
    narration: `${p.acquirerCode} charge kept off the ${p.receivedOn} payout — ${p.charge.note}`,
    lines: [
      { accountCode: p.charge.accountCode, debitSen: p.charge.amountSen, creditSen: 0, partyType: null, partyCode: null, partyName: null, notes: p.charge.note },
      { accountCode: p.transitAccountCode, debitSen: 0, creditSen: p.charge.amountSen, partyType: null, partyCode: null, partyName: null, notes: `Kept by ${p.acquirerCode} off the ${p.receivedOn} payout` },
    ],
  });
  if (!posted.ok) return { ok: false, status: posted.status, reason: posted.reason ?? 'the posting gate refused the entry' };
  return { ok: true, jeNo: posted.jeNo, jeId: posted.jeId };
}

/** Take the charge kept off one credit back out: the contra sits on the
    charge's own day, so the pair nets to zero in the month it was booked. */
export async function undoReceiptCharge(
  sb: Db, companyId: number, receiptId: number,
): Promise<{ ok: true } | { ok: false; status: string; reason: string }> {
  const undone = await reverseJournal(sb, {
    sourceType: CHARGE_SOURCE,
    sourceDocNo: receiptChargeKey(receiptId),
    companyId,
    onOriginalDate: true,
    narration: (o) => `Reversal of ${o.je_no} — the charge kept off that credit is undone with it`,
  });
  if (!undone.ok) return { ok: false, status: undone.status, reason: undone.reason ?? 'the reversal did not post' };
  return { ok: true };
}
