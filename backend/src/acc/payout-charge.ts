/* A bank charge deducted from a day's payout, booked to the account Finance picks.

   Owner, 2026-09-10, on a PBB advice whose 2026-06-06 day said RM 3,024.18
   against a merchant report netting RM 3,348.18: 「我检查了好像是银行的卡机
   application fees 来的，我该如何做」— then 「可以让我点了后选这笔 324 进什么
   户口吗」. Until this, the advice screen reported the RM 324.00 difference and
   stopped: a receipt books only what the bank credited, so nothing could book
   the RM 324 and the acquirer's transit account would have stayed short by it
   for ever (docs/bugs/0787).

   The charge lives on the ADVICE DAY it was deducted from
   (`acc_settlement_payout_batches`, migration 20260910T1200): `statusOfPayout`
   reads those rows, and a day agrees when  report net = advice net + charge.
   The journal is
       Dr <the chosen expense account>   charge
       Cr <the acquirer's transit>       charge
   dated the SETTLEMENT day — the deduction happened then, not when the button
   was pressed — source SETTLECHARGE keyed on the day row. Undo reverses it
   through the engine and clears the row; nothing is deleted.

   Every read fails closed: a charge booked on a guess about the difference is
   money moved to the wrong place with a journal number on it. */

import { postJournal, reverseJournal } from './engine';
import { loadAcquirer } from './settlement';
import { postSoPayment } from './payments';

/* Borrowed from the poster rather than spelled out again — a new file's lint
   ceiling is zero, and a second name for the same client would be worse. */
type Db = Parameters<typeof postSoPayment>[0];
type Row = Record<string, unknown>;

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

export type ChargeInput = {
  payoutId: number;
  settledOn: string;
  /** Omitted = the whole difference. Must be > 0 and ≤ the difference. */
  amountSen?: number | null;
  accountCode: string;
  note: string;
  userName?: string | null;
};

export type ChargeResult =
  | { ok: true; status: 'charged'; chargeSen: number; accountCode: string; jeNo: string }
  | { ok: false; status: 'not_found' | 'report_missing' | 'nothing_to_charge' | 'already_charged' | 'over_difference' | 'bad_amount' | 'note_required' | 'bad_account' | 'load_failed' | string; reason: string };

/** The advice day and the report it is checked against, read together and
    scoped to the company on both — a day row is reachable only through its
    own company's payout. */
async function loadDay(sb: Db, companyId: number, payoutId: number, settledOn: string): Promise<
  | { ok: true; day: Row; payableSen: number | null; acquirerCode: string }
  | { ok: false; status: 'not_found' | 'load_failed'; reason: string }
> {
  const { data: payoutRaw, error: pErr } = await sb.from('acc_settlement_payouts')
    .select('id, acquirer_code').eq('id', payoutId).eq('company_id', companyId).maybeSingle();
  if (pErr) return { ok: false, status: 'load_failed', reason: pErr.message };
  if (!payoutRaw) return { ok: false, status: 'not_found', reason: `advice ${payoutId} not found` };
  const { data: dayRaw, error: dErr } = await sb.from('acc_settlement_payout_batches')
    .select('id, payout_id, settled_on, net_sen, batch_id, charge_sen, charge_account_code, charge_je_no')
    .eq('payout_id', payoutId).eq('company_id', companyId).eq('settled_on', settledOn).maybeSingle();
  if (dErr) return { ok: false, status: 'load_failed', reason: dErr.message };
  if (!dayRaw) return { ok: false, status: 'not_found', reason: `the advice names no settlement on ${settledOn}` };
  const day = dayRaw as Row;
  let payableSen: number | null = null;
  if (day.batch_id != null) {
    const { data: batchRaw, error: bErr } = await sb.from('acc_settlement_batches')
      .select('id, net_sen, stated_net_sen').eq('id', Number(day.batch_id)).eq('company_id', companyId).maybeSingle();
    if (bErr) return { ok: false, status: 'load_failed', reason: bErr.message };
    const b = batchRaw as { net_sen?: number | null; stated_net_sen?: number | null } | null;
    if (b) payableSen = Number(b.stated_net_sen ?? b.net_sen ?? 0);
  }
  return { ok: true, day, payableSen, acquirerCode: String((payoutRaw as Row).acquirer_code ?? '') };
}

export async function postPayoutCharge(sb: Db, companyId: number, input: ChargeInput): Promise<ChargeResult> {
  const note = String(input.note ?? '').trim();
  if (!note) return { ok: false, status: 'note_required', reason: 'Say what the bank deducted this for — the corrections report prints it.' };

  const loaded = await loadDay(sb, companyId, input.payoutId, input.settledOn);
  if (!loaded.ok) return loaded;
  const { day, payableSen, acquirerCode } = loaded;
  if (payableSen == null) {
    return { ok: false, status: 'report_missing', reason: `No merchant report is uploaded for ${input.settledOn} yet, so the difference is not known.` };
  }
  if (Number(day.charge_sen ?? 0) > 0) {
    return { ok: false, status: 'already_charged', reason: `A charge of ${rm(Number(day.charge_sen))} is already booked on ${input.settledOn}. Undo it first to book a different one.` };
  }
  /* The gap the charge may explain: what the report says was collected minus
     what the advice says was paid. Nothing to explain when they already agree,
     and a "charge" that exceeds the gap is not a deduction but a mismatch. */
  const differenceSen = payableSen - Number(day.net_sen ?? 0);
  if (differenceSen <= 0) {
    return { ok: false, status: 'nothing_to_charge', reason: `${input.settledOn} already agrees with its report — there is no deduction to explain.` };
  }
  const chargeSen = input.amountSen == null ? differenceSen : Math.round(Number(input.amountSen));
  if (!Number.isFinite(chargeSen) || chargeSen <= 0) {
    return { ok: false, status: 'bad_amount', reason: 'Give the amount the bank deducted, as it reads on the advice.' };
  }
  if (chargeSen > differenceSen) {
    return { ok: false, status: 'over_difference', reason: `The advice is ${rm(differenceSen)} short of the report on ${input.settledOn}; a charge of ${rm(chargeSen)} is more than that. Record only what the bank deducted.` };
  }

  const account = String(input.accountCode ?? '').trim();
  const okAccount = await checkExpenseLeaf(sb, companyId, account, 'a bank charge');
  if (!okAccount.ok) return okAccount;

  const acq = await loadAcquirer(sb, companyId, acquirerCode);
  if (!acq.ok) return { ok: false, status: 'load_failed', reason: acq.reason };

  const posted = await postJournal(sb, {
    companyId,
    entryDate: input.settledOn,
    sourceType: CHARGE_SOURCE,
    sourceDocNo: `${CHARGE_SOURCE}-${Number(day.id)}`,
    narration: `${acquirerCode} bank charge on the ${input.settledOn} payout — ${note}`,
    lines: [
      { accountCode: account, debitSen: chargeSen, creditSen: 0, partyType: null, partyCode: null, partyName: null, notes: note },
      { accountCode: acq.acquirer.transit_account_code, debitSen: 0, creditSen: chargeSen, partyType: null, partyCode: null, partyName: null, notes: `Deducted by the bank from the ${input.settledOn} payout` },
    ],
  });
  if (!posted.ok) return { ok: false, status: posted.status, reason: posted.reason ?? 'the posting gate refused the entry' };

  const { error: upErr } = await sb.from('acc_settlement_payout_batches').update({
    charge_sen: chargeSen,
    charge_account_code: account,
    charge_note: note,
    charge_je_no: posted.jeNo,
    charge_je_id: posted.jeId,
    charge_by: input.userName ?? null,
    charged_at: new Date().toISOString(),
  }).eq('id', Number(day.id)).eq('company_id', companyId);
  if (upErr) {
    /* The entry is in the ledger and the row does not say so — reverse it,
       so the books and the screen do not disagree about a charge. */
    await reverseJournal(sb, { sourceType: CHARGE_SOURCE, sourceDocNo: `${CHARGE_SOURCE}-${Number(day.id)}`, entryDate: input.settledOn, narration: (o) => `Reversal of ${o.je_no} — the charge could not be recorded on the advice` });
    return { ok: false, status: 'save_failed', reason: upErr.message };
  }
  return { ok: true, status: 'charged', chargeSen, accountCode: account, jeNo: posted.jeNo };
}

export async function undoPayoutCharge(
  sb: Db, companyId: number, input: { payoutId: number; settledOn: string },
): Promise<{ ok: true; status: 'undone' } | { ok: false; status: 'not_found' | 'nothing_to_undo' | 'load_failed' | string; reason: string }> {
  const loaded = await loadDay(sb, companyId, input.payoutId, input.settledOn);
  if (!loaded.ok) return loaded;
  const { day } = loaded;
  if (Number(day.charge_sen ?? 0) === 0) {
    return { ok: false, status: 'nothing_to_undo', reason: `No charge is booked on ${input.settledOn}.` };
  }
  /* The contra sits on the same day as the charge — an undone deduction nets
     to zero in the month it was booked, the same rule a corrected payment
     follows (acc/payment-repost). */
  const undone = await reverseJournal(sb, {
    sourceType: CHARGE_SOURCE,
    sourceDocNo: `${CHARGE_SOURCE}-${Number(day.id)}`,
    entryDate: input.settledOn,
    narration: (o) => `Reversal of ${o.je_no} — bank charge on the ${input.settledOn} payout undone`,
  });
  if (!undone.ok) return { ok: false, status: undone.status, reason: undone.reason ?? 'the reversal did not post' };
  const { error: upErr } = await sb.from('acc_settlement_payout_batches').update({
    charge_sen: 0, charge_account_code: null, charge_note: null, charge_je_no: null, charge_je_id: null, charge_by: null, charged_at: null,
  }).eq('id', Number(day.id)).eq('company_id', companyId);
  if (upErr) return { ok: false, status: 'save_failed', reason: upErr.message };
  return { ok: true, status: 'undone' };
}

const rm = (sen: number) =>
  `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
