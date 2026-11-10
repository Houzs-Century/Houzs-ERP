// ----------------------------------------------------------------------------
// acc/receipt-rebank — move earlier transfer receipts onto the bank the company
// now receives into.
//
// Owner 2026-11-04 (之前的收款我做maybank recon 时会有出现了吗？ → 做改记工具):
// Houzs Century receives transfers in Maybank, but its default bank was Hong
// Leong, so every transfer receipt so far debited Hong Leong. Setting Receive
// into = Maybank only books FUTURE receipts there; the Maybank reconciliation
// reads only entries already on Maybank, so the old ones never appear.
//
// A candidate is a transfer payment (SO or SI) whose live entry debits a bank
// other than the company's current BANK_DEFAULT. Moving one is the edit
// pattern (acc/payment-repost.ts): reverse the live entry ON ITS OWN DATE, so
// the wrong pair nets to nothing in its month and every reader leaves both out,
// then book the payment again through its ordinary poster, which now resolves
// BANK_DEFAULT to the new bank. Nothing else about the payment changes.
//
// Refused, by name: a receipt already matched on a bank statement (the money
// was claimed on that bank), a receipt in a closed bank month on either bank,
// and anything whose reads fail — every check fails closed.
//
// ALL OR NOTHING, per receipt (owner-approved root fix): the contra and the new
// entry are written in ONE database transaction (acc/rebank-transaction.ts), so
// a receipt either moves whole or is left exactly where it was. Each receipt is
// its own transaction — one failure never undoes the receipts before it. The
// old two-step path stays behind RECEIPT_REBANK_MODE=two-step for one release.
// ----------------------------------------------------------------------------

import { reverseJournal } from './engine';
import { postSiPayment, postSoPayment, type SiPaymentRow, type SoPaymentRow } from './payments';
import { resolveRoles } from './rules';
import { chunkIn, paginateAll } from '../scm/lib/paginate-all';
import type { RebankTx } from './rebank-transaction';

type Db = Parameters<typeof postSoPayment>[0];
type Rec = Record<string, unknown>;
type Source = 'SOPAY' | 'SIPAY';

export type RebankCandidate = {
  source: Source;
  paymentId: string;
  /** The order or invoice the payment is on, as a reader recognises it. */
  docNo: string;
  paidOn: string;
  amountSen: number;
  jeNo: string;
  fromAccount: string;
  /** Why it cannot move, or null when it can. */
  blocked: string | null;
};

export type RebankList = { ok: true; target: string; rows: RebankCandidate[] } | { ok: false; reason: string };

/** At most this many receipts per move call — each one is several writes. */
export const MAX_REBANK_PER_CALL = 25;

/* Date-safe: inside the transaction (postgres.js) a DATE comes back as a JS Date. */
const dayOf = (v: unknown): string =>
  v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)) : String(v ?? '').slice(0, 10);
const nextDay = (ymd: string): string => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

type PaymentRead = { source: Source; row: Rec; docNo: string };

/** The transfer payments in [from, to], or only the ones named. */
async function readTransfers(
  sb: Db, companyId: number, range: { from: string; to: string } | null, only: Array<{ source: Source; paymentId: string }> | null,
): Promise<{ ok: true; rows: PaymentRead[] } | { ok: false; reason: string }> {
  const out: PaymentRead[] = [];
  const tables: Array<{ source: Source; table: string; cols: string }> = [
    { source: 'SOPAY', table: 'mfg_sales_order_payments', cols: 'id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id' },
    { source: 'SIPAY', table: 'sales_invoice_payments', cols: 'id, sales_invoice_id, paid_at, method, merchant_provider, amount_sen, company_id' },
  ];
  for (const t of tables) {
    const ids = only ? only.filter((o) => o.source === t.source).map((o) => o.paymentId) : null;
    if (ids && ids.length === 0) continue;
    const r = ids
      ? await chunkIn<Rec>(ids, (batch, lo, hi) => sb.from(t.table).select(t.cols)
        .eq('company_id', companyId).eq('method', 'transfer').in('id', batch).order('id').range(lo, hi))
      : await paginateAll<Rec>((lo, hi) => sb.from(t.table).select(t.cols)
        .eq('company_id', companyId).eq('method', 'transfer')
        .gte('paid_at', range!.from).lt('paid_at', nextDay(range!.to)).order('id').range(lo, hi));
    if (r.error) return { ok: false, reason: `${t.table}: ${r.error.message}` };
    for (const row of r.data ?? []) out.push({ source: t.source, row, docNo: String((t.source === 'SOPAY' ? row.so_doc_no : row.sales_invoice_id) ?? '') });
  }
  /* An SI payment names its invoice by id; the reader wants its number. */
  const siIds = [...new Set(out.filter((p) => p.source === 'SIPAY').map((p) => p.docNo))];
  if (siIds.length > 0) {
    const inv = await chunkIn<Rec>(siIds, (batch, lo, hi) => sb.from('sales_invoices').select('id, invoice_number')
      .eq('company_id', companyId).in('id', batch).order('id').range(lo, hi));
    if (inv.error) return { ok: false, reason: `sales_invoices: ${inv.error.message}` };
    const no = new Map(inv.data.map((i) => [String(i.id), String(i.invoice_number ?? i.id)]));
    for (const p of out) if (p.source === 'SIPAY') p.docNo = no.get(p.docNo) ?? p.docNo;
  }
  return { ok: true, rows: out };
}

/** Each payment's live entry and the account its money leg debits. */
async function liveEntries(
  sb: Db, companyId: number, payments: PaymentRead[],
): Promise<{ ok: true; byPayment: Map<string, { jeNo: string; entryDate: string; account: string }> } | { ok: false; reason: string }> {
  const byPayment = new Map<string, { jeNo: string; entryDate: string; account: string }>();
  const jeById = new Map<string, { key: string; jeNo: string; entryDate: string }>();
  for (const source of ['SOPAY', 'SIPAY'] as const) {
    const ids = payments.filter((p) => p.source === source).map((p) => String(p.row.id));
    if (ids.length === 0) continue;
    const r = await chunkIn<Rec>(ids, (batch, lo, hi) => sb.from('journal_entries')
      .select('id, je_no, entry_date, reversed, source_doc_no')
      .eq('company_id', companyId).eq('source_type', source).eq('posted', true).in('source_doc_no', batch).order('id').range(lo, hi));
    if (r.error) return { ok: false, reason: `journal entries: ${r.error.message}` };
    /* `reversed` filtered here, not in the query (docs/bugs/0778). */
    for (const je of r.data) {
      if (je.reversed) continue;
      jeById.set(String(je.id), { key: `${source}:${String(je.source_doc_no)}`, jeNo: String(je.je_no), entryDate: dayOf(je.entry_date) });
    }
  }
  if (jeById.size === 0) return { ok: true, byPayment };
  const lines = await chunkIn<Rec>([...jeById.keys()], (batch, lo, hi) => sb.from('journal_entry_lines')
    .select('journal_entry_id, account_code, debit_sen').in('journal_entry_id', batch).order('journal_entry_id').range(lo, hi));
  if (lines.error) return { ok: false, reason: `entry lines: ${lines.error.message}` };
  for (const l of lines.data) {
    if (Number(l.debit_sen ?? 0) <= 0) continue;
    const je = jeById.get(String(l.journal_entry_id));
    if (je) byPayment.set(je.key, { jeNo: je.jeNo, entryDate: je.entryDate, account: String(l.account_code) });
  }
  return { ok: true, byPayment };
}

/** `bank`: the bank to move onto; null = the company's current BANK_DEFAULT
    (Receive into). Formalising a receipt onto a named bank passes that bank. */
async function listFor(
  sb: Db, companyId: number, range: { from: string; to: string } | null, only: Array<{ source: Source; paymentId: string }> | null,
  bank: string | null,
): Promise<RebankList & { payments?: Map<string, PaymentRead> }> {
  const target = bank ?? (await resolveRoles(sb, companyId)).BANK_DEFAULT;
  const pays = await readTransfers(sb, companyId, range, only);
  if (!pays.ok) return pays;
  const live = await liveEntries(sb, companyId, pays.rows);
  if (!live.ok) return live;

  const rows: RebankCandidate[] = [];
  const payments = new Map<string, PaymentRead>();
  for (const p of pays.rows) {
    const key = `${p.source}:${p.row.id}`;
    const je = live.byPayment.get(key);
    if (!je || je.account === target) continue;
    payments.set(key, p);
    rows.push({
      source: p.source, paymentId: String(p.row.id), docNo: p.docNo, paidOn: je.entryDate || dayOf(p.row.paid_at),
      amountSen: Number(p.row.amount_sen ?? 0), jeNo: je.jeNo, fromAccount: je.account, blocked: null,
    });
  }
  if (rows.length === 0) return { ok: true, target, rows, payments };

  /* Confirmed into a named bank (Conts #476): a receipt Finance confirmed into
     the bank its entry sits on stays there — the clean-up never undoes it. */
  if (bank === null) {
    const confirmed = new Set<string>();
    for (const source of ['SOPAY', 'SIPAY'] as const) {
      const ids = rows.filter((r) => r.source === source).map((r) => r.paymentId);
      if (ids.length === 0) continue;
      const f = await chunkIn<Rec>(ids, (batch, lo, hi) => sb.from('acc_official_receipts')
        .select('payment_id, channel_account_code').eq('company_id', companyId).eq('status', 'FORMAL')
        .eq('payment_source', source).in('payment_id', batch).order('payment_id').range(lo, hi));
      if (f.error) return { ok: false, reason: `receipts: ${f.error.message}` };
      for (const x of f.data) if (x.channel_account_code) confirmed.add(`${source}:${String(x.payment_id)}|${String(x.channel_account_code)}`);
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (confirmed.has(`${r.source}:${r.paymentId}|${r.fromAccount}`)) { rows.splice(i, 1); payments.delete(`${r.source}:${r.paymentId}`); }
    }
    if (rows.length === 0) return { ok: true, target, rows, payments };
  }

  /* Claimed on a statement: the money was matched on the bank it sits on. */
  const claims = await chunkIn<Rec>(rows.map((r) => r.jeNo), (batch, lo, hi) => sb.from('acc_bank_statement_matches')
    .select('je_no').eq('company_id', companyId).in('je_no', batch).order('je_no').range(lo, hi));
  if (claims.error) return { ok: false, reason: `bank matches: ${claims.error.message}` };
  const claimed = new Set(claims.data.map((c) => String(c.je_no)));

  /* Closed months, on the bank it leaves and the bank it joins. */
  const accounts = [...new Set([target, ...rows.map((r) => r.fromAccount)])];
  const locks = await chunkIn<Rec>(accounts, (batch, lo, hi) => sb.from('acc_bank_month_locks')
    .select('account_code, period_month, released_at').eq('company_id', companyId).in('account_code', batch).order('account_code').range(lo, hi));
  if (locks.error) return { ok: false, reason: `bank month locks: ${locks.error.message}` };
  const locked = new Set(locks.data.filter((l) => l.released_at == null).map((l) => `${l.account_code}|${dayOf(l.period_month).slice(0, 7)}`));

  for (const r of rows) {
    const month = r.paidOn.slice(0, 7);
    if (claimed.has(r.jeNo)) r.blocked = `already matched on the ${r.fromAccount} statement`;
    else if (locked.has(`${r.fromAccount}|${month}`)) r.blocked = `${r.fromAccount} ${month} is closed — unlock it first`;
    else if (locked.has(`${target}|${month}`)) r.blocked = `${target} ${month} is closed — unlock it first`;
  }
  rows.sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.docNo.localeCompare(b.docNo));
  return { ok: true, target, rows, payments };
}

/** The transfer receipts in [from, to] that sit on another bank than the company's Receive into. */
export async function rebankCandidates(sb: Db, companyId: number, from: string, to: string): Promise<RebankList> {
  const r = await listFor(sb, companyId, { from, to }, null, null);
  if (!r.ok) return r;
  return { ok: true, target: r.target, rows: r.rows };
}

export type RebankOutcome = {
  source: Source;
  paymentId: string;
  status: 'moved' | 'skipped' | 'failed';
  reason: string | null;
  /** The reversed entry and the new one. */
  fromJeNo: string | null;
  jeNo: string | null;
};

/** Move the named receipts, each checked again first. A receipt that cannot
    move is skipped with its reason. With `tx` (the default path) a receipt
    whose move fails is `failed` with NOTHING written — its old entry is still
    live. With `tx` null (RECEIPT_REBANK_MODE=two-step) the old path runs: a
    `failed` there can mean the reversal landed and the new entry did not. */
export async function rebankReceipts(
  sb: Db, companyId: number, items: Array<{ source: Source; paymentId: string }>, tx: RebankTx | null,
): Promise<{ ok: true; target: string; results: RebankOutcome[] } | { ok: false; reason: string }> {
  return moveReceipts(sb, companyId, items, null, tx);
}

/**
 * Where a transfer payment's live entry sits against the bank Finance is
 * confirming it into (Conts #476): null when it is already there (or has no
 * live entry, or is no transfer), else the move with its `blocked` reason.
 */
export async function transferMoveFor(
  sb: Db, companyId: number, item: { source: Source; paymentId: string }, bank: string,
): Promise<{ ok: true; move: RebankCandidate | null } | { ok: false; reason: string }> {
  const r = await listFor(sb, companyId, null, [item], bank);
  if (!r.ok) return r;
  return { ok: true, move: r.rows[0] ?? null };
}

/** Move the named receipts onto `bank` (null = BANK_DEFAULT). One at a time:
    the Worker holds ONE database connection per request (db/pg.ts max:1), so
    parallel transactions would only queue on it. */
export async function moveReceipts(
  sb: Db, companyId: number, items: Array<{ source: Source; paymentId: string }>, bank: string | null, tx: RebankTx | null,
): Promise<{ ok: true; target: string; results: RebankOutcome[] } | { ok: false; reason: string }> {
  const fresh = await listFor(sb, companyId, null, items, bank);
  if (!fresh.ok) return fresh;
  const byKey = new Map(fresh.rows.map((r) => [`${r.source}:${r.paymentId}`, r]));
  const results: RebankOutcome[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = `${it.source}:${it.paymentId}`;
    const c = byKey.get(key);
    const base = { source: it.source, paymentId: it.paymentId, fromJeNo: c?.jeNo ?? null, jeNo: null };
    /* The same receipt twice in one call is one journal moved twice: the second is refused. */
    if (seen.has(key)) { results.push({ ...base, status: 'skipped', reason: 'listed twice in this move' }); continue; }
    seen.add(key);
    if (!c) { results.push({ ...base, status: 'skipped', reason: `not a transfer receipt on another bank than ${fresh.target}` }); continue; }
    if (c.blocked) { results.push({ ...base, status: 'skipped', reason: c.blocked }); continue; }
    const payment = fresh.payments!.get(key)!;
    results.push(tx
      ? await moveOneAtomic(tx, companyId, it, c, payment, fresh.target)
      : await moveOneTwoStep(sb, companyId, it, c, payment, fresh.target));
  }
  return { ok: true, target: fresh.target, results };
}

/** Why the transaction is rolled back; `status` is what the receipt reports. */
class RebankRollback extends Error {
  constructor(readonly status: 'skipped' | 'failed', readonly why: string) { super(why); }
}

const contraNarration = (c: RebankCandidate, target: string) => (orig: { je_no: string }) =>
  `Reversal of ${orig.je_no} — receipt on ${c.docNo} moved from ${c.fromAccount} to ${target}`;

const postOnto = (db: Db, source: Source, payment: PaymentRead, target: string) => {
  const onto = { bankAccountCode: target };
  return source === 'SOPAY' ? postSoPayment(db, payment.row as SoPaymentRow, onto) : postSiPayment(db, payment.row as SiPaymentRow, onto);
};

/** Contra + new entry + read-back in ONE transaction: any refusal or error
    rolls all of it back, and the receipt stays on the bank it was on. */
async function moveOneAtomic(
  tx: RebankTx, companyId: number, it: { source: Source; paymentId: string }, c: RebankCandidate, payment: PaymentRead, target: string,
): Promise<RebankOutcome> {
  const base = { source: it.source, paymentId: it.paymentId, fromJeNo: c.jeNo };
  try {
    const jeNo = await tx(async (db) => {
      /* Checked again inside the transaction: a statement match made since the list. */
      const claim = await db.from('acc_bank_statement_matches').select('je_no')
        .eq('company_id', companyId).eq('je_no', c.jeNo).limit(1);
      if (claim.error) throw new RebankRollback('failed', `bank matches: ${claim.error.message}`);
      if ((claim.data ?? []).length > 0) throw new RebankRollback('skipped', `already matched on the ${c.fromAccount} statement`);

      const undone = await reverseJournal(db, {
        sourceType: it.source, sourceDocNo: it.paymentId, companyId, onOriginalDate: true, narration: contraNarration(c, target),
      });
      if (!undone.ok) throw new RebankRollback('failed', `reverse: ${undone.status}${undone.reason ? ` (${undone.reason})` : ''}`);
      /* The entry reversed must be the one listed — anything else changed under us. */
      if (undone.status !== 'reversed' || undone.originalJeNo !== c.jeNo) {
        throw new RebankRollback('skipped', `its entry changed since the list (expected ${c.jeNo}) — list again`);
      }

      const posted = await postOnto(db, it.source, payment, target);
      if (!posted.ok || posted.status !== 'posted') {
        const why = posted.ok ? posted.status : `${posted.status}${posted.reason ? ` (${posted.reason})` : ''}`;
        throw new RebankRollback('failed', `the new entry did not post: ${why}`);
      }
      /* Read back: the new entry's money leg must be the target bank. */
      const after = await liveEntries(db, companyId, [payment]);
      const leg = after.ok ? after.byPayment.get(`${it.source}:${it.paymentId}`) : null;
      if (!leg || leg.account !== target) {
        throw new RebankRollback('failed', `the new entry ${posted.jeNo} debits ${leg?.account ?? 'nothing readable'}, not ${target}`);
      }
      return posted.jeNo;
    });
    return { ...base, status: 'moved', reason: null, jeNo };
  } catch (e) {
    const status = e instanceof RebankRollback ? e.status : 'failed';
    const why = e instanceof RebankRollback ? e.why : (e instanceof Error ? e.message : String(e));
    return { ...base, status, jeNo: null, reason: status === 'failed' ? `nothing changed, still on ${c.fromAccount}: ${why}` : why };
  }
}

/** THE OLD PATH (RECEIPT_REBANK_MODE=two-step), unchanged: the reversal commits
    before the new entry is written. Remove after one clean release. */
async function moveOneTwoStep(
  sb: Db, companyId: number, it: { source: Source; paymentId: string }, c: RebankCandidate, payment: PaymentRead, target: string,
): Promise<RebankOutcome> {
  const key = `${it.source}:${it.paymentId}`;
  const base = { source: it.source, paymentId: it.paymentId, fromJeNo: c.jeNo, jeNo: null };
  const undone = await reverseJournal(sb, {
    sourceType: it.source, sourceDocNo: it.paymentId, companyId, onOriginalDate: true, narration: contraNarration(c, target),
  });
  if (!undone.ok) return { ...base, status: 'skipped', reason: `reverse: ${undone.status}${undone.reason ? ` (${undone.reason})` : ''}` };

  const posted = await postOnto(sb, it.source, payment, target);
  if (!posted.ok || (posted.status !== 'posted' && posted.status !== 'already_posted')) {
    const why = posted.ok ? posted.status : `${posted.status}${posted.reason ? ` (${posted.reason})` : ''}`;
    return { ...base, status: 'failed', reason: `reversed, but the new entry did not post: ${why}` };
  }
  const after = await liveEntries(sb, companyId, [payment]);
  const leg = after.ok ? after.byPayment.get(key) : null;
  if (!leg || leg.account !== target) {
    return { ...base, status: 'failed', jeNo: posted.jeNo, reason: `the new entry ${posted.jeNo} debits ${leg?.account ?? 'nothing readable'}, not ${target}` };
  }
  return { ...base, status: 'moved', reason: null, jeNo: posted.jeNo };
}
