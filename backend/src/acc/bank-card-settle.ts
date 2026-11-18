// ----------------------------------------------------------------------------
// bank-card-settle — a bank credit takes card payments in itself, no merchant
// report carrying them (owner 2026-11-17: 「我在bank recon时可以选刷卡的
// transaction，然后差额就直接去terminal charges」, then 「照这样做」).
//
// acc/bank-card-match decides the journal; this reads what it needs from the
// books, writes it, and takes it back on Undo. In order:
//   1. each payment is read back from the books — this company's, a card
//      method, not on a merchant report, not taken by another movement, not a
//      previous record, its live receipt entry putting its exact amount on ONE
//      card clearing account (the merchants' transit accounts, the EDC role);
//   2. the payments are CLAIMED (scm.acc_bank_card_settlements — one movement
//      per payment by its unique index, and never one a report line holds, by
//      its trigger), then the SETTLECARD journal is posted keyed on the claim;
//   3. the movement is matched to the ticked entries and to that journal, and
//      marked POSTED; the receipts turn formal on this bank.
// A refusal after the claim takes back what was written, so nothing is left
// half done; an earlier attempt that died half way is taken back first.
// ----------------------------------------------------------------------------

import { postJournal, reverseJournal } from './engine';
import { resolveRoles } from './rules';
import { planCardMatch, type CardForMatch, type CardMatchPlan, type EntryForMatch } from './bank-card-match';
import { BANK_CARD_TABLE, bankCardRowsOfLine, loadBankCardKeys } from './bank-card-settled';
import { CARD_METHODS } from './settlement';
import { loadPreviousKeys } from './previous-payments';
import { formaliseReceiptsForBankMatch, formaliseReceiptsForSettlement } from './receipts';
import { companyCodeById } from '../scm/lib/doc-no';
import { chunkIn } from '../scm/lib/paginate-all';
import { fmtSen } from '../scm/shared/format';

/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Sb = Parameters<typeof resolveRoles>[0];
type Row = Record<string, unknown>;

export const SETTLECARD = 'SETTLECARD';

export type CardPaymentRef = { source: 'SOPAY' | 'SIPAY'; id: string };
export type CardRefusal = { ok: false; httpStatus: 404 | 409 | 500; status: string; message: string };

const refuse = (httpStatus: CardRefusal['httpStatus'], status: string, message: string): CardRefusal => ({ ok: false, httpStatus, status, message });
const failedRead = (what: string, reason: string): CardRefusal => refuse(500, 'load_failed', `${what} could not be read (${reason}), so nothing was changed. Try again.`);

/** Where this company's card money waits, and the one account its merchants' charges go to. */
export async function loadCardAccounts(sb: Sb, companyId: number): Promise<
  | { ok: true; clearing: Set<string>; feeAccountCode: string | null; feeProblem: string | null }
  | CardRefusal
> {
  const [{ data, error }, roles] = await Promise.all([
    sb.from('acc_acquirers').select('code, transit_account_code, fee_account_code, is_active').eq('company_id', companyId),
    resolveRoles(sb, companyId),
  ]);
  if (error) return failedRead('The merchants set up for this company', String(error.message ?? error));
  const merchants = (Array.isArray(data) ? data : []) as Array<{ code: string; transit_account_code: string | null; fee_account_code: string | null; is_active: boolean | null }>;
  const clearing = new Set<string>([roles.TRANSIT_EDC]);
  for (const m of merchants) if (m.transit_account_code) clearing.add(String(m.transit_account_code));
  /* The charges account the merchants already book their fees to — the active
     ones', and every one's when none is active. One account, or the person is
     told rather than one being picked for them. */
  const active = merchants.filter((m) => m.is_active !== false);
  const fees = [...new Set((active.length > 0 ? active : merchants).map((m) => String(m.fee_account_code ?? '').trim()).filter(Boolean))];
  if (fees.length === 1) return { ok: true, clearing, feeAccountCode: fees[0]!, feeProblem: null };
  return {
    ok: true, clearing, feeAccountCode: null,
    feeProblem: fees.length === 0
      ? 'No merchant of this company names a charges account (Merchant Recon → Setup), so the difference has nowhere to go.'
      : `This company's merchants book their charges to different accounts (${fees.join(', ')}), so the difference has no one account to go to.`,
  };
}

/** The payments as the books hold them (step 1 above), or the refusal naming the one that cannot be taken. */
async function readCards(sb: Sb, companyId: number, refs: readonly CardPaymentRef[], clearing: ReadonlySet<string>): Promise<
  { ok: true; cards: CardForMatch[] } | CardRefusal
> {
  const idsOf = (source: CardPaymentRef['source']) => [...new Set(refs.filter((r) => r.source === source).map((r) => r.id))];
  const soIds = idsOf('SOPAY');
  const siIds = idsOf('SIPAY');
  const allIds = [...new Set(refs.map((r) => r.id))];
  const none = { data: [] as Row[], error: null, truncated: false };
  const [so, si, held, taken, previous, entries] = await Promise.all([
    soIds.length === 0 ? none : chunkIn<Row>(soIds, (b, f, t) => sb.from('mfg_sales_order_payments')
      .select('id, so_doc_no, amount_sen, method, approval_code').eq('company_id', companyId).in('id', b).order('id').range(f, t)),
    siIds.length === 0 ? none : chunkIn<Row>(siIds, (b, f, t) => sb.from('sales_invoice_payments')
      .select('id, sales_invoice_id, amount_sen, method, approval_code').eq('company_id', companyId).in('id', b).order('id').range(f, t)),
    chunkIn<Row>(allIds, (b, f, t) => sb.from('acc_settlement_matches')
      .select('payment_source, payment_id').eq('company_id', companyId).in('payment_id', b).order('id').range(f, t)),
    loadBankCardKeys(sb, companyId, refs),
    loadPreviousKeys(sb, companyId),
    chunkIn<Row>(allIds, (b, f, t) => sb.from('journal_entries')
      .select('id, je_no, source_type, source_doc_no, reversed').eq('company_id', companyId).eq('posted', true)
      .in('source_doc_no', b).order('id').range(f, t)),
  ]);
  if (so.error) return failedRead('The order payments', so.error.message);
  if (si.error) return failedRead('The invoice payments', si.error.message);
  if (held.error) return failedRead('The merchant report links', held.error.message);
  if (!taken.ok) return failedRead('The card payments already taken in', taken.reason);
  if (!previous.ok) return failedRead('The previous records', previous.reason);
  if (entries.error) return failedRead("The payments' entries", entries.error.message);

  /* Each payment's LIVE entry, and the accounts it debits. */
  const live = entries.data.filter((e) => e.reversed !== true);
  const legs = live.length === 0 ? none : await chunkIn<Row>(live.map((e) => String(e.id)), (b, f, t) => sb.from('journal_entry_lines')
    .select('journal_entry_id, account_code, debit_sen').eq('company_id', companyId).in('journal_entry_id', b).order('journal_entry_id').range(f, t));
  if (legs.error) return failedRead("The payments' entry lines", legs.error.message);
  const debitsOf = new Map<string, Array<{ account: string; sen: number }>>();
  for (const l of legs.data) {
    const sen = Number(l.debit_sen ?? 0);
    if (sen <= 0) continue;
    const id = String(l.journal_entry_id);
    debitsOf.set(id, [...(debitsOf.get(id) ?? []), { account: String(l.account_code), sen }]);
  }

  const invoiceNo = new Map<string, string>();
  const invoiceIds = [...new Set(si.data.map((r) => String(r.sales_invoice_id ?? '')).filter(Boolean))];
  if (invoiceIds.length > 0) {
    const inv = await chunkIn<Row>(invoiceIds, (b, f, t) => sb.from('sales_invoices')
      .select('id, invoice_number').eq('company_id', companyId).in('id', b).order('id').range(f, t));
    if (inv.error) return failedRead('The invoices', inv.error.message);
    for (const r of inv.data) if (r.invoice_number) invoiceNo.set(String(r.id), String(r.invoice_number));
  }

  const rowOf = new Map<string, Row>();
  for (const r of so.data) rowOf.set(`SOPAY:${String(r.id)}`, r);
  for (const r of si.data) rowOf.set(`SIPAY:${String(r.id)}`, r);
  const onReport = new Set(held.data.map((m) => `${String(m.payment_source)}:${String(m.payment_id)}`));
  const cards: CardForMatch[] = [];
  for (const ref of refs) {
    const key = `${ref.source}:${ref.id}`;
    if (cards.some((c) => `${c.source}:${c.id}` === key)) continue;
    const r = rowOf.get(key);
    if (!r) return refuse(404, 'payment_not_found', `Card payment ${ref.id} is not in this company's books. Refresh the list.`);
    const docNo = ref.source === 'SOPAY' ? (r.so_doc_no == null ? null : String(r.so_doc_no)) : (invoiceNo.get(String(r.sales_invoice_id ?? '')) ?? null);
    const name = docNo ?? ref.id;
    const method = String(r.method ?? '');
    if (!CARD_METHODS.has(method)) return refuse(409, 'not_card_payment', `${name} was paid by ${method || 'an unknown method'}, not by card — match it to its own entry instead.`);
    if (onReport.has(key)) return refuse(409, 'payment_on_report', `${name} is on a merchant report already — its money comes through that report, not this movement.`);
    if (taken.keys.has(key)) return refuse(409, 'payment_already_settled', `${name} was taken in by another bank movement already. Refresh the list.`);
    if (previous.keys.has(key)) return refuse(409, 'previous_record', `${name} is marked a previous record — it is in no reconciliation.`);
    const amountSen = Number(r.amount_sen ?? 0);
    const entry = live.filter((e) => String(e.source_type) === ref.source && String(e.source_doc_no) === ref.id);
    if (entry.length !== 1) {
      return refuse(409, 'no_receipt_entry', entry.length === 0
        ? `${name} has no posted entry, so there is no card money in the books to take in. Book the payment first.`
        : `${name} has ${entry.length} live entries — fix the payment before taking it in.`);
    }
    const debits = debitsOf.get(String(entry[0]!.id)) ?? [];
    const leg = debits.length === 1 ? debits[0]! : null;
    if (!leg || !clearing.has(leg.account) || leg.sen !== amountSen) {
      return refuse(409, 'not_in_card_clearing', leg && clearing.has(leg.account)
        ? `${name}'s entry ${String(entry[0]!.je_no)} puts ${fmtSen(leg.sen)} on ${leg.account}, but the payment is ${fmtSen(amountSen)}. Correct the payment first.`
        : `${name}'s entry ${String(entry[0]!.je_no)} does not put its money on a card clearing account, so this movement cannot take it in.`);
    }
    cards.push({ source: ref.source, id: ref.id, docNo, approvalCode: r.approval_code == null ? null : String(r.approval_code), grossSen: amountSen, clearingAccountCode: leg.account });
  }
  return { ok: true, cards };
}

export type SettleCardsInput = {
  line: { id: number; booked_on: string; reference: string | null; amount_sen: number };
  bankAccountCode: string;
  /** Entries on this bank the route has checked: posted, unclaimed. */
  entries: EntryForMatch[];
  payments: CardPaymentRef[];
  actor: string | null;
};

export type SettleCardsResult =
  | { ok: true; jeNo: string; plan: CardMatchPlan; feeAccountCode: string }
  | CardRefusal;

export async function settleCardsOnBankLine(sb: Sb, companyId: number, input: SettleCardsInput): Promise<SettleCardsResult> {
  /* An earlier attempt on this OPEN movement that died half way: taken back first. */
  const leftover = await undoCardSettlement(sb, companyId, input.line.id);
  if (!leftover.ok) return refuse(500, 'leftover_failed', `An earlier attempt on this movement could not be taken back: ${leftover.reason}`);

  const accounts = await loadCardAccounts(sb, companyId);
  if (!accounts.ok) return accounts;
  if (!accounts.feeAccountCode) return refuse(409, 'no_fee_account', accounts.feeProblem ?? 'No charges account.');
  const read = await readCards(sb, companyId, input.payments, accounts.clearing);
  if (!read.ok) return read;
  const plan = planCardMatch({
    lineSen: Number(input.line.amount_sen), entries: input.entries, cards: read.cards,
    bankAccountCode: input.bankAccountCode, feeAccountCode: accounts.feeAccountCode, bankRef: input.line.reference,
  });
  if (!plan.ok) return refuse(409, plan.status, plan.message);

  /* 2. The claim first, so the journal can be keyed on it and a second movement
        loses the race at the unique index rather than booking the money twice. */
  const receivedOn = String(input.line.booked_on).slice(0, 10);
  const { data: claimedRaw, error: claimErr } = await sb.from(BANK_CARD_TABLE).insert(read.cards.map((c) => ({
    company_id: companyId, bank_line_id: input.line.id, payment_source: c.source, payment_id: c.id, doc_no: c.docNo,
    gross_sen: c.grossSen, clearing_account_code: c.clearingAccountCode, received_on: receivedOn, created_by: input.actor,
  }))).select('id');
  if (claimErr) {
    const twice = String(claimErr.code ?? '') === '23505' || /duplicate key|payment_on_merchant_report/i.test(String(claimErr.message ?? ''));
    return twice
      ? refuse(409, 'payment_already_settled', 'One of these card payments was just taken by a merchant report or another bank movement. Refresh the list.')
      : refuse(500, 'save_failed', String(claimErr.message ?? claimErr));
  }
  const claimIds = ((Array.isArray(claimedRaw) ? claimedRaw : []) as Array<{ id: number }>).map((r) => Number(r.id));
  const release = async () => { await sb.from(BANK_CARD_TABLE).delete().eq('company_id', companyId).eq('bank_line_id', input.line.id); };
  if (claimIds.length !== read.cards.length) {
    await release();
    return refuse(500, 'save_failed', 'The card payments were written but did not report back, so nothing was kept. Try again.');
  }

  const sourceDocNo = `${SETTLECARD}-${input.line.id}-${Math.min(...claimIds)}`;
  const posted = await postJournal(sb, {
    companyId,
    entryDate: receivedOn,
    sourceType: SETTLECARD,
    sourceDocNo,
    narration: `Card payments taken in on the bank ${receivedOn} — ${read.cards.length} payment(s) ${fmtSen(plan.cardsSen)}, charges ${fmtSen(plan.chargeSen)}`,
    lines: plan.lines,
  });
  if (!posted.ok) {
    await release();
    return refuse(409, posted.status, posted.reason ?? 'The posting gate refused the entry.');
  }
  const takeBack = async (why: string): Promise<CardRefusal> => {
    await reverseJournal(sb, { sourceType: SETTLECARD, sourceDocNo, companyId, onOriginalDate: true, narration: (orig) => `Reversal of ${orig.je_no} — ${why}` });
    await release();
    return refuse(500, 'save_failed', `${why}; the entry was taken back, so nothing is half done. Try again.`);
  };
  const { error: stampErr } = await sb.from(BANK_CARD_TABLE).update({ je_no: posted.jeNo }).eq('company_id', companyId).eq('bank_line_id', input.line.id);
  if (stampErr) return takeBack(`the card payments could not be stamped with ${posted.jeNo} (${String(stampErr.message ?? stampErr)})`);

  /* 3. The movement accounts for the ticked entries and the new journal's bank leg. */
  const { error: matchErr } = await sb.from('acc_bank_statement_matches').insert([
    ...input.entries.map((e) => ({ bank_line_id: input.line.id, company_id: companyId, je_no: e.jeNo, amount_sen: e.sen, match_reason: 'manual' })),
    { bank_line_id: input.line.id, company_id: companyId, je_no: posted.jeNo, amount_sen: plan.bankSen, match_reason: 'manual' },
  ]);
  if (matchErr) return takeBack(`the match could not be saved (${String(matchErr.message ?? matchErr)})`);
  const { error: upErr } = await sb.from('acc_bank_statement_lines')
    .update({ state: 'POSTED', posted_je_no: posted.jeNo, updated_at: new Date().toISOString() })
    .eq('id', input.line.id).eq('company_id', companyId);
  if (upErr) {
    await sb.from('acc_bank_statement_matches').delete().eq('company_id', companyId).eq('bank_line_id', input.line.id);
    return takeBack(`the movement could not be marked matched (${String(upErr.message ?? upErr)})`);
  }

  /* Best effort, like every other match: a receipt never fails the money. */
  await formaliseReceiptsForBankMatch(sb, companyId, input.bankAccountCode, input.entries.map((e) => e.jeNo), input.actor);
  const code = await companyCodeById(sb, companyId);
  if (code) await formaliseReceiptsForSettlement(sb, companyId, code, read.cards.map((c) => ({ source: c.source, id: c.id })), input.bankAccountCode, input.actor);
  return { ok: true, jeNo: posted.jeNo, plan, feeAccountCode: accounts.feeAccountCode };
}

/** Undo: the SETTLECARD journal reversed on its own date and the claims let go,
    so the payments go back to waiting for a report. Nothing to do is no failure. */
export async function undoCardSettlement(sb: Sb, companyId: number, bankLineId: number): Promise<
  { ok: true; undone: number; jeNo: string | null } | { ok: false; reason: string }
> {
  const rows = await bankCardRowsOfLine(sb, companyId, bankLineId);
  if (!rows.ok) return rows;
  if (rows.rows.length === 0) return { ok: true, undone: 0, jeNo: null };
  const sourceDocNo = `${SETTLECARD}-${bankLineId}-${Math.min(...rows.rows.map((r) => Number(r.id)))}`;
  const reversed = await reverseJournal(sb, {
    sourceType: SETTLECARD, sourceDocNo, companyId, onOriginalDate: true,
    narration: (orig) => `Reversal of ${orig.je_no} — the card payments go back to waiting for a report`,
  });
  if (!reversed.ok) return { ok: false, reason: reversed.reason ?? 'the reversal was refused' };
  const { error } = await sb.from(BANK_CARD_TABLE).delete().eq('company_id', companyId).eq('bank_line_id', bankLineId);
  if (error) return { ok: false, reason: `${String(error.message ?? error)} (the entry WAS reversed — press undo again to finish putting the card payments back)` };
  return { ok: true, undone: rows.rows.length, jeNo: reversed.status === 'reversed' ? reversed.jeNo : null };
}
