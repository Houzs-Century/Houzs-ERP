// ----------------------------------------------------------------------------
// accounting-bank-cards — Bank Recon taking card payments in itself.
//
// Owner, 2026-11-17, on 2990's Hong Leong credit of RM 26,308.81 (Houzs's
// HC-HPV-2611-052): 「我在bank recon时可以选刷卡的transaction，然后差额就直接去
// terminal charges」, then 「照这样做」. Two doors:
//
//   GET  /accounting/bank/card-payments?from&to — the card payments no merchant
//        report has carried (the list Merchant Recon shows, acc/waiting-card-
//        payments), the charges account a difference would go to, and its cap;
//   POST /accounting/bank/lines/:id/match-with-cards { jeNos, cardPayments } —
//        one OPEN credit matched to entries on its own bank AND to those card
//        payments; what the bank did not pay of them goes to the charges
//        account (acc/bank-card-settle, acc/bank-card-match).
//
// Merchant money stays with its merchant's report: a movement the bank rules
// read as a merchant's payout, or a DuitNow QR credit, is refused here.
// ----------------------------------------------------------------------------

import type { Context } from 'hono';
import type { Env, Variables } from '../env';
import { requireActiveCompanyId } from '../lib/companyScope';
import { todayMyt } from '../lib/my-time';
import { loadAccountLedger } from '../../acc/bank';
import { MAX_CARD_CHARGE_PCT, type EntryForMatch } from '../../acc/bank-card-match';
import { loadCardAccounts, settleCardsOnBankLine, type CardPaymentRef } from '../../acc/bank-card-settle';
import { loadWaitingCardPayments, type WaitingMerchant } from '../../acc/waiting-card-payments';
import { accountOfStatement, bankGuard, claimedHere, liveClaimsOn, refuseIfLineLocked, userName } from './accounting-bank';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ── GET /bank/card-payments — what a movement may take in ─────────────────── */

export const bankCardPayments = bankGuard(async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const sb = c.get('supabase');
  const to = DAY.test(c.req.query('to') ?? '') ? String(c.req.query('to')) : todayMyt();
  const from = DAY.test(c.req.query('from') ?? '')
    ? String(c.req.query('from'))
    : new Date(Date.parse(`${to}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10);

  const { data: acqRaw, error } = await sb.from('acc_acquirers')
    .select('code, display_name, date_tolerance_days, so_names')
    .eq('company_id', co.companyId).eq('is_active', true).order('code');
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  const [waiting, accounts] = await Promise.all([
    loadWaitingCardPayments(sb, co.companyId, (Array.isArray(acqRaw) ? acqRaw : []) as WaitingMerchant[], from, to),
    loadCardAccounts(sb, co.companyId),
  ]);
  if (!waiting.ok) return c.json({ error: 'load_failed', reason: waiting.reason }, 500);
  if (!accounts.ok) return c.json({ error: accounts.status, message: accounts.message }, accounts.httpStatus);

  let feeAccount: { code: string; name: string | null } | null = null;
  if (accounts.feeAccountCode) {
    const { data: acc, error: aErr } = await sb.from('accounts')
      .select('account_name').eq('company_id', co.companyId).eq('account_code', accounts.feeAccountCode).maybeSingle();
    if (aErr) return c.json({ error: 'load_failed', reason: aErr.message }, 500);
    feeAccount = { code: accounts.feeAccountCode, name: (acc as { account_name?: string | null } | null)?.account_name ?? null };
  }
  return c.json({
    from, to, feeAccount, feeProblem: accounts.feeProblem, maxChargePct: MAX_CARD_CHARGE_PCT,
    payments: waiting.payments.map((p) => ({
      source: p.source, id: p.id, docNo: p.docNo, paidOn: p.paidOn, amountSen: p.amountSen,
      approvalCode: p.approvalCode, customerName: p.customerName, acquirerCode: p.acquirerCode,
      merchantProvider: p.merchantProvider ?? null, ageDays: p.ageDays,
    })),
  });
});

/* ── POST /bank/lines/:id/match-with-cards — entries AND card payments ─────── */

export const bankLineMatchWithCards = bankGuard(async (c: Ctx) => {
  const co = requireActiveCompanyId(c);
  if (!co.ok) return c.json(co.refusal, 409);
  const lineId = Number(c.req.param('id'));
  if (!Number.isInteger(lineId)) return c.json({ error: 'bad_id' }, 400);
  /* A closed month refuses this, asked before the row is read (accounting-bank). */
  const shut = await refuseIfLineLocked(c, co.companyId, lineId, 'matching this movement');
  if (shut) return shut;

  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const jeNos = [...new Set((Array.isArray(body.jeNos) ? body.jeNos : []).map((v: unknown) => String(v ?? '').trim()).filter(Boolean))] as string[];
  const payments: CardPaymentRef[] = [];
  for (const raw of Array.isArray(body.cardPayments) ? body.cardPayments : []) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const source = String(p.source ?? '');
    const id = String(p.id ?? '').trim();
    if ((source !== 'SOPAY' && source !== 'SIPAY') || !id) {
      return c.json({ error: 'bad_payment', message: 'Each card payment needs its source and id. Refresh the list.' }, 400);
    }
    if (!payments.some((q) => q.source === source && q.id === id)) payments.push({ source, id });
  }
  if (payments.length === 0) {
    return c.json({ error: 'no_card_payments', message: 'Tick the card payments this money is for, or match it to its entries without them.' }, 400);
  }

  const sb = c.get('supabase');
  const { data: lineRaw, error } = await sb.from('acc_bank_statement_lines')
    .select('id, statement_id, amount_sen, state, kind, booked_on, reference')
    .eq('id', lineId).eq('company_id', co.companyId).maybeSingle();
  if (error) return c.json({ error: 'load_failed', reason: error.message }, 500);
  if (!lineRaw) return c.json({ error: 'not_found' }, 404);
  const line = lineRaw as { id: number; statement_id: number; amount_sen: number; state: string; kind: string | null; booked_on: string; reference: string | null };
  if (String(line.state) !== 'OPEN') {
    return c.json({ error: 'not_open', message: `This movement is already ${String(line.state).toLowerCase()}. Undo it first.` }, 409);
  }
  if (!(Number(line.amount_sen) > 0)) {
    return c.json({ error: 'not_a_credit', message: 'This movement takes money out of the account — only money coming in can take card payments in.' }, 400);
  }
  const kind = String(line.kind ?? '');
  if (kind.startsWith('PAYOUT') || kind === 'QR') {
    return c.json({
      error: 'merchant_money',
      message: kind === 'QR'
        ? 'This is DuitNow QR money — it is matched to its sales, not to card payments.'
        : 'This is a merchant\'s own payout — book it against that merchant\'s report (Money received), not against card payments here.',
    }, 409);
  }
  const account = await accountOfStatement(sb, co.companyId, Number(line.statement_id));
  if (!account.ok) return c.json({ error: 'load_failed', reason: account.reason }, 500);

  /* The entries, by what the ledger says they are — never the screen's amount —
     and none another movement of this bank already accounts for. */
  const entries: EntryForMatch[] = [];
  if (jeNos.length > 0) {
    const ledger = await loadAccountLedger(sb, co.companyId, account.accountCode, '9999-12-31');
    if (!ledger.ok) return c.json({ error: 'load_failed', reason: ledger.reason }, 500);
    for (const jeNo of jeNos) {
      const m = ledger.movements.find((x) => x.jeNo === jeNo);
      if (!m) return c.json({ error: 'entry_not_found', message: `${jeNo} is not a posted entry on ${account.accountCode}.` }, 404);
      entries.push({ jeNo, sen: m.debitSen - m.creditSen });
    }
    const held = await liveClaimsOn(sb, co.companyId, jeNos);
    if (!held.ok) return c.json({ error: 'load_failed', reason: held.reason }, 500);
    const here = held.live.find((m) => m.accountCode === account.accountCode);
    if (here) return c.json({ error: 'already_matched', message: claimedHere(here.jeNo, account.accountCode) }, 409);
    if (held.dead.length > 0) {
      /* Rows an older undo left behind (docs/bugs/0802). */
      const { error: dErr } = await sb.from('acc_bank_statement_matches').delete().eq('company_id', co.companyId).in('id', held.dead.map((m) => m.id));
      if (dErr) return c.json({ error: 'save_failed', reason: dErr.message }, 500);
    }
  }

  const done = await settleCardsOnBankLine(sb, co.companyId, {
    line: { id: line.id, booked_on: String(line.booked_on), reference: line.reference ?? null, amount_sen: Number(line.amount_sen) },
    bankAccountCode: account.accountCode,
    entries,
    payments,
    actor: userName(c),
  });
  if (!done.ok) return c.json({ error: done.status, message: done.message }, done.httpStatus);
  return c.json({
    ok: true, status: 'matched', jeNo: done.jeNo,
    entries: entries.length, cards: payments.length,
    entriesSen: done.plan.entriesSen, cardsSen: done.plan.cardsSen, bankSen: done.plan.bankSen,
    chargeSen: done.plan.chargeSen, chargePct: done.plan.chargePct, feeAccountCode: done.feeAccountCode,
  });
});
